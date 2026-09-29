import "server-only";

import { GoogleGenAI } from "@google/genai";

// Tried in order; the next model is used when one fails (e.g. 503 UNAVAILABLE
// "high demand", which has hit individual models for this key). Pinned to named
// releases rather than "gemini-flash-latest" first, since "latest" can resolve
// to a preview build — it is only a last resort.
export const GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
] as const;

let cachedClient: GoogleGenAI | null = null;

function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local (see .env.example) and restart the dev server."
    );
  }
  return key;
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function getGeminiClient(): GoogleGenAI {
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  }
  return cachedClient;
}
