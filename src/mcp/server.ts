import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  comparePeriods,
  getAgentCoachingReport,
  getAgentPerformance,
  getCallAnalysis,
  getCallDetails,
  getCallsNeedingReview,
  getCallTranscript,
  getConversionFunnel,
  getDailyCallReport,
  getFollowups,
  getHotLeads,
  getLeadDetails,
  getObjectionReport,
  searchCalls,
} from "../analytics/analytics.service.js";
import { db, getOrCreateDefaultTenant } from "../db/client.js";
import { agents } from "../db/schema/index.js";
import { getSafeProviderMetadata } from "../providers/registry.js";
import { askCallAnalytics } from "../services/ask-analytics.service.js";
import { recordToolAudit } from "../services/audit.service.js";
import { generateFullDailyReport, getMissedOpportunities } from "../services/report.service.js";
import { getTodayYmd, validateDateRange } from "../utils/dates.js";

async function executeAuditedTool<T>(
  toolName: string,
  params: unknown,
  actor: string,
  fn: (tenantId: string) => Promise<T>
) {
  const start = Date.now();
  const tenant = await getOrCreateDefaultTenant();
  try {
    const result = await fn(tenant.id);
    await recordToolAudit({
      tenantId: tenant.id,
      actor,
      toolName,
      parameters: params,
      outcome: "success",
      durationMs: Date.now() - start,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    await recordToolAudit({
      tenantId: tenant.id,
      actor,
      toolName,
      parameters: params,
      outcome: "error",
      durationMs: Date.now() - start,
    });
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    };
  }
}

export function createMcpServer(actor = "mcp-client"): McpServer {
  const server = new McpServer({
    name: "smartflow-intelligence",
    version: "1.0.0",
  });

  // 1. Daily call report
  server.tool(
    "get_daily_call_report",
    "Daily call totals, connected/missed/failed counts, talk durations, unique leads, follow-ups, and data completeness percentage.",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD format"),
      timezone: z.string().default("Asia/Kolkata").describe("IANA timezone, default Asia/Kolkata"),
    },
    async (args) =>
      executeAuditedTool("get_daily_call_report", args, actor, (tenantId) =>
        getDailyCallReport({ tenantId, date: args.date, timezone: args.timezone })
      )
  );

  // 2. Search calls
  server.tool(
    "search_calls",
    "Search calls by date range, agent, status, AI outcome, or transcript keyword (phone numbers are masked).",
    {
      from: z.string().datetime({ offset: true }).describe("Start ISO-8601 timestamp with offset"),
      to: z.string().datetime({ offset: true }).describe("End ISO-8601 timestamp with offset"),
      agentId: z.string().uuid().optional(),
      status: z.enum(["answered", "missed", "failed", "other"]).optional(),
      outcome: z
        .enum([
          "interested",
          "not_interested",
          "callback_requested",
          "information_requested",
          "verbal_commitment",
          "not_connected",
          "unknown",
        ])
        .optional(),
      searchText: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("search_calls", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return searchCalls({
          tenantId,
          from: range.from,
          to: range.to,
          agentId: args.agentId,
          status: args.status,
          outcome: args.outcome,
          searchText: args.searchText,
          limit: args.limit,
        });
      })
  );

  // 3. Call details
  server.tool(
    "get_call_details",
    "Get metadata, recording status, transcript summary, and latest AI analysis for a single call.",
    { callId: z.string().uuid().describe("Internal call UUID") },
    async (args) =>
      executeAuditedTool("get_call_details", args, actor, (tenantId) =>
        getCallDetails(tenantId, args.callId)
      )
  );

  // 4. Call transcript (audited)
  server.tool(
    "get_call_transcript",
    "Retrieve the latest transcript for a specific call ID (access is audit-logged).",
    { callId: z.string().uuid().describe("Internal call UUID") },
    async (args) =>
      executeAuditedTool("get_call_transcript", args, actor, (tenantId) =>
        getCallTranscript(tenantId, args.callId)
      )
  );

  // 5. Call analysis
  server.tool(
    "get_call_analysis",
    "Retrieve the latest structured AI call analysis, rubric scores, objections, and evidence for a call.",
    { callId: z.string().uuid().describe("Internal call UUID") },
    async (args) =>
      executeAuditedTool("get_call_analysis", args, actor, (tenantId) =>
        getCallAnalysis(tenantId, args.callId)
      )
  );

  // 6. Hot leads
  server.tool(
    "get_hot_leads",
    "List high-priority or hot leads within a date range based on deterministic priority score and call signals.",
    {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      minScore: z.number().int().min(0).max(100).default(60),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_hot_leads", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getHotLeads({
          tenantId,
          from: range.from,
          to: range.to,
          minScore: args.minScore,
          limit: args.limit,
        });
      })
  );

  // 7. Pending follow-ups
  server.tool(
    "get_pending_followups",
    "List pending callback/follow-up commitments.",
    { limit: z.number().int().min(1).max(100).default(30) },
    async (args) =>
      executeAuditedTool("get_pending_followups", args, actor, (tenantId) =>
        getFollowups({ tenantId, mode: "pending", limit: args.limit })
      )
  );

  // 8. Overdue follow-ups
  server.tool(
    "get_overdue_followups",
    "List overdue callback/follow-up commitments whose due date has passed.",
    { limit: z.number().int().min(1).max(100).default(30) },
    async (args) =>
      executeAuditedTool("get_overdue_followups", args, actor, (tenantId) =>
        getFollowups({ tenantId, mode: "overdue", limit: args.limit })
      )
  );

  // 9. Agent performance
  server.tool(
    "get_agent_performance",
    "Deterministic SQL call metrics and advisory QA score averages per telecaller for a date range.",
    {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      agentId: z.string().uuid().optional(),
    },
    async (args) =>
      executeAuditedTool("get_agent_performance", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getAgentPerformance({
          tenantId,
          from: range.from,
          to: range.to,
          agentId: args.agentId,
        });
      })
  );

  // 10. Objection report
  server.tool(
    "get_objection_report",
    "Aggregate customer objection categories and sample evidence quotes within a date range.",
    {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_objection_report", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getObjectionReport({
          tenantId,
          from: range.from,
          to: range.to,
          limit: args.limit,
        });
      })
  );

  // 11. Conversion funnel
  server.tool(
    "get_conversion_funnel",
    "Cohort-based lead contact rate and stage counts (uses unique leads, never raw call attempts).",
    {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
    },
    async (args) =>
      executeAuditedTool("get_conversion_funnel", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getConversionFunnel({ tenantId, from: range.from, to: range.to });
      })
  );

  // 12. Agent coaching report
  server.tool(
    "get_agent_coaching_report",
    "Evidence-backed telecaller coaching report with repeated strengths, weaknesses, and low-sample warnings.",
    {
      agentId: z.string().uuid(),
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
    },
    async (args) =>
      executeAuditedTool("get_agent_coaching_report", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getAgentCoachingReport({
          tenantId,
          agentId: args.agentId,
          from: range.from,
          to: range.to,
        });
      })
  );

  // 13. Calls needing review
  server.tool(
    "get_calls_needing_review",
    "Find calls with low QA scores, negative sentiment, or low transcript quality for human QA review.",
    {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      maxQualityScore: z.number().int().min(0).max(100).default(60),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_calls_needing_review", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getCallsNeedingReview({
          tenantId,
          from: range.from,
          to: range.to,
          maxQualityScore: args.maxQualityScore,
          limit: args.limit,
        });
      })
  );

  // 14. Period comparison
  server.tool(
    "compare_periods",
    "Deterministic SQL period-over-period comparison for call volume, connection rate, unique leads, and talk duration.",
    {
      currentFrom: z.string().datetime({ offset: true }),
      currentTo: z.string().datetime({ offset: true }),
      previousFrom: z.string().datetime({ offset: true }),
      previousTo: z.string().datetime({ offset: true }),
    },
    async (args) =>
      executeAuditedTool("compare_periods", args, actor, (tenantId) => {
        const cur = validateDateRange(args.currentFrom, args.currentTo);
        const prev = validateDateRange(args.previousFrom, args.previousTo);
        return comparePeriods({
          tenantId,
          currentFrom: cur.from,
          currentTo: cur.to,
          previousFrom: prev.from,
          previousTo: prev.to,
        });
      })
  );

  // 15. Lead details
  server.tool(
    "get_lead_details",
    "Get lead profile (masked phone), stage, deterministic priority score, recent call history, and follow-ups.",
    { leadId: z.string().uuid() },
    async (args) =>
      executeAuditedTool("get_lead_details", args, actor, (tenantId) =>
        getLeadDetails(tenantId, args.leadId)
      )
  );

  // 16. Missed opportunities
  server.tool(
    "get_missed_opportunities",
    "Find high-intent or interested calls that have no scheduled follow-up, plus overdue callbacks.",
    {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_missed_opportunities", args, actor, (tenantId) => {
        const range = validateDateRange(args.from, args.to);
        return getMissedOpportunities({
          tenantId,
          from: range.from,
          to: range.to,
          limit: args.limit,
        });
      })
  );

  // 17. Full daily report with AI insights
  server.tool(
    "get_daily_ai_insights",
    "Complete daily operations report combining deterministic SQL metrics, agent performance, top objections, missed opportunities, and grounded AI executive insights.",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date YYYY-MM-DD"),
      timezone: z.string().default("Asia/Kolkata"),
    },
    async (args) =>
      executeAuditedTool("get_daily_ai_insights", args, actor, (tenantId) =>
        generateFullDailyReport({
          tenantId,
          date: args.date,
          timezone: args.timezone,
          includeAiInsights: true,
        })
      )
  );

  // 18. Natural-language analytics Q&A (approved SQL tools + grounded LLM breakdown)
  server.tool(
    "ask_call_analytics",
    "Ask any natural-language question about calls, agents, branches/departments, follow-ups, or objections. Executes approved deterministic SQL tools and returns a simple broken-down answer with caveats.",
    {
      question: z.string().min(3).max(500),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      timezone: z.string().default("Asia/Kolkata"),
    },
    async (args) =>
      executeAuditedTool("ask_call_analytics", args, actor, (tenantId) => {
        const range = args.from && args.to ? validateDateRange(args.from, args.to) : undefined;
        return askCallAnalytics({
          tenantId,
          question: args.question,
          date: args.date,
          from: range?.from,
          to: range?.to,
          timezone: args.timezone,
        });
      })
  );

  // Read-only MCP resources (no secrets, no broad transcripts)
  server.resource("today-report", "smartflow://reports/today", async (uri) => {
    const tenant = await getOrCreateDefaultTenant();
    const today = getTodayYmd(tenant.timezone);
    const report = await getDailyCallReport({
      tenantId: tenant.id,
      date: today,
      timezone: tenant.timezone,
    });
    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }],
    };
  });

  server.resource("agents-roster", "smartflow://agents", async (uri) => {
    const tenant = await getOrCreateDefaultTenant();
    const list = await db
      .select({
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        active: agents.active,
      })
      .from(agents)
      .where(eq(agents.tenantId, tenant.id));
    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(list, null, 2) }],
    };
  });

  server.resource("analytics-schema", "smartflow://analytics/schema", async (uri) => {
    const definitions = {
      connectionRate: "connected call attempts / total call attempts",
      leadContactRate: "unique contacted leads / unique attempted leads",
      talkDuration: "Smartflo answered_seconds (fallback to call_duration when answered)",
      actualConversion: "Verified CRM/business stage transitions only — never LLM conversionProbability",
      leadPriorityScore: "Deterministic rule-based 0-100 score (lead-score-v1), not a probability",
    };
    return {
      contents: [
        { uri: uri.href, mimeType: "application/json", text: JSON.stringify(definitions, null, 2) },
      ],
    };
  });

  server.resource("active-providers", "smartflow://settings/providers", async (uri) => {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(getSafeProviderMetadata(), null, 2),
        },
      ],
    };
  });

  return server;
}

