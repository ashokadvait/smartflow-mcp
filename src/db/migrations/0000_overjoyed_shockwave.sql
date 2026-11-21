CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"agent_number" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"transcript_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"rubric_version" text DEFAULT 'rubric-v1' NOT NULL,
	"intent" text NOT NULL,
	"sentiment" text NOT NULL,
	"lead_temperature" text NOT NULL,
	"call_outcome" text NOT NULL,
	"quality_score" integer NOT NULL,
	"conversion_probability" integer NOT NULL,
	"analysis_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb,
	"event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"smartflo_uuid" text,
	"agent_id" uuid,
	"lead_id" uuid,
	"status" text NOT NULL,
	"raw_status" text,
	"direction" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"answered_seconds" integer,
	"disposition" text,
	"hangup_cause" text,
	"service" text,
	"campaign_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid,
	"call_id" uuid,
	"due_at" timestamp with time zone,
	"reason" text NOT NULL,
	"action" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"phone_encrypted" text,
	"phone_hash" text,
	"source" text,
	"current_stage" text DEFAULT 'new' NOT NULL,
	"priority_score" integer,
	"priority_score_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"fallback_provider" text,
	"config_json" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"source_url_encrypted" text,
	"storage_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"checksum" text,
	"mime_type" text,
	"size_bytes" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sync_type" text NOT NULL,
	"range_from" timestamp with time zone,
	"range_to" timestamp with time zone,
	"cursor" text,
	"status" text NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor" text NOT NULL,
	"tool_name" text NOT NULL,
	"parameters_redacted" jsonb,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"recording_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"language" text,
	"duration_seconds" integer,
	"content" text NOT NULL,
	"content_hash" text,
	"segments_json" jsonb,
	"quality_flag" text DEFAULT 'ok',
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_analyses" ADD CONSTRAINT "call_analyses_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_analyses" ADD CONSTRAINT "call_analyses_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_audit_logs" ADD CONSTRAINT "tool_audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_tenant_external_unique" ON "agents" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "agents_tenant_number_idx" ON "agents" USING btree ("tenant_id","agent_number");--> statement-breakpoint
CREATE INDEX "call_analyses_call_id_idx" ON "call_analyses" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "call_analyses_outcome_idx" ON "call_analyses" USING btree ("call_outcome");--> statement-breakpoint
CREATE INDEX "call_analyses_temperature_idx" ON "call_analyses" USING btree ("lead_temperature");--> statement-breakpoint
CREATE INDEX "call_events_call_id_idx" ON "call_events" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_tenant_external_unique" ON "calls" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "calls_tenant_started_at_idx" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_agent_started_idx" ON "calls" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_lead_started_idx" ON "calls" USING btree ("lead_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_status_idx" ON "calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "followups_tenant_status_due_idx" ON "followups" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX "followups_lead_id_idx" ON "followups" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_stage_history_lead_changed_idx" ON "lead_stage_history" USING btree ("lead_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_tenant_external_unique" ON "leads" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "leads_tenant_phone_hash_idx" ON "leads" USING btree ("tenant_id","phone_hash");--> statement-breakpoint
CREATE INDEX "leads_tenant_stage_idx" ON "leads" USING btree ("tenant_id","current_stage");--> statement-breakpoint
CREATE INDEX "leads_tenant_priority_idx" ON "leads" USING btree ("tenant_id","priority_score");--> statement-breakpoint
CREATE INDEX "provider_configs_tenant_task_idx" ON "provider_configs" USING btree ("tenant_id","task");--> statement-breakpoint
CREATE INDEX "recordings_call_id_idx" ON "recordings" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "recordings_checksum_idx" ON "recordings" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "recordings_status_idx" ON "recordings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_logs_tenant_started_idx" ON "sync_logs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_name_unique" ON "tenants" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tool_audit_logs_created_idx" ON "tool_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "transcripts_call_id_idx" ON "transcripts" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "transcripts_content_hash_idx" ON "transcripts" USING btree ("content_hash");