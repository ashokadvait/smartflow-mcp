import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { callAnalyses, transcripts } from "../db/schema/index.js";

export interface QuotaLimits {
  dailyTranscriptions: number;
  dailyAudioSeconds: number;
  hourlyAudioSeconds: number;
  dailyAnalyses: number;
}

export interface DailyQuotaStatus {
  windowHours: number;
  transcriptions: {
    used: number;
    limit: number;
    remaining: number;
  };
  audioSecondsDaily: {
    used: number;
    limit: number;
    remaining: number;
  };
  audioSecondsHourly: {
    used: number;
    limit: number;
    remaining: number;
  };
  analyses: {
    used: number;
    limit: number;
    remaining: number;
  };
  canTranscribe: boolean;
  canAnalyze: boolean;
  blockedReason: string | null;
}

export function getDefaultQuotaLimits(overrides?: Partial<QuotaLimits>): QuotaLimits {
  return {
    dailyTranscriptions: overrides?.dailyTranscriptions ?? env.DAILY_TRANSCRIPTION_LIMIT,
    dailyAudioSeconds: overrides?.dailyAudioSeconds ?? env.DAILY_TRANSCRIPTION_AUDIO_SECONDS_LIMIT,
    hourlyAudioSeconds: overrides?.hourlyAudioSeconds ?? env.HOURLY_TRANSCRIPTION_AUDIO_SECONDS_LIMIT,
    dailyAnalyses: overrides?.dailyAnalyses ?? env.DAILY_ANALYSIS_LIMIT,
  };
}

/**
 * Checks rolling 24-hour and 1-hour usage directly from Postgres so daily limits
 * are enforced accurately across restarts, multiple workers, and cron invocations.
 */
export async function getDailyQuotaStatus(
  overrides?: Partial<QuotaLimits>
): Promise<DailyQuotaStatus> {
  const limits = getDefaultQuotaLimits(overrides);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since1h = new Date(Date.now() - 60 * 60 * 1000);

  const [trStats] = await db
    .select({
      count24h: sql<number>`count(*) filter (where ${transcripts.createdAt} >= ${since24h})::int`,
      audioSec24h: sql<number>`coalesce(sum(${transcripts.durationSeconds}) filter (where ${transcripts.createdAt} >= ${since24h}), 0)::int`,
      audioSec1h: sql<number>`coalesce(sum(${transcripts.durationSeconds}) filter (where ${transcripts.createdAt} >= ${since1h}), 0)::int`,
    })
    .from(transcripts);

  const [anStats] = await db
    .select({
      count24h: sql<number>`count(*) filter (where ${callAnalyses.createdAt} >= ${since24h})::int`,
    })
    .from(callAnalyses);

  const transcriptionsUsed = trStats?.count24h ?? 0;
  const audioSecondsDailyUsed = trStats?.audioSec24h ?? 0;
  const audioSecondsHourlyUsed = trStats?.audioSec1h ?? 0;
  const analysesUsed = anStats?.count24h ?? 0;

  const transcriptionsRemaining = Math.max(0, limits.dailyTranscriptions - transcriptionsUsed);
  const audioSecondsDailyRemaining = Math.max(0, limits.dailyAudioSeconds - audioSecondsDailyUsed);
  const audioSecondsHourlyRemaining = Math.max(0, limits.hourlyAudioSeconds - audioSecondsHourlyUsed);
  const analysesRemaining = Math.max(0, limits.dailyAnalyses - analysesUsed);

  const canTranscribe =
    transcriptionsRemaining > 0 &&
    audioSecondsDailyRemaining > 0 &&
    audioSecondsHourlyRemaining > 0;
  const canAnalyze = analysesRemaining > 0;

  let blockedReason: string | null = null;
  if (transcriptionsRemaining <= 0) {
    blockedReason = `Daily transcription request limit reached (${transcriptionsUsed}/${limits.dailyTranscriptions}).`;
  } else if (audioSecondsDailyRemaining <= 0) {
    blockedReason = `Daily transcription audio limit reached (${audioSecondsDailyUsed}s/${limits.dailyAudioSeconds}s).`;
  } else if (audioSecondsHourlyRemaining <= 0) {
    blockedReason = `Hourly transcription audio limit reached (${audioSecondsHourlyUsed}s/${limits.hourlyAudioSeconds}s).`;
  } else if (analysesRemaining <= 0) {
    blockedReason = `Daily analysis request limit reached (${analysesUsed}/${limits.dailyAnalyses}).`;
  }

  return {
    windowHours: 24,
    transcriptions: {
      used: transcriptionsUsed,
      limit: limits.dailyTranscriptions,
      remaining: transcriptionsRemaining,
    },
    audioSecondsDaily: {
      used: audioSecondsDailyUsed,
      limit: limits.dailyAudioSeconds,
      remaining: audioSecondsDailyRemaining,
    },
    audioSecondsHourly: {
      used: audioSecondsHourlyUsed,
      limit: limits.hourlyAudioSeconds,
      remaining: audioSecondsHourlyRemaining,
    },
    analyses: {
      used: analysesUsed,
      limit: limits.dailyAnalyses,
      remaining: analysesRemaining,
    },
    canTranscribe,
    canAnalyze,
    blockedReason,
  };
}

