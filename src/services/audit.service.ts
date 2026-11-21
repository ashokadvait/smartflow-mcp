import { db } from "../db/client.js";
import { toolAuditLogs } from "../db/schema/index.js";
import { logger } from "../utils/logger.js";
import { redactParameters } from "../utils/pii.js";

export async function recordToolAudit(entry: {
  tenantId?: string | null;
  actor: string;
  toolName: string;
  parameters: unknown;
  outcome: "success" | "error" | "denied";
  durationMs: number;
}): Promise<void> {
  try {
    await db.insert(toolAuditLogs).values({
      tenantId: entry.tenantId ?? null,
      actor: entry.actor,
      toolName: entry.toolName,
      parametersRedacted: redactParameters(entry.parameters),
      outcome: entry.outcome,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
    });
  } catch (err) {
    logger.warn({ err, toolName: entry.toolName }, "Failed to write tool audit log");
  }
}

