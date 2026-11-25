import { z } from "zod";
import type { TranscriptSegment } from "../db/schema/tables.js";

export type ProviderName = "groq" | "openai" | "gemini" | "ollama";

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments?: TranscriptSegment[];
}

export interface TranscriptionProvider {
  readonly name: ProviderName;
  readonly model: string;
  transcribe(input: { filePath: string; language?: string; prompt?: string }): Promise<TranscriptionResult>;
}

export const AgentEvaluationSchema = z.object({
  introduction: z.number().min(0).max(10),
  discovery: z.number().min(0).max(15),
  productKnowledge: z.number().min(0).max(15),
  explanation: z.number().min(0).max(15),
  listening: z.number().min(0).max(15),
  objectionHandling: z.number().min(0).max(15),
  nextStep: z.number().min(0).max(10),
  professionalism: z.number().min(0).max(5),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
});

export const CallAnalysisSchema = z.object({
  summary: z.string(),
  customerIntent: z.enum(["high", "medium", "low", "unknown"]),
  leadTemperature: z.enum(["hot", "warm", "cold", "unknown"]),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed", "unknown"]),
  // Note: "verbal_commitment" replaces "converted" so AI never reports unverified CRM conversions.
  callOutcome: z.enum([
    "interested",
    "not_interested",
    "callback_requested",
    "information_requested",
    "verbal_commitment",
    "not_connected",
    "unknown",
  ]),
  signals: z
    .object({
      requestedPricing: z.boolean().default(false),
      requestedCallback: z.boolean().default(false),
      mentionedPurchaseTimeline: z.boolean().default(false),
      requestedDemoOrAppointment: z.boolean().default(false),
      explicitRejection: z.boolean().default(false),
    })
    .default({}),
  objections: z.array(
    z.object({
      category: z.string(),
      description: z.string(),
      evidence: z.string(),
      agentResponse: z.string().optional(),
      improvement: z.string().optional(),
    })
  ),
  productKnowledgeCheck: z
    .object({
      status: z
        .enum(["correct", "partially_correct", "incorrect", "not_applicable", "insufficient_knowledge"])
        .default("not_applicable"),
      correctInformation: z.array(z.string()).default([]),
      incorrectInformation: z.array(z.string()).default([]),
      missingInformation: z.array(z.string()).default([]),
    })
    .optional(),
  missedOpportunities: z
    .array(
      z.object({
        opportunity: z.string(),
        reason: z.string(),
        suggestedAction: z.string(),
      })
    )
    .default([]),
  compliance: z
    .object({
      riskLevel: z.enum(["none", "low", "medium", "high"]).default("none"),
      violations: z.array(z.string()).default([]),
      medicalClaims: z.array(z.string()).default([]),
      requiresHumanReview: z.boolean().default(false),
    })
    .default({}),
  agentEvaluation: AgentEvaluationSchema,
  followUp: z.object({
    required: z.boolean(),
    suggestedDate: z.string().nullable(),
    reason: z.string(),
    action: z.string(),
  }),
  conversionProbability: z.number().min(0).max(100),
  uncertaintyNotes: z.string().optional().default(""),
  evidence: z.array(
    z.object({
      claim: z.string(),
      quote: z.string(),
      timestampStart: z.number().nullable(),
    })
  ),
});

export type CallAnalysis = z.infer<typeof CallAnalysisSchema>;

export interface AnalysisProvider {
  readonly name: ProviderName;
  readonly model: string;
  generateStructured<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  }): Promise<T>;
}

/**
 * Deterministically sum the 8 rubric dimensions (max 100) so we never rely on LLM arithmetic.
 */
export function computeRubricScore(evalObj: CallAnalysis["agentEvaluation"]): number {
  const sum =
    evalObj.introduction +
    evalObj.discovery +
    evalObj.productKnowledge +
    evalObj.explanation +
    evalObj.listening +
    evalObj.objectionHandling +
    evalObj.nextStep +
    evalObj.professionalism;
  return Math.max(0, Math.min(100, Math.round(sum)));
}

export const LEAD_SCORE_VERSION = "lead-score-v1";

/**
 * Deterministic rule-based lead priority score (0-100) per Blueprint Section 15.
 * Not a conversion probability.
 */
export function calculateLeadPriorityScore(
  analysis: CallAnalysis,
  options: { hasOverdueFollowup?: boolean; unreachable?: boolean } = {}
): number {
  let score = 20; // neutral baseline for a connected call
  if (analysis.customerIntent === "high") score += 25;
  else if (analysis.customerIntent === "medium") score += 10;

  if (analysis.signals.requestedPricing) score += 15;
  if (analysis.signals.requestedCallback || analysis.callOutcome === "callback_requested") score += 15;
  if (analysis.signals.mentionedPurchaseTimeline) score += 15;
  if (analysis.signals.requestedDemoOrAppointment) score += 20;
  if (options.hasOverdueFollowup) score += 15;
  if (analysis.signals.explicitRejection || analysis.callOutcome === "not_interested") score -= 30;
  if (options.unreachable || analysis.callOutcome === "not_connected") score -= 20;

  return Math.max(0, Math.min(100, score));
}
