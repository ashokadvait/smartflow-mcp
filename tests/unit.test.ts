import { describe, expect, it } from "vitest";
import { mapSmartfloCallRecord, mapSmartfloUser, normalizeCallStatus } from "../src/integrations/smartflow/mappers.js";
import { parseSmartfloWebhook } from "../src/integrations/smartflow/webhooks.js";
import { validateRecordingUrl } from "../src/pipeline/recording.pipeline.js";
import { PRAANA_VAIDYA_KNOWLEDGE_BASE, PRAANA_VAIDYA_WHISPER_PROMPT } from "../src/prompts/business-knowledge.js";
import { buildCallAnalysisPrompt, CALL_ANALYSIS_PROMPT_VERSION } from "../src/prompts/call-analysis.prompt.js";
import {
  calculateLeadPriorityScore,
  CallAnalysisSchema,
  computeRubricScore,
  type CallAnalysis,
} from "../src/providers/types.js";
import { formatForSmartfloQuery, getDayBoundsUtc, parseSmartfloTimestamp, validateDateRange } from "../src/utils/dates.js";
import { decryptSecret, encryptSecret, hashPhone, maskPhone, redactParameters } from "../src/utils/pii.js";
import { generateRawApiKey, hashApiKey, normalizeSlug, toSafeAccountSummary } from "../src/services/account.service.js";
import { buildDateChunks } from "../src/services/backfill.service.js";
import { classifyRateLimitError } from "../src/services/quota.service.js";

describe("Date & Timezone utilities", () => {
  it("parses Smartflo IST timestamp to exact UTC Date", () => {
    const dt = parseSmartfloTimestamp("2026-11-20", "11:52:14", "Asia/Kolkata");
    expect(dt?.toISOString()).toBe("2026-11-20T06:22:14.000Z");
  });

  it("computes IST day boundaries in UTC", () => {
    const { from, to } = getDayBoundsUtc("2026-11-20", "Asia/Kolkata");
    expect(from.toISOString()).toBe("2026-11-19T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-11-20T18:30:00.000Z");
    expect(formatForSmartfloQuery(from, "Asia/Kolkata")).toBe("2026-11-20 00:00:00");
  });

  it("rejects inverted or oversized date ranges", () => {
    expect(() => validateDateRange("2026-11-20T00:00:00Z", "2026-11-19T00:00:00Z")).toThrow();
    expect(() => validateDateRange("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z", 90)).toThrow();
  });
});

describe("PII encryption, HMAC hashing & masking", () => {
  it("round-trips AES-256-GCM encryption", () => {
    const secret = "https://cloudphone.tatateleservices.com/file/recording?callId=123&token=abc";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain("cloudphone");
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces deterministic HMAC phone hash across formats", () => {
    expect(hashPhone("+91-98765 43210")).toBe(hashPhone("919876543210"));
    expect(maskPhone("+91-98765 43210")).toBe("********3210");
  });

  it("redacts sensitive parameters for audit logs", () => {
    const redacted = redactParameters({
      callId: "abc",
      apiKey: "secret-key",
      nested: { token: "xyz", limit: 10 },
    });
    expect(redacted).toEqual({
      callId: "abc",
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]", limit: 10 },
    });
  });
});

describe("Smartflo mappers & webhooks", () => {
  it("maps Smartflo CDR record including answered_seconds and recording_url", () => {
    const mapped = mapSmartfloCallRecord({
      id: "663c6bc92b66f80b611f8f40",
      call_id: "1715235734.129662",
      uuid: "48e0d4fbe3ad9",
      direction: "inbound",
      status: "answered",
      recording_url: "https://cloudphone.tatateleservices.com/file/recording?callId=1715235734.129662&type=rec&token=tok",
      service: "Dialer",
      date: "2026-11-20",
      time: "11:52:14",
      end_stamp: "2026-11-20 11:53:02",
      call_duration: 60,
      answered_seconds: 48,
      agent_number: "Extension-06047530219",
      client_number: "919650134255",
    });

    expect(mapped.externalId).toBe("663c6bc92b66f80b611f8f40");
    expect(mapped.status).toBe("answered");
    expect(mapped.durationSeconds).toBe(60);
    expect(mapped.answeredSeconds).toBe(48);
    expect(mapped.phone).toBe("919650134255");
    expect(mapped.startedAt.toISOString()).toBe("2026-11-20T06:22:14.000Z");
  });

  it("maps Smartflo user and webhook payload", () => {
    const agent = mapSmartfloUser({ id: 42, name: "Priya", email: "priya@example.com", user_status: true });
    expect(agent).toEqual({
      externalId: "42",
      name: "Priya",
      email: "priya@example.com",
      agentNumber: undefined,
      active: true,
    });

    const { call } = parseSmartfloWebhook({
      uuid: "wh-1",
      answered: true,
      direction: "outbound",
      call_to_number: "919876543210",
      answered_agent_email: "priya@example.com",
    });
    expect(call.externalId).toBe("wh-1");
    expect(call.status).toBe("answered");
    expect(normalizeCallStatus("no-answer")).toBe("missed");
  });
});

