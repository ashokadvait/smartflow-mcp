import crypto from "node:crypto";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { env } from "../config/env.js";
import { db, getOrCreateDefaultTenant } from "../db/client.js";
import { apiKeys, tenants } from "../db/schema/index.js";
import { SmartFlowAuthManager } from "../integrations/smartflow/auth.js";
import { SmartFlowClient } from "../integrations/smartflow/client.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../utils/errors.js";
import { decryptSecret, encryptSecret } from "../utils/pii.js";

export type TenantRow = typeof tenants.$inferSelect;

export interface AuthContext {
  role: "admin" | "tenant";
  tenantId?: string;
  actor: string;
  apiKeyId?: string;
}

export interface SafeAccountSummary {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  active: boolean;
  smartfloBaseUrl: string;
  hasSmartfloCredentials: boolean;
  hasWebhookSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,62}[a-z0-9]$/;

export function normalizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(cleaned)) {
    throw new ValidationError(
      "Account slug must be 3-64 characters of lowercase letters, numbers, hyphens, or underscores."
    );
  }
  return cleaned;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateRawApiKey(role: "admin" | "tenant"): { rawKey: string; prefix: string; hash: string } {
  const tag = role === "admin" ? "sf_adm_" : "sf_acc_";
  const secret = crypto.randomBytes(24).toString("hex");
  const rawKey = `${tag}${secret}`;
  return {
    rawKey,
    prefix: rawKey.slice(0, 14),
    hash: hashApiKey(rawKey),
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function toSafeAccountSummary(row: TenantRow): SafeAccountSummary {
  const isDefault = row.name === env.DEFAULT_TENANT_NAME || row.slug === "default-tenant";
  const hasDbCreds = Boolean(
    row.smartfloApiKeyEncrypted || (row.smartfloEmailEncrypted && row.smartfloPasswordEncrypted)
  );
  const hasEnvCreds = isDefault && Boolean(env.SMARTFLOW_API_KEY || (env.SMARTFLOW_EMAIL && env.SMARTFLOW_PASSWORD));
  const hasWebhookSecret = Boolean(
    row.smartfloWebhookSecretEncrypted || (isDefault && env.SMARTFLOW_WEBHOOK_SECRET)
  );

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    active: row.active,
    smartfloBaseUrl: row.smartfloBaseUrl || env.SMARTFLOW_BASE_URL,
    hasSmartfloCredentials: hasDbCreds || hasEnvCreds,
    hasWebhookSecret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Authenticates a Bearer / x-api-key token against the api_keys table (and env.MCP_API_KEY fallback).
 */
export async function authenticateApiKey(rawToken?: string | null): Promise<AuthContext> {
  const token = (rawToken ?? "").trim();

  if (token) {
    // 1. Check bootstrap admin key from env
    if (env.MCP_API_KEY && safeEqual(token, env.MCP_API_KEY)) {
      return { role: "admin", actor: "env-admin" };
    }

    // 2. Check database api_keys table
    const keyHash = hashApiKey(token);
    const found = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.active, true)))
      .limit(1);

    const row = found[0];
    if (row) {
      // Best-effort lastUsedAt update
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id))
        .catch(() => {});

      const role = row.role === "admin" ? "admin" : "tenant";
      if (role === "tenant" && !row.tenantId) {
        throw new UnauthorizedError("API key is not bound to an account.");
      }

      return {
        role,
        tenantId: row.tenantId ?? undefined,
        actor: `key:${row.keyPrefix}`,
        apiKeyId: row.id,
      };
    }

    throw new UnauthorizedError("Invalid or revoked API key.");
  }

  // No token provided: allow only in local dev when MCP_API_KEY is unset and no active DB keys exist
  if (!env.MCP_API_KEY) {
    const anyKey = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.active, true))
      .limit(1);
    if (anyKey.length === 0) {
      return { role: "admin", actor: "local-dev" };
    }
  }

  throw new UnauthorizedError("Missing API key. Pass Authorization: Bearer <key> or x-api-key.");
}

