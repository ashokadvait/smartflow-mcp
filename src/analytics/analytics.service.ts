import { and, desc, eq, gte, ilike, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agents,
  callAnalyses,
  calls,
  followups,
  leads,
  recordings,
  syncLogs,
  transcripts,
} from "../db/schema/index.js";
import { getDayBoundsUtc } from "../utils/dates.js";
import { NotFoundError } from "../utils/errors.js";
import { decryptSecret, maskPhone } from "../utils/pii.js";

function safeMaskEncryptedPhone(enc?: string | null): string {
  if (!enc) return "Unknown";
  try {
    return maskPhone(decryptSecret(enc));
  } catch {
    return "****";
  }
}

export async function getDailyCallReport(params: {
  tenantId: string;
  date: string;
  timezone?: string;
}) {
  const timezone = params.timezone ?? "Asia/Kolkata";
  const { from, to } = getDayBoundsUtc(params.date, timezone);

  const [callStats] = await db
    .select({
      totalCalls: sql<number>`count(*)::int`,
      answeredCalls: sql<number>`count(*) filter (where ${calls.status} = 'answered')::int`,
      missedCalls: sql<number>`count(*) filter (where ${calls.status} = 'missed')::int`,
      failedCalls: sql<number>`count(*) filter (where ${calls.status} = 'failed')::int`,
      otherCalls: sql<number>`count(*) filter (where ${calls.status} not in ('answered', 'missed', 'failed'))::int`,
      uniqueLeads: sql<number>`count(distinct ${calls.leadId})::int`,
      avgTalkDurationSeconds: sql<number>`coalesce(round(avg(coalesce(${calls.answeredSeconds}, ${calls.durationSeconds})) filter (where ${calls.status} = 'answered')), 0)::int`,
      totalTalkDurationSeconds: sql<number>`coalesce(sum(coalesce(${calls.answeredSeconds}, ${calls.durationSeconds})) filter (where ${calls.status} = 'answered'), 0)::int`,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, from), lt(calls.startedAt, to)));

  const [coverage] = await db
    .select({
      answeredWithRecording: sql<number>`count(distinct ${recordings.callId})::int`,
      answeredWithTranscript: sql<number>`count(distinct ${transcripts.callId})::int`,
      answeredWithAnalysis: sql<number>`count(distinct ${callAnalyses.callId})::int`,
    })
    .from(calls)
    .leftJoin(recordings, eq(recordings.callId, calls.id))
    .leftJoin(transcripts, eq(transcripts.callId, calls.id))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(
      and(
        eq(calls.tenantId, params.tenantId),
        eq(calls.status, "answered"),
        gte(calls.startedAt, from),
        lt(calls.startedAt, to)
      )
    );

  const [followupCounts] = await db
    .select({
      pendingFollowups: sql<number>`count(*) filter (where ${followups.status} = 'pending')::int`,
      overdueFollowups: sql<number>`count(*) filter (where ${followups.status} = 'pending' and ${followups.dueAt} < now())::int`,
    })
    .from(followups)
    .where(eq(followups.tenantId, params.tenantId));

  const [leadInsights] = await db
    .select({
      interestedCalls: sql<number>`count(*) filter (where ${callAnalyses.callOutcome} in ('interested', 'verbal_commitment', 'callback_requested'))::int`,
      hotLeadsCalls: sql<number>`count(*) filter (where ${callAnalyses.leadTemperature} = 'hot')::int`,
    })
    .from(callAnalyses)
    .innerJoin(calls, eq(calls.id, callAnalyses.callId))
    .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, from), lt(calls.startedAt, to)));

  const outcomeRows = await db
    .select({
      outcome: callAnalyses.callOutcome,
      count: sql<number>`count(distinct ${callAnalyses.callId})::int`,
    })
    .from(callAnalyses)
    .innerJoin(calls, eq(calls.id, callAnalyses.callId))
    .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, from), lt(calls.startedAt, to)))
    .groupBy(callAnalyses.callOutcome)
    .orderBy(desc(sql`count(distinct ${callAnalyses.callId})`));

  const [lastSync] = await db
    .select({
      status: syncLogs.status,
      finishedAt: syncLogs.finishedAt,
    })
    .from(syncLogs)
    .where(eq(syncLogs.tenantId, params.tenantId))
    .orderBy(desc(syncLogs.startedAt))
    .limit(1);

  const totalAnswered = callStats?.answeredCalls ?? 0;
  const analyzedCount = coverage?.answeredWithAnalysis ?? 0;
  const analysisCompletenessPct =
    totalAnswered === 0 ? 100 : Math.round((analyzedCount / totalAnswered) * 100);

  return {
    reportDate: params.date,
    timezone,
    windowUtc: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: new Date().toISOString(),
    completeness: {
      answeredCalls: totalAnswered,
      withRecording: coverage?.answeredWithRecording ?? 0,
      withTranscript: coverage?.answeredWithTranscript ?? 0,
      withAnalysis: analyzedCount,
      analysisCompletenessPct,
      isComplete: analysisCompletenessPct === 100,
      lastSyncStatus: lastSync?.status ?? "never_synced",
      lastSyncAt: lastSync?.finishedAt?.toISOString() ?? null,
    },
    callActivity: {
      totalCalls: callStats?.totalCalls ?? 0,
      answeredCalls: totalAnswered,
      missedCalls: callStats?.missedCalls ?? 0,
      failedCalls: callStats?.failedCalls ?? 0,
      otherCalls: callStats?.otherCalls ?? 0,
      connectionRatePct:
        callStats && callStats.totalCalls > 0
          ? Math.round((totalAnswered / callStats.totalCalls) * 1000) / 10
          : 0,
      uniqueLeads: callStats?.uniqueLeads ?? 0,
      avgTalkDurationSeconds: callStats?.avgTalkDurationSeconds ?? 0,
      totalTalkDurationSeconds: callStats?.totalTalkDurationSeconds ?? 0,
    },
    leadSignals: {
      interestedCalls: leadInsights?.interestedCalls ?? 0,
      hotLeadCalls: leadInsights?.hotLeadsCalls ?? 0,
      pendingFollowups: followupCounts?.pendingFollowups ?? 0,
      overdueFollowups: followupCounts?.overdueFollowups ?? 0,
      note: "Actual conversions must be verified from authoritative CRM/business stage data.",
    },
    outcomeBreakdown: outcomeRows,
  };
}

