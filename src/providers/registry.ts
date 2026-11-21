import { env } from "../config/env.js";
import { createGroqTranscriptionProvider } from "./transcription/groq.provider.js";
import { createOpenAITranscriptionProvider } from "./transcription/openai.provider.js";
import {
  createGeminiAnalysisProvider,
  createGroqAnalysisProvider,
  createOllamaAnalysisProvider,
  createOpenAIAnalysisProvider,
} from "./llm/providers.js";
import type { AnalysisProvider, ProviderName, TranscriptionProvider } from "./types.js";

export const providerRegistry = {
  transcription: {
    groq: createGroqTranscriptionProvider,
    openai: createOpenAITranscriptionProvider,
  },
  analysis: {
    groq: createGroqAnalysisProvider,
    openai: createOpenAIAnalysisProvider,
    gemini: createGeminiAnalysisProvider,
    ollama: createOllamaAnalysisProvider,
  },
} as const;

export function getActiveTranscriptionProvider(): TranscriptionProvider {
  const factory = providerRegistry.transcription[env.TRANSCRIPTION_PROVIDER];
  return factory(env.TRANSCRIPTION_MODEL);
}

export function getActiveAnalysisProvider(overrideProvider?: ProviderName): AnalysisProvider {
  const providerName = overrideProvider ?? env.ANALYSIS_PROVIDER;
  const model =
    providerName === env.ANALYSIS_PROVIDER
      ? env.ANALYSIS_MODEL
      : providerName === "openai"
        ? env.OPENAI_ANALYSIS_MODEL
        : providerName === "gemini"
          ? env.GEMINI_ANALYSIS_MODEL
          : providerName === "ollama"
            ? env.OLLAMA_ANALYSIS_MODEL
            : env.ANALYSIS_MODEL;

  const factory = providerRegistry.analysis[providerName];
  return factory(model);
}

export function getSafeProviderMetadata() {
  return {
    transcription: {
      provider: env.TRANSCRIPTION_PROVIDER,
      model: env.TRANSCRIPTION_MODEL,
      configured:
        env.TRANSCRIPTION_PROVIDER === "groq"
          ? Boolean(env.GROQ_API_KEY)
          : Boolean(env.OPENAI_API_KEY),
    },
    analysis: {
      provider: env.ANALYSIS_PROVIDER,
      model: env.ANALYSIS_MODEL,
      fallbackProvider: env.ANALYSIS_FALLBACK_PROVIDER || null,
      configured:
        env.ANALYSIS_PROVIDER === "groq"
          ? Boolean(env.GROQ_API_KEY)
          : env.ANALYSIS_PROVIDER === "openai"
            ? Boolean(env.OPENAI_API_KEY)
            : env.ANALYSIS_PROVIDER === "gemini"
              ? Boolean(env.GEMINI_API_KEY)
              : true,
    },
  };
}

