import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("tenants_name_unique").on(t.name)]
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    agentNumber: text("agent_number"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("agents_tenant_external_unique").on(t.tenantId, t.externalId),
    index("agents_tenant_number_idx").on(t.tenantId, t.agentNumber),
  ]
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name"),
    phoneEncrypted: text("phone_encrypted"),
    phoneHash: text("phone_hash"),
    source: text("source"),
    currentStage: text("current_stage").notNull().default("new"),
    priorityScore: integer("priority_score"),
    priorityScoreVersion: text("priority_score_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("leads_tenant_external_unique").on(t.tenantId, t.externalId),
    index("leads_tenant_phone_hash_idx").on(t.tenantId, t.phoneHash),
    index("leads_tenant_stage_idx").on(t.tenantId, t.currentStage),
    index("leads_tenant_priority_idx").on(t.tenantId, t.priorityScore),
  ]
);

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    smartfloUuid: text("smartflo_uuid"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    status: text("status").notNull(), // answered | missed | failed | other
    rawStatus: text("raw_status"),
    direction: text("direction"), // inbound | outbound
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    answeredSeconds: integer("answered_seconds"),
    disposition: text("disposition"),
    hangupCause: text("hangup_cause"),
    service: text("service"),
    campaignId: text("campaign_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("calls_tenant_external_unique").on(t.tenantId, t.externalId),
    index("calls_tenant_started_at_idx").on(t.tenantId, t.startedAt),
    index("calls_agent_started_idx").on(t.agentId, t.startedAt),
    index("calls_lead_started_idx").on(t.leadId, t.startedAt),
    index("calls_status_idx").on(t.status),
  ]
);

export const recordings = pgTable(
  "recordings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    sourceUrlEncrypted: text("source_url_encrypted"),
    storageKey: text("storage_key"),
    status: text("status").notNull().default("pending"), // pending | downloaded | failed | missing
    checksum: text("checksum"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("recordings_call_id_idx").on(t.callId),
    index("recordings_checksum_idx").on(t.checksum),
    index("recordings_status_idx").on(t.status),
  ]
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id").references(() => recordings.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    language: text("language"),
    durationSeconds: integer("duration_seconds"),
    content: text("content").notNull(),
    contentHash: text("content_hash"),
    segmentsJson: jsonb("segments_json").$type<TranscriptSegment[]>(),
    qualityFlag: text("quality_flag").default("ok"), // ok | low_quality | uncertain | empty
    status: text("status").notNull().default("completed"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("transcripts_call_id_idx").on(t.callId),
    index("transcripts_content_hash_idx").on(t.contentHash),
  ]
);

export const callAnalyses = pgTable(
  "call_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    transcriptId: uuid("transcript_id").references(() => transcripts.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    rubricVersion: text("rubric_version").notNull().default("rubric-v1"),
    intent: text("intent").notNull(),
    sentiment: text("sentiment").notNull(),
    leadTemperature: text("lead_temperature").notNull(),
    callOutcome: text("call_outcome").notNull(),
    qualityScore: integer("quality_score").notNull(),
    conversionProbability: integer("conversion_probability").notNull(),
    analysisJson: jsonb("analysis_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("call_analyses_call_id_idx").on(t.callId),
    index("call_analyses_outcome_idx").on(t.callOutcome),
    index("call_analyses_temperature_idx").on(t.leadTemperature),
  ]
);

export const followups = pgTable(
  "followups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    reason: text("reason").notNull(),
    action: text("action"),
    status: text("status").notNull().default("pending"), // pending | completed | missed | cancelled
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("followups_tenant_status_due_idx").on(t.tenantId, t.status, t.dueAt),
    index("followups_lead_id_idx").on(t.leadId),
  ]
);

export const leadStageHistory = pgTable(
  "lead_stage_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    source: text("source").notNull(), // crm | smartflow_disposition | manual
    notes: text("notes"),
  },
  (t) => [index("lead_stage_history_lead_changed_idx").on(t.leadId, t.changedAt)]
);

export const callEvents = pgTable(
  "call_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>(),
    eventAt: timestamp("event_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("call_events_call_id_idx").on(t.callId)]
);

export const syncLogs = pgTable(
  "sync_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    syncType: text("sync_type").notNull(),
    rangeFrom: timestamp("range_from", { withTimezone: true }),
    rangeTo: timestamp("range_to", { withTimezone: true }),
    cursor: text("cursor"),
    status: text("status").notNull(), // running | success | partial | failed
    fetchedCount: integer("fetched_count").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("sync_logs_tenant_started_idx").on(t.tenantId, t.startedAt)]
);

export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    task: text("task").notNull(), // transcription | analysis
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    fallbackProvider: text("fallback_provider"),
    configJson: jsonb("config_json").$type<Record<string, unknown>>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("provider_configs_tenant_task_idx").on(t.tenantId, t.task)]
);

export const toolAuditLogs = pgTable(
  "tool_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    toolName: text("tool_name").notNull(),
    parametersRedacted: jsonb("parameters_redacted").$type<Record<string, unknown>>(),
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tool_audit_logs_created_idx").on(t.createdAt)]
);

