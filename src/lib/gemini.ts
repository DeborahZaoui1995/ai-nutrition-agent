import "server-only";

import { GoogleGenAI } from "@google/genai";

// Current stable Gemini Flash model (GA as of Sept 2026). Google also
// offers a "gemini-flash-latest" alias, but that can resolve to a preview
// build — we pin to a named stable release instead.
export const GEMINI_MODEL = "gemini-3.8-flash";

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
