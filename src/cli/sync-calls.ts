import { closeDb } from "../db/client.js";
import { syncCallsWindow } from "../services/sync.service.js";
import { getDayBoundsUtc, getTodayYmd } from "../utils/dates.js";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main() {
  const fromArg = parseArg("--from") ?? getTodayYmd("Asia/Kolkata");
  const toArg = parseArg("--to") ?? fromArg;

  const fromBounds = getDayBoundsUtc(fromArg, "Asia/Kolkata");
  const toBounds = getDayBoundsUtc(toArg, "Asia/Kolkata");

  const summary = await syncCallsWindow({
    from: fromBounds.from,
    to: toBounds.to,
    syncType: "cli",
  });

  console.log("SmartFlow Sync");
  console.log(`Range: ${fromArg} to ${toArg} (Asia/Kolkata)`);
  console.log(`Calls fetched: ${summary.callsFetched}`);
  console.log(`New calls: ${summary.newCalls}`);
  console.log(`Updated calls: ${summary.updatedCalls}`);
  console.log(`Agents synced: ${summary.agentsSynced}`);
  console.log(`Recording URLs: ${summary.recordingUrlsFound}`);
  console.log(`Missing audio: ${summary.missingAudio}`);
  console.log(`Sync status: ${summary.status.toUpperCase()}`);
}

main()
  .catch((err) => {
    console.error("Sync failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