export async function getAgentPerformance(params: {
  tenantId: string;
  from: Date;
  to: Date;
  agentId?: string;
}) {
  const rows = await db
    .select({
      agentId: agents.id,
      externalId: agents.externalId,
      name: agents.name,
      active: agents.active,
      totalCalls: sql<number>`count(${calls.id})::int`,
      connectedCalls: sql<number>`count(${calls.id}) filter (where ${calls.status} = 'answered')::int`,
      missedCalls: sql<number>`count(${calls.id}) filter (where ${calls.status} = 'missed')::int`,
      uniqueLeads: sql<number>`count(distinct ${calls.leadId})::int`,
      avgTalkDurationSeconds: sql<number>`coalesce(round(avg(coalesce(${calls.answeredSeconds}, ${calls.durationSeconds})) filter (where ${calls.status} = 'answered')), 0)::int`,
      analyzedCalls: sql<number>`count(${callAnalyses.id})::int`,
      avgQualityScore: sql<number | null>`round(avg(${callAnalyses.qualityScore}))::int`,
    })
    .from(agents)
    .leftJoin(
      calls,
      and(eq(calls.agentId, agents.id), gte(calls.startedAt, params.from), lt(calls.startedAt, params.to))
    )
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(
      params.agentId
        ? and(eq(agents.tenantId, params.tenantId), eq(agents.id, params.agentId))
        : eq(agents.tenantId, params.tenantId)
    )
    .groupBy(agents.id, agents.externalId, agents.name, agents.active)
    .orderBy(desc(sql`count(${calls.id})`));

  return {
    windowUtc: { from: params.from.toISOString(), to: params.to.toISOString() },
    caveat:
      "QA scores are advisory only and depend on analyzed call sample size. Compare agents within similar campaigns and lead mixes.",
    agents: rows.map((r) => ({
      ...r,
      connectionRatePct: r.totalCalls > 0 ? Math.round((r.connectedCalls / r.totalCalls) * 1000) / 10 : 0,
      lowSampleWarning: r.analyzedCalls < 5,
    })),
  };
}

