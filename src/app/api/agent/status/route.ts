import { NextResponse } from "next/server";

import { isGeminiConfigured } from "@/lib/gemini";

// Server-side only: confirms whether GEMINI_API_KEY is configured, without
// ever exposing the key itself. The full agent (chat/generate) endpoint
// will be built on top of src/lib/gemini.ts in a later step.
export async function GET() {
  return NextResponse.json({ configured: isGeminiConfigured() });
}
