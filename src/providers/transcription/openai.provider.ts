import { OpenAI } from "openai";
import { createReadStream } from "node:fs";
import { env } from "../../config/env.js";
import type { TranscriptionProvider, TranscriptionResult } from "../types.js";

export function createOpenAITranscriptionProvider(model = "whisper-1"): TranscriptionProvider {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  return {
    name: "openai",
    model,
    async transcribe({ filePath, language }): Promise<TranscriptionResult> {
      const result = (await openai.audio.transcriptions.create({
        file: createReadStream(filePath),
        model,
        response_format: "verbose_json",
        ...(language ? { language } : {}),
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

