import { desc, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { agents, callAnalyses, calls, followups, leads, transcripts } from "../db/schema/index.js";
import {
  buildCallAnalysisPrompt,
  CALL_ANALYSIS_PROMPT_VERSION,
  CALL_ANALYSIS_SYSTEM_PROMPT,
  RUBRIC_VERSION,
} from "../prompts/call-analysis.prompt.js";
import { getActiveAnalysisProvider } from "../providers/registry.js";
import {
  calculateLeadPriorityScore,
  CallAnalysisSchema,
  computeRubricScore,
  LEAD_SCORE_VERSION,
  type AnalysisProvider,
  type CallAnalysis,
  type ProviderName,
} from "../providers/types.js";
import { PermanentJobError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export async function analyzeCallTranscript(
  callId: string,
  options: { provider?: AnalysisProvider } = {}
) {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!call) {
    throw new PermanentJobError(`Call ${callId} not found.`);
  }

  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.callId, callId))
    .orderBy(desc(transcripts.createdAt))
    .limit(1);

  if (!transcript || !transcript.content.trim()) {
    throw new PermanentJobError(`No usable transcript found for call ${callId}.`);
  }

  const agent = call.agentId
    ? (await db.select().from(agents).where(eq(agents.id, call.agentId)).limit(1))[0]
    : undefined;
  const lead = call.leadId
    ? (await db.select().from(leads).where(eq(leads.id, call.leadId)).limit(1))[0]
    : undefined;

  const userPrompt = buildCallAnalysisPrompt(transcript.content, {
    callId: call.id,
    agentName: agent?.name,
    callDate: call.startedAt.toISOString(),
    durationSeconds: call.answeredSeconds ?? call.durationSeconds ?? undefined,
    leadSource: lead?.source ?? undefined,
    language: transcript.language ?? undefined,
  });

  let provider = options.provider ?? getActiveAnalysisProvider();
  let analysis: CallAnalysis;

  try {
    analysis = await provider.generateStructured({
      systemPrompt: CALL_ANALYSIS_SYSTEM_PROMPT,
      userPrompt,
      schema: CallAnalysisSchema,
    });
  } catch (primaryErr) {
    const fallbackName = env.ANALYSIS_FALLBACK_PROVIDER as ProviderName | "";
    if (!fallbackName || fallbackName === provider.name || options.provider) {
      throw primaryErr;
    }
    logger.warn(
      { callId, primary: provider.name, fallback: fallbackName, err: primaryErr },
      "Primary analysis provider failed; switching to fallback provider"
    );
    provider = getActiveAnalysisProvider(fallbackName);
    analysis = await provider.generateStructured({
      systemPrompt: CALL_ANALYSIS_SYSTEM_PROMPT,
      userPrompt,
      schema: CallAnalysisSchema,
    });
  }

  // Deterministic rubric score calculation (never trust LLM arithmetic)
  const qualityScore = computeRubricScore(analysis.agentEvaluation);

  const [saved] = await db
    .insert(callAnalyses)
    .values({
      callId: call.id,
      transcriptId: transcript.id,
      provider: provider.name,
      model: provider.model,
      promptVersion: CALL_ANALYSIS_PROMPT_VERSION,
      rubricVersion: RUBRIC_VERSION,
      intent: analysis.customerIntent,
      sentiment: analysis.sentiment,
      leadTemperature: analysis.leadTemperature,
      callOutcome: analysis.callOutcome,
      qualityScore,
      conversionProbability: Math.round(analysis.conversionProbability),
      analysisJson: {
        ...analysis,
        computedQualityScore: qualityScore,
      },
    })
    .returning();

  // Persist grounded follow-up if required
  if (analysis.followUp.required) {
    let dueAt: Date | null = null;
    if (analysis.followUp.suggestedDate) {
      const parsed = new Date(analysis.followUp.suggestedDate);
      if (!Number.isNaN(parsed.getTime())) {
        dueAt = parsed;
      }
    }
    await db.insert(followups).values({
      tenantId: call.tenantId,
      leadId: call.leadId,
      callId: call.id,
      dueAt,
      reason: analysis.followUp.reason || "Callback/follow-up identified in call analysis",
      action: analysis.followUp.action || null,
      status: "pending",
    });
  }

  // Update lead deterministic priority score
  if (call.leadId) {
    const priorityScore = calculateLeadPriorityScore(analysis);
    await db
      .update(leads)
      .set({
        priorityScore,
        priorityScoreVersion: LEAD_SCORE_VERSION,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, call.leadId));
  }

  logger.info(
    {
      callId: call.id,
      analysisId: saved?.id,
      provider: provider.name,
      qualityScore,
      leadTemperature: analysis.leadTemperature,
      callOutcome: analysis.callOutcome,
    },
    "Call analysis persisted"
  );

  return saved!;
}

