import { and, eq } from "drizzle-orm";
import { db, getOrCreateDefaultTenant } from "../db/client.js";
import { agents, calls, leads, recordings, syncLogs } from "../db/schema/index.js";
import { SmartFlowClient } from "../integrations/smartflow/client.js";
import type { SmartFlowAgent, SmartFlowCall } from "../integrations/smartflow/types.js";
import { logger } from "../utils/logger.js";
import { encryptSecret, hashPhone, normalizePhone } from "../utils/pii.js";
import { getSmartFlowClientForTenant } from "./account.service.js";

export interface SyncSummary {
  syncLogId: string;
  from: Date;
  to: Date;
  callsFetched: number;
  newCalls: number;
  updatedCalls: number;
  agentsSynced: number;
  recordingUrlsFound: number;
  missingAudio: number;
  status: "success" | "partial" | "failed";
}

export async function upsertAgents(tenantId: string, incoming: SmartFlowAgent[]): Promise<number> {
  let count = 0;
  for (const agent of incoming) {
    await db
      .insert(agents)
      .values({
        tenantId,
        externalId: agent.externalId,
        name: agent.name,
        email: agent.email ?? null,
        agentNumber: agent.agentNumber ?? null,
        active: agent.active,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agents.tenantId, agents.externalId],
        set: {
          name: agent.name,
          email: agent.email ?? null,
          agentNumber: agent.agentNumber ?? null,
          active: agent.active,
          updatedAt: new Date(),
        },
      });
    count += 1;
  }
  return count;
}

async function resolveAgentId(tenantId: string, call: SmartFlowCall): Promise<string | null> {
  if (call.agentExternalId) {
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.externalId, call.agentExternalId)))
      .limit(1);
    if (existing[0]) return existing[0].id;
  }

  if (call.agentNumber) {
    const byNumber = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.agentNumber, call.agentNumber)))
      .limit(1);
    if (byNumber[0]) return byNumber[0].id;
  }

  if (call.agentExternalId || call.agentNumber) {
    const externalId = call.agentExternalId ?? call.agentNumber!;
    const [inserted] = await db
      .insert(agents)
      .values({
        tenantId,
        externalId,
        name: call.agentName ?? `Agent ${externalId}`,
        email: call.agentEmail ?? null,
        agentNumber: call.agentNumber ?? null,
        active: true,
      })
      .onConflictDoNothing()
      .returning({ id: agents.id });

    if (inserted) return inserted.id;
    const retry = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.externalId, externalId)))
      .limit(1);
    return retry[0]?.id ?? null;
  }

  return null;
}

async function resolveLeadId(tenantId: string, call: SmartFlowCall): Promise<string | null> {
  const normalizedPhone = call.phone ? normalizePhone(call.phone) : "";
  const phoneHashVal = normalizedPhone ? hashPhone(normalizedPhone) : null;
  const externalId = call.leadExternalId ?? (phoneHashVal ? `phone:${phoneHashVal.slice(0, 24)}` : null);

  if (!externalId) return null;

  if (phoneHashVal) {
    const byPhone = await db
      .select({ id: leads.id, name: leads.name })
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.phoneHash, phoneHashVal)))
      .limit(1);
    if (byPhone[0]) {
      if (call.leadName && !byPhone[0].name) {
        await db
          .update(leads)
          .set({ name: call.leadName, updatedAt: new Date() })
          .where(eq(leads.id, byPhone[0].id));
      }
      return byPhone[0].id;
    }
  }

  const byExternal = await db
    .select({ id: leads.id, name: leads.name })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.externalId, externalId)))
    .limit(1);
  if (byExternal[0]) {
    if (call.leadName && !byExternal[0].name) {
      await db
        .update(leads)
        .set({ name: call.leadName, updatedAt: new Date() })
        .where(eq(leads.id, byExternal[0].id));
    }
    return byExternal[0].id;
  }

  const [inserted] = await db
    .insert(leads)
    .values({
      tenantId,
      externalId,
      name: call.leadName ?? null,
      phoneEncrypted: normalizedPhone ? encryptSecret(normalizedPhone) : null,
      phoneHash: phoneHashVal,
      source: call.campaignId ?? call.service ?? "smartflo",
      currentStage: "new",
    })
    .onConflictDoNothing()
    .returning({ id: leads.id });

  if (inserted) return inserted.id;
  const retry = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.externalId, externalId)))
    .limit(1);
  return retry[0]?.id ?? null;
}

