import { closeDb } from "../db/client.js";
import { backfillCallsHistory } from "../services/backfill.service.js";
import { getDayBoundsUtc, getTodayYmd } from "../utils/dates.js";

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

function subtractDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const tz = "Asia/Kolkata";
  const account = parseArg("--account");
  const allAccounts = hasFlag("--all-accounts") || !account;
  const chunkDays = Math.max(1, Number(parseArg("--chunk-days") ?? 7));
  const order = parseArg("--order") === "oldest" ? "oldest" : "newest";

  const monthsArg = parseArg("--months");
  const daysArg = parseArg("--days");
  const toYmd = parseArg("--to") ?? getTodayYmd(tz);
  const fromYmd =
    parseArg("--from") ??
    subtractDaysYmd(
      toYmd,
      daysArg ? Number(daysArg) : Math.round((monthsArg ? Number(monthsArg) : 6) * 30.5)
    );

  const fromBounds = getDayBoundsUtc(fromYmd, tz);
  const toBounds = getDayBoundsUtc(toYmd, tz);

  console.log("=== SmartFlow Historical Call Backfill ===");
  console.log(`Account:    ${account ?? "all active accounts"}`);
  console.log(`Date range: ${fromYmd} to ${toYmd} (${tz})`);
  console.log(`Chunk size: ${chunkDays} day(s) | Order: ${order}`);
  console.log("");

  const result = await backfillCallsHistory({
    account,
    allAccounts,
    from: fromBounds.from,
    to: toBounds.to,
    chunkDays,
    order,
    onChunkComplete: (info) => {
      const f = info.from.toISOString().slice(0, 10);
      const t = info.to.toISOString().slice(0, 10);
      if (info.error) {
        console.error(
          `[${info.account}] Chunk ${info.chunkIndex}/${info.totalChunks} (${f}..${t}) FAILED: ${info.error}`
        );
      } else {
        console.log(
          `[${info.account}] Chunk ${info.chunkIndex}/${info.totalChunks} (${f}..${t}) | fetched=${info.callsFetched} new=${info.newCalls} updated=${info.updatedCalls} recs=${info.recordingUrlsFound}`
        );
      }
    },
  });

  console.log("\n=== Backfill Summary ===");
  console.log(`Accounts processed: ${result.accountsProcessed}`);
  console.log(`Chunks succeeded:   ${result.chunksSucceeded}/${result.chunksTotal} (failed: ${result.chunksFailed})`);
  console.log(`Total calls fetched:${result.callsFetched}`);
  console.log(`New calls stored:   ${result.newCalls}`);
  console.log(`Updated calls:      ${result.updatedCalls}`);
  console.log(`Recording URLs:     ${result.recordingUrlsFound}`);
  console.log(`Missing audio URLs: ${result.missingAudio}`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

