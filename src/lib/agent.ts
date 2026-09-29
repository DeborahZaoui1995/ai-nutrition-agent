import "server-only";

import { getGeminiClient, GEMINI_MODELS } from "@/lib/gemini";
import {
  AgentRequest,
  AgentResult,
  CHALLENGE_VALUES,
  isChallengeValue,
  isDetectedClassKey,
  pickVariedChallenge,
} from "@/lib/challenge";

export type { AgentRequest, AgentResult };

export class GeminiUnavailableError extends Error {}

const MAX_MESSAGE_LENGTH = 160;
const MIN_SCORE_DELTA = -10;
const MAX_SCORE_DELTA = 30;

const RESCAN_FALLBACK: Omit<AgentResult, "nextChallenge"> = {
  accepted: false,
  feedback: "Couldn't quite make sense of that scan — try again!",
  scoreDelta: 0,
  action: "RESCAN",
  tip: "Sip water regularly through the day, even before you feel thirsty.",
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateAgentRequest(body: unknown): AgentRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (!isDetectedClassKey(b.detectedClass)) return null;
  if (!isChallengeValue(b.currentChallenge)) return null;
  if (!isFiniteNumber(b.confidence) || b.confidence < 0 || b.confidence > 1) return null;
  if (!isFiniteNumber(b.currentScore) || b.currentScore < 0) return null;
  if (!isFiniteNumber(b.streak) || b.streak < 0) return null;
  if (!isFiniteNumber(b.totalScans) || b.totalScans < 0) return null;
  if (!isFiniteNumber(b.waterCount) || b.waterCount < 0) return null;
  if (!isFiniteNumber(b.healthySnackCount) || b.healthySnackCount < 0) return null;
  if (!isFiniteNumber(b.unHealthySnackCount) || b.unHealthySnackCount < 0) return null;
  if (typeof b.previousAgentMessage !== "string") return null;

  return {
    detectedClass: b.detectedClass,
    confidence: b.confidence,
    currentScore: b.currentScore,
    streak: b.streak,
    totalScans: b.totalScans,
    waterCount: b.waterCount,
    healthySnackCount: b.healthySnackCount,
    unHealthySnackCount: b.unHealthySnackCount,
    currentChallenge: b.currentChallenge,
    previousAgentMessage: b.previousAgentMessage,
  };
}

const SYSTEM_INSTRUCTION = `You are the game-master AI for a "healthy desk habits" mini-game inside a mobile app called "AI Desk Snack & Health Coach". A camera classifier just detected an object at the user's desk, and you must decide how the mini-game reacts, then give the user short, encouraging nutrition/hydration feedback. You are making a game decision, not describing the object.

Rules:
- The only valid challenge categories, ever, are exactly: "Water", "HEALTHY_SNACK", "UNHEALTHY_SNACK". Never invent or return any other value, and never invent a detection class beyond WATER, HEALTHY_SNACK, UNHEALTHY_SNACK.
- If detectedClass matches currentChallenge's category, set accepted=true and action="ACCEPT_SCAN". Reward generously: scoreDelta between 15 and 30, higher for longer streaks. High positive rewards are only ever for "Water" or "HEALTHY_SNACK" scans, or an "UNHEALTHY_SNACK" scan when the challenge specifically asked for one.
- If detectedClass is "Water" or "HEALTHY_SNACK" but doesn't match currentChallenge (still a valid, healthy scan), set accepted=false but action="ACCEPT_SCAN" with a small scoreDelta between 0 and 5, and gently steer the player back to the current challenge in your feedback.
- If detectedClass is "UNHEALTHY_SNACK" and it does NOT match currentChallenge, this is not rewarded: set accepted=false, action="ACCEPT_SCAN", and scoreDelta to 0 or a small penalty down to -5 (never positive). In feedback, gently remind the user to swap for a healthy snack or water to earn points — do not praise the unhealthy scan.
- Only use action="RESCAN" (accepted=false, scoreDelta=0) if the given session data looks unclear, inconsistent, or you cannot make a confident decision.
- Always pick nextChallenge from exactly: "Water", "HEALTHY_SNACK", "UNHEALTHY_SNACK". Vary it across turns — avoid repeating the challenge that was just satisfied unless session counts clearly call for it. Nudge the user toward good desk habits: if waterCount is low relative to totalScans, favor "Water"; if unHealthySnackCount is climbing, favor "HEALTHY_SNACK" next.
- feedback: one short, upbeat, encouraging, mobile-friendly sentence about their health/hydration habit, under 15 words.
- tip: one short, concrete nutrition or hydration tip related to the detected item or next challenge, under 15 words.
- Respond only with JSON matching the provided schema.`;

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    feedback: { type: "string" },
    scoreDelta: { type: "number" },
    nextChallenge: { type: "string", enum: [...CHALLENGE_VALUES] },
    action: { type: "string", enum: ["ACCEPT_SCAN", "RESCAN"] },
    tip: { type: "string" },
  },
  required: ["accepted", "feedback", "scoreDelta", "nextChallenge", "action", "tip"],
  propertyOrdering: ["accepted", "feedback", "scoreDelta", "nextChallenge", "action", "tip"],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Validates and repairs the model's raw JSON output so a malformed or partially-hallucinated response can never break the app. */
