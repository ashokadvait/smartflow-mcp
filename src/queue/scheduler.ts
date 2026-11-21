import { getOrCreateDefaultTenant } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { createQueues } from "./queues.js";

/**
 * Registers repeatable BullMQ jobs:
 * 1) Incremental Smartflo reconciliation every 15 minutes (re-fetches last 60 min with overlap).
 * 2) Nightly reconciliation at 20:00 IST (14:30 UTC).
 */
export async function registerScheduledJobs() {
  const tenant = await getOrCreateDefaultTenant();
  const { syncQueue } = createQueues();

  await syncQueue.upsertJobScheduler(
    "smartflow-incremental-sync",
    { every: 15 * 60 * 1000 },
    {
      name: "sync-recent-window",
      data: {
        tenantId: tenant.id,
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
        tenantId: tenant.id,
        syncType: "nightly_reconciliation",
        windowMinutes: 24 * 60,
      },
    }
  );

  logger.info({ tenantId: tenant.id }, "Registered BullMQ repeatable sync & reconciliation schedules");
}

