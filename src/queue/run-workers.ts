import { UnrecoverableError, Worker } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { callAnalyses, calls, recordings } from "../db/schema/index.js";
import { analyzeCallTranscript } from "../pipeline/analysis.pipeline.js";
import { downloadAndValidateRecording } from "../pipeline/recording.pipeline.js";
import { transcribeCallRecording } from "../pipeline/transcription.pipeline.js";
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
      const { from, to, windowMinutes, tenantId, syncType } = job.data as {
        from?: string;
        to?: string;
        windowMinutes?: number;
        tenantId?: string;
        syncType?: string;
      };
      const toDate = to ? new Date(to) : new Date();
      const fromDate = from
        ? new Date(from)
        : new Date(toDate.getTime() - (windowMinutes ?? 60) * 60 * 1000);
      const summary = await wrapPermanentErrors(() =>
        syncCallsWindow({
          from: fromDate,
          to: toDate,
          tenantId,
          syncType: syncType ?? "scheduled",
        })
      );

      // Enqueue pending answered recordings automatically (deterministic jobId prevents duplicates)
      const pending = await db
        .select({ recordingId: recordings.id, callId: calls.id })
        .from(calls)
        .innerJoin(recordings, eq(recordings.callId, calls.id))
        .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
        .where(and(eq(calls.status, "answered"), isNull(callAnalyses.id)))
        .limit(50);

      for (const item of pending) {
        await queues.recordingQueue.add(
          "process-recording",
          { recordingId: item.recordingId, callId: item.callId },
          { jobId: `rec-${item.recordingId}` }
        );
      }

      return { ...summary, enqueuedRecordings: pending.length };
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
    { connection, concurrency: 3 }
  );

  const transcriptionWorker = new Worker(
    "transcription",
    async (job) => {
      const { callId } = job.data as { callId: string };
      const transcript = await wrapPermanentErrors(() => transcribeCallRecording(callId));
      await queues.analysisQueue.add(
        "analyze-call",
        { callId },
        { jobId: `analyze-${callId}-${transcript.id}` }
      );
      return { transcriptId: transcript.id };
    },
    { connection, concurrency: 2 }
  );

  const analysisWorker = new Worker(
    "analysis",
    async (job) => {
      const { callId } = job.data as { callId: string };
      const analysis = await wrapPermanentErrors(() => analyzeCallTranscript(callId));
      return { analysisId: analysis.id };
    },
    { connection, concurrency: 2 }
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