export type RateLimitKind = "none" | "minute_limit" | "hourly_limit" | "daily_limit";

export interface ClassifiedRateLimit {
  kind: RateLimitKind;
  retryAfterMs: number;
  message: string;
}

function parseWaitDurationMs(message: string): number | null {
  // Matches Groq messages like "Please try again in 12.5s" or "1h2m3s" or "4m12.3s"
  const match = message.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const mins = Number(match[2] ?? 0);
  const secs = Number(match[3] ?? 0);
  const totalMs = Math.ceil((hours * 3600 + mins * 60 + secs) * 1000);
  return totalMs > 0 ? totalMs : null;
}

/**
 * Classifies provider 429 / quota errors so workers know whether to back off
 * briefly (per-minute RPM/TPM) or stop the batch cleanly (hourly/daily limit).
 */
export function classifyRateLimitError(err: unknown): ClassifiedRateLimit {
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : String(err);
  const lower = message.toLowerCase();

  const isRateLimit =
    status === 429 ||
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("quota");

  if (!isRateLimit) {
    return { kind: "none", retryAfterMs: 0, message };
  }

  const headers = (err as { headers?: Record<string, string> | { get?: (k: string) => string | null } })?.headers;
  let retryAfterSec = 0;
  if (headers) {
    const raw = typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get: (k: string) => string | null }).get("retry-after")
      : (headers as Record<string, string>)["retry-after"];
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        retryAfterSec = parsed;
      }
    }
  }

  const parsedWaitMs = parseWaitDurationMs(message);
  const retryAfterMs = Math.max(retryAfterSec * 1000, parsedWaitMs ?? 0, 5000);

  if (
    lower.includes("per day") ||
    lower.includes("(rpd)") ||
    lower.includes("(tpd)") ||
    lower.includes("daily") ||
    lower.includes("audio seconds per day") ||
    retryAfterMs >= 2 * 60 * 60 * 1000
  ) {
    return { kind: "daily_limit", retryAfterMs, message };
  }

  if (
    lower.includes("per hour") ||
    lower.includes("audio seconds per hour") ||
    retryAfterMs >= 10 * 60 * 1000
  ) {
    return { kind: "hourly_limit", retryAfterMs, message };
  }

  return { kind: "minute_limit", retryAfterMs: Math.min(retryAfterMs, 65000), message };
}

/**
 * Simple async RPM pacer shared across concurrent workers so parallel execution
 * maximizes throughput without tripping provider per-minute limits.
 */
export class RpmRateLimiter {
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;

  constructor(requestsPerMinute: number) {
    const rpm = Math.max(1, requestsPerMinute);
    this.minIntervalMs = Math.ceil(60_000 / rpm);
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const scheduled = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = scheduled + this.minIntervalMs;
    const waitMs = scheduled - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Push back the next available slot after a provider 429 Retry-After response.
   */
  backoff(delayMs: number): void {
    const target = Date.now() + Math.max(1000, delayMs);
    if (target > this.nextSlotAt) {
      this.nextSlotAt = target;
    }
  }
}
