import "server-only";

import { GoogleGenAI } from "@google/genai";

// Pinned to a named stable release rather than "gemini-flash-latest" (which
// can resolve to a preview build). gemini-3.8-flash / gemini-3.5-flash /
// gemini-flash-latest are returning 503 UNAVAILABLE ("high demand") for this
// key as of 2026-09-28 — gemini-3.6-flash responds normally, so we pin to
// that until the newer models recover.
export const GEMINI_MODEL = "gemini-3.6-flash";

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
