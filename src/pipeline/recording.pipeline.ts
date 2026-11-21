import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { recordings } from "../db/schema/index.js";
import { PermanentJobError, TransientJobError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { decryptSecret } from "../utils/pii.js";

const ALLOWED_AUDIO_MIME_PREFIXES = ["audio/", "application/octet-stream", "video/mp4"];

export function validateRecordingUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PermanentJobError("Invalid recording URL format.");
  }

  if (parsed.protocol !== "https:") {
    throw new PermanentJobError(`Disallowed recording URL protocol: ${parsed.protocol}`);
  }

  const allowedHosts = env.SMARTFLOW_ALLOWED_MEDIA_HOSTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new PermanentJobError(`Recording host "${parsed.hostname}" is not in SSRF allowlist.`);
  }

  return parsed;
}

function guessExtension(mimeType?: string | null): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("wav")) return ".wav";
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("m4a") || m.includes("mp4")) return ".m4a";
  if (m.includes("webm")) return ".webm";
  return ".mp3";
}

export async function downloadAndValidateRecording(recordingId: string): Promise<{
  recordingId: string;
  filePath: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}> {
  const [rec] = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  if (!rec) {
    throw new PermanentJobError(`Recording ${recordingId} not found.`);
  }

  if (rec.status === "downloaded" && rec.storageKey && rec.checksum) {
    try {
      await fs.access(rec.storageKey);
      return {
        recordingId: rec.id,
        filePath: rec.storageKey,
        checksum: rec.checksum,
        sizeBytes: rec.sizeBytes ?? 0,
        mimeType: rec.mimeType ?? "audio/mpeg",
      };
    } catch {
      // File missing on disk; re-download below
    }
  }

  if (!rec.sourceUrlEncrypted) {
    await db
      .update(recordings)
      .set({ status: "missing", lastError: "No source URL", updatedAt: new Date() })
      .where(eq(recordings.id, rec.id));
    throw new PermanentJobError(`Recording ${rec.id} has no source URL.`);
  }

  const sourceUrl = decryptSecret(rec.sourceUrlEncrypted);
  const validatedUrl = validateRecordingUrl(sourceUrl);

  const response = await fetch(validatedUrl.toString(), {
    method: "GET",
    redirect: "manual", // Protect against SSRF open redirects
  });

  if (response.status >= 300 && response.status < 400) {
    throw new PermanentJobError(`Recording download attempted unsafe redirect (HTTP ${response.status}).`);
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await db
      .update(recordings)
      .set({ status: "failed", lastError: `HTTP ${response.status}`, updatedAt: new Date() })
      .where(eq(recordings.id, rec.id));
    throw new PermanentJobError(`Recording unavailable (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new TransientJobError(`Recording download failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "audio/mpeg";
  if (!ALLOWED_AUDIO_MIME_PREFIXES.some((prefix) => contentType.toLowerCase().startsWith(prefix))) {
    throw new PermanentJobError(`Unexpected recording MIME type: ${contentType}`);
  }

  const maxBytes = env.MAX_AUDIO_SIZE_MB * 1024 * 1024;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new PermanentJobError(`Recording exceeds max size limit (${env.MAX_AUDIO_SIZE_MB} MB).`);
  }

  // Stream with strict size bound
  const reader = response.body?.getReader();
  if (!reader) {
    throw new TransientJobError("Empty response body when downloading recording.");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const hash = crypto.createHash("sha256");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new PermanentJobError(`Recording stream exceeded max size (${env.MAX_AUDIO_SIZE_MB} MB).`);
      }
      hash.update(value);
      chunks.push(value);
    }
  }

  if (totalBytes === 0) {
    throw new PermanentJobError("Downloaded recording is empty (0 bytes).");
  }

  const checksum = hash.digest("hex");
  const storageDir = path.resolve(env.AUDIO_STORAGE_PATH);
  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });

  const ext = guessExtension(contentType);
  const filePath = path.join(storageDir, `${rec.callId}_${checksum.slice(0, 12)}${ext}`);
  const buffer = Buffer.concat(chunks);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });

  await db
    .update(recordings)
    .set({
      storageKey: filePath,
      status: "downloaded",
      checksum,
      mimeType: contentType,
      sizeBytes: totalBytes,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(recordings.id, rec.id));

  logger.info({ recordingId: rec.id, callId: rec.callId, sizeBytes: totalBytes }, "Recording downloaded");
  return { recordingId: rec.id, filePath, checksum, sizeBytes: totalBytes, mimeType: contentType };
}

