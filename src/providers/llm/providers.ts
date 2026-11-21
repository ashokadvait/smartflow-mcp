import Groq from "groq-sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import { env } from "../../config/env.js";
import type { AnalysisProvider } from "../types.js";

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(candidate);
}

async function parseWithRepair<T>(
  rawText: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  repairFn: (invalidText: string, errorMessage: string) => Promise<string>
): Promise<T> {
  try {
    return schema.parse(extractJsonObject(rawText));
  } catch (firstErr) {
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const repairedText = await repairFn(rawText, errMsg);
    return schema.parse(extractJsonObject(repairedText));
  }
}

export function createGroqAnalysisProvider(model = env.ANALYSIS_MODEL): AnalysisProvider {
  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured.");
  }
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });

  return {
    name: "groq",
    model,
    async generateStructured({ systemPrompt, userPrompt, schema }) {
      const callLlm = async (prompt: string) => {
        const res = await groq.chat.completions.create({
          model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
        });
        return res.choices[0]?.message?.content ?? "{}";
      };

      const raw = await callLlm(userPrompt);
      return parseWithRepair(raw, schema, (invalid, err) =>
        callLlm(
          `Your previous JSON output failed schema validation (${err}). Fix it and return ONLY valid JSON.\nPrevious output:\n${invalid}`
        )
      );
    },
  };
}

export function createOpenAIAnalysisProvider(model = env.OPENAI_ANALYSIS_MODEL): AnalysisProvider {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  return {
    name: "openai",
    model,
    async generateStructured({ systemPrompt, userPrompt, schema }) {
      const callLlm = async (prompt: string) => {
        const res = await openai.chat.completions.create({
          model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
        });
        return res.choices[0]?.message?.content ?? "{}";
      };

      const raw = await callLlm(userPrompt);
      return parseWithRepair(raw, schema, (invalid, err) =>
        callLlm(
          `Your previous JSON output failed validation (${err}). Fix it and return ONLY valid JSON.\nPrevious output:\n${invalid}`
        )
      );
    },
  };
}

export function createGeminiAnalysisProvider(model = env.GEMINI_ANALYSIS_MODEL): AnalysisProvider {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  return {
    name: "gemini",
    model,
    async generateStructured({ systemPrompt, userPrompt, schema }) {
      const callLlm = async (prompt: string) => {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        });
        return res.text ?? "{}";
      };

      const raw = await callLlm(userPrompt);
      return parseWithRepair(raw, schema, (invalid, err) =>
        callLlm(
          `Your previous JSON output failed validation (${err}). Fix it and return ONLY valid JSON.\nPrevious output:\n${invalid}`
        )
      );
    },
  };
}

export function createOllamaAnalysisProvider(model = env.OLLAMA_ANALYSIS_MODEL): AnalysisProvider {
  const baseUrl = env.OLLAMA_BASE_URL.replace(/\/+$/, "");

  return {
    name: "ollama",
    model,
    async generateStructured({ systemPrompt, userPrompt, schema }) {
      const callLlm = async (prompt: string) => {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            format: "json",
            options: { temperature: 0.1 },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!res.ok) {
          throw new Error(`Ollama API error ${res.status}`);
        }
        const body = (await res.json()) as { message?: { content?: string } };
        return body.message?.content ?? "{}";
      };

      const raw = await callLlm(userPrompt);
      return parseWithRepair(raw, schema, (invalid, err) =>
        callLlm(
          `Your previous JSON output failed validation (${err}). Fix it and return ONLY valid JSON.\nPrevious output:\n${invalid}`
        )
      );
    },
  };
}
