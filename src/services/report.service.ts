import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import {
  getAgentPerformance,
  getDailyCallReport,
  getFollowups,
  getObjectionReport,
} from "../analytics/analytics.service.js";
import { db } from "../db/client.js";
import { agents, callAnalyses, calls, followups, leads } from "../db/schema/index.js";
import { getActiveAnalysisProvider } from "../providers/registry.js";
import { getDayBoundsUtc } from "../utils/dates.js";
import { decryptSecret, maskPhone } from "../utils/pii.js";

function safeMask(enc?: string | null): string {
  if (!enc) return "Unknown";
  try {
    return maskPhone(decryptSecret(enc));
  } catch {
    return "****";
  }
}

export async function getMissedOpportunities(params: {
  tenantId: string;
  from: Date;
  to: Date;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

  // High-intent or interested calls without any scheduled follow-up
  const highIntentNoFollowup = await db
    .select({
      callId: calls.id,
      startedAt: calls.startedAt,
      agentName: agents.name,
      leadId: leads.id,
      leadPhoneEncrypted: leads.phoneEncrypted,
      intent: callAnalyses.intent,
      leadTemperature: callAnalyses.leadTemperature,
      callOutcome: callAnalyses.callOutcome,
      qualityScore: callAnalyses.qualityScore,
    })
    .from(calls)
    .innerJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(leads, eq(leads.id, calls.leadId))
    .leftJoin(followups, eq(followups.callId, calls.id))
    .where(
      and(
        eq(calls.tenantId, params.tenantId),
        gte(calls.startedAt, params.from),
        lt(calls.startedAt, params.to),
        isNull(followups.id),
        or(
          eq(callAnalyses.intent, "high"),
          eq(callAnalyses.leadTemperature, "hot"),
          eq(callAnalyses.callOutcome, "interested")
        )!
      )
    )
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  const overdue = await getFollowups({ tenantId: params.tenantId, mode: "overdue", limit });

  return {
    windowUtc: { from: params.from.toISOString(), to: params.to.toISOString() },
    highIntentWithoutFollowup: highIntentNoFollowup.map((r) => ({
      callId: r.callId,
      startedAt: r.startedAt.toISOString(),
      agentName: r.agentName ?? "Unknown",
      leadId: r.leadId,
      leadPhoneMasked: safeMask(r.leadPhoneEncrypted),
      intent: r.intent,
      leadTemperature: r.leadTemperature,
      callOutcome: r.callOutcome,
      qualityScore: r.qualityScore,
    })),
    overdueFollowups: overdue.followups,
  };
}

const DailyInsightsSchema = z.object({
  executiveSummary: z.string(),
  keyObservations: z.array(z.string()),
  priorityActions: z.array(
    z.object({
      action: z.string(),
      evidence: z.string(),
      ownerHint: z.string().nullable(),
    })
  ),
  caveats: z.array(z.string()),
});

export async function generateFullDailyReport(params: {
  tenantId: string;
  date: string;
  timezone?: string;
  includeAiInsights?: boolean;
}) {
  const timezone = params.timezone ?? "Asia/Kolkata";
  const { from, to } = getDayBoundsUtc(params.date, timezone);

  const [daily, agentPerf, objections, missedOpps] = await Promise.all([
    getDailyCallReport({ tenantId: params.tenantId, date: params.date, timezone }),
    getAgentPerformance({ tenantId: params.tenantId, from, to }),
    getObjectionReport({ tenantId: params.tenantId, from, to, limit: 10 }),
    getMissedOpportunities({ tenantId: params.tenantId, from, to, limit: 10 }),
  ]);

  let aiInsights: z.infer<typeof DailyInsightsSchema> | null = null;

  if (params.includeAiInsights) {
    try {
      const provider = getActiveAnalysisProvider();
      aiInsights = await provider.generateStructured({
        systemPrompt:
          "You are a call-center operations analyst. Interpret ONLY the provided deterministic SQL metrics and evidence. Never invent numbers, never claim unverified conversions, and always state data completeness caveats. Return valid JSON only.",
        userPrompt: `Generate concise daily insights as JSON with keys: executiveSummary (string), keyObservations (string[]), priorityActions (array of { action, evidence, ownerHint }), caveats (string[]).

DETERMINISTIC REPORT DATA:
${JSON.stringify({ daily, topAgents: agentPerf.agents.slice(0, 10), objections: objections.objections, missedOpportunitiesCount: missedOpps.highIntentWithoutFollowup.length, overdueCount: missedOpps.overdueFollowups.length })}`,
        schema: DailyInsightsSchema,
      });
    } catch {
      aiInsights = null;
    }
  }

  return {
    ...daily,
    telecallerPerformance: agentPerf.agents,
    topObjections: objections.objections,
    missedOpportunities: {
      highIntentWithoutFollowupCount: missedOpps.highIntentWithoutFollowup.length,
      overdueFollowupsCount: missedOpps.overdueFollowups.length,
      samples: missedOpps.highIntentWithoutFollowup.slice(0, 5),
    },
    aiInsights,
  };
}

