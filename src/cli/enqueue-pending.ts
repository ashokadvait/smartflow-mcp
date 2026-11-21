import { and, desc, eq, isNull } from "drizzle-orm";
import { closeDb, db, getOrCreateDefaultTenant } from "../db/client.js";
import { callAnalyses, calls, recordings } from "../db/schema/index.js";
import { closeRedis, createQueues } from "../queue/queues.js";

function parseLimit(): number {
  const idx = process.argv.indexOf("--limit");
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 200);
  }
  return 10;
}

async function main() {
  const limit = parseLimit();
  const tenant = await getOrCreateDefaultTenant();
  const { recordingQueue } = createQueues();

  const pending = await db
    .select({ recordingId: recordings.id, callId: calls.id })
    .from(calls)
    .innerJoin(recordings, eq(recordings.callId, calls.id))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(and(eq(calls.tenantId, tenant.id), eq(calls.status, "answered"), isNull(callAnalyses.id)))
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  for (const item of pending) {
    await recordingQueue.add(
      "process-recording",
      { recordingId: item.recordingId, callId: item.callId },
      { jobId: `rec-${item.recordingId}` }
    );
  }

  console.log(`Enqueued ${pending.length} pending answered recordings into BullMQ 'recording' queue.`);
}

main()
  .catch((err) => {
    console.error("Failed to enqueue pending recordings:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await closeDb();
  });