export async function searchCalls(params: {
  tenantId: string;
  from: Date;
  to: Date;
  agentId?: string;
  department?: string;
  status?: string;
  outcome?: string;
  hasFollowup?: boolean;
  searchText?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const conditions = [
    eq(calls.tenantId, params.tenantId),
    gte(calls.startedAt, params.from),
    lt(calls.startedAt, params.to),
  ];

  if (params.agentId) conditions.push(eq(calls.agentId, params.agentId));
  if (params.department) {
    if (params.department === "__unassigned__") {
      conditions.push(isNull(calls.campaignId));
    } else {
      conditions.push(eq(calls.campaignId, params.department));
    }
  }
  if (params.status) conditions.push(eq(calls.status, params.status));
  if (params.outcome) conditions.push(eq(callAnalyses.callOutcome, params.outcome));
  if (params.hasFollowup) {
    conditions.push(
      sql`exists (select 1 from ${followups} f where f.call_id = ${calls.id} and f.status = 'pending')`
    );
  }
  if (params.searchText) {
    const pattern = `%${params.searchText}%`;
    conditions.push(or(ilike(transcripts.content, pattern), ilike(calls.disposition, pattern))!);
  }

  const rows = await db
    .select({
      callId: calls.id,
      externalId: calls.externalId,
      startedAt: calls.startedAt,
      status: calls.status,
      direction: calls.direction,
      durationSeconds: calls.durationSeconds,
      answeredSeconds: calls.answeredSeconds,
      disposition: calls.disposition,
      department: calls.campaignId,
      agentName: agents.name,
      leadName: leads.name,
      leadPhoneEncrypted: leads.phoneEncrypted,
      leadStage: leads.currentStage,
      callOutcome: callAnalyses.callOutcome,
      leadTemperature: callAnalyses.leadTemperature,
      qualityScore: callAnalyses.qualityScore,
    })
    .from(calls)
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(leads, eq(leads.id, calls.leadId))
    .leftJoin(transcripts, eq(transcripts.callId, calls.id))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(and(...conditions))
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  return {
    count: rows.length,
    limit,
    calls: rows.map((r) => ({
      callId: r.callId,
      externalId: r.externalId,
      startedAt: r.startedAt.toISOString(),
      status: r.status,
      direction: r.direction,
      durationSeconds: r.durationSeconds,
      answeredSeconds: r.answeredSeconds,
      disposition: r.disposition,
      department: r.department ?? null,
      agentName: r.agentName ?? "Unknown",
      leadName: r.leadName ?? null,
      leadPhoneMasked: safeMaskEncryptedPhone(r.leadPhoneEncrypted),
      leadStage: r.leadStage ?? "unknown",
      callOutcome: r.callOutcome ?? null,
      leadTemperature: r.leadTemperature ?? null,
      qualityScore: r.qualityScore ?? null,
    })),
  };
}

export async function getDepartments(params: { tenantId: string; from: Date; to: Date }) {
  const rows = await db
    .select({
      department: sql<string>`coalesce(${calls.campaignId}, '__unassigned__')`,
      callCount: sql<number>`count(*)::int`,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, params.from), lt(calls.startedAt, params.to)))
    .groupBy(sql`coalesce(${calls.campaignId}, '__unassigned__')`)
    .orderBy(desc(sql`count(*)`));

  return {
    departments: rows.map((r) => ({
      value: r.department,
      label: r.department === "__unassigned__" ? "Unassigned" : r.department,
      callCount: r.callCount,
    })),
  };
}

