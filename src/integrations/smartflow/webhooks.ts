import { z } from "zod";
import { mapSmartfloCallRecord } from "./mappers.js";
import type { SmartFlowCall, SmartfloRawCallRecord } from "./types.js";

export const SmartfloWebhookPayloadSchema = z
  .object({
    uuid: z.string().optional(),
    call_id: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    ref_id: z.string().optional().nullable(),
    direction: z.string().optional().nullable(),
    call_type: z.string().optional().nullable(),
    answered: z.union([z.boolean(), z.string(), z.number()]).optional(),
    status: z.string().optional().nullable(),
    caller_id_number: z.string().optional().nullable(),
    call_to_number: z.string().optional().nullable(),
    client_number: z.string().optional().nullable(),
    agent: z.string().optional().nullable(),
    agent_number: z.string().optional().nullable(),
    answered_agent_name: z.string().optional().nullable(),
    answered_agent_email: z.string().optional().nullable(),
    hangup_cause: z.string().optional().nullable(),
    recording_url: z.string().optional().nullable(),
    start_stamp: z.string().optional().nullable(),
    end_stamp: z.string().optional().nullable(),
    call_duration: z.union([z.number(), z.string()]).optional().nullable(),
    answered_seconds: z.union([z.number(), z.string()]).optional().nullable(),
    disposition: z.string().optional().nullable(),
  })
  .passthrough();

export type SmartfloWebhookPayload = z.infer<typeof SmartfloWebhookPayloadSchema>;

export function parseSmartfloWebhook(
  body: unknown,
  timezone = "Asia/Kolkata"
): { call: SmartFlowCall; raw: SmartfloWebhookPayload } {
  const parsed = SmartfloWebhookPayloadSchema.parse(body);

  const inferredStatus =
    parsed.status ??
    (parsed.answered === true || parsed.answered === "true" || parsed.answered === 1
      ? "answered"
      : parsed.answered === false || parsed.answered === "false" || parsed.answered === 0
        ? "missed"
        : undefined);

  const rawRecord: SmartfloRawCallRecord = {
    ...parsed,
    id: parsed.id ?? parsed.call_id ?? parsed.uuid,
    status: inferredStatus,
    agent_number: parsed.agent_number ?? parsed.agent ?? undefined,
    start_stamp: parsed.start_stamp ?? undefined,
    end_stamp: parsed.end_stamp ?? undefined,
  };

  const call = mapSmartfloCallRecord(rawRecord, timezone);
  return { call, raw: parsed };
}

