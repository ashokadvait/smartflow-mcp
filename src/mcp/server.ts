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
import { db } from "../db/client.js";
import { agents } from "../db/schema/index.js";
import { getSafeProviderMetadata } from "../providers/registry.js";
import {
  listAccessibleAccounts,
  resolveTenantForContext,
  type AuthContext,
  type TenantRow,
} from "../services/account.service.js";
import { askCallAnalytics } from "../services/ask-analytics.service.js";
import { recordToolAudit } from "../services/audit.service.js";
import { generateFullDailyReport, getMissedOpportunities } from "../services/report.service.js";
import { getTodayYmd, validateDateRange } from "../utils/dates.js";

const accountParam = z
  .string()
  .max(120)
  .optional()
  .describe(
    "Optional Smartflo account slug, name, or UUID. Admin keys can query any account; client-scoped keys are locked to their own account."
  );

function normalizeAuthContext(authOrActor: AuthContext | string): AuthContext {
  if (typeof authOrActor === "string") {
    return { role: "admin", actor: authOrActor };
  }
  return authOrActor;
}

async function executeAuditedTool<T>(
  toolName: string,
  params: unknown,
  auth: AuthContext,
  requestedAccount: string | undefined,
  fn: (tenant: TenantRow) => Promise<T>
) {
  const start = Date.now();
  let resolvedTenantId: string | undefined = auth.tenantId;
  try {
    const tenant = await resolveTenantForContext(auth, requestedAccount);
    resolvedTenantId = tenant.id;
    const result = await fn(tenant);
    await recordToolAudit({
      tenantId: tenant.id,
      actor: auth.actor,
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
      tenantId: resolvedTenantId,
      actor: auth.actor,
      toolName,
      parameters: params,
      outcome: "error",
      durationMs: Date.now() - start,
    }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    };
  }
}

