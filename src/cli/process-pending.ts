import { and, desc, eq, isNull } from "drizzle-orm";
import { closeDb, db, getOrCreateDefaultTenant } from "../db/client.js";
import { callAnalyses, calls, recordings } from "../db/schema/index.js";
import { analyzeCallTranscript } from "../pipeline/analysis.pipeline.js";
import { transcribeCallRecording } from "../pipeline/transcription.pipeline.js";

function parseLimit(): number {
  const idx = process.argv.indexOf("--limit");
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 100);
  }
  return 10;
}

async function main() {
  const limit = parseLimit();
  const tenant = await getOrCreateDefaultTenant();

  const pendingCalls = await db
    .select({
      callId: calls.id,
      externalId: calls.externalId,
      answeredSeconds: calls.answeredSeconds,
    })
    .from(calls)
    .innerJoin(recordings, eq(recordings.callId, calls.id))
    .leftJoin(callAnalyses, eq(callAnalyses.callId, calls.id))
    .where(
      and(
        eq(calls.tenantId, tenant.id),
        eq(calls.status, "answered"),
        isNull(callAnalyses.id)
      )
    )
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  console.log(`Found ${pendingCalls.length} answered calls pending transcription/analysis (limit=${limit}).`);

  let succeeded = 0;
  let failed = 0;

  for (const item of pendingCalls) {
    try {
      const t = await transcribeCallRecording(item.callId);
      const a = await analyzeCallTranscript(item.callId);
      console.log(
        `[OK] ${item.callId} | lang=${t.language ?? "?"} | outcome=${a.callOutcome} | temp=${a.leadTemperature} | qa=${a.qualityScore}/100`
      );
      succeeded += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FAIL] ${item.callId}: ${msg}`);
      failed += 1;
    }
  }

  console.log(`Done. Succeeded: ${succeeded}, Failed: ${failed}`);
}

main()
  .catch((err) => {
    console.error("Batch processing failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