export async function getCallDetails(tenantId: string, callId: string) {
  const [row] = await db
    .select({
      call: calls,
      agentName: agents.name,
      leadStage: leads.currentStage,
      leadPriorityScore: leads.priorityScore,
      leadPhoneEncrypted: leads.phoneEncrypted,
    })
    .from(calls)
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(leads, eq(leads.id, calls.leadId))
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId)))
    .limit(1);

  if (!row) {
    throw new NotFoundError(`Call ${callId} not found.`);
  }

  const [latestRec] = await db
    .select({
      id: recordings.id,
      status: recordings.status,
      mimeType: recordings.mimeType,
      sizeBytes: recordings.sizeBytes,
    })
    .from(recordings)
    .where(eq(recordings.callId, callId))
    .orderBy(desc(recordings.createdAt))
    .limit(1);

  const [latestTranscript] = await db
    .select({
      id: transcripts.id,
      provider: transcripts.provider,
      model: transcripts.model,
      language: transcripts.language,
      qualityFlag: transcripts.qualityFlag,
      createdAt: transcripts.createdAt,
    })
    .from(transcripts)
    .where(eq(transcripts.callId, callId))
    .orderBy(desc(transcripts.createdAt))
    .limit(1);

  const [latestAnalysis] = await db
    .select()
    .from(callAnalyses)
    .where(eq(callAnalyses.callId, callId))
    .orderBy(desc(callAnalyses.createdAt))
    .limit(1);

  return {
    call: {
      id: row.call.id,
      externalId: row.call.externalId,
      status: row.call.status,
      direction: row.call.direction,
      startedAt: row.call.startedAt.toISOString(),
      endedAt: row.call.endedAt?.toISOString() ?? null,
      durationSeconds: row.call.durationSeconds,
      answeredSeconds: row.call.answeredSeconds,
      disposition: row.call.disposition,
      hangupCause: row.call.hangupCause,
      agentName: row.agentName ?? "Unknown",
      leadPhoneMasked: safeMaskEncryptedPhone(row.leadPhoneEncrypted),
      leadStage: row.leadStage ?? "unknown",
      leadPriorityScore: row.leadPriorityScore ?? null,
    },
    recording: latestRec ?? null,
    transcriptMetadata: latestTranscript ?? null,
    latestAnalysis: latestAnalysis ?? null,
  };
}

export async function getCallTranscript(tenantId: string, callId: string) {
  const [call] = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId)))
    .limit(1);

  if (!call) {
    throw new NotFoundError(`Call ${callId} not found.`);
  }

  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.callId, callId))
    .orderBy(desc(transcripts.createdAt))
    .limit(1);

  if (!transcript) {
    throw new NotFoundError(`Transcript for call ${callId} not found.`);
  }

  return transcript;
}

export async function getCallAnalysis(tenantId: string, callId: string) {
  const [call] = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId)))
    .limit(1);

  if (!call) {
    throw new NotFoundError(`Call ${callId} not found.`);
  }

  const [analysis] = await db
    .select()
    .from(callAnalyses)
    .where(eq(callAnalyses.callId, callId))
    .orderBy(desc(callAnalyses.createdAt))
    .limit(1);

  if (!analysis) {
    throw new NotFoundError(`Analysis for call ${callId} not found.`);
  }

  return analysis;
}

export async function getHotLeads(params: {
  tenantId: string;
  from: Date;
  to: Date;
  minScore?: number;
  limit?: number;
}) {
  const minScore = params.minScore ?? 60;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

  const rows = await db
    .select({
      leadId: leads.id,
      externalId: leads.externalId,
      name: leads.name,
      phoneEncrypted: leads.phoneEncrypted,
      currentStage: leads.currentStage,
      priorityScore: leads.priorityScore,
      priorityScoreVersion: leads.priorityScoreVersion,
      callId: calls.id,
      callStartedAt: calls.startedAt,
      leadTemperature: callAnalyses.leadTemperature,
      callOutcome: callAnalyses.callOutcome,
      intent: callAnalyses.intent,
    })
    .from(leads)
    .innerJoin(calls, eq(calls.leadId, leads.id))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(
      and(
        eq(leads.tenantId, params.tenantId),
        gte(calls.startedAt, params.from),
        lt(calls.startedAt, params.to),
        or(gte(leads.priorityScore, minScore), eq(callAnalyses.leadTemperature, "hot"))!
      )
    )
    .orderBy(desc(leads.priorityScore), desc(calls.startedAt))
    .limit(limit);

  return {
    minScore,
    count: rows.length,
    leads: rows.map((r) => ({
      leadId: r.leadId,
      externalId: r.externalId,
      name: r.name ?? "Unknown",
      phoneMasked: safeMaskEncryptedPhone(r.phoneEncrypted),
      currentStage: r.currentStage,
      priorityScore: r.priorityScore,
      priorityScoreVersion: r.priorityScoreVersion,
      latestCallId: r.callId,
      callStartedAt: r.callStartedAt.toISOString(),
      leadTemperature: r.leadTemperature,
      callOutcome: r.callOutcome,
      intent: r.intent,
    })),
  };
}

