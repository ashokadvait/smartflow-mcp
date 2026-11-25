import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getAgentPerformance,
  getCallDetails,
  getCallTranscript,
  getConversionFunnel,
  getDailyCallReport,
  getDepartments,
  searchCalls,
} from "../analytics/analytics.service.js";
import { env } from "../config/env.js";
import { db, getOrCreateDefaultTenant } from "../db/client.js";
import { callAnalyses, calls, recordings, syncLogs } from "../db/schema/index.js";
import { parseSmartfloWebhook } from "../integrations/smartflow/webhooks.js";
import { createMcpServer } from "../mcp/server.js";
import { analyzeCallTranscript } from "../pipeline/analysis.pipeline.js";
import { transcribeCallRecording } from "../pipeline/transcription.pipeline.js";
import { getSafeProviderMetadata } from "../providers/registry.js";
import { createQueues } from "../queue/queues.js";
import {
  authenticateApiKey,
  createAccount,
  createApiKeyRecord,
  getTenantByIdentifier,
  getWebhookSecretForTenant,
  listAccessibleAccounts,
  listAllAccounts,
  listApiKeyRecords,
  resolveTenantForContext,
  revokeApiKeyRecord,
  updateAccount,
  type AuthContext,
} from "../services/account.service.js";
import { askCallAnalytics } from "../services/ask-analytics.service.js";
import { recordToolAudit } from "../services/audit.service.js";
import { generateFullDailyReport } from "../services/report.service.js";
import { syncCallsWindow, upsertNormalizedCall } from "../services/sync.service.js";
import { DASHBOARD_HTML } from "../ui/dashboard-html.js";
import { getTodayYmd, validateDateRange } from "../utils/dates.js";
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const requestAuthMap = new WeakMap<FastifyRequest, AuthContext>();

function extractApiKeyToken(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return String(req.headers["x-api-key"] ?? "").trim();
}

function getAuthContext(req: FastifyRequest): AuthContext {
  const ctx = requestAuthMap.get(req);
  if (!ctx) {
    throw new UnauthorizedError("Unauthenticated request.");
  }
  return ctx;
}

function extractRequestedAccount(req: FastifyRequest): string | undefined {
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = typeof query?.account === "string" ? query.account : undefined;
  const fromHeader = typeof req.headers["x-account"] === "string" ? req.headers["x-account"] : undefined;
  return fromQuery || fromHeader;
}

async function requireApiKey(req: FastifyRequest, _reply: FastifyReply) {
  const token = extractApiKeyToken(req);
  const auth = await authenticateApiKey(token);
  requestAuthMap.set(req, auth);
}

async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireApiKey(req, reply);
  const auth = getAuthContext(req);
  if (auth.role !== "admin") {
    throw new ForbiddenError("Admin API key required for this endpoint.");
  }
}

