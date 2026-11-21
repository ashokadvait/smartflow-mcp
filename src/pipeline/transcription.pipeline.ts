import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { recordings, transcripts } from "../db/schema/index.js";
import { getActiveTranscriptionProvider } from "../providers/registry.js";
import type { TranscriptionProvider } from "../providers/types.js";
import { PermanentJobError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { downloadAndValidateRecording } from "./recording.pipeline.js";

export async function transcribeCallRecording(
  callId: string,
  options: { provider?: TranscriptionProvider; force?: boolean; language?: string } = {}
) {
  const [rec] = await db
    .select()
    .from(recordings)
    .where(eq(recordings.callId, callId))
    .orderBy(desc(recordings.createdAt))
    .limit(1);

  if (!rec) {
    throw new PermanentJobError(`No recording metadata found for call ${callId}.`);
  }

  const downloaded = await downloadAndValidateRecording(rec.id);
  const provider = options.provider ?? getActiveTranscriptionProvider();

  // Checksum deduplication: skip re-transcribing identical audio unless forced
  if (!options.force) {
    const existing = await db
      .select()
      .from(transcripts)
      .where(
        and(
          eq(transcripts.callId, callId),
          eq(transcripts.recordingId, rec.id),
          eq(transcripts.provider, provider.name),
          eq(transcripts.model, provider.model),
          eq(transcripts.status, "completed")
        )
      )
      .orderBy(desc(transcripts.createdAt))
      .limit(1);

    if (existing[0]) {
      logger.info({ callId, transcriptId: existing[0].id }, "Reusing existing transcript");
      return existing[0];
    }
  }

  const result = await provider.transcribe({
    filePath: downloaded.filePath,
    language: options.language ?? (env.TRANSCRIPTION_LANGUAGE || undefined),
  });

  const cleanText = result.text.trim();
  const contentHash = crypto.createHash("sha256").update(cleanText).digest("hex");
  const qualityFlag =
    cleanText.length === 0 ? "empty" : cleanText.length < 25 ? "low_quality" : "ok";

  const [saved] = await db
    .insert(transcripts)
    .values({
      callId,
      recordingId: rec.id,
      provider: provider.name,
      model: provider.model,
      language: result.language ?? null,
      durationSeconds: result.durationSeconds ?? null,
      content: cleanText,
      contentHash,
      segmentsJson: result.segments ?? null,
      qualityFlag,
      status: "completed",
    })
    .returning();

  logger.info(
    { callId, transcriptId: saved?.id, provider: provider.name, language: result.language, qualityFlag },
    "Call transcribed and persisted"
  );
  return saved!;
}

