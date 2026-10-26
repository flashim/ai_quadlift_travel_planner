import type { ModelAdapter } from "../types";
import { openaiCompatibleAdapter } from "./openai";

/**
 * Groq's OpenAI-compatible API (`GROQ_API_KEY`, `GROQ_MODEL`). Same wire
 * format as OpenAI; only the host and credential differ.
 */
export const groqAdapter: ModelAdapter = openaiCompatibleAdapter(
  "groq",
  "https://api.groq.com/openai/v1",
);