export async function getTenantByIdentifier(identifier: string): Promise<TenantRow | null> {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  if (UUID_RE.test(trimmed)) {
    const byId = await db.select().from(tenants).where(eq(tenants.id, trimmed)).limit(1);
    return byId[0] ?? null;
  }

  const lower = trimmed.toLowerCase();
  const bySlugOrName = await db
    .select()
    .from(tenants)
    .where(or(eq(tenants.slug, lower), ilike(tenants.name, trimmed)))
    .limit(1);

  return bySlugOrName[0] ?? null;
}

/**
 * Resolves the target Smartflo account (tenant) for an authenticated request, enforcing tenant isolation.
 */
export async function resolveTenantForContext(
  auth: AuthContext,
  requestedAccount?: string
): Promise<TenantRow> {
  if (auth.role === "tenant") {
    if (!auth.tenantId) {
      throw new ForbiddenError("API key is missing an assigned account.");
    }
    const rows = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, auth.tenantId), eq(tenants.active, true)))
      .limit(1);
    const own = rows[0];
    if (!own) {
      throw new ForbiddenError("Assigned Smartflo account is inactive or not found.");
    }

    if (requestedAccount && requestedAccount.trim()) {
      const req = requestedAccount.trim().toLowerCase();
      const matchesOwn =
        req === own.id.toLowerCase() ||
        (own.slug !== null && req === own.slug.toLowerCase()) ||
        req === own.name.toLowerCase();
      if (!matchesOwn) {
        throw new ForbiddenError(
          `This API key is scoped to account "${own.slug ?? own.name}" and cannot access "${requestedAccount}".`
        );
      }
    }
    return own;
  }

  // Admin role
  if (requestedAccount && requestedAccount.trim()) {
    const found = await getTenantByIdentifier(requestedAccount);
    if (!found || !found.active) {
      throw new NotFoundError(
        `Smartflo account "${requestedAccount}" not found or inactive. Call list_accounts to see available accounts.`
      );
    }
    return found;
  }

  const def = await getOrCreateDefaultTenant();
  const rows = await db.select().from(tenants).where(eq(tenants.id, def.id)).limit(1);
  if (!rows[0]) {
    throw new NotFoundError("Default Smartflo account not found.");
  }
  return rows[0];
}

export async function listAccessibleAccounts(auth: AuthContext): Promise<SafeAccountSummary[]> {
  if (auth.role === "tenant") {
    if (!auth.tenantId) return [];
    const rows = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, auth.tenantId), eq(tenants.active, true)))
      .limit(1);
    return rows.map(toSafeAccountSummary);
  }

  const rows = await db
    .select()
    .from(tenants)
    .where(eq(tenants.active, true))
    .orderBy(tenants.name);
  return rows.map(toSafeAccountSummary);
}

export async function listAllAccounts(): Promise<SafeAccountSummary[]> {
  const rows = await db.select().from(tenants).orderBy(tenants.name);
  return rows.map(toSafeAccountSummary);
}

export async function createAccount(input: {
  name: string;
  slug?: string;
  timezone?: string;
  smartfloBaseUrl?: string;
  smartfloApiKey?: string;
  smartfloEmail?: string;
  smartfloPassword?: string;
  smartfloWebhookSecret?: string;
}): Promise<SafeAccountSummary> {
  const name = input.name.trim();
  const slug = normalizeSlug(input.slug ?? name);

  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(or(eq(tenants.slug, slug), ilike(tenants.name, name)))
    .limit(1);

  if (existing[0]) {
    throw new ConflictError(`An account with name "${name}" or slug "${slug}" already exists.`);
  }

  const [inserted] = await db
    .insert(tenants)
    .values({
      name,
      slug,
      timezone: input.timezone ?? env.DEFAULT_TIMEZONE,
      active: true,
      smartfloBaseUrl: input.smartfloBaseUrl?.trim() || null,
      smartfloApiKeyEncrypted: input.smartfloApiKey ? encryptSecret(input.smartfloApiKey.trim()) : null,
      smartfloEmailEncrypted: input.smartfloEmail ? encryptSecret(input.smartfloEmail.trim()) : null,
      smartfloPasswordEncrypted: input.smartfloPassword ? encryptSecret(input.smartfloPassword) : null,
      smartfloWebhookSecretEncrypted: input.smartfloWebhookSecret
        ? encryptSecret(input.smartfloWebhookSecret.trim())
        : null,
    })
    .returning();

  return toSafeAccountSummary(inserted!);
}

