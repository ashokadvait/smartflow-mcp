import { logger } from "../utils/logger.js";
import { createQueues } from "./queues.js";

/**
 * Registers repeatable BullMQ jobs across all active Smartflo accounts:
 * 1) Incremental Smartflo reconciliation every 15 minutes (re-fetches last 60 min with overlap).
 * 2) Nightly reconciliation at 20:00 IST (14:30 UTC).
 */
export async function registerScheduledJobs() {
  const { syncQueue } = createQueues();

  await syncQueue.upsertJobScheduler(
    "smartflow-incremental-sync",
    { every: 15 * 60 * 1000 },
    {
      name: "sync-recent-window",
      data: {
        syncAllTenants: true,
        syncType: "reconciliation",
        windowMinutes: 60,
      },
    }
  );

  await syncQueue.upsertJobScheduler(
    "smartflow-nightly-reconcile",
    { pattern: "30 14 * * *" }, // 20:00 IST (UTC+5:30)
    {
      name: "sync-full-day-reconcile",
      data: {
        syncAllTenants: true,
        syncType: "nightly_reconciliation",
        windowMinutes: 24 * 60,
      },
    }
  );

  logger.info("Registered BullMQ repeatable multi-account sync & reconciliation schedules");
}
