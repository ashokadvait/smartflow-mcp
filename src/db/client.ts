import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

let cachedDefaultTenantId: string | null = null;

function toSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

export async function getOrCreateDefaultTenant(): Promise<{
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
}> {
  if (cachedDefaultTenantId) {
    const existing = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, cachedDefaultTenantId))
      .limit(1);
    if (existing[0]) {
      return existing[0];
    }
  }

  const found = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.name, env.DEFAULT_TENANT_NAME))
    .limit(1);

  if (found[0]) {
    if (!found[0].slug) {
      const slug = toSlug(found[0].name);
      const [updated] = await db
        .update(schema.tenants)
        .set({ slug, updatedAt: new Date() })
        .where(eq(schema.tenants.id, found[0].id))
        .returning();
      if (updated) {
        cachedDefaultTenantId = updated.id;
        return updated;
      }
    }
    cachedDefaultTenantId = found[0].id;
    return found[0];
  }

  const inserted = await db
    .insert(schema.tenants)
    .values({
      name: env.DEFAULT_TENANT_NAME,
      slug: toSlug(env.DEFAULT_TENANT_NAME),
      timezone: env.DEFAULT_TIMEZONE,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    cachedDefaultTenantId = inserted[0].id;
    return inserted[0];
  }

  const retry = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.name, env.DEFAULT_TENANT_NAME))
    .limit(1);

  if (!retry[0]) {
    throw new Error("Failed to resolve default tenant.");
  }
  cachedDefaultTenantId = retry[0].id;
  return retry[0];
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

