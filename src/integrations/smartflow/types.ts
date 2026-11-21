export type NormalizedCallStatus = "answered" | "missed" | "failed" | "other";

export interface SmartFlowCall {
  externalId: string;
  smartfloUuid?: string;
  agentExternalId?: string;
  agentNumber?: string;
  agentName?: string;
  agentEmail?: string;
  leadExternalId?: string;
  leadName?: string;
  phone?: string;
  status: NormalizedCallStatus;
  rawStatus?: string;
  direction?: "inbound" | "outbound";
  startedAt: Date;
  endedAt?: Date;
  durationSeconds?: number;
  answeredSeconds?: number;
  recordingUrl?: string;
  disposition?: string;
  hangupCause?: string;
  service?: string;
  campaignId?: string;
}

export interface SmartFlowAgent {
  externalId: string;
  name: string;
  email?: string;
  agentNumber?: string;
  active: boolean;
}

export interface SmartfloRawCallRecord {
  id?: string | number;
  call_id?: string;
  uuid?: string;
  direction?: string | null;
  call_type?: string | null;
  status?: string | null;
  description?: string;
  detailed_description?: string | null;
  recording_url?: string | null;
  service?: string | null;
  date?: string;
  time?: string;
  start_stamp?: string;
  end_stamp?: string;
  call_duration?: number | string | null;
  answered_seconds?: number | string | null;
  agent_number?: string | null;
  agent_name?: string | null;
  answered_agent?: { id?: string | number; name?: string; agent_number?: string; email?: string } | null;
  answered_agent_name?: string | null;
  answered_agent_number?: string | null;
  answered_agent_email?: string | null;
  client_number?: string | null;
  caller_id_number?: string | null;
  call_to_number?: string | null;
  hangup_cause?: string | null;
  disposition?: string | null;
  disposition_name?: string | null;
  custom_status?: string | null;
  department_name?: string | null;
  notes?: string | null;
  u_contact_id?: string | number | null;
  u_contact_name?: string | null;
  campaign_id?: string | number | null;
  ref_id?: string | null;
  lead_id?: string | number | null;
  [key: string]: unknown;
}

export interface SmartfloRawUser {
  id?: string | number;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  agent?: {
    id?: string | number;
    follow_me_number?: string;
    intercom?: string;
  };
  agent_number?: string;
  extension?: string;
  status?: boolean | number | string;
  user_status?: boolean | number | string;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface SmartfloCdrPageResponse {
  count?: number;
  limit?: number;
  size?: number;
  page?: number;
  results?: SmartfloRawCallRecord[];
  data?: SmartfloRawCallRecord[];
}
