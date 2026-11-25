CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"role" text DEFAULT 'tenant' NOT NULL,
	"tenant_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "smartflo_base_url" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "smartflo_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "smartflo_email_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "smartflo_password_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "smartflo_webhook_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "tenants" USING btree ("slug");