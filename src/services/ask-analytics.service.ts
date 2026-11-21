import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getAgentPerformance,
  getCallsNeedingReview,
  getConversionFunnel,
  getDailyCallReport,
  getFollowups,
  getHotLeads,
  getObjectionReport,
  searchCalls,
} from "../analytics/analytics.service.js";
import { db } from "../db/client.js";
import { calls } from "../db/schema/index.js";
import { getActiveAnalysisProvider } from "../providers/registry.js";
import { getDayBoundsUtc, getTodayYmd } from "../utils/dates.js";
import { getMissedOpportunities } from "./report.service.js";

const AskResponseSchema = z.object({
  headline: z.string(),
  answer: z.string(),
  keyPoints: z.array(z.string()),
  caveats: z.array(z.string()).default([]),
});

async function getDepartmentBreakdown(tenantId: string, from: Date, to: Date) {
  return db
    .select({
      department: sql<string>`coalesce(${calls.campaignId}, 'Unassigned')`,
      totalCalls: sql<number>`count(*)::int`,
      answeredCalls: sql<number>`count(*) filter (where ${calls.status} = 'answered')::int`,
      missedCalls: sql<number>`count(*) filter (where ${calls.status} = 'missed')::int`,
      uniqueLeads: sql<number>`count(distinct ${calls.leadId})::int`,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), gte(calls.startedAt, from), lt(calls.startedAt, to)))
    .groupBy(sql`coalesce(${calls.campaignId}, 'Unassigned')`)
    .orderBy(desc(sql`count(*)`))
    .limit(20);
}

function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m! - 1), d! + deltaDays));
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolve natural-language date references ("yesterday", "today", "last 7 days", "YYYY-MM-DD")
 * relative to the current date in the tenant timezone.
 */
export function resolveQuestionWindow(
  question: string,
  fallbackDateYmd: string,
  timezone: string
): { label: string; dateYmd: string; from: Date; to: Date; isMultiDay: boolean } {
  const q = question.toLowerCase();
  const todayYmd = getTodayYmd(timezone);

  // Explicit YYYY-MM-DD in question
  const explicit = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit?.[1]) {
    const bounds = getDayBoundsUtc(explicit[1], timezone);
    return { label: explicit[1], dateYmd: explicit[1], ...bounds, isMultiDay: false };
  }

  if (/\byesterday\b/.test(q)) {
    const yest = shiftYmd(todayYmd, -1);
    const bounds = getDayBoundsUtc(yest, timezone);
    return { label: `Yesterday (${yest})`, dateYmd: yest, ...bounds, isMultiDay: false };
  }

  if (/\btoday\b/.test(q)) {
    const bounds = getDayBoundsUtc(todayYmd, timezone);
    return { label: `Today (${todayYmd})`, dateYmd: todayYmd, ...bounds, isMultiDay: false };
  }

  const lastDaysMatch = q.match(/\b(?:last|past)\s+(\d{1,2})\s+days?\b/);
  if (lastDaysMatch?.[1]) {
    const n = Math.min(Math.max(Number(lastDaysMatch[1]), 1), 90);
    const startYmd = shiftYmd(todayYmd, -(n - 1));
    const from = getDayBoundsUtc(startYmd, timezone).from;
    const to = getDayBoundsUtc(todayYmd, timezone).to;
    return { label: `Last ${n} days (${startYmd} to ${todayYmd})`, dateYmd: todayYmd, from, to, isMultiDay: true };
  }

  if (/\bthis week\b|\bpast week\b|\blast week\b/.test(q)) {
    const startYmd = shiftYmd(todayYmd, -6);
    const from = getDayBoundsUtc(startYmd, timezone).from;
    const to = getDayBoundsUtc(todayYmd, timezone).to;
    return { label: `Last 7 days (${startYmd} to ${todayYmd})`, dateYmd: todayYmd, from, to, isMultiDay: true };
  }

  const bounds = getDayBoundsUtc(fallbackDateYmd, timezone);
  return { label: fallbackDateYmd, dateYmd: fallbackDateYmd, ...bounds, isMultiDay: false };
}

/**
 * Natural-language analytics assistant (Blueprint Section 13).
 * Strict safety: executes ONLY approved parameterized SQL analytics functions,
 * never LLM-generated SQL, then asks the LLM to explain the deterministic numbers simply.
 */