export async function getAccountCredentialsForEdit(identifier: string): Promise<{
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  active: boolean;
  smartfloBaseUrl: string;
  smartfloApiKey: string;
  smartfloEmail: string;
  hasSmartfloPassword: boolean;
  smartfloWebhookSecret: string;
}> {
  const row = await getTenantByIdentifier(identifier);
  if (!row) {
    throw new NotFoundError(`Account "${identifier}" not found.`);
  }
  const isDefault = row.name === env.DEFAULT_TENANT_NAME || row.slug === "default-tenant";
  const smartfloApiKey = row.smartfloApiKeyEncrypted
    ? decryptSecret(row.smartfloApiKeyEncrypted)
    : isDefault
      ? env.SMARTFLOW_API_KEY
      : "";
  const smartfloEmail = row.smartfloEmailEncrypted
    ? decryptSecret(row.smartfloEmailEncrypted)
    : isDefault
      ? env.SMARTFLOW_EMAIL
      : "";
  const hasSmartfloPassword = Boolean(row.smartfloPasswordEncrypted || (isDefault && env.SMARTFLOW_PASSWORD));
  const smartfloWebhookSecret = row.smartfloWebhookSecretEncrypted
    ? decryptSecret(row.smartfloWebhookSecretEncrypted)
    : isDefault
      ? env.SMARTFLOW_WEBHOOK_SECRET
      : "";

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    active: row.active,
    smartfloBaseUrl: row.smartfloBaseUrl || env.SMARTFLOW_BASE_URL,
    smartfloApiKey,
    smartfloEmail,
    hasSmartfloPassword,
    smartfloWebhookSecret,
  };
}

export async function updateAccount(
  identifier: string,
  input: {
    name?: string;
    slug?: string;
    timezone?: string;
    active?: boolean;
    smartfloBaseUrl?: string | null;
    smartfloApiKey?: string | null;
    smartfloEmail?: string | null;
    smartfloPassword?: string | null;
    smartfloWebhookSecret?: string | null;
  }
): Promise<SafeAccountSummary> {
  const existing = await getTenantByIdentifier(identifier);
  if (!existing) {
    throw new NotFoundError(`Account "${identifier}" not found.`);
  }

  const patch: Partial<typeof tenants.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    patch.name = input.name.trim();
    // If renaming the default tenant while it still relies on .env Smartflo creds, persist them encrypted to DB
    if (
      existing.name === env.DEFAULT_TENANT_NAME &&
      patch.name !== env.DEFAULT_TENANT_NAME &&
      !existing.smartfloApiKeyEncrypted &&
      !existing.smartfloEmailEncrypted &&
      input.smartfloApiKey === undefined &&
      input.smartfloEmail === undefined
    ) {
      if (env.SMARTFLOW_API_KEY) {
        patch.smartfloApiKeyEncrypted = encryptSecret(env.SMARTFLOW_API_KEY.trim());
      } else if (env.SMARTFLOW_EMAIL && env.SMARTFLOW_PASSWORD) {
        patch.smartfloEmailEncrypted = encryptSecret(env.SMARTFLOW_EMAIL.trim());
        patch.smartfloPasswordEncrypted = encryptSecret(env.SMARTFLOW_PASSWORD);
      }
      if (!existing.smartfloWebhookSecretEncrypted && env.SMARTFLOW_WEBHOOK_SECRET) {
        patch.smartfloWebhookSecretEncrypted = encryptSecret(env.SMARTFLOW_WEBHOOK_SECRET.trim());
      }
    }
  }
  if (input.slug !== undefined && input.slug.trim()) {
    const nextSlug = normalizeSlug(input.slug);
    if (nextSlug !== existing.slug) {
      const clash = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, nextSlug))
        .limit(1);
      if (clash[0] && clash[0].id !== existing.id) {
        throw new ConflictError(`Slug "${nextSlug}" is already in use by another organization.`);
      }
      patch.slug = nextSlug;
    }
  }
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.active !== undefined) patch.active = input.active;
  if (input.smartfloBaseUrl !== undefined) {
    patch.smartfloBaseUrl = input.smartfloBaseUrl ? input.smartfloBaseUrl.trim() : null;
  }
  if (input.smartfloApiKey !== undefined) {
    patch.smartfloApiKeyEncrypted = input.smartfloApiKey ? encryptSecret(input.smartfloApiKey.trim()) : null;
  }
  if (input.smartfloEmail !== undefined) {
    patch.smartfloEmailEncrypted = input.smartfloEmail ? encryptSecret(input.smartfloEmail.trim()) : null;
  }
  if (input.smartfloPassword !== undefined) {
    patch.smartfloPasswordEncrypted = input.smartfloPassword ? encryptSecret(input.smartfloPassword) : null;
  }
  if (input.smartfloWebhookSecret !== undefined) {
    patch.smartfloWebhookSecretEncrypted = input.smartfloWebhookSecret
      ? encryptSecret(input.smartfloWebhookSecret.trim())
      : null;
  }

  const [updated] = await db
    .update(tenants)
    .set(patch)
    .where(eq(tenants.id, existing.id))
    .returning();

  return toSafeAccountSummary(updated!);
}