export async function upsertNormalizedCall(
  tenantId: string,
  call: SmartFlowCall
): Promise<{ callId: string; isNew: boolean; hasRecording: boolean }> {
  const agentId = await resolveAgentId(tenantId, call);
  const leadId = await resolveLeadId(tenantId, call);

  const existing = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.externalId, call.externalId)))
    .limit(1);

  const isNew = !existing[0];

  const [upserted] = await db
    .insert(calls)
    .values({
      tenantId,
      externalId: call.externalId,
      smartfloUuid: call.smartfloUuid ?? null,
      agentId,
      leadId,
      status: call.status,
      rawStatus: call.rawStatus ?? null,
      direction: call.direction ?? null,
      startedAt: call.startedAt,
      endedAt: call.endedAt ?? null,
      durationSeconds: call.durationSeconds ?? null,
      answeredSeconds: call.answeredSeconds ?? null,
      disposition: call.disposition ?? null,
      hangupCause: call.hangupCause ?? null,
      service: call.service ?? null,
      campaignId: call.campaignId ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [calls.tenantId, calls.externalId],
      set: {
        smartfloUuid: call.smartfloUuid ?? null,
        agentId,
        leadId,
        status: call.status,
        rawStatus: call.rawStatus ?? null,
        direction: call.direction ?? null,
        endedAt: call.endedAt ?? null,
        durationSeconds: call.durationSeconds ?? null,
        answeredSeconds: call.answeredSeconds ?? null,
        disposition: call.disposition ?? null,
        hangupCause: call.hangupCause ?? null,
        service: call.service ?? null,
        campaignId: call.campaignId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: calls.id });

  const callId = upserted!.id;
  const hasRecording = Boolean(call.recordingUrl);

  if (call.recordingUrl) {
    const existingRec = await db
      .select({ id: recordings.id })
      .from(recordings)
      .where(eq(recordings.callId, callId))
      .limit(1);

    const encryptedUrl = encryptSecret(call.recordingUrl);
    if (!existingRec[0]) {
      await db.insert(recordings).values({
        callId,
        sourceUrlEncrypted: encryptedUrl,
        status: "pending",
      });
    } else {
      await db
        .update(recordings)
        .set({ sourceUrlEncrypted: encryptedUrl, updatedAt: new Date() })
        .where(eq(recordings.id, existingRec[0].id));
    }
  }

  return { callId, isNew, hasRecording };
}

export async function syncCallsWindow(params: {
  from: Date;
  to: Date;
  tenantId?: string;
  syncType?: string;
  syncAgentsFirst?: boolean;
  client?: SmartFlowClient;
}): Promise<SyncSummary> {
  const targetTenantId = params.tenantId ?? (await getOrCreateDefaultTenant()).id;
  let tenant: { id: string; timezone: string };
  let client: SmartFlowClient;

  if (params.client) {
    const def = await getOrCreateDefaultTenant();
    tenant = { id: targetTenantId, timezone: def.timezone };
    client = params.client;
  } else {
    const resolved = await getSmartFlowClientForTenant(targetTenantId);
    tenant = { id: resolved.tenant.id, timezone: resolved.tenant.timezone };
    client = resolved.client;
  }

  const [logRow] = await db
    .insert(syncLogs)
    .values({
      tenantId: tenant.id,
      syncType: params.syncType ?? "calls",
      rangeFrom: params.from,
      rangeTo: params.to,
      status: "running",
    })
    .returning({ id: syncLogs.id });

  const syncLogId = logRow!.id;
  let agentsSynced = 0;
  let newCalls = 0;
  let updatedCalls = 0;
  let recordingUrlsFound = 0;
  let missingAudio = 0;

  try {
    if (params.syncAgentsFirst !== false) {
      try {
        const fetchedAgents = await client.getAgents();
        agentsSynced = await upsertAgents(tenant.id, fetchedAgents);
      } catch (err) {
        logger.warn({ err }, "Failed to sync Smartflo users; continuing with CDR sync");
      }
    }

    const fetchedCalls = await client.getAllCalls({
      from: params.from,
      to: params.to,
      timezone: tenant.timezone,
    });

    for (const call of fetchedCalls) {
      const res = await upsertNormalizedCall(tenant.id, call);
      if (res.isNew) newCalls += 1;
      else updatedCalls += 1;
      if (res.hasRecording) recordingUrlsFound += 1;
      else missingAudio += 1;
    }

    await db
      .update(syncLogs)
      .set({
        status: "success",
        fetchedCount: fetchedCalls.length,
        insertedCount: newCalls,
        updatedCount: updatedCalls,
        finishedAt: new Date(),
      })
      .where(eq(syncLogs.id, syncLogId));

    return {
      syncLogId,
      from: params.from,
      to: params.to,
      callsFetched: fetchedCalls.length,
      newCalls,
      updatedCalls,
      agentsSynced,
      recordingUrlsFound,
      missingAudio,
      status: "success",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncLogs)
      .set({
        status: "failed",
        insertedCount: newCalls,
        updatedCount: updatedCalls,
        errorSummary: message.slice(0, 1000),
        finishedAt: new Date(),
      })
      .where(eq(syncLogs.id, syncLogId));
    throw err;
  }
}

