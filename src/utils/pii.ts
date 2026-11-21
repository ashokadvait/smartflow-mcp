import crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getEncryptionKeyBuffer(overrideKey?: string): Buffer {
  const raw = overrideKey ?? env.ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    // Deterministic fallback only for test/dev if unset; warn in production
    if (env.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_KEY must be set to a 64-char hex string in production.");
    }
    return crypto.createHash("sha256").update(raw || "local-dev-insecure-key").digest();
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt sensitive string using AES-256-GCM. Output format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encryptSecret(plaintext: string, overrideKey?: string): string {
  const key = getEncryptionKeyBuffer(overrideKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(ciphertext: string, overrideKey?: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format.");
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const key = getEncryptionKeyBuffer(overrideKey);
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Normalize phone number to digits only (preserving country code if present).
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Deterministic HMAC-SHA256 hash of a normalized phone number for indexing/dedup without exposing PII.
 */
export function hashPhone(phone: string, overrideSecret?: string): string {
  const normalized = normalizePhone(phone);
  const secret = overrideSecret ?? (env.PHONE_HASH_SECRET || env.ENCRYPTION_KEY || "local-dev-hash-secret");
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

/**
 * Mask a phone number for general reports: e.g. "919876543210" -> "********3210"
 */
export function maskPhone(phone?: string | null): string {
  if (!phone) return "Unknown";
  const digits = normalizePhone(phone);
  if (digits.length <= 4) return "****";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Redact sensitive fields from tool/API parameters before writing to audit logs.
 */
export function redactParameters(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const sensitiveKeys = new Set([
    "apikey",
    "api_key",
    "token",
    "password",
    "secret",
    "authorization",
    "phone",
    "recordingurl",
    "recording_url",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (sensitiveKeys.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactParameters(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