export async function getFollowups(params: {
  tenantId: string;
  mode: "pending" | "overdue";
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
  const now = new Date();
  const conditions = [eq(followups.tenantId, params.tenantId), eq(followups.status, "pending")];
  if (params.mode === "overdue") {
    conditions.push(lte(followups.dueAt, now));
  }

  const rows = await db
    .select({
      followupId: followups.id,
      leadId: followups.leadId,
      callId: followups.callId,
      dueAt: followups.dueAt,
      reason: followups.reason,
      action: followups.action,
      status: followups.status,
      leadName: leads.name,
      leadPhoneEncrypted: leads.phoneEncrypted,
    })
    .from(followups)
    .leftJoin(leads, eq(leads.id, followups.leadId))
    .where(and(...conditions))
    .orderBy(followups.dueAt)
    .limit(limit);

  return {
    mode: params.mode,
    count: rows.length,
    followups: rows.map((r) => ({
      followupId: r.followupId,
      leadId: r.leadId,
      callId: r.callId,
      dueAt: r.dueAt?.toISOString() ?? null,
      reason: r.reason,
      action: r.action,
      status: r.status,
      leadName: r.leadName ?? "Unknown",
      leadPhoneMasked: safeMaskEncryptedPhone(r.leadPhoneEncrypted),
    })),
  };
}

export async function getObjectionReport(params: {
  tenantId: string;
  from: Date;
  to: Date;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const rows = await db
    .select({
      callId: callAnalyses.callId,
      analysisJson: callAnalyses.analysisJson,
    })
    .from(callAnalyses)
    .innerJoin(calls, eq(calls.id, callAnalyses.callId))
    .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, params.from), lt(calls.startedAt, params.to)));

  const byCategory = new Map<string, { count: number; examples: Array<{ callId: string; evidence: string }> }>();

  for (const row of rows) {
    const objections = (row.analysisJson as { objections?: Array<{ category?: string; evidence?: string }> })?.objections;
    if (!Array.isArray(objections)) continue;
    for (const obj of objections) {
      const cat = (obj.category ?? "uncategorized").trim().toLowerCase();
      const entry = byCategory.get(cat) ?? { count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 3 && obj.evidence) {
        entry.examples.push({ callId: row.callId, evidence: obj.evidence });
      }
      byCategory.set(cat, entry);
    }
  }

  const sorted = [...byCategory.entries()]
    .map(([category, data]) => ({ category, count: data.count, sampleEvidence: data.examples }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return {
    windowUtc: { from: params.from.toISOString(), to: params.to.toISOString() },
    analyzedCallsChecked: rows.length,
    objections: sorted,
  };
}

export async function getConversionFunnel(params: {
  tenantId: string;
  from: Date;
  to: Date;
}) {
  const stageRows = await db
    .select({
      stage: leads.currentStage,
      leadCount: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(and(eq(leads.tenantId, params.tenantId), gte(leads.createdAt, params.from), lt(leads.createdAt, params.to)))
    .groupBy(leads.currentStage)
    .orderBy(desc(sql`count(*)`));

  const [leadReach] = await db
    .select({
      attemptedUniqueLeads: sql<number>`count(distinct ${calls.leadId})::int`,
      connectedUniqueLeads: sql<number>`count(distinct ${calls.leadId}) filter (where ${calls.status} = 'answered')::int`,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, params.from), lt(calls.startedAt, params.to)));

  return {
    windowUtc: { from: params.from.toISOString(), to: params.to.toISOString() },
    cohortNote:
      "Lead contact rate uses unique leads (never raw call attempts) as denominator. Verified conversions come from authoritative CRM/business stage transitions.",
    leadReach: {
      attemptedUniqueLeads: leadReach?.attemptedUniqueLeads ?? 0,
      connectedUniqueLeads: leadReach?.connectedUniqueLeads ?? 0,
      leadContactRatePct:
        leadReach && leadReach.attemptedUniqueLeads > 0
          ? Math.round((leadReach.connectedUniqueLeads / leadReach.attemptedUniqueLeads) * 1000) / 10
          : 0,
    },
    stages: stageRows,
  };
}

export async function getAgentCoachingReport(params: {
  tenantId: string;
  agentId: string;
  from: Date;
  to: Date;
}) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.tenantId, params.tenantId), eq(agents.id, params.agentId)))
    .limit(1);

  if (!agent) {
    throw new NotFoundError(`Agent ${params.agentId} not found.`);
  }

  const rows = await db
    .select({
      callId: calls.id,
      startedAt: calls.startedAt,
      qualityScore: callAnalyses.qualityScore,
      analysisJson: callAnalyses.analysisJson,
    })
    .from(callAnalyses)
    .innerJoin(calls, eq(calls.id, callAnalyses.callId))
    .where(
      and(
        eq(calls.tenantId, params.tenantId),
        eq(calls.agentId, params.agentId),
        gte(calls.startedAt, params.from),
        lt(calls.startedAt, params.to)
      )
    )
    .orderBy(desc(calls.startedAt))
    .limit(50);

  const strengthCounts = new Map<string, number>();
  const weaknessCounts = new Map<string, number>();
  let scoreSum = 0;

  for (const r of rows) {
    scoreSum += r.qualityScore;
    const evalObj = (r.analysisJson as { agentEvaluation?: { strengths?: string[]; weaknesses?: string[] } })
      ?.agentEvaluation;
    for (const s of evalObj?.strengths ?? []) {
      const key = s.trim();
      if (key) strengthCounts.set(key, (strengthCounts.get(key) ?? 0) + 1);
    }
    for (const w of evalObj?.weaknesses ?? []) {
      const key = w.trim();
      if (key) weaknessCounts.set(key, (weaknessCounts.get(key) ?? 0) + 1);
    }
  }

  const topStrengths = [...strengthCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => ({ text, count }));
  const topWeaknesses = [...weaknessCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => ({ text, count }));

  return {
    agent: { id: agent.id, name: agent.name, active: agent.active },
    windowUtc: { from: params.from.toISOString(), to: params.to.toISOString() },
    analyzedCallsCount: rows.length,
    lowSampleWarning: rows.length < 5,
    avgQualityScore: rows.length > 0 ? Math.round(scoreSum / rows.length) : null,
    repeatedStrengths: topStrengths,
    coachingOpportunities: topWeaknesses,
    sampleCalls: rows.slice(0, 5).map((r) => ({
      callId: r.callId,
      startedAt: r.startedAt.toISOString(),
      qualityScore: r.qualityScore,
    })),
    fairnessNote:
      "Advisory coaching report based on observable transcript behavior only. Do not use AI scores alone for employment decisions.",
  };
}