export function createMcpServer(authOrActor: AuthContext | string = "mcp-client"): McpServer {
  const auth = normalizeAuthContext(authOrActor);

  const server = new McpServer({
    name: "smartflow-intelligence",
    version: "1.1.0",
  });

  // 0. List accessible Smartflo accounts
  server.tool(
    "list_accounts",
    "List Smartflo accounts accessible to this API key (use the returned slug or id in the `account` parameter of other tools).",
    {},
    async () => {
      const start = Date.now();
      try {
        const accounts = await listAccessibleAccounts(auth);
        await recordToolAudit({
          tenantId: auth.tenantId,
          actor: auth.actor,
          toolName: "list_accounts",
          parameters: {},
          outcome: "success",
          durationMs: Date.now() - start,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  accessScope: auth.role === "admin" ? "all_accounts" : "single_account",
                  count: accounts.length,
                  accounts: accounts.map((a) => ({
                    id: a.id,
                    slug: a.slug,
                    name: a.name,
                    timezone: a.timezone,
                    hasSmartfloCredentials: a.hasSmartfloCredentials,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        };
      }
    }
  );

  // 1. Daily call report
  server.tool(
    "get_daily_call_report",
    "Daily call totals, connected/missed/failed counts, talk durations, unique leads, follow-ups, and data completeness percentage.",
    {
      account: accountParam,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD format"),
      timezone: z.string().optional().describe("IANA timezone, defaults to account timezone"),
    },
    async (args) =>
      executeAuditedTool("get_daily_call_report", args, auth, args.account, (tenant) =>
        getDailyCallReport({
          tenantId: tenant.id,
          date: args.date,
          timezone: args.timezone ?? tenant.timezone,
        })
      )
  );

  // 2. Search calls
  server.tool(
    "search_calls",
    "Search calls by date range, agent, status, AI outcome, or transcript keyword (phone numbers are masked).",
    {
      account: accountParam,
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
      executeAuditedTool("search_calls", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return searchCalls({
          tenantId: tenant.id,
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
    {
      account: accountParam,
      callId: z.string().uuid().describe("Internal call UUID"),
    },
    async (args) =>
      executeAuditedTool("get_call_details", args, auth, args.account, (tenant) =>
        getCallDetails(tenant.id, args.callId)
      )
  );

  // 4. Call transcript (audited)
  server.tool(
    "get_call_transcript",
    "Retrieve the latest transcript for a specific call ID (access is audit-logged).",
    {
      account: accountParam,
      callId: z.string().uuid().describe("Internal call UUID"),
    },
    async (args) =>
      executeAuditedTool("get_call_transcript", args, auth, args.account, (tenant) =>
        getCallTranscript(tenant.id, args.callId)
      )
  );

  // 5. Call analysis
  server.tool(
    "get_call_analysis",
    "Retrieve the latest structured AI call analysis, rubric scores, objections, and evidence for a call.",
    {
      account: accountParam,
      callId: z.string().uuid().describe("Internal call UUID"),
    },
    async (args) =>
      executeAuditedTool("get_call_analysis", args, auth, args.account, (tenant) =>
        getCallAnalysis(tenant.id, args.callId)
      )
  );

  // 6. Hot leads
  server.tool(
    "get_hot_leads",
    "List high-priority or hot leads within a date range based on deterministic priority score and call signals.",
    {
      account: accountParam,
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      minScore: z.number().int().min(0).max(100).default(60),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_hot_leads", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getHotLeads({
          tenantId: tenant.id,
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
    {
      account: accountParam,
      limit: z.number().int().min(1).max(100).default(30),
    },
    async (args) =>
      executeAuditedTool("get_pending_followups", args, auth, args.account, (tenant) =>
        getFollowups({ tenantId: tenant.id, mode: "pending", limit: args.limit })
      )
  );

  // 8. Overdue follow-ups
  server.tool(
    "get_overdue_followups",
    "List overdue callback/follow-up commitments whose due date has passed.",
    {
      account: accountParam,
      limit: z.number().int().min(1).max(100).default(30),
    },
    async (args) =>
      executeAuditedTool("get_overdue_followups", args, auth, args.account, (tenant) =>
        getFollowups({ tenantId: tenant.id, mode: "overdue", limit: args.limit })
      )
  );

  // 9. Agent performance
  server.tool(
    "get_agent_performance",
    "Deterministic SQL call metrics and advisory QA score averages per telecaller for a date range.",
    {
      account: accountParam,
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      agentId: z.string().uuid().optional(),
    },
    async (args) =>
      executeAuditedTool("get_agent_performance", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getAgentPerformance({
          tenantId: tenant.id,
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
      account: accountParam,
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_objection_report", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getObjectionReport({
          tenantId: tenant.id,
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
      account: accountParam,
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
    },
    async (args) =>
      executeAuditedTool("get_conversion_funnel", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getConversionFunnel({ tenantId: tenant.id, from: range.from, to: range.to });
      })
  );

  // 12. Agent coaching report
  server.tool(
    "get_agent_coaching_report",
    "Evidence-backed telecaller coaching report with repeated strengths, weaknesses, and low-sample warnings.",
    {
      account: accountParam,
      agentId: z.string().uuid(),
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
    },
    async (args) =>
      executeAuditedTool("get_agent_coaching_report", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getAgentCoachingReport({
          tenantId: tenant.id,
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
      account: accountParam,
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      maxQualityScore: z.number().int().min(0).max(100).default(60),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_calls_needing_review", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getCallsNeedingReview({
          tenantId: tenant.id,
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
      account: accountParam,
      currentFrom: z.string().datetime({ offset: true }),
      currentTo: z.string().datetime({ offset: true }),
      previousFrom: z.string().datetime({ offset: true }),
      previousTo: z.string().datetime({ offset: true }),
    },
    async (args) =>
      executeAuditedTool("compare_periods", args, auth, args.account, (tenant) => {
        const cur = validateDateRange(args.currentFrom, args.currentTo);
        const prev = validateDateRange(args.previousFrom, args.previousTo);
        return comparePeriods({
          tenantId: tenant.id,
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
    {
      account: accountParam,
      leadId: z.string().uuid(),
    },
    async (args) =>
      executeAuditedTool("get_lead_details", args, auth, args.account, (tenant) =>
        getLeadDetails(tenant.id, args.leadId)
      )
  );

  // 16. Missed opportunities
  server.tool(
    "get_missed_opportunities",
    "Find high-intent or interested calls that have no scheduled follow-up, plus overdue callbacks.",
    {
      account: accountParam,
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async (args) =>
      executeAuditedTool("get_missed_opportunities", args, auth, args.account, (tenant) => {
        const range = validateDateRange(args.from, args.to);
        return getMissedOpportunities({
          tenantId: tenant.id,
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
      account: accountParam,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date YYYY-MM-DD"),
      timezone: z.string().optional(),
    },
    async (args) =>
      executeAuditedTool("get_daily_ai_insights", args, auth, args.account, (tenant) =>
        generateFullDailyReport({
          tenantId: tenant.id,
          date: args.date,
          timezone: args.timezone ?? tenant.timezone,
          includeAiInsights: true,
        })
      )
  );

  // 18. Natural-language analytics Q&A (approved SQL tools + grounded LLM breakdown)
  server.tool(
    "ask_call_analytics",
    "Ask any natural-language question about calls, agents, branches/departments, follow-ups, or objections. Executes approved deterministic SQL tools and returns a simple broken-down answer with caveats.",
    {
      account: accountParam,
      question: z.string().min(3).max(500),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      timezone: z.string().optional(),
    },
    async (args) =>
      executeAuditedTool("ask_call_analytics", args, auth, args.account, (tenant) => {
        const range = args.from && args.to ? validateDateRange(args.from, args.to) : undefined;
        return askCallAnalytics({
          tenantId: tenant.id,
          question: args.question,
          date: args.date,
          from: range?.from,
          to: range?.to,
          timezone: args.timezone ?? tenant.timezone,
        });
      })
  );

  // Read-only MCP resources (no secrets, no broad transcripts)
  server.resource("accessible-accounts", "smartflow://accounts", async (uri) => {
    const accounts = await listAccessibleAccounts(auth);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(accounts, null, 2),
        },
      ],
    };
  });

  server.resource("today-report", "smartflow://reports/today", async (uri) => {
    const tenant = await resolveTenantForContext(auth);
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
    const tenant = await resolveTenantForContext(auth);
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