describe("SSRF recording URL validation", () => {
  it("allows Smartflo media host and blocks arbitrary hosts", () => {
    expect(() =>
      validateRecordingUrl("https://cloudphone.tatateleservices.com/file/recording?callId=1&token=x")
    ).not.toThrow();
    expect(() => validateRecordingUrl("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => validateRecordingUrl("https://evil.example.com/audio.mp3")).toThrow();
  });
});

describe("Rubric scoring & Lead priority score", () => {
  const sampleAnalysis: CallAnalysis = CallAnalysisSchema.parse({
    summary: "Customer asked for pricing and requested a demo tomorrow.",
    customerIntent: "high",
    leadTemperature: "hot",
    sentiment: "positive",
    callOutcome: "interested",
    signals: {
      requestedPricing: true,
      requestedCallback: false,
      mentionedPurchaseTimeline: true,
      requestedDemoOrAppointment: true,
      explicitRejection: false,
    },
    objections: [{ category: "price", description: "Asked for discount", evidence: "Can you reduce the fee?" }],
    agentEvaluation: {
      introduction: 9,
      discovery: 13,
      productKnowledge: 14,
      explanation: 12,
      listening: 13,
      objectionHandling: 11,
      nextStep: 8,
      professionalism: 5,
      strengths: ["Clear product explanation"],
      weaknesses: ["Could probe budget earlier"],
    },
    followUp: {
      required: true,
      suggestedDate: "2026-11-21T10:00:00+05:30",
      reason: "Demo requested",
      action: "Send calendar invite",
    },
    conversionProbability: 72,
    evidence: [{ claim: "Requested demo", quote: "Let's do a demo tomorrow at 10 AM", timestampStart: 45 }],
  });

  it("computes deterministic rubric total", () => {
    expect(computeRubricScore(sampleAnalysis.agentEvaluation)).toBe(85);
  });

  it("computes deterministic rule-based lead priority score clamped to 0-100", () => {
    expect(calculateLeadPriorityScore(sampleAnalysis)).toBe(95);
    expect(
      calculateLeadPriorityScore({
        ...sampleAnalysis,
        customerIntent: "low",
        callOutcome: "not_interested",
        signals: {
          requestedPricing: false,
          requestedCallback: false,
          mentionedPurchaseTimeline: false,
          requestedDemoOrAppointment: false,
          explicitRejection: true,
        },
      })
    ).toBe(0);
  });
});

describe("Praana Vaidya Whisper prompt & Business Knowledge Base", () => {
  it("keeps Whisper prompt concise without duplicate brand names", () => {
    const terms = PRAANA_VAIDYA_WHISPER_PROMPT.split(",").map((t) => t.trim());
    expect(terms.filter((t) => t === "Praana Vaidya")).toHaveLength(1);
    expect(PRAANA_VAIDYA_WHISPER_PROMPT).toContain("Panchakarma");
    expect(PRAANA_VAIDYA_WHISPER_PROMPT).toContain("Dr. Chethan Upadhyaya");
    expect(PRAANA_VAIDYA_WHISPER_PROMPT.length).toBeLessThan(900);
  });

  it("injects business knowledge separately from untrusted transcript", () => {
    const prompt = buildCallAnalysisPrompt("Hello from Praana Vaidya", {
      callId: "call-1",
      agentName: "Priya",
      department: "Online Consultation",
      callDate: "2026-11-24T10:00:00Z",
    });

    expect(CALL_ANALYSIS_PROMPT_VERSION).toBe("call-analysis-v2");
    expect(prompt).toContain("<business_knowledge>");
    expect(prompt).toContain(PRAANA_VAIDYA_KNOWLEDGE_BASE.business.name);
    expect(prompt).toContain("Department/Campaign: Online Consultation");
    expect(prompt).toContain("<transcript>\nHello from Praana Vaidya\n</transcript>");
  });

  it("parses extended v2 analysis fields with compliance and missed opportunities", () => {
    const parsed = CallAnalysisSchema.parse({
      summary: "Patient asked about Home Panchakarma for joint pain.",
      customerIntent: "high",
      leadTemperature: "hot",
      sentiment: "positive",
      callOutcome: "callback_requested",
      signals: {
        requestedPricing: true,
        requestedCallback: true,
        mentionedPurchaseTimeline: false,
        requestedDemoOrAppointment: true,
        explicitRejection: false,
      },
      objections: [
        {
          category: "travel",
          description: "Cannot visit hospital",
          evidence: "I cannot travel to the clinic",
          agentResponse: "Mentioned Home Panchakarma",
          improvement: "Also explain live online doctor support",
        },
      ],
      productKnowledgeCheck: {
        status: "correct",
        correctInformation: ["Home Panchakarma available"],
        incorrectInformation: [],
        missingInformation: ["App Based Panchakarma"],
      },
      missedOpportunities: [
        {
          opportunity: "Mention No-cost EMI",
          reason: "Patient asked about affordability",
          suggestedAction: "Inform patient that no-cost EMI options are available",
        },
      ],
      compliance: {
        riskLevel: "high",
        violations: ["Guaranteed 100% cure"],
        medicalClaims: ["This will cure your arthritis completely"],
        requiresHumanReview: true,
      },
      agentEvaluation: {
        introduction: 8,
        discovery: 12,
        productKnowledge: 13,
        explanation: 12,
        listening: 13,
        objectionHandling: 11,
        nextStep: 8,
        professionalism: 4,
        strengths: ["Suggested Home Panchakarma"],
        weaknesses: ["Made unsupported cure claim"],
      },
      followUp: {
        required: true,
        suggestedDate: null,
        reason: "Patient requested callback after consulting family",
        action: "Call back to schedule online consultation",
      },
      conversionProbability: 65,
      evidence: [
        {
          claim: "Unsupported cure claim",
          quote: "This will cure your arthritis completely",
          timestampStart: 32,
        },
      ],
    });

    expect(parsed.compliance.requiresHumanReview).toBe(true);
    expect(parsed.compliance.riskLevel).toBe("high");
    expect(parsed.missedOpportunities).toHaveLength(1);
    expect(parsed.productKnowledgeCheck?.status).toBe("correct");
  });
});

describe("Multi-account helpers & API key generation", () => {
  it("normalizes account slugs and rejects invalid ones", () => {
    expect(normalizeSlug("Acme Sales Team")).toBe("acme-sales-team");
    expect(normalizeSlug("  branch_01  ")).toBe("branch_01");
    expect(() => normalizeSlug("a")).toThrow();
  });

  it("generates distinct prefixed API keys with matching SHA-256 hashes", () => {
    const adminKey = generateRawApiKey("admin");
    const tenantKey = generateRawApiKey("tenant");

    expect(adminKey.rawKey.startsWith("sf_adm_")).toBe(true);
    expect(tenantKey.rawKey.startsWith("sf_acc_")).toBe(true);
    expect(adminKey.hash).toBe(hashApiKey(adminKey.rawKey));
    expect(tenantKey.hash).toBe(hashApiKey(tenantKey.rawKey));
    expect(adminKey.hash).not.toBe(tenantKey.hash);
  });

  it("returns safe account summary without exposing encrypted credentials", () => {
    const now = new Date();
    const summary = toSafeAccountSummary({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme Sales",
      slug: "acme-sales",
      timezone: "Asia/Kolkata",
      active: true,
      smartfloBaseUrl: "https://api-smartflo.tatateleservices.com/v1",
      smartfloApiKeyEncrypted: "iv:tag:ciphertext",
      smartfloEmailEncrypted: null,
      smartfloPasswordEncrypted: null,
      smartfloWebhookSecretEncrypted: "iv:tag:secret",
      createdAt: now,
      updatedAt: now,
    });

    expect(summary.hasSmartfloCredentials).toBe(true);
    expect(summary.hasWebhookSecret).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("ciphertext");
    expect(JSON.stringify(summary)).not.toContain("iv:tag");
  });
});

describe("Backfill chunking & rate-limit classification", () => {
  it("splits a date range into bounded chunks in newest-first or oldest-first order", () => {
    const from = new Date("2026-06-01T00:00:00Z");
    const to = new Date("2026-06-22T00:00:00Z");
    const newestFirst = buildDateChunks(from, to, 7, "newest");
    expect(newestFirst).toHaveLength(3);
    expect(newestFirst[0]!.to.toISOString()).toBe("2026-06-22T00:00:00.000Z");
    expect(newestFirst[2]!.from.toISOString()).toBe("2026-06-01T00:00:00.000Z");

    const oldestFirst = buildDateChunks(from, to, 7, "oldest");
    expect(oldestFirst[0]!.from.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(oldestFirst[2]!.to.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });

  it("classifies Groq 429 minute, hourly, and daily limits accurately", () => {
    const daily = classifyRateLimitError({
      status: 429,
      message: "Rate limit reached for model whisper-large-v3-turbo: audio seconds per day (ASPD). Please try again in 3h12m10s.",
    });
    expect(daily.kind).toBe("daily_limit");

    const hourly = classifyRateLimitError({
      status: 429,
      message: "Rate limit reached: audio seconds per hour. Please try again in 24m10s.",
    });
    expect(hourly.kind).toBe("hourly_limit");

    const minute = classifyRateLimitError({
      status: 429,
      message: "Rate limit reached: requests per minute. Please try again in 8.5s.",
    });
    expect(minute.kind).toBe("minute_limit");
    expect(minute.retryAfterMs).toBeGreaterThanOrEqual(8500);

    const normal = classifyRateLimitError(new Error("Network timeout"));
    expect(normal.kind).toBe("none");
  });
});