export async function getCallsNeedingReview(params: {
  tenantId: string;
  from: Date;
  to: Date;
  maxQualityScore?: number;
  limit?: number;
}) {
  const maxScore = params.maxQualityScore ?? 60;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

  const rows = await db
    .select({
      callId: calls.id,
      startedAt: calls.startedAt,
      agentName: agents.name,
      answeredSeconds: calls.answeredSeconds,
      qualityScore: callAnalyses.qualityScore,
      sentiment: callAnalyses.sentiment,
      callOutcome: callAnalyses.callOutcome,
      transcriptQuality: transcripts.qualityFlag,
    })
    .from(calls)
    .innerJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(transcripts, eq(transcripts.id, callAnalyses.transcriptId))
    .where(
      and(
        eq(calls.tenantId, params.tenantId),
        gte(calls.startedAt, params.from),
        lt(calls.startedAt, params.to),
        or(
          lte(callAnalyses.qualityScore, maxScore),
          eq(callAnalyses.sentiment, "negative"),
          eq(transcripts.qualityFlag, "low_quality")
        )!
      )
    )
    .orderBy(callAnalyses.qualityScore, desc(calls.startedAt))
    .limit(limit);

  return {
    windowUtc: { from: params.from.toISOString(), to: params.to.toISOString() },
    maxQualityScore: maxScore,
    count: rows.length,
    calls: rows.map((r) => ({
      ...r,
      agentName: r.agentName ?? "Unknown",
      startedAt: r.startedAt.toISOString(),
    })),
  };
}