export async function createApiKeyRecord(input: {
  name: string;
  role: "admin" | "tenant";
  accountIdentifier?: string;
}): Promise<{
  id: string;
  name: string;
  role: "admin" | "tenant";
  tenantId: string | null;
  accountSlug: string | null;
  keyPrefix: string;
  apiKey: string;
  createdAt: Date;
}> {
  let tenant: TenantRow | null = null;
  if (input.role === "tenant") {
    if (!input.accountIdentifier) {
      throw new ValidationError("accountIdentifier is required for tenant-scoped API keys.");
    }
    tenant = await getTenantByIdentifier(input.accountIdentifier);
    if (!tenant || !tenant.active) {
      throw new NotFoundError(`Account "${input.accountIdentifier}" not found or inactive.`);
    }
  }

  const generated = generateRawApiKey(input.role);
  const [inserted] = await db
    .insert(apiKeys)
    .values({
      name: input.name.trim(),
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      keyEncrypted: encryptSecret(generated.rawKey),
      role: input.role,
      tenantId: tenant?.id ?? null,
      active: true,
    })
    .returning();

  return {
    id: inserted!.id,
    name: inserted!.name,
    role: input.role,
    tenantId: inserted!.tenantId,
    accountSlug: tenant?.slug ?? null,
    keyPrefix: inserted!.keyPrefix,
    apiKey: generated.rawKey,
    createdAt: inserted!.createdAt,
  };
}

export async function listApiKeyRecords(tenantId?: string) {
  const whereClause = tenantId ? eq(apiKeys.tenantId, tenantId) : undefined;
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      keyEncrypted: apiKeys.keyEncrypted,
      role: apiKeys.role,
      tenantId: apiKeys.tenantId,
      active: apiKeys.active,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(whereClause)
    .orderBy(desc(apiKeys.createdAt));

  return rows.map(({ keyEncrypted, ...rest }) => ({
    ...rest,
    canReveal: Boolean(keyEncrypted),
  }));
}