export function buildApp() {
  const app = Fastify({ logger: false });

  app.addHook("onResponse", async (req, reply) => {
    logger.info(
      {
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      "HTTP request"
    );
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "Validation error", issues: err.issues });
    }
    logger.error({ err }, "Unhandled HTTP error");
    return reply.status(500).send({ error: "Internal server error" });
  });

  // Operations Dashboard UI (served at /)
  app.get("/", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(DASHBOARD_HTML);
  });

  // Health & readiness
  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // =========================================================================
  // Multi-Account & API Key Management
  // =========================================================================

  // List accounts (admin sees all; tenant key sees only its own account)
  app.get("/api/v1/accounts", { preHandler: requireApiKey }, async (req) => {
    const auth = getAuthContext(req);
    const accounts = auth.role === "admin" ? await listAllAccounts() : await listAccessibleAccounts(auth);
    return { role: auth.role, count: accounts.length, accounts };
  });

  // Create a Smartflo account (admin only)
  app.post("/api/v1/accounts", { preHandler: requireAdmin }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(2).max(120),
        slug: z.string().min(3).max(64).optional(),
        timezone: z.string().default("Asia/Kolkata"),
        smartfloBaseUrl: z.string().url().optional(),
        smartfloApiKey: z.string().min(1).optional(),
        smartfloEmail: z.string().email().optional(),
        smartfloPassword: z.string().min(1).optional(),
        smartfloWebhookSecret: z.string().min(1).optional(),
      })
      .parse(req.body);
    const created = await createAccount(body);
    return reply.status(201).send(created);
  });

  // Update a Smartflo account's settings or credentials (admin only)
  app.patch("/api/v1/accounts/:account", { preHandler: requireAdmin }, async (req) => {
    const { account } = z.object({ account: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        timezone: z.string().optional(),
        active: z.boolean().optional(),
        smartfloBaseUrl: z.string().url().nullable().optional(),
        smartfloApiKey: z.string().nullable().optional(),
        smartfloEmail: z.string().email().nullable().optional(),
        smartfloPassword: z.string().nullable().optional(),
        smartfloWebhookSecret: z.string().nullable().optional(),
      })
      .parse(req.body);
    return updateAccount(account, body);
  });

  // List API keys (admin only; optionally filter by ?account=<slug>)
  app.get("/api/v1/api-keys", { preHandler: requireAdmin }, async (req) => {
    const q = z.object({ account: z.string().optional() }).parse(req.query);
    let tenantId: string | undefined;
    if (q.account) {
      const tenant = await getTenantByIdentifier(q.account);
      if (!tenant) throw new NotFoundError(`Account "${q.account}" not found.`);
      tenantId = tenant.id;
    }
    const keys = await listApiKeyRecords(tenantId);
    return { count: keys.length, keys };
  });

  // Issue a client-scoped API key bound to a single Smartflo account (admin only)
  app.post("/api/v1/accounts/:account/api-keys", { preHandler: requireAdmin }, async (req, reply) => {
    const { account } = z.object({ account: z.string().min(1) }).parse(req.params);
    const body = z.object({ name: z.string().min(2).max(120) }).parse(req.body);
    const created = await createApiKeyRecord({
      name: body.name,
      role: "tenant",
      accountIdentifier: account,
    });
    return reply.status(201).send({
      ...created,
      note: "Save this apiKey now; it will not be shown again.",
    });
  });

  // Issue an admin API key that can access all Smartflo accounts (admin only)
  app.post("/api/v1/admin/api-keys", { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({ name: z.string().min(2).max(120) }).parse(req.body);
    const created = await createApiKeyRecord({
      name: body.name,
      role: "admin",
    });
    return reply.status(201).send({
      ...created,
      note: "Save this apiKey now; it will not be shown again.",
    });
  });

  // Revoke an API key (admin only)
  app.delete("/api/v1/api-keys/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return revokeApiKeyRecord(id);
  });

  // =========================================================================
  // Sync & Analytics Endpoints (Tenant-Scoped)
  // =========================================================================

  // Sync status
  app.get("/api/v1/sync/status", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const recent = await db
      .select()
      .from(syncLogs)
      .where(eq(syncLogs.tenantId, tenant.id))
      .orderBy(desc(syncLogs.startedAt))
      .limit(10);
    return { tenantId: tenant.id, accountSlug: tenant.slug, recentSyncs: recent };
  });

  // Trigger bounded sync for an account
  app.post("/api/v1/sync/calls", { preHandler: requireApiKey }, async (req) => {
    const body = z
      .object({
        account: z.string().max(120).optional(),
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .parse(req.body);
    const tenant = await resolveTenantForContext(
      getAuthContext(req),
      body.account ?? extractRequestedAccount(req)
    );
    const range = validateDateRange(body.from, body.to, 31);
    return syncCallsWindow({ tenantId: tenant.id, from: range.from, to: range.to, syncType: "manual" });
  });

  // Daily report (supports ?insights=true for full report with AI insights)
  app.get("/api/v1/reports/daily", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const q = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        timezone: z.string().optional(),
        insights: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const date = q.date ?? getTodayYmd(tenant.timezone);
    const timezone = q.timezone ?? tenant.timezone;
    if (q.insights === "true") {
      return generateFullDailyReport({ tenantId: tenant.id, date, timezone, includeAiInsights: true });
    }
    return getDailyCallReport({ tenantId: tenant.id, date, timezone });
  });

  // Agent report
  app.get("/api/v1/reports/agents", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        agentId: z.string().uuid().optional(),
      })
      .parse(req.query);
    const range = validateDateRange(q.from, q.to);
    return getAgentPerformance({
      tenantId: tenant.id,
      from: range.from,
      to: range.to,
      agentId: q.agentId,
    });
  });

  // Conversion funnel
  app.get("/api/v1/reports/conversions", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .parse(req.query);
    const range = validateDateRange(q.from, q.to);
    return getConversionFunnel({ tenantId: tenant.id, from: range.from, to: range.to });
  });

  // Distinct branches/departments for filter dropdown
  app.get("/api/v1/departments", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .parse(req.query);
    const range = validateDateRange(q.from, q.to);
    return getDepartments({ tenantId: tenant.id, from: range.from, to: range.to });
  });

  // Search calls
  app.get("/api/v1/calls", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        agentId: z.string().uuid().optional(),
        department: z.string().max(120).optional(),
        status: z.string().optional(),
        outcome: z.string().optional(),
        hasFollowup: z.enum(["true", "false"]).optional(),
        searchText: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const range = validateDateRange(q.from, q.to);
    return searchCalls({
      tenantId: tenant.id,
      from: range.from,
      to: range.to,
      agentId: q.agentId,
      department: q.department,
      status: q.status,
      outcome: q.outcome,
      hasFollowup: q.hasFollowup === "true",
      searchText: q.searchText,
      limit: q.limit,
    });
  });

  // Call detail
  app.get("/api/v1/calls/:id", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getCallDetails(tenant.id, id);
  });

  // Protected transcript (audit logged)
  app.get("/api/v1/calls/:id/transcript", { preHandler: requireApiKey }, async (req) => {
    const start = Date.now();
    const auth = getAuthContext(req);
    const tenant = await resolveTenantForContext(auth, extractRequestedAccount(req));
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const transcript = await getCallTranscript(tenant.id, id);
    await recordToolAudit({
      tenantId: tenant.id,
      actor: auth.actor,
      toolName: "GET /api/v1/calls/:id/transcript",
      parameters: { callId: id },
      outcome: "success",
      durationMs: Date.now() - start,
    });
    return transcript;
  });

  // Trigger transcription + analysis for a call (verified against caller's tenant)
  app.post("/api/v1/calls/:id/analyze", { preHandler: requireApiKey }, async (req) => {
    const tenant = await resolveTenantForContext(getAuthContext(req), extractRequestedAccount(req));
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const owned = await db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.id, id), eq(calls.tenantId, tenant.id)))
      .limit(1);
    if (!owned[0]) {
      throw new NotFoundError(`Call "${id}" not found in account "${tenant.slug ?? tenant.name}".`);
    }
    await transcribeCallRecording(id);
    const analysis = await analyzeCallTranscript(id);
    return { status: "completed", analysisId: analysis.id };
  });

  // Natural-language analytics Q&A bot endpoint (audit logged)
  app.post("/api/v1/ask", { preHandler: requireApiKey }, async (req) => {
    const start = Date.now();
    const auth = getAuthContext(req);
    const body = z
      .object({
        account: z.string().max(120).optional(),
        question: z.string().min(3).max(500),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        timezone: z.string().optional(),
      })
      .parse(req.body);
    const tenant = await resolveTenantForContext(auth, body.account ?? extractRequestedAccount(req));

    const range = body.from && body.to ? validateDateRange(body.from, body.to) : undefined;
    const result = await askCallAnalytics({
      tenantId: tenant.id,
      question: body.question,
      date: body.date ?? getTodayYmd(tenant.timezone),
      from: range?.from,
      to: range?.to,
      timezone: body.timezone ?? tenant.timezone,
    });

    await recordToolAudit({
      tenantId: tenant.id,
      actor: auth.actor,
      toolName: "POST /api/v1/ask",
      parameters: { question: body.question, date: body.date, account: tenant.slug },
      outcome: "success",
      durationMs: Date.now() - start,
    });

    return result;
  });

  // Safe provider metadata (never exposes secrets)
  app.get("/api/v1/providers", { preHandler: requireApiKey }, async () => {
    return getSafeProviderMetadata();
  });

  // Queue depths & health (observability; degrades gracefully in serverless without Redis)
  app.get("/api/v1/queues/status", { preHandler: requireApiKey }, async () => {
    if (process.env.VERCEL && !process.env.REDIS_URL) {
      return {
        mode: "serverless",
        queues: {
          sync: { waiting: 0, active: 0, completed: 0, failed: 0 },
          recording: { waiting: 0, active: 0, completed: 0, failed: 0 },
          transcription: { waiting: 0, active: 0, completed: 0, failed: 0 },
          analysis: { waiting: 0, active: 0, completed: 0, failed: 0 },
        },
      };
    }
    const { syncQueue, recordingQueue, transcriptionQueue, analysisQueue } = createQueues();
    const [sync, recording, transcription, analysis] = await Promise.all([
      syncQueue.getJobCounts(),
      recordingQueue.getJobCounts(),
      transcriptionQueue.getJobCounts(),
      analysisQueue.getJobCounts(),
    ]);
    return { mode: "bullmq", queues: { sync, recording, transcription, analysis } };
  });

  // Enqueue pending answered calls (or process inline batch on Vercel serverless when Redis is absent)
  app.post("/api/v1/queues/enqueue-pending", { preHandler: requireApiKey }, async (req) => {
    const body = z
      .object({
        account: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(req.body ?? {});
    const tenant = await resolveTenantForContext(
      getAuthContext(req),
      body.account ?? extractRequestedAccount(req)
    );

    const allPending = await db
      .select({ recordingId: recordings.id, callId: calls.id })
      .from(calls)
      .innerJoin(recordings, eq(recordings.callId, calls.id))
      .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
      .where(
        and(
          eq(calls.tenantId, tenant.id),
          eq(calls.status, "answered"),
          sql`${recordings.status} != 'failed'`,
          isNull(callAnalyses.id)
        )
      )
      .orderBy(desc(calls.startedAt))
      .limit(200);

    const batchSize =
      process.env.VERCEL && !process.env.REDIS_URL ? Math.min(body.limit, 5) : Math.min(body.limit, 50);
    const batch = allPending.slice(0, batchSize);

    if (process.env.VERCEL && !process.env.REDIS_URL) {
      let processed = 0;
      let failed = 0;
      for (const item of batch) {
        try {
          await transcribeCallRecording(item.callId);
          await analyzeCallTranscript(item.callId);
          processed += 1;
        } catch (err) {
          failed += 1;
          logger.warn({ callId: item.callId, err }, "Inline serverless call processing failed");
        }
      }
      const remaining = Math.max(0, allPending.length - batch.length);
      return { enqueued: processed, processed, failed, remaining, mode: "inline" };
    }

    const { recordingQueue } = createQueues();
    for (const item of batch) {
      await recordingQueue.add(
        "process-recording",
        { recordingId: item.recordingId, callId: item.callId },
        { jobId: `rec-${item.recordingId}` }
      );
    }

    return {
      enqueued: batch.length,
      processed: 0,
      failed: 0,
      remaining: Math.max(0, allPending.length - batch.length),
      mode: "queue",
    };
  });

  // Smartflo webhook receiver (default account, backward compatible)
  app.post("/api/v1/webhooks/smartflow", async (req, reply) => {
    if (env.SMARTFLOW_WEBHOOK_SECRET) {
      const provided = String(req.headers["x-webhook-secret"] ?? "");
      if (provided !== env.SMARTFLOW_WEBHOOK_SECRET) {
        throw new UnauthorizedError("Invalid webhook secret.");
      }
    }
    const tenant = await getOrCreateDefaultTenant();
    const { call } = parseSmartfloWebhook(req.body, tenant.timezone);
    const result = await upsertNormalizedCall(tenant.id, call);
    logger.info(
      { tenantId: tenant.id, callId: result.callId, externalId: call.externalId, isNew: result.isNew },
      "Smartflo webhook ingested"
    );
    return reply.status(200).send({ received: true, callId: result.callId });
  });

  // Smartflo webhook receiver for a specific account slug or UUID
  app.post("/api/v1/webhooks/smartflow/:account", async (req, reply) => {
    const { account } = z.object({ account: z.string().min(1) }).parse(req.params);
    const tenant = await getTenantByIdentifier(account);
    if (!tenant || !tenant.active) {
      throw new NotFoundError(`Smartflo account "${account}" not found or inactive.`);
    }
    const expectedSecret = getWebhookSecretForTenant(tenant);
    if (expectedSecret) {
      const provided = String(req.headers["x-webhook-secret"] ?? "");
      if (provided !== expectedSecret) {
        throw new UnauthorizedError("Invalid webhook secret.");
      }
    }
    const { call } = parseSmartfloWebhook(req.body, tenant.timezone);
    const result = await upsertNormalizedCall(tenant.id, call);
    logger.info(
      { tenantId: tenant.id, accountSlug: tenant.slug, callId: result.callId, externalId: call.externalId, isNew: result.isNew },
      "Smartflo account webhook ingested"
    );
    return reply.status(200).send({ received: true, accountSlug: tenant.slug, callId: result.callId });
  });

  // Authenticated Streamable HTTP MCP endpoint (stateless per-request, multi-account aware)
  app.post("/mcp", { preHandler: requireApiKey }, async (req, reply) => {
    const auth = getAuthContext(req);
    const mcpServer = createMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    reply.hijack();
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } finally {
      await transport.close();
      await mcpServer.close();
    }
  });

  return app;
}
