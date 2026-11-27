import { UnrecoverableError, Worker } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../config/env.js";
import { closeDb, db } from "../db/client.js";
import { callAnalyses, calls, recordings } from "../db/schema/index.js";
import { analyzeCallTranscript } from "../pipeline/analysis.pipeline.js";
import { downloadAndValidateRecording } from "../pipeline/recording.pipeline.js";
import { transcribeCallRecording } from "../pipeline/transcription.pipeline.js";
import { listSyncableTenants } from "../services/account.service.js";
import { getDailyQuotaStatus } from "../services/quota.service.js";
import { syncCallsWindow } from "../services/sync.service.js";
import { PermanentJobError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { closeRedis, createQueues, getRedisConnection } from "./queues.js";
import { registerScheduledJobs } from "./scheduler.js";

function wrapPermanentErrors<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof PermanentJobError) {
      throw new UnrecoverableError(err.message);
    }
    throw err;
  });
}

async function main() {
  const connection = getRedisConnection();
  const queues = createQueues();

  const syncWorker = new Worker(
    "smartflow-sync",
    async (job) => {
      const { from, to, windowMinutes, tenantId, syncAllTenants, syncType } = job.data as {
        from?: string;
        to?: string;
        windowMinutes?: number;
        tenantId?: string;
        syncAllTenants?: boolean;
        syncType?: string;
      };
      const toDate = to ? new Date(to) : new Date();
      const fromDate = from
        ? new Date(from)
        : new Date(toDate.getTime() - (windowMinutes ?? 60) * 60 * 1000);

      const targetTenantIds: string[] = tenantId
        ? [tenantId]
        : syncAllTenants
          ? (await listSyncableTenants()).map((t) => t.id)
          : [];

      const summaries: Array<Record<string, unknown>> = [];
      let totalEnqueued = 0;

      const runForTenant = async (tid?: string) => {
        const summary = await wrapPermanentErrors(() =>
          syncCallsWindow({
            from: fromDate,
            to: toDate,
            tenantId: tid,
            syncType: syncType ?? "scheduled",
          })
        );

        const pendingWhere = tid
          ? and(eq(calls.tenantId, tid), eq(calls.status, "answered"), isNull(callAnalyses.id))
          : and(eq(calls.status, "answered"), isNull(callAnalyses.id));

        const pending = await db
          .select({ recordingId: recordings.id, callId: calls.id })
          .from(calls)
          .innerJoin(recordings, eq(recordings.callId, calls.id))
          .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
          .where(pendingWhere)
          .limit(50);

        for (const item of pending) {
          await queues.recordingQueue.add(
            "process-recording",
            { recordingId: item.recordingId, callId: item.callId },
            { jobId: `rec-${item.recordingId}` }
          );
        }

        totalEnqueued += pending.length;
        summaries.push({ tenantId: tid ?? "default", ...summary, enqueuedRecordings: pending.length });
      };

      if (targetTenantIds.length === 0) {
        await runForTenant(undefined);
      } else {
        for (const tid of targetTenantIds) {
          try {
            await runForTenant(tid);
          } catch (err) {
            logger.error({ tenantId: tid, err }, "Multi-account scheduled sync failed for tenant");
            summaries.push({
              tenantId: tid,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      return { tenantsProcessed: summaries.length, totalEnqueued, summaries };
    },
    { connection, concurrency: 1 }
  );

  const recordingWorker = new Worker(
    "recording",
    async (job) => {
      const { recordingId, callId } = job.data as { recordingId: string; callId: string };
      const res = await wrapPermanentErrors(() => downloadAndValidateRecording(recordingId));
      await queues.transcriptionQueue.add(
        "transcribe-call",
        { callId },
        { jobId: `transcribe-${callId}-${res.checksum.slice(0, 12)}` }
      );
      return res;
    },
    { connection, concurrency: env.RECORDING_WORKER_CONCURRENCY }
  );

  const transcriptionWorker = new Worker(
    "transcription",
    async (job) => {
      const { callId } = job.data as { callId: string };
      const quota = await getDailyQuotaStatus();
      if (!quota.canTranscribe) {
        logger.warn({ callId, reason: quota.blockedReason }, "Daily/hourly transcription quota reached; deferring job");
        throw new Error(quota.blockedReason ?? "Daily transcription quota reached");
      }
      const transcript = await wrapPermanentErrors(() => transcribeCallRecording(callId));
      await queues.analysisQueue.add(
        "analyze-call",
        { callId },
        { jobId: `analyze-${callId}-${transcript.id}` }
      );
      return { transcriptId: transcript.id };
    },
    {
      connection,
      concurrency: env.TRANSCRIPTION_WORKER_CONCURRENCY,
      limiter: { max: env.TRANSCRIPTION_RPM_LIMIT, duration: 60_000 },
    }
  );

  const analysisWorker = new Worker(
    "analysis",
    async (job) => {
      const { callId } = job.data as { callId: string };
      const quota = await getDailyQuotaStatus();
      if (!quota.canAnalyze) {
        logger.warn({ callId, reason: quota.blockedReason }, "Daily analysis quota reached; deferring job");
        throw new Error(quota.blockedReason ?? "Daily analysis quota reached");
      }
      const analysis = await wrapPermanentErrors(() => analyzeCallTranscript(callId));
      return { analysisId: analysis.id };
    },
    {
      connection,
      concurrency: env.ANALYSIS_WORKER_CONCURRENCY,
      limiter: { max: env.ANALYSIS_RPM_LIMIT, duration: 60_000 },
    }
  );

  const workers = [syncWorker, recordingWorker, transcriptionWorker, analysisWorker];
  for (const w of workers) {
    w.on("completed", (job, result) => {
      logger.info({ queue: w.name, jobId: job.id, result }, "Background job completed");
    });
    w.on("failed", (job, err) => {
      logger.error({ queue: w.name, jobId: job?.id, err: err.message }, "Background job failed");
    });
  }

  await registerScheduledJobs();
  logger.info("SmartFlow BullMQ workers started");

  const shutdown = async () => {
    logger.info("Shutting down workers...");
    await Promise.all(workers.map((w) => w.close()));
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Worker startup failed");
  process.exit(1);
});

