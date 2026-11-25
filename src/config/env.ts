import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DEFAULT_TENANT_NAME: z.string().default("Default Tenant"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Kolkata"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  SMARTFLOW_BASE_URL: z.string().url().default("https://api-smartflo.tatateleservices.com/v1"),
  SMARTFLOW_API_KEY: z.string().optional().default(""),
  SMARTFLOW_EMAIL: z.string().optional().default(""),
  SMARTFLOW_PASSWORD: z.string().optional().default(""),
  SMARTFLOW_ALLOWED_MEDIA_HOSTS: z.string().default("cloudphone.tatateleservices.com"),
  SMARTFLOW_RATE_LIMIT_RPS: z.coerce.number().min(1).max(100).default(5),
  SMARTFLOW_WEBHOOK_SECRET: z.string().optional().default(""),

  TRANSCRIPTION_PROVIDER: z.enum(["groq", "openai"]).default("groq"),
  TRANSCRIPTION_MODEL: z.string().default("whisper-large-v3-turbo"),
  TRANSCRIPTION_LANGUAGE: z.string().optional().default(""),
  TRANSCRIPTION_PROMPT: z.string().optional().default(""),

  ANALYSIS_PROVIDER: z.enum(["groq", "openai", "gemini", "ollama"]).default("groq"),
  ANALYSIS_MODEL: z.string().default("openai/gpt-oss-120b"),
  ANALYSIS_FALLBACK_PROVIDER: z.enum(["", "groq", "openai", "gemini", "ollama"]).default(""),

  GROQ_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_ANALYSIS_MODEL: z.string().default("gpt-4o-mini"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_ANALYSIS_MODEL: z.string().default("gemini-2.5-flash"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_ANALYSIS_MODEL: z.string().default("llama3.1"),

  AUDIO_STORAGE_PROVIDER: z.enum(["local"]).default("local"),
  AUDIO_STORAGE_PATH: z.string().default("./storage/audio"),
  MAX_AUDIO_SIZE_MB: z.coerce.number().min(1).max(200).default(25),

  MCP_API_KEY: z.string().optional().default(""),
  CRON_SECRET: z.string().optional().default(""),
  ENCRYPTION_KEY: z.string().optional().default(""),
  PHONE_HASH_SECRET: z.string().optional().default(""),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!cachedEnv) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const formatted = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid environment configuration: ${formatted}`);
    }
    cachedEnv = parsed.data;
  }
  return cachedEnv;
}

export const env = getEnv();