function sanitizeAgentResult(raw: unknown, input: AgentRequest): AgentResult {
  if (typeof raw !== "object" || raw === null) {
    return { ...RESCAN_FALLBACK, nextChallenge: input.currentChallenge };
  }
  const r = raw as Record<string, unknown>;

  const action: AgentResult["action"] = r.action === "ACCEPT_SCAN" ? "ACCEPT_SCAN" : "RESCAN";
  let accepted = action === "ACCEPT_SCAN" ? Boolean(r.accepted) : false;

  const rawDelta = isFiniteNumber(r.scoreDelta) ? r.scoreDelta : 0;
  let scoreDelta =
    action === "RESCAN" ? 0 : Math.round(clamp(rawDelta, MIN_SCORE_DELTA, MAX_SCORE_DELTA));

  // Hard rule, enforced server-side regardless of what the model returned:
  // an unhealthy snack that doesn't match the current challenge is never a
  // rewarded scan — only Water/HEALTHY_SNACK (or a matching UNHEALTHY_SNACK
  // challenge) can earn a positive score.
  const isUnrewardedUnhealthyScan =
    input.detectedClass === "UNHEALTHY_SNACK" && input.currentChallenge !== "UNHEALTHY_SNACK";
  if (action === "ACCEPT_SCAN" && isUnrewardedUnhealthyScan) {
    accepted = false;
    scoreDelta = clamp(scoreDelta, -5, 0);
  }

  const counts = {
    water: input.waterCount,
    healthy: input.healthySnackCount,
    unhealthy: input.unHealthySnackCount,
  };
  const nextChallenge = isChallengeValue(r.nextChallenge)
    ? r.nextChallenge
    : pickVariedChallenge(input.currentChallenge, counts);

  const feedback = isNonEmptyString(r.feedback)
    ? truncate(r.feedback, MAX_MESSAGE_LENGTH)
    : RESCAN_FALLBACK.feedback;

  const tip = isNonEmptyString(r.tip) ? truncate(r.tip, MAX_MESSAGE_LENGTH) : RESCAN_FALLBACK.tip;

  return { accepted, feedback, scoreDelta, nextChallenge, action, tip };
}

export function buildRescanFallback(input: AgentRequest): AgentResult {
  const counts = {
    water: input.waterCount,
    healthy: input.healthySnackCount,
    unhealthy: input.unHealthySnackCount,
  };
  return {
    ...RESCAN_FALLBACK,
    nextChallenge: pickVariedChallenge(input.currentChallenge, counts),
  };
}

const ATTEMPT_TIMEOUT_MS = 6_000;

export async function runAgent(input: AgentRequest): Promise<AgentResult> {
  const ai = getGeminiClient();

  let responseText: string | undefined;
  let lastError = "Gemini request failed";
  let succeeded = false;

  for (const model of GEMINI_MODELS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_JSON_SCHEMA,
          temperature: 0.8,
          maxOutputTokens: 512,
          // This is a quick structured game-logic decision, not a reasoning
          // task — disable thinking so the token budget goes to the JSON
          // answer instead of a thought trace (which was starving the
          // response and producing empty/truncated output).
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: controller.signal,
        },
      });
      responseText = response.text;
      succeeded = true;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
      console.warn(`[agent] ${model} failed, trying next model:`, lastError);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!succeeded) {
    throw new GeminiUnavailableError(lastError);
  }

  if (!responseText) {
    console.warn("[agent] Gemini returned no text; using RESCAN fallback.");
    return buildRescanFallback(input);
  }

  try {
    const parsed = JSON.parse(responseText);
    return sanitizeAgentResult(parsed, input);
  } catch {
    console.warn("[agent] Gemini returned non-JSON text; using RESCAN fallback:", responseText);
    return buildRescanFallback(input);
  }
}