export async function revealApiKeyRecord(keyId: string): Promise<{
  id: string;
  name: string;
  role: "admin" | "tenant";
  tenantId: string | null;
  accountSlug: string | null;
  keyPrefix: string;
  apiKey: string;
}> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  const row = rows[0];
  if (!row || !row.active) {
    throw new NotFoundError(`Active API key "${keyId}" not found.`);
  }
  if (!row.keyEncrypted) {
    throw new ValidationError(
      "This older API key was created before key viewing was enabled. Delete it and generate a new key."
    );
  }

  let accountSlug: string | null = null;
  if (row.tenantId) {
    const tRows = await db.select({ slug: tenants.slug, name: tenants.name }).from(tenants).where(eq(tenants.id, row.tenantId)).limit(1);
    accountSlug = tRows[0]?.slug ?? tRows[0]?.name ?? null;
  }

  return {
    id: row.id,
    name: row.name,
    role: row.role === "admin" ? "admin" : "tenant",
    tenantId: row.tenantId,
    accountSlug,
    keyPrefix: row.keyPrefix,
    apiKey: decryptSecret(row.keyEncrypted),
  };
}

export async function revokeApiKeyRecord(keyId: string): Promise<{ id: string; deleted: boolean }> {
  const [deleted] = await db
    .delete(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .returning({ id: apiKeys.id });

  if (!deleted) {
    throw new NotFoundError(`API key "${keyId}" not found.`);
  }
  return { id: deleted.id, deleted: true };
}

/**
 * Builds a SmartFlowClient configured with the specific tenant's decrypted credentials.
 * Falls back to .env credentials for the default tenant if no DB credentials are stored.
 */
export async function getSmartFlowClientForTenant(tenantId: string): Promise<{
  tenant: TenantRow;
  client: SmartFlowClient;
}> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const tenant = rows[0];
  if (!tenant) {
    throw new NotFoundError(`Tenant "${tenantId}" not found.`);
  }

  const baseUrl = tenant.smartfloBaseUrl || env.SMARTFLOW_BASE_URL;
  const dbApiKey = tenant.smartfloApiKeyEncrypted ? decryptSecret(tenant.smartfloApiKeyEncrypted) : "";
  const dbEmail = tenant.smartfloEmailEncrypted ? decryptSecret(tenant.smartfloEmailEncrypted) : "";
  const dbPassword = tenant.smartfloPasswordEncrypted ? decryptSecret(tenant.smartfloPasswordEncrypted) : "";

  if (dbApiKey || (dbEmail && dbPassword)) {
    const auth = new SmartFlowAuthManager(baseUrl, dbApiKey, dbEmail, dbPassword);
    return { tenant, client: new SmartFlowClient({ baseUrl, auth }) };
  }

  // Fallback to global env credentials for the default tenant
  if (tenant.name === env.DEFAULT_TENANT_NAME) {
    const auth = new SmartFlowAuthManager(
      baseUrl,
      env.SMARTFLOW_API_KEY,
      env.SMARTFLOW_EMAIL,
      env.SMARTFLOW_PASSWORD
    );
    return { tenant, client: new SmartFlowClient({ baseUrl, auth }) };
  }

  throw new UnauthorizedError(
    `Smartflo credentials are not configured for account "${tenant.slug ?? tenant.name}".`
  );
}

export function getWebhookSecretForTenant(tenant: TenantRow): string {
  if (tenant.smartfloWebhookSecretEncrypted) {
    return decryptSecret(tenant.smartfloWebhookSecretEncrypted);
  }
  if (tenant.name === env.DEFAULT_TENANT_NAME) {
    return env.SMARTFLOW_WEBHOOK_SECRET;
  }
  return "";
}

/**
 * Returns all active tenants that have Smartflo credentials configured (in DB or default env).
 */
export async function listSyncableTenants(): Promise<TenantRow[]> {
  await getOrCreateDefaultTenant();
  const activeTenants = await db.select().from(tenants).where(eq(tenants.active, true));
  return activeTenants.filter((t) => {
    const hasDbCreds = Boolean(
      t.smartfloApiKeyEncrypted || (t.smartfloEmailEncrypted && t.smartfloPasswordEncrypted)
    );
    const hasEnvCreds =
      t.name === env.DEFAULT_TENANT_NAME &&
      Boolean(env.SMARTFLOW_API_KEY || (env.SMARTFLOW_EMAIL && env.SMARTFLOW_PASSWORD));
    return hasDbCreds || hasEnvCreds;
  });
}