export async function comparePeriods(params: {
  tenantId: string;
  currentFrom: Date;
  currentTo: Date;
  previousFrom: Date;
  previousTo: Date;
}) {
  const summarize = async (from: Date, to: Date) => {
    const [row] = await db
      .select({
        totalCalls: sql<number>`count(*)::int`,
        answeredCalls: sql<number>`count(*) filter (where ${calls.status} = 'answered')::int`,
        missedCalls: sql<number>`count(*) filter (where ${calls.status} = 'missed')::int`,
        uniqueLeads: sql<number>`count(distinct ${calls.leadId})::int`,
        avgTalkDurationSeconds: sql<number>`coalesce(round(avg(coalesce(${calls.answeredSeconds}, ${calls.durationSeconds})) filter (where ${calls.status} = 'answered')), 0)::int`,
      })
      .from(calls)
      .where(and(eq(calls.tenantId, params.tenantId), gte(calls.startedAt, from), lt(calls.startedAt, to)));
    return row!;
  };

  const [current, previous] = await Promise.all([
    summarize(params.currentFrom, params.currentTo),
    summarize(params.previousFrom, params.previousTo),
  ]);

  const pctChange = (cur: number, prev: number) =>
    prev === 0 ? (cur === 0 ? 0 : null) : Math.round(((cur - prev) / prev) * 1000) / 10;

  return {
    currentWindowUtc: { from: params.currentFrom.toISOString(), to: params.currentTo.toISOString() },
    previousWindowUtc: { from: params.previousFrom.toISOString(), to: params.previousTo.toISOString() },
    current,
    previous,
    delta: {
      totalCalls: current.totalCalls - previous.totalCalls,
      totalCallsPct: pctChange(current.totalCalls, previous.totalCalls),
      answeredCalls: current.answeredCalls - previous.answeredCalls,
      answeredCallsPct: pctChange(current.answeredCalls, previous.answeredCalls),
      uniqueLeads: current.uniqueLeads - previous.uniqueLeads,
      uniqueLeadsPct: pctChange(current.uniqueLeads, previous.uniqueLeads),
      avgTalkDurationSeconds: current.avgTalkDurationSeconds - previous.avgTalkDurationSeconds,
    },
  };
}

export async function getLeadDetails(tenantId: string, leadId: string) {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, leadId)))
    .limit(1);

  if (!lead) {
    throw new NotFoundError(`Lead ${leadId} not found.`);
  }

  const recentCalls = await db
    .select({
      callId: calls.id,
      startedAt: calls.startedAt,
      status: calls.status,
      direction: calls.direction,
      answeredSeconds: calls.answeredSeconds,
      agentName: agents.name,
      callOutcome: callAnalyses.callOutcome,
      leadTemperature: callAnalyses.leadTemperature,
    })
    .from(calls)
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(and(eq(calls.tenantId, tenantId), eq(calls.leadId, leadId)))
    .orderBy(desc(calls.startedAt))
    .limit(20);

  const leadFollowups = await db
    .select()
    .from(followups)
    .where(and(eq(followups.tenantId, tenantId), eq(followups.leadId, leadId)))
    .orderBy(desc(followups.createdAt))
    .limit(10);

  return {
    lead: {
      id: lead.id,
      externalId: lead.externalId,
      name: lead.name ?? "Unknown",
      phoneMasked: safeMaskEncryptedPhone(lead.phoneEncrypted),
      source: lead.source,
      currentStage: lead.currentStage,
      priorityScore: lead.priorityScore,
      priorityScoreVersion: lead.priorityScoreVersion,
    },
    recentCalls: recentCalls.map((c) => ({
      ...c,
      agentName: c.agentName ?? "Unknown",
      startedAt: c.startedAt.toISOString(),
    })),
    followups: leadFollowups,
  };
}

