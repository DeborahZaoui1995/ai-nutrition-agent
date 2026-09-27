// Shared between client (SnackCoach) and server (agent route) — pure data,
// no server-only imports, so it's safe to import from either side.

export type DetectedClassKey = "WATER" | "HEALTHY_SNACK" | "UNHEALTHY_SNACK";

export type ChallengeValue = "Water" | "HEALTHY_SNACK" | "UNHEALTHY_SNACK";

export const CHALLENGE_VALUES: readonly ChallengeValue[] = [
  "Water",
  "HEALTHY_SNACK",
  "UNHEALTHY_SNACK",
];

const CLASS_TO_CHALLENGE: Record<DetectedClassKey, ChallengeValue> = {
  WATER: "Water",
  HEALTHY_SNACK: "HEALTHY_SNACK",
  UNHEALTHY_SNACK: "UNHEALTHY_SNACK",
};

export function classKeyToChallenge(key: DetectedClassKey): ChallengeValue {
  return CLASS_TO_CHALLENGE[key];
}

export function isChallengeValue(value: unknown): value is ChallengeValue {
  return typeof value === "string" && (CHALLENGE_VALUES as readonly string[]).includes(value);
}

export function isDetectedClassKey(value: unknown): value is DetectedClassKey {
  return value === "WATER" || value === "HEALTHY_SNACK" || value === "UNHEALTHY_SNACK";
}

export const CHALLENGE_LABELS: Record<ChallengeValue, string> = {
  Water: "Time to hydrate — show a water bottle!",
  HEALTHY_SNACK: "Grab and show a healthy snack",
  UNHEALTHY_SNACK: "Show an unhealthy snack (everything in moderation!)",
};

interface ChallengeCounts {
  water: number;
  healthy: number;
  unhealthy: number;
}

/** Deterministic fallback used when the model omits/invents a challenge — favors whichever category has been scanned least, for variety. */
export function pickVariedChallenge(
  current: ChallengeValue,
  counts: ChallengeCounts
): ChallengeValue {
  const options: { value: ChallengeValue; count: number }[] = [
    { value: "Water", count: counts.water },
    { value: "HEALTHY_SNACK", count: counts.healthy },
    { value: "UNHEALTHY_SNACK", count: counts.unhealthy },
  ];
  const others = options.filter((o) => o.value !== current);
  others.sort((a, b) => a.count - b.count);
  return others[0]?.value ?? current;
}

// Shared request/response contract for POST /api/agent — imported by both
// the server route (src/lib/agent.ts) and the client (SnackCoach.tsx), so
// it must stay free of "server-only" imports.

export interface AgentRequest {
  detectedClass: DetectedClassKey;
  confidence: number;
  currentScore: number;
  streak: number;
  totalScans: number;
  waterCount: number;
  healthySnackCount: number;
  unHealthySnackCount: number;
  currentChallenge: ChallengeValue;
  previousAgentMessage: string;
}

export interface AgentResult {
  accepted: boolean;
  feedback: string;
  scoreDelta: number;
  nextChallenge: ChallengeValue;
  action: "ACCEPT_SCAN" | "RESCAN";
  tip: string;
}
