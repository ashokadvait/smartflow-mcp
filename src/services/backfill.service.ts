import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { callAnalyses, calls, recordings, transcripts } from "../db/schema/index.js";
import { analyzeCallTranscript } from "../pipeline/analysis.pipeline.js";
import { downloadAndValidateRecording } from "../pipeline/recording.pipeline.js";
import { transcribeCallRecording } from "../pipeline/transcription.pipeline.js";
import { logger } from "../utils/logger.js";
import { getTenantByIdentifier, listSyncableTenants } from "./account.service.js";
import {
  classifyRateLimitError,
  getDailyQuotaStatus,
  getDefaultQuotaLimits,
  RpmRateLimiter,
  type DailyQuotaStatus,
  type QuotaLimits,
} from "./quota.service.js";
import { syncCallsWindow } from "./sync.service.js";

export interface BackfillCallsOptions {
  account?: string;
  allAccounts?: boolean;
  from: Date;
  to: Date;
  chunkDays?: number;
  order?: "newest" | "oldest";
  onChunkComplete?: (info: {
    account: string;
    chunkIndex: number;
    totalChunks: number;
    from: Date;
    to: Date;
    callsFetched: number;
    newCalls: number;
    updatedCalls: number;
    recordingUrlsFound: number;
    error?: string;
  }) => void;
}

export interface BackfillCallsResult {
  accountsProcessed: number;
  chunksTotal: number;
  chunksSucceeded: number;
  chunksFailed: number;
  callsFetched: number;
  newCalls: number;
  updatedCalls: number;
  recordingUrlsFound: number;
  missingAudio: number;
  accountSummaries: Array<{
    account: string;
    tenantId: string;
    chunksSucceeded: number;
    chunksFailed: number;
    callsFetched: number;
    newCalls: number;
    updatedCalls: number;
    recordingUrlsFound: number;
  }>;
}

export function buildDateChunks(
  from: Date,
  to: Date,
  chunkDays = 7,
  order: "newest" | "oldest" = "newest"
): Array<{ from: Date; to: Date }> {
  const stepMs = Math.max(1, chunkDays) * 24 * 60 * 60 * 1000;
  const chunks: Array<{ from: Date; to: Date }> = [];

  let cursor = from.getTime();
  const end = to.getTime();
  while (cursor < end) {
    const next = Math.min(cursor + stepMs, end);
    chunks.push({ from: new Date(cursor), to: new Date(next) });
    cursor = next;
  }

  return order === "newest" ? chunks.reverse() : chunks;
}

export async function backfillCallsHistory(
  options: BackfillCallsOptions
): Promise<BackfillCallsResult> {
  const tenants = options.account
    ? await getTenantByIdentifier(options.account).then((t) => {
        if (!t || !t.active) {
          throw new Error(`Smartflo account "${options.account}" not found or inactive.`);
        }
        return [t];
      })
    : await listSyncableTenants();

  if (tenants.length === 0) {
    throw new Error("No active syncable Smartflo accounts found.");
  }

  const chunkDays = options.chunkDays ?? 7;
  const chunks = buildDateChunks(options.from, options.to, chunkDays, options.order ?? "newest");

  let chunksSucceeded = 0;
  let chunksFailed = 0;
  let callsFetched = 0;
  let newCalls = 0;
  let updatedCalls = 0;
  let recordingUrlsFound = 0;
  let missingAudio = 0;
  const accountSummaries: BackfillCallsResult["accountSummaries"] = [];

  for (const tenant of tenants) {
    const accountLabel = tenant.slug ?? tenant.name;
    let accSucceeded = 0;
    let accFailed = 0;
    let accFetched = 0;
    let accNew = 0;
    let accUpdated = 0;
    let accRecs = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      try {
        const summary = await syncCallsWindow({
          tenantId: tenant.id,
          from: chunk.from,
          to: chunk.to,
          syncType: "backfill",
          syncAgentsFirst: i === 0,
        });

        chunksSucceeded += 1;
        accSucceeded += 1;
        callsFetched += summary.callsFetched;
        newCalls += summary.newCalls;
        updatedCalls += summary.updatedCalls;
        recordingUrlsFound += summary.recordingUrlsFound;
        missingAudio += summary.missingAudio;

        accFetched += summary.callsFetched;
        accNew += summary.newCalls;
        accUpdated += summary.updatedCalls;
        accRecs += summary.recordingUrlsFound;

        options.onChunkComplete?.({
          account: accountLabel,
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          from: chunk.from,
          to: chunk.to,
          callsFetched: summary.callsFetched,
          newCalls: summary.newCalls,
          updatedCalls: summary.updatedCalls,
          recordingUrlsFound: summary.recordingUrlsFound,
        });
      } catch (err) {
        chunksFailed += 1;
        accFailed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          { tenantId: tenant.id, account: accountLabel, from: chunk.from, to: chunk.to, err: msg },
          "Backfill chunk failed"
        );
        options.onChunkComplete?.({
          account: accountLabel,
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          from: chunk.from,
          to: chunk.to,
          callsFetched: 0,
          newCalls: 0,
          updatedCalls: 0,
          recordingUrlsFound: 0,
          error: msg,
        });
      }
    }

    accountSummaries.push({
      account: accountLabel,
      tenantId: tenant.id,
      chunksSucceeded: accSucceeded,
      chunksFailed: accFailed,
      callsFetched: accFetched,
      newCalls: accNew,
      updatedCalls: accUpdated,
      recordingUrlsFound: accRecs,
    });
  }

  return {
    accountsProcessed: tenants.length,
    chunksTotal: chunks.length * tenants.length,
    chunksSucceeded,
    chunksFailed,
    callsFetched,
    newCalls,
    updatedCalls,
    recordingUrlsFound,
    missingAudio,
    accountSummaries,
  };
}