export async function askCallAnalytics(params: {
  tenantId: string;
  question: string;
  date?: string;
  from?: Date;
  to?: Date;
  timezone?: string;
}) {
  const timezone = params.timezone ?? "Asia/Kolkata";
  const fallbackDate = params.date ?? getTodayYmd(timezone);
  const resolved =
    params.from && params.to
      ? {
          label: `${params.from.toISOString()} to ${params.to.toISOString()}`,
          dateYmd: fallbackDate,
          from: params.from,
          to: params.to,
          isMultiDay: true,
        }
      : resolveQuestionWindow(params.question, fallbackDate, timezone);

  const dateYmd = resolved.dateYmd;
  const range = { from: resolved.from, to: resolved.to };

  const q = params.question.toLowerCase();
  const toolsUsed: string[] = [];
  const contextData: Record<string, unknown> = {};

  // Always include deterministic daily/period call summary + department breakdown
  const [daily, departments] = await Promise.all([
    getDailyCallReport({ tenantId: params.tenantId, date: dateYmd, timezone }),
    getDepartmentBreakdown(params.tenantId, range.from, range.to),
  ]);
  toolsUsed.push("get_daily_call_report", "department_breakdown");
  contextData.dailySummary = daily;
  contextData.departments = departments;

  // Select additional approved SQL functions based on question intent
  const tasks: Array<Promise<void>> = [];

  if (/agent|telecaller|who|top|best|worst|team|staff|rep|coach|qa|score|perform/i.test(q)) {
    toolsUsed.push("get_agent_performance");
    tasks.push(
      getAgentPerformance({ tenantId: params.tenantId, from: range.from, to: range.to }).then((res) => {
        contextData.agentPerformance = res;
      })
    );
  }

  if (/follow|callback|overdue|pending|missed opp|unfollowed/i.test(q)) {
    toolsUsed.push("get_pending_followups", "get_missed_opportunities");
    tasks.push(
      getFollowups({ tenantId: params.tenantId, mode: "pending", limit: 20 }).then((res) => {
        contextData.pendingFollowups = res;
      }),
      getMissedOpportunities({ tenantId: params.tenantId, from: range.from, to: range.to, limit: 15 }).then(
        (res) => {
          contextData.missedOpportunities = res;
        }
      )
    );
  }

  if (/hot|lead|interest|priority|funnel|conver/i.test(q)) {
    toolsUsed.push("get_hot_leads", "get_conversion_funnel");
    tasks.push(
      getHotLeads({ tenantId: params.tenantId, from: range.from, to: range.to, minScore: 50, limit: 15 }).then(
        (res) => {
          contextData.hotLeads = res;
        }
      ),
      getConversionFunnel({ tenantId: params.tenantId, from: range.from, to: range.to }).then((res) => {
        contextData.conversionFunnel = res;
      })
    );
  }

  if (/objection|price|cost|why|drop|complaint|reject|issue|problem/i.test(q)) {
    toolsUsed.push("get_objection_report", "get_calls_needing_review");
    tasks.push(
      getObjectionReport({ tenantId: params.tenantId, from: range.from, to: range.to, limit: 15 }).then((res) => {
        contextData.objections = res;
      }),
      getCallsNeedingReview({ tenantId: params.tenantId, from: range.from, to: range.to, limit: 10 }).then(
        (res) => {
          contextData.callsNeedingReview = res;
        }
      )
    );
  }

  // If no specialized keyword matched, include agent performance + recent calls for a helpful general breakdown
  if (tasks.length === 0) {
    toolsUsed.push("get_agent_performance", "search_calls");
    tasks.push(
      getAgentPerformance({ tenantId: params.tenantId, from: range.from, to: range.to }).then((res) => {
        contextData.agentPerformance = res;
      }),
      searchCalls({ tenantId: params.tenantId, from: range.from, to: range.to, limit: 15 }).then((res) => {
        contextData.recentCalls = res.calls;
      })
    );
  }

  await Promise.all(tasks);

  const provider = getActiveAnalysisProvider();
  const synthesized = await provider.generateStructured({
    systemPrompt: `You are SmartFlow Intelligence Assistant. Answer the user's question clearly and simply in plain business English using ONLY the verified deterministic SQL data provided.
RULES:
1. Never invent numbers, names, or facts not present in the JSON data.
2. Never mention internal JSON keys or field paths (like "dailySummary.callActivity.totalCalls"). Write naturally for a business user.
3. Break the answer down into a short headline, a plain-English answer mentioning the exact IST date/period queried, and 3-5 concise bullet keyPoints.
4. Never treat LLM conversionProbability or "interested" as actual CRM sales conversion.
5. If analysisCompletenessPct < 100 and the question relies on AI analysis (outcomes, QA scores, objections, follow-ups), explicitly mention the completeness % in caveats. If totalCalls is 0, mention that no calls are synced in that window (do not claim "100% reliable").
6. Return ONLY valid JSON with keys: headline (string), answer (string), keyPoints (string[]), caveats (string[]).`,
    userPrompt: `USER QUESTION: ${params.question}
RESOLVED PERIOD (${timezone}): ${resolved.label}

VERIFIED SQL ANALYTICS DATA:
${JSON.stringify(contextData)}`,
    schema: AskResponseSchema,
  });

  return {
    question: params.question,
    date: dateYmd,
    resolvedPeriod: resolved.label,
    timezone,
    toolsUsed,
    completenessPct: daily.completeness.analysisCompletenessPct,
    ...synthesized,
  };
}

