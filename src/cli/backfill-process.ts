import { closeDb } from "../db/client.js";
import { runDailyBatchWorkerPool } from "../services/backfill.service.js";
import { getDailyQuotaStatus } from "../services/quota.service.js";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePositiveInt(flag: string): number | undefined {
  const raw = parseArg(flag);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function main() {
  const account = parseArg("--account");
  const batchSize = parsePositiveInt("--batch-size") ?? 200;
  const concurrency = parsePositiveInt("--concurrency");
  const transcribeOnly = hasFlag("--transcribe-only");
  const cleanupAudio = hasFlag("--cleanup-audio");
  const dryRun = hasFlag("--dry-run");
  const order = parseArg("--order") === "oldest" ? "oldest" : "newest";

  const quotaOverrides = {
    dailyTranscriptions: parsePositiveInt("--daily-limit"),
    dailyAudioSeconds: parsePositiveInt("--daily-audio-seconds"),
    hourlyAudioSeconds: parsePositiveInt("--hourly-audio-seconds"),
    dailyAnalyses: parsePositiveInt("--daily-analysis-limit"),
  };

  if (hasFlag("--status-only")) {
    const status = await getDailyQuotaStatus(quotaOverrides);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log("=== SmartFlow Daily-Limited Batch Transcription & Analysis ===");
  console.log(`Account:     ${account ?? "all active accounts"}`);
  console.log(`Batch size:  ${batchSize} | Workers: ${concurrency ?? "default (env)"} | Order: ${order}`);
  console.log(`Mode:        ${transcribeOnly ? "transcribe-only" : "transcribe + analyze"}${cleanupAudio ? " | cleanup-audio" : ""}${dryRun ? " | DRY RUN" : ""}`);
  console.log("");

  const result = await runDailyBatchWorkerPool({
    account,
    batchSize,
    transcribeConcurrency: concurrency,
    downloadConcurrency: concurrency,
    analyzeConcurrency: concurrency,
    transcribeOnly,
    cleanupAudio,
    order,
    quotaOverrides,
    dryRun,
    onItemComplete: (info) => {
      if (info.status === "ok") {
        console.log(
          `[${info.index}/${info.total}] OK ${info.callId} | tr=${info.transcribed ? "yes" : "cached"} an=${info.analyzed ? "yes" : "skip"} audio=${info.audioSeconds ?? "?"}s outcome=${info.outcome ?? "-"}`
        );
      } else if (info.status === "skipped_quota") {
        console.warn(`[${info.index}/${info.total}] QUOTA STOP ${info.callId}: ${info.error}`);
      } else {
        console.error(`[${info.index}/${info.total}] FAIL ${info.callId}: ${info.error}`);
      }
    },
  });

  console.log("\n=== Batch Summary ===");
  console.log(`Pending before:     ${result.totalPendingBefore}`);
  console.log(`Targeted in batch:  ${result.batchTargeted}`);
  console.log(`Processed OK:       ${result.processed} (transcribed=${result.transcribed}, analyzed=${result.analyzed})`);
  console.log(`Failed:             ${result.failed}`);
  console.log(`Stopped by quota:   ${result.skippedQuota} (reason: ${result.stoppedReason})`);
  console.log(`Remaining pending:  ${result.remainingPending}`);
  console.log(`Duration:           ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log("\n=== Daily Quota Status (Rolling 24h / 1h) ===");
  console.log(
    `Transcriptions:     ${result.quotaAfter.transcriptions.used}/${result.quotaAfter.transcriptions.limit} (remaining: ${result.quotaAfter.transcriptions.remaining})`
  );
  console.log(
    `Audio sec (24h):    ${result.quotaAfter.audioSecondsDaily.used}s/${result.quotaAfter.audioSecondsDaily.limit}s (remaining: ${result.quotaAfter.audioSecondsDaily.remaining}s)`
  );
  console.log(
    `Audio sec (1h):     ${result.quotaAfter.audioSecondsHourly.used}s/${result.quotaAfter.audioSecondsHourly.limit}s (remaining: ${result.quotaAfter.audioSecondsHourly.remaining}s)`
  );
  console.log(
    `Analyses (24h):     ${result.quotaAfter.analyses.used}/${result.quotaAfter.analyses.limit} (remaining: ${result.quotaAfter.analyses.remaining})`
  );
}

main()
  .catch((err) => {
    console.error("Batch worker failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