export interface BatchWorkerOptions {
  account?: string;
  batchSize?: number;
  downloadConcurrency?: number;
  transcribeConcurrency?: number;
  analyzeConcurrency?: number;
  transcribeOnly?: boolean;
  cleanupAudio?: boolean;
  order?: "newest" | "oldest";
  quotaOverrides?: Partial<QuotaLimits>;
  dryRun?: boolean;
  onItemComplete?: (info: {
    index: number;
    total: number;
    callId: string;
    status: "ok" | "failed" | "skipped_quota";
    transcribed?: boolean;
    analyzed?: boolean;
    audioSeconds?: number;
    outcome?: string;
    error?: string;
  }) => void;
}

export interface BatchWorkerResult {
  totalPendingBefore: number;
  batchTargeted: number;
  processed: number;
  transcribed: number;
  analyzed: number;
  failed: number;
  skippedQuota: number;
  stoppedReason: "completed" | "daily_limit" | "hourly_limit" | "dry_run" | "no_pending";
  remainingPending: number;
  quotaBefore: DailyQuotaStatus;
  quotaAfter: DailyQuotaStatus;
  durationMs: number;
}

async function runWithRateLimitRetry<T>(
  fn: () => Promise<T>,
  limiter: RpmRateLimiter,
  onHardLimit: (kind: "daily_limit" | "hourly_limit", message: string) => void,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await limiter.acquire();
    try {
      return await fn();
    } catch (err) {
      const classified = classifyRateLimitError(err);
      if (classified.kind === "daily_limit" || classified.kind === "hourly_limit") {
        onHardLimit(classified.kind, classified.message);
        throw err;
      }
      if (classified.kind === "minute_limit" && attempt < maxRetries) {
        limiter.backoff(classified.retryAfterMs);
        logger.warn(
          { attempt, retryAfterMs: classified.retryAfterMs },
          "Provider per-minute rate limit hit; backing off and retrying"
        );
        await new Promise((resolve) => setTimeout(resolve, classified.retryAfterMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Exhausted rate-limit retries");
}

/**
 * Multi-worker batch processor for historical transcription & AI analysis.
 * Enforces daily request + daily/hourly audio-second limits and per-minute RPM pacing.
 */
export async function runDailyBatchWorkerPool(
  options: BatchWorkerOptions = {}
): Promise<BatchWorkerResult> {
  const startedAt = Date.now();
  const limits = getDefaultQuotaLimits(options.quotaOverrides);
  const quotaBefore = await getDailyQuotaStatus(limits);

  const tenantFilterIds: string[] = [];
  if (options.account) {
    const tenant = await getTenantByIdentifier(options.account);
    if (!tenant || !tenant.active) {
      throw new Error(`Smartflo account "${options.account}" not found or inactive.`);
    }
    tenantFilterIds.push(tenant.id);
  }

  const baseConditions = [
    eq(calls.status, "answered"),
    sql`${recordings.status} != 'failed'`,
    sql`${recordings.status} != 'missing'`,
  ];
  if (tenantFilterIds.length > 0) {
    baseConditions.push(inArray(calls.tenantId, tenantFilterIds));
  }

  // Count total pending calls matching criteria
  const pendingQueryWhere = options.transcribeOnly
    ? and(...baseConditions, isNull(transcripts.id))
    : and(...baseConditions, isNull(callAnalyses.id));

  const [countRow] = options.transcribeOnly
    ? await db
        .select({ count: sql<number>`count(distinct ${calls.id})::int` })
        .from(calls)
        .innerJoin(recordings, eq(recordings.callId, calls.id))
        .leftJoin(transcripts, eq(transcripts.callId, calls.id))
        .where(pendingQueryWhere)
    : await db
        .select({ count: sql<number>`count(distinct ${calls.id})::int` })
        .from(calls)
        .innerJoin(recordings, eq(recordings.callId, calls.id))
        .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
        .where(pendingQueryWhere);

  const totalPendingBefore = countRow?.count ?? 0;

  if (totalPendingBefore === 0) {
    return {
      totalPendingBefore: 0,
      batchTargeted: 0,
      processed: 0,
      transcribed: 0,
      analyzed: 0,
      failed: 0,
      skippedQuota: 0,
      stoppedReason: "no_pending",
      remainingPending: 0,
      quotaBefore,
      quotaAfter: quotaBefore,
      durationMs: Date.now() - startedAt,
    };
  }

  // Check if quota is already exhausted before fetching batch
  const canDoWork = options.transcribeOnly
    ? quotaBefore.canTranscribe
    : quotaBefore.canAnalyze && (quotaBefore.canTranscribe || true);

  if (!canDoWork) {
    const reason =
      quotaBefore.audioSecondsHourly.remaining <= 0 ? "hourly_limit" : "daily_limit";
    return {
      totalPendingBefore,
      batchTargeted: 0,
      processed: 0,
      transcribed: 0,
      analyzed: 0,
      failed: 0,
      skippedQuota: totalPendingBefore,
      stoppedReason: reason,
      remainingPending: totalPendingBefore,
      quotaBefore,
      quotaAfter: quotaBefore,
      durationMs: Date.now() - startedAt,
    };
  }

  const maxAffordableByQuota = options.transcribeOnly
    ? quotaBefore.transcriptions.remaining
    : Math.min(
        quotaBefore.analyses.remaining,
        Math.max(quotaBefore.transcriptions.remaining, 1)
      );

  const requestedBatchSize = options.batchSize ?? 200;
  const effectiveLimit = Math.min(requestedBatchSize, Math.max(1, maxAffordableByQuota));
  const orderCol = options.order === "oldest" ? asc(calls.startedAt) : desc(calls.startedAt);

  const pendingItems = await db
    .select({
      callId: calls.id,
      recordingId: recordings.id,
      answeredSeconds: calls.answeredSeconds,
      durationSeconds: calls.durationSeconds,
      hasTranscript: sql<boolean>`exists (select 1 from transcripts t where t.call_id = ${calls.id} and t.status = 'completed')`,
    })
    .from(calls)
    .innerJoin(recordings, eq(recordings.callId, calls.id))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(
      options.transcribeOnly
        ? and(
            ...baseConditions,
            sql`not exists (select 1 from transcripts t where t.call_id = ${calls.id} and t.status = 'completed')`
          )
        : and(...baseConditions, isNull(callAnalyses.id))
    )
    .orderBy(orderCol)
    .limit(effectiveLimit);

  if (options.dryRun) {
    return {
      totalPendingBefore,
      batchTargeted: pendingItems.length,
      processed: 0,
      transcribed: 0,
      analyzed: 0,
      failed: 0,
      skippedQuota: 0,
      stoppedReason: "dry_run",
      remainingPending: totalPendingBefore,
      quotaBefore,
      quotaAfter: quotaBefore,
      durationMs: Date.now() - startedAt,
    };
  }

  // Shared in-memory quota budget tracker (updated atomically in JS single-threaded event loop)
  let remainingTranscriptions = quotaBefore.transcriptions.remaining;
  let remainingAudioDaily = quotaBefore.audioSecondsDaily.remaining;
  let remainingAudioHourly = quotaBefore.audioSecondsHourly.remaining;
  let remainingAnalyses = quotaBefore.analyses.remaining;

  let circuitBreaker: "none" | "daily_limit" | "hourly_limit" = "none";

  const transcriptionLimiter = new RpmRateLimiter(env.TRANSCRIPTION_RPM_LIMIT);
  const analysisLimiter = new RpmRateLimiter(env.ANALYSIS_RPM_LIMIT);

  const workerCount = Math.max(
    1,
    options.transcribeConcurrency ??
      options.downloadConcurrency ??
      env.TRANSCRIPTION_WORKER_CONCURRENCY
  );

  let nextIdx = 0;
  let completedCount = 0;
  let processed = 0;
  let transcribed = 0;
  let analyzed = 0;
  let failed = 0;
  let skippedQuota = 0;

  const cleanupAudio = options.cleanupAudio ?? env.CLEANUP_AUDIO_AFTER_TRANSCRIPTION;

  const worker = async () => {
    while (true) {
      if (circuitBreaker !== "none") break;
      const idx = nextIdx++;
      if (idx >= pendingItems.length) break;

      const item = pendingItems[idx]!;
      const estAudioSec = Math.max(1, item.answeredSeconds ?? item.durationSeconds ?? 60);

      // Reserve quota before starting API work
      const needsTranscription = !item.hasTranscript;
      if (needsTranscription) {
        if (remainingTranscriptions <= 0 || remainingAudioDaily < estAudioSec) {
          circuitBreaker = "daily_limit";
          skippedQuota += 1;
          options.onItemComplete?.({
            index: ++completedCount,
            total: pendingItems.length,
            callId: item.callId,
            status: "skipped_quota",
            error: "Daily transcription quota budget reached",
          });
          break;
        }
        if (remainingAudioHourly < estAudioSec) {
          circuitBreaker = "hourly_limit";
          skippedQuota += 1;
          options.onItemComplete?.({
            index: ++completedCount,
            total: pendingItems.length,
            callId: item.callId,
            status: "skipped_quota",
            error: "Hourly transcription audio-seconds budget reached",
          });
          break;
        }
        remainingTranscriptions -= 1;
        remainingAudioDaily -= estAudioSec;
        remainingAudioHourly -= estAudioSec;
      }

      if (!options.transcribeOnly) {
        if (remainingAnalyses <= 0) {
          circuitBreaker = "daily_limit";
          skippedQuota += 1;
          options.onItemComplete?.({
            index: ++completedCount,
            total: pendingItems.length,
            callId: item.callId,
            status: "skipped_quota",
            error: "Daily analysis quota budget reached",
          });
          break;
        }
        remainingAnalyses -= 1;
      }

      try {
        let didTranscribe = false;
        let actualAudioSec = estAudioSec;

        if (needsTranscription) {
          await downloadAndValidateRecording(item.recordingId);
          const tr = await runWithRateLimitRetry(
            () => transcribeCallRecording(item.callId, { cleanupAudio }),
            transcriptionLimiter,
            (kind) => {
              circuitBreaker = kind;
            }
          );
          didTranscribe = true;
          transcribed += 1;
          actualAudioSec = tr.durationSeconds ?? estAudioSec;
          // Reconcile actual vs estimated audio seconds
          const diff = actualAudioSec - estAudioSec;
          remainingAudioDaily -= diff;
          remainingAudioHourly -= diff;
        }

        let didAnalyze = false;
        let outcome: string | undefined;
        if (!options.transcribeOnly) {
          const an = await runWithRateLimitRetry(
            () => analyzeCallTranscript(item.callId),
            analysisLimiter,
            (kind) => {
              circuitBreaker = kind;
            }
          );
          didAnalyze = true;
          analyzed += 1;
          outcome = an.callOutcome;
        }

        processed += 1;
        options.onItemComplete?.({
          index: ++completedCount,
          total: pendingItems.length,
          callId: item.callId,
          status: "ok",
          transcribed: didTranscribe,
          analyzed: didAnalyze,
          audioSeconds: actualAudioSec,
          outcome,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const classified = classifyRateLimitError(err);
        if (classified.kind === "daily_limit" || classified.kind === "hourly_limit") {
          circuitBreaker = classified.kind;
          skippedQuota += 1;
          options.onItemComplete?.({
            index: ++completedCount,
            total: pendingItems.length,
            callId: item.callId,
            status: "skipped_quota",
            error: msg,
          });
          break;
        }
        failed += 1;
        options.onItemComplete?.({
          index: ++completedCount,
          total: pendingItems.length,
          callId: item.callId,
          status: "failed",
          error: msg,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const quotaAfter = await getDailyQuotaStatus(limits);
  const stoppedReason: BatchWorkerResult["stoppedReason"] =
    circuitBreaker !== "none" ? circuitBreaker : "completed";

  return {
    totalPendingBefore,
    batchTargeted: pendingItems.length,
    processed,
    transcribed,
    analyzed,
    failed,
    skippedQuota,
    stoppedReason,
    remainingPending: Math.max(0, totalPendingBefore - processed),
    quotaBefore,
    quotaAfter,
    durationMs: Date.now() - startedAt,
  };
}

