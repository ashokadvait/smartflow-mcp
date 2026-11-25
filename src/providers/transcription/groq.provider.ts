import { Groq } from "groq-sdk";
import { createReadStream } from "node:fs";
import { env } from "../../config/env.js";
import type { TranscriptionProvider, TranscriptionResult } from "../types.js";

export function createGroqTranscriptionProvider(model = env.TRANSCRIPTION_MODEL): TranscriptionProvider {
  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured.");
  }
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });

  return {
    name: "groq",
    model,
    async transcribe({ filePath, language, prompt }): Promise<TranscriptionResult> {
      const result = (await groq.audio.transcriptions.create({
        file: createReadStream(filePath),
        model,
        response_format: "verbose_json",
        temperature: 0,
        ...(language ? { language } : {}),
        ...(prompt ? { prompt } : {}),
      })) as unknown as {
        text: string;
        language?: string;
        duration?: number;
        segments?: Array<{ start: number; end: number; text: string }>;
      };

      return {
        text: result.text ?? "",
        language: result.language,
        durationSeconds: result.duration ? Math.round(result.duration) : undefined,
        segments: result.segments?.map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text.trim(),
        })),
      };
    },
  };
}

