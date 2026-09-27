import { NextRequest, NextResponse } from "next/server";

import {
  buildRescanFallback,
  GeminiUnavailableError,
  runAgent,
  validateAgentRequest,
} from "@/lib/agent";
import { isGeminiConfigured } from "@/lib/gemini";

// Server-side only. The browser calls this after a stable, valid Teachable
// Machine detection (>=90% confidence held for ~1s, cooldown-gated). The
// Gemini API key never leaves the server — see src/lib/gemini.ts.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = validateAgentRequest(body);
  if (!input) {
    // Malformed/unclear input from the client — the agent's own contract
    // says this is a RESCAN, not a hard failure.
    return NextResponse.json(
      {
        accepted: false,
        feedback: "That scan didn't look right — try again!",
        scoreDelta: 0,
        nextChallenge: "Water",
        action: "RESCAN",
        tip: "Sip water regularly through the day, even before you feel thirsty.",
      },
      { status: 200 }
    );
  }

  if (!isGeminiConfigured()) {
    return NextResponse.json(
      { error: "The AI coach isn't configured yet. Add GEMINI_API_KEY and restart the server." },
      { status: 503 }
    );
  }

  try {
    const result = await runAgent(input);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof GeminiUnavailableError) {
      console.error("[agent] Gemini unavailable:", err.message);
      return NextResponse.json(
        { error: "The AI coach is temporarily unavailable. You can keep scanning!" },
        { status: 503 }
      );
    }
    console.error("[agent] Unexpected error:", err);
    return NextResponse.json(buildRescanFallback(input), { status: 200 });
  }
}
