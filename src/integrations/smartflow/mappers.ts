import { parseSmartfloTimestamp } from "../../utils/dates.js";
import type {
  NormalizedCallStatus,
  SmartFlowAgent,
  SmartFlowCall,
  SmartfloRawCallRecord,
  SmartfloRawUser,
} from "./types.js";

export function normalizeCallStatus(raw?: string | null, answeredSeconds?: number): NormalizedCallStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "answered" || s === "completed" || s === "connected") {
    return "answered";
  }
  if (s === "missed" || s === "no_answer" || s === "no-answer" || s === "unanswered" || s === "cancel" || s === "cancelled") {
    return "missed";
  }
  if (s === "failed" || s === "busy" || s === "rejected" || s === "congestion" || s === "error") {
    return "failed";
  }
  if (answeredSeconds && answeredSeconds > 0) {
    return "answered";
  }
  return "other";
}

export function normalizeDirection(raw?: string | null): "inbound" | "outbound" | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.includes("in")) return "inbound";
  if (s.includes("out") || s.includes("click") || s.includes("dial")) return "outbound";
  return undefined;
}

function toOptionalInt(val: unknown): number | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
}

export function mapSmartfloCallRecord(
  raw: SmartfloRawCallRecord,
  timezone = "Asia/Kolkata"
): SmartFlowCall {
  const externalId = String(raw.id ?? raw.call_id ?? raw.uuid ?? "").trim();
  if (!externalId) {
    throw new Error("Smartflo call record missing id/call_id/uuid");
  }

  const startedAt =
    parseSmartfloTimestamp(raw.start_stamp ?? raw.date, raw.start_stamp ? undefined : raw.time, timezone) ??
    new Date();
  const endedAt = parseSmartfloTimestamp(raw.end_stamp, undefined, timezone) ?? undefined;

  const durationSeconds = toOptionalInt(raw.call_duration);
  const answeredSeconds = toOptionalInt(raw.answered_seconds);
  const status = normalizeCallStatus(raw.status, answeredSeconds);

  const agentNumber =
    raw.answered_agent?.agent_number ??
    raw.answered_agent_number ??
    raw.agent_number ??
    undefined;
  const agentName =
    raw.answered_agent?.name ??
    raw.answered_agent_name ??
    raw.agent_name ??
    undefined;
  const agentEmail =
    raw.answered_agent?.email ??
    raw.answered_agent_email ??
    undefined;
  const agentExternalId = raw.answered_agent?.id
    ? String(raw.answered_agent.id)
    : agentNumber ?? undefined;

  const direction = normalizeDirection(raw.direction ?? raw.call_type);
  const phone =
    raw.client_number ??
    (direction === "inbound" ? raw.caller_id_number : raw.call_to_number) ??
    raw.caller_id_number ??
    undefined;

  const disposition =
    raw.disposition_name ?? raw.disposition ?? raw.custom_status ?? raw.notes ?? undefined;
  const leadName = raw.u_contact_name?.trim() || undefined;
  const leadExternalId =
    raw.lead_id
      ? String(raw.lead_id)
      : raw.u_contact_id && String(raw.u_contact_id).trim() !== ""
        ? `contact:${String(raw.u_contact_id).trim()}`
        : raw.ref_id
          ? String(raw.ref_id)
          : undefined;
  const campaignOrDept = raw.campaign_id
    ? String(raw.campaign_id)
    : raw.department_name?.trim() || undefined;

  return {
    externalId,
    smartfloUuid: raw.uuid ? String(raw.uuid) : undefined,
    agentExternalId,
    agentNumber: agentNumber ?? undefined,
    agentName: agentName ?? undefined,
    agentEmail: agentEmail ?? undefined,
    leadExternalId,
    leadName,
    phone: phone ?? undefined,
    status,
    rawStatus: raw.status ?? undefined,
    direction,
    startedAt,
    endedAt,
    durationSeconds,
    answeredSeconds,
    recordingUrl: raw.recording_url ? String(raw.recording_url) : undefined,
    disposition: disposition ?? undefined,
    hangupCause: raw.hangup_cause ? String(raw.hangup_cause) : undefined,
    service: raw.service ? String(raw.service) : undefined,
    campaignId: campaignOrDept,
  };
}

export function mapSmartfloUser(raw: SmartfloRawUser): SmartFlowAgent {
  const externalId = String(raw.id ?? raw.agent?.id ?? raw.email ?? "").trim();
  if (!externalId) {
    throw new Error("Smartflo user record missing id");
  }

  const fullName =
    raw.name?.trim() ||
    [raw.first_name, raw.last_name].filter(Boolean).join(" ").trim() ||
    raw.email ||
    `Agent ${externalId}`;

  const rawStatus = raw.user_status ?? raw.status ?? raw.is_active;
  const active =
    rawStatus === undefined
      ? true
      : rawStatus === true || rawStatus === 1 || String(rawStatus).toLowerCase() === "active" || String(rawStatus) === "true";

  return {
    externalId,
    name: fullName,
    email: raw.email ?? undefined,
    agentNumber: raw.agent_number ?? raw.agent?.follow_me_number ?? raw.extension ?? undefined,
    active,
  };
}

