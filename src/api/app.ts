import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { askCallAnalytics } from "../services/ask-analytics.service.js";
import { recordToolAudit } from "../services/audit.service.js";
import { generateFullDailyReport } from "../services/report.service.js";
import { syncCallsWindow, upsertNormalizedCall } from "../services/sync.service.js";
import { getTodayYmd, validateDateRange } from "../utils/dates.js";
import { AppError, UnauthorizedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

async function requireApiKey(req: FastifyRequest, _reply: FastifyReply) {
  if (!env.MCP_API_KEY) return; // local dev without key set
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : String(req.headers["x-api-key"] ?? "");
  if (token !== env.MCP_API_KEY) {
    throw new UnauthorizedError("Invalid or missing API key.");
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
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(currentDir, "../ui/dashboard.html"),
      path.resolve(process.cwd(), "src/ui/dashboard.html"),
    ];
    const htmlPath = candidates.find((p) => fs.existsSync(p));
    if (!htmlPath) {
      return reply.status(404).send({ error: "Dashboard UI not found" });
    }
    const html = fs.readFileSync(htmlPath, "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  // Health & readiness
  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Sync status
  app.get("/api/v1/sync/status", { preHandler: requireApiKey }, async () => {
    const tenant = await getOrCreateDefaultTenant();
    const recent = await db
      .select()
      .from(syncLogs)
      .where(eq(syncLogs.tenantId, tenant.id))
      .orderBy(desc(syncLogs.startedAt))
      .limit(10);
    return { tenantId: tenant.id, recentSyncs: recent };
  });

  // Trigger bounded sync
  app.post("/api/v1/sync/calls", { preHandler: requireApiKey }, async (req) => {
    const body = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .parse(req.body);
    const range = validateDateRange(body.from, body.to, 31);
    return syncCallsWindow({ from: range.from, to: range.to, syncType: "manual" });
  });

  // Daily report (supports ?insights=true for full report with AI insights)
  app.get("/api/v1/reports/daily", { preHandler: requireApiKey }, async (req) => {
    const tenant = await getOrCreateDefaultTenant();
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
    const tenant = await getOrCreateDefaultTenant();
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
    const tenant = await getOrCreateDefaultTenant();
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
    const tenant = await getOrCreateDefaultTenant();
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
    const tenant = await getOrCreateDefaultTenant();
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        agentId: z.string().uuid().optional(),
        department: z.string().max(120).optional(),
        status: z.string().optional(),
        outcome: z.string().optional(),
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
      searchText: q.searchText,
      limit: q.limit,
    });
  });

  // Call detail
  app.get("/api/v1/calls/:id", { preHandler: requireApiKey }, async (req) => {
    const tenant = await getOrCreateDefaultTenant();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getCallDetails(tenant.id, id);
  });

  // Protected transcript (audit logged)
  app.get("/api/v1/calls/:id/transcript", { preHandler: requireApiKey }, async (req) => {
    const start = Date.now();
    const tenant = await getOrCreateDefaultTenant();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const transcript = await getCallTranscript(tenant.id, id);
    await recordToolAudit({
      tenantId: tenant.id,
      actor: "http-api",
      toolName: "GET /api/v1/calls/:id/transcript",
      parameters: { callId: id },
      outcome: "success",
      durationMs: Date.now() - start,
    });
    return transcript;
  });

  // Trigger transcription + analysis for a call
  app.post("/api/v1/calls/:id/analyze", { preHandler: requireApiKey }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await transcribeCallRecording(id);
    const analysis = await analyzeCallTranscript(id);
    return { status: "completed", analysisId: analysis.id };
  });

  // Natural-language analytics Q&A bot endpoint (audit logged)
  app.post("/api/v1/ask", { preHandler: requireApiKey }, async (req) => {
    const start = Date.now();
    const tenant = await getOrCreateDefaultTenant();
    const body = z
      .object({
        question: z.string().min(3).max(500),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        timezone: z.string().optional(),
      })
      .parse(req.body);

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
      actor: "dashboard-bot",
      toolName: "POST /api/v1/ask",
      parameters: { question: body.question, date: body.date },
      outcome: "success",
      durationMs: Date.now() - start,
    });

    return result;
  });

  // Safe provider metadata (never exposes secrets)
  app.get("/api/v1/providers", { preHandler: requireApiKey }, async () => {
    return getSafeProviderMetadata();
  });

  // Queue depths & health (observability)
  app.get("/api/v1/queues/status", { preHandler: requireApiKey }, async () => {
    const { syncQueue, recordingQueue, transcriptionQueue, analysisQueue } = createQueues();
    const [sync, recording, transcription, analysis] = await Promise.all([
      syncQueue.getJobCounts(),
      recordingQueue.getJobCounts(),
      transcriptionQueue.getJobCounts(),
      analysisQueue.getJobCounts(),
    ]);
    return { sync, recording, transcription, analysis };
  });

  // Enqueue pending answered calls for background worker processing
  app.post("/api/v1/queues/enqueue-pending", { preHandler: requireApiKey }, async (req) => {
    const tenant = await getOrCreateDefaultTenant();
    const body = z
      .object({ limit: z.number().int().min(1).max(200).default(50) })
      .parse(req.body ?? {});

    const { recordingQueue } = createQueues();
    const pending = await db
      .select({ recordingId: recordings.id, callId: calls.id })
      .from(calls)
      .innerJoin(recordings, eq(recordings.callId, calls.id))
      .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
      .where(and(eq(calls.tenantId, tenant.id), eq(calls.status, "answered"), isNull(callAnalyses.id)))
      .orderBy(desc(calls.startedAt))
      .limit(body.limit);

    for (const item of pending) {
      await recordingQueue.add(
        "process-recording",
        { recordingId: item.recordingId, callId: item.callId },
        { jobId: `rec-${item.recordingId}` }
      );
    }

    return { enqueued: pending.length };
  });

  // Smartflo webhook receiver (fast 200 OK; Smartflo retries only twice)
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
    logger.info({ callId: result.callId, externalId: call.externalId, isNew: result.isNew }, "Smartflo webhook ingested");
    return reply.status(200).send({ received: true, callId: result.callId });
  });

  // Authenticated Streamable HTTP MCP endpoint (stateless per-request)
  app.post("/mcp", { preHandler: requireApiKey }, async (req, reply) => {
    const mcpServer = createMcpServer("mcp-http");
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

