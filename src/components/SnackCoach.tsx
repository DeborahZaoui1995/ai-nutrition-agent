"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AgentRequest,
  AgentResult,
  CHALLENGE_LABELS,
  ChallengeValue,
  DetectedClassKey,
} from "@/lib/challenge";

const TF_SRC = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const TM_SRC =
  "https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8.5/dist/teachablemachine-image.min.js";

const CONFIDENCE_THRESHOLD = 0.9;
const STABLE_DURATION_MS = 1000;
const COOLDOWN_MS = 3000;

type ClassKey = DetectedClassKey | "NO_OBJECT" | "UNKNOWN";

const CLASS_KEYS: Record<string, ClassKey> = {
  WATER: "WATER",
  HEALTHY_SNACK: "HEALTHY_SNACK",
  UNHEALTHY_SNACK: "UNHEALTHY_SNACK",
  NO_OBJECT: "NO_OBJECT",
};

const DISPLAY_LABELS: Record<ClassKey, string> = {
  WATER: "Water",
  HEALTHY_SNACK: "Healthy Snack",
  UNHEALTHY_SNACK: "Unhealthy Snack",
  NO_OBJECT: "No Object",
  UNKNOWN: "Unknown",
};

const CLASS_ICONS: Record<ClassKey, string> = {
  WATER: "💧",
  HEALTHY_SNACK: "🥗",
  UNHEALTHY_SNACK: "🍟",
  NO_OBJECT: "❔",
  UNKNOWN: "❓",
};

const CLASS_BADGE_CLASS: Record<ClassKey, string> = {
  WATER: "bg-sky-500",
  HEALTHY_SNACK: "bg-emerald-500",
  UNHEALTHY_SNACK: "bg-rose-500",
  NO_OBJECT: "bg-slate-500",
  UNKNOWN: "bg-slate-500",
};

const CHALLENGE_THEME: Record<ChallengeValue, { icon: string; className: string }> = {
  Water: { icon: "💧", className: "bg-gradient-to-r from-sky-500 to-sky-600" },
  HEALTHY_SNACK: { icon: "🥗", className: "bg-gradient-to-r from-emerald-500 to-emerald-600" },
  UNHEALTHY_SNACK: { icon: "🍟", className: "bg-gradient-to-r from-amber-500 to-amber-600" },
};

function normalizeClassName(className: string): ClassKey {
  const key = className.trim().toUpperCase().replace(/\s+/g, "_");
  return CLASS_KEYS[key] ?? "UNKNOWN";
}

type CameraState = "idle" | "requesting" | "active" | "denied" | "error";
type ModelState = "loading" | "ready" | "error";
type AgentStatus = "idle" | "thinking" | "error";
type AgentSubPhase = "sending" | "waiting";

// A single, unified state machine covering the whole app lifecycle, so the
// UI always has exactly one clear answer to "what is happening right now" —
// rather than several separate flags the user has to piece together.
type AppPhase =
  | "model-loading"
  | "model-error"
  | "camera-idle"
  | "camera-permission"
  | "camera-error"
  | "agent-error"
  | "sending-scan"
  | "waiting-agent"
  | "showing-decision"
  | "cooldown"
  | "stabilizing"
  | "detecting"
  | "ready";

const SHOWING_DECISION_MS = 1600;
const SENDING_PHASE_MS = 350;

interface ModelConfig {
  modelUrl: string;
  metadataUrl: string;
}

interface Stats {
  water: number;
  healthy: number;
  unhealthy: number;
  total: number;
}

interface Candidate {
  key: ClassKey | null;
  since: number;
  triggered: boolean;
}

interface SessionSnapshot {
  score: number;
  streak: number;
  challenge: ChallengeValue;
  agentMessage: string;
  stats: Stats;
}

const INITIAL_CHALLENGE: ChallengeValue = "Water";
const INITIAL_AGENT_MESSAGE = "Show me your drink or snack to get started!";
const INITIAL_STATS: Stats = { water: 0, healthy: 0, unhealthy: 0, total: 0 };

export default function SnackCoach() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const modelRef = useRef<TMModel | null>(null);
  const rafRef = useRef<number | null>(null);
  const candidateRef = useRef<Candidate>({ key: null, since: 0, triggered: false });
  const cooldownUntilRef = useRef<number>(0);

  const [tfLoaded, setTfLoaded] = useState(false);
  const [tmScriptLoaded, setTmScriptLoaded] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [modelState, setModelState] = useState<ModelState>("loading");
  const [modelError, setModelError] = useState<string | null>(null);

  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [predictions, setPredictions] = useState<TMPrediction[]>([]);
  const [topKey, setTopKey] = useState<ClassKey>("NO_OBJECT");
  const [topConfidence, setTopConfidence] = useState(0);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const [isStabilizing, setIsStabilizing] = useState(false);
  const [stabilizeProgress, setStabilizeProgress] = useState(0);

  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [challenge, setChallenge] = useState<ChallengeValue>(INITIAL_CHALLENGE);
  const [stats, setStats] = useState<Stats>(INITIAL_STATS);
  const [agentMessage, setAgentMessage] = useState(INITIAL_AGENT_MESSAGE);
  const [tip, setTip] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [agentErrorMessage, setAgentErrorMessage] = useState<string | null>(null);
  const [agentSubPhase, setAgentSubPhase] = useState<AgentSubPhase>("sending");
  const [showingDecision, setShowingDecision] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const agentRequestIdRef = useRef(0);
  const sendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showingDecisionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirrors the latest session state into a ref so the stable (empty-deps)
  // triggerValidScan callback below never reads stale closures. This is the
  // in-memory session store — it survives re-renders for the life of the
  // component but is intentionally not persisted (no DB, no localStorage),
  // per the "no database needed" requirement.
  const sessionRef = useRef<SessionSnapshot>({
    score: 0,
    streak: 0,
    challenge: INITIAL_CHALLENGE,
    agentMessage,
    stats: INITIAL_STATS,
  });
  useEffect(() => {
    sessionRef.current = { score, streak, challenge, agentMessage, stats };
  }, [score, streak, challenge, agentMessage, stats]);

  const resetSession = useCallback(() => {
    // Clear any in-flight stability/cooldown tracking so a reset takes
    // effect immediately rather than being masked by leftover camera state.
    candidateRef.current = { key: null, since: 0, triggered: false };
    cooldownUntilRef.current = 0;
    setIsStabilizing(false);
    setStabilizeProgress(0);
    setIsCoolingDown(false);
    setCooldownRemainingMs(0);

    // Invalidate any in-flight "sending -> waiting" / "showing decision"
    // timers from a scan that was still in progress when reset was pressed.
    agentRequestIdRef.current += 1;
    if (sendingTimeoutRef.current) clearTimeout(sendingTimeoutRef.current);
    if (showingDecisionTimeoutRef.current) clearTimeout(showingDecisionTimeoutRef.current);
    setAgentSubPhase("sending");
    setShowingDecision(false);

    setScore(0);
    setStreak(0);
    setChallenge(INITIAL_CHALLENGE);
    setStats(INITIAL_STATS);
    setAgentMessage(INITIAL_AGENT_MESSAGE);
    setTip(null);
    setAgentStatus("idle");
    setAgentErrorMessage(null);

    // Update the ref synchronously too, so a scan that lands before the
    // mirroring effect above has re-run still sees the reset state.
    sessionRef.current = {
      score: 0,
      streak: 0,
      challenge: INITIAL_CHALLENGE,
      agentMessage: INITIAL_AGENT_MESSAGE,
      stats: INITIAL_STATS,
    };
  }, []);

  // Fetch model configuration from the server API route.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/model")
      .then((res) => res.json())
      .then((data: ModelConfig) => {
        if (!cancelled) setModelConfig(data);
      })
      .catch(() => {
        if (!cancelled) {
          setModelState("error");
          setModelError("Failed to load model configuration from the server.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the Teachable Machine model once both scripts and the config are ready.
  useEffect(() => {
    if (!tfLoaded || !tmScriptLoaded || !modelConfig) return;
    let cancelled = false;
    (async () => {
      setModelState("loading");
      setModelError(null);
      try {
        const model = await window.tmImage!.load(modelConfig.modelUrl, modelConfig.metadataUrl);
        if (cancelled) return;
        modelRef.current = model;
        setModelState("ready");
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setModelState("error");
          setModelError("Failed to load the Teachable Machine model. Check your connection and refresh.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tfLoaded, tmScriptLoaded, modelConfig]);

  const triggerValidScan = useCallback((key: DetectedClassKey, confidence: number, now: number) => {
    cooldownUntilRef.current = now + COOLDOWN_MS;

    const session = sessionRef.current;
    const nextStats: Stats = {
      water: session.stats.water + (key === "WATER" ? 1 : 0),
      healthy: session.stats.healthy + (key === "HEALTHY_SNACK" ? 1 : 0),
      unhealthy: session.stats.unhealthy + (key === "UNHEALTHY_SNACK" ? 1 : 0),
      total: session.stats.total + 1,
    };
    setStats(nextStats);

    fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ className: key, confidence, timestamp: now }),
    }).catch(() => {});

    const payload: AgentRequest = {
      detectedClass: key,
      confidence,
      currentScore: session.score,
      streak: session.streak,
      totalScans: nextStats.total,
      waterCount: nextStats.water,
      healthySnackCount: nextStats.healthy,
      unHealthySnackCount: nextStats.unhealthy,
      currentChallenge: session.challenge,
      previousAgentMessage: session.agentMessage,
    };

    const requestId = ++agentRequestIdRef.current;
    setAgentStatus("thinking");
    setAgentErrorMessage(null);
    // Briefly show "sending" before switching to "waiting for the agent" —
    // these are two distinct states the user should be able to see, even
    // though the underlying request is a single fetch.
    setAgentSubPhase("sending");
    if (sendingTimeoutRef.current) clearTimeout(sendingTimeoutRef.current);
    sendingTimeoutRef.current = setTimeout(() => {
      if (agentRequestIdRef.current === requestId) setAgentSubPhase("waiting");
    }, SENDING_PHASE_MS);

    fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "The AI coach is temporarily unavailable.");
        }
        return (await res.json()) as AgentResult;
      })
      .then((result) => {
        setScore((prev) => Math.max(0, prev + result.scoreDelta));
        setChallenge(result.nextChallenge);
        setStreak((prev) => (result.accepted ? prev + 1 : 0));
        setAgentMessage(result.feedback);
        setTip(result.tip);
        setAgentStatus("idle");

        // Flash a clear "here's the decision" state before settling back
        // into cooldown/ready, so the transition from "waiting" to "done"
        // is visible rather than an instant, easy-to-miss swap.
        if (agentRequestIdRef.current === requestId) {
          setShowingDecision(true);
          if (showingDecisionTimeoutRef.current) clearTimeout(showingDecisionTimeoutRef.current);
          showingDecisionTimeoutRef.current = setTimeout(() => {
            if (agentRequestIdRef.current === requestId) setShowingDecision(false);
          }, SHOWING_DECISION_MS);
        }
      })
      .catch((err) => {
        setAgentStatus("error");
        setAgentErrorMessage(
          err instanceof Error ? err.message : "The AI coach is temporarily unavailable."
        );
      });
  }, []);

  const loopRef = useRef<() => void>(() => {});

  const loop = useCallback(async () => {
    const video = videoRef.current;
    const model = modelRef.current;

    if (video && model && video.readyState >= 2) {
      try {
        const preds = await model.predict(video);
        setPredictions(preds);

        const top = preds.reduce((a, b) => (b.probability > a.probability ? b : a));
        const key = normalizeClassName(top.className);
        setTopKey(key);
        setTopConfidence(top.probability);

        const now = Date.now();
        const cooling = now < cooldownUntilRef.current;
        setIsCoolingDown(cooling);
        setCooldownRemainingMs(cooling ? cooldownUntilRef.current - now : 0);

        if (cooling) {
          candidateRef.current = { key: null, since: 0, triggered: false };
          setIsStabilizing(false);
          setStabilizeProgress(0);
        } else if (top.probability >= CONFIDENCE_THRESHOLD && key !== "NO_OBJECT" && key !== "UNKNOWN") {
          if (candidateRef.current.key === key) {
            const elapsed = now - candidateRef.current.since;
            if (!candidateRef.current.triggered) {
              setIsStabilizing(elapsed < STABLE_DURATION_MS);
              setStabilizeProgress(Math.min(1, elapsed / STABLE_DURATION_MS));
              if (elapsed >= STABLE_DURATION_MS) {
                candidateRef.current.triggered = true;
                triggerValidScan(key, top.probability, now);
              }
            }
          } else {
            candidateRef.current = { key, since: now, triggered: false };
            setIsStabilizing(true);
            setStabilizeProgress(0);
          }
        } else {
          candidateRef.current = { key: null, since: 0, triggered: false };
          setIsStabilizing(false);
          setStabilizeProgress(0);
        }
      } catch (err) {
        console.error("Prediction error", err);
      }
    }

    rafRef.current = requestAnimationFrame(() => loopRef.current());
  }, [triggerValidScan]);

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  // Run the prediction loop while the camera is active and the model is ready.
  useEffect(() => {
    if (cameraState === "active" && modelState === "ready") {
      rafRef.current = requestAnimationFrame(() => loopRef.current());
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [cameraState, modelState, loop]);

  // Stop camera tracks and pending timers on unmount.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (sendingTimeoutRef.current) clearTimeout(sendingTimeoutRef.current);
      if (showingDecisionTimeoutRef.current) clearTimeout(showingDecisionTimeoutRef.current);
    };
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setCameraState("requesting");
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState("active");
    } catch (err) {
      const domErr = err as DOMException;
      if (domErr?.name === "NotAllowedError" || domErr?.name === "PermissionDeniedError") {
        setCameraState("denied");
        setCameraError(
          "Camera access was denied. Please allow camera permission for this site in your browser settings, then try again."
        );
      } else if (domErr?.name === "NotFoundError") {
        setCameraState("error");
        setCameraError("No camera was found on this device.");
      } else {
        setCameraState("error");
        setCameraError("Could not access the camera. Please check your device and try again.");
      }
    }
  }, []);

  const challengeText = CHALLENGE_LABELS[challenge];
  const challengeTheme = CHALLENGE_THEME[challenge];

  // Single source of truth for "what is the app doing right now" — see the
  // AppPhase type above for the full list of states this covers.
  const appPhase: AppPhase = (() => {
    if (modelState === "error") return "model-error";
    if (cameraState === "denied" || cameraState === "error") return "camera-error";
    if (cameraState === "requesting") return "camera-permission";
    if (cameraState === "idle") return modelState === "loading" ? "model-loading" : "camera-idle";
    // From here on, the camera is active. Order matters: an in-progress or
    // fresh engagement (thinking/stabilizing) always outranks a stale error
    // from a previous scan, so retrying isn't blocked by old error text —
    // but the error still shows promptly whenever nothing newer is happening.
    if (agentStatus === "thinking") return agentSubPhase === "sending" ? "sending-scan" : "waiting-agent";
    if (showingDecision) return "showing-decision";
    if (isStabilizing) return "stabilizing";
    if (agentStatus === "error") return "agent-error";
    if (isCoolingDown) return "cooldown";
    if (modelState !== "ready") return "model-loading";
    if (topKey !== "NO_OBJECT" && topKey !== "UNKNOWN") return "detecting";
    return "ready";
  })();

  const APP_PHASE_META: Record<AppPhase, { icon: string; label: string; className: string }> = {
    "model-loading": { icon: "⏳", label: "Loading the AI model…", className: "bg-slate-100 text-slate-600" },
    "model-error": { icon: "⚠️", label: "AI model failed to load", className: "bg-rose-100 text-rose-700" },
    "camera-idle": { icon: "📷", label: "Tap Start Camera to begin", className: "bg-slate-100 text-slate-600" },
    "camera-permission": {
      icon: "🔐",
      label: "Waiting for camera permission…",
      className: "bg-slate-100 text-slate-600",
    },
    "camera-error": { icon: "⚠️", label: "Camera problem", className: "bg-rose-100 text-rose-700" },
    "agent-error": { icon: "⚠️", label: "AI Coach unavailable", className: "bg-rose-100 text-rose-700" },
    "sending-scan": { icon: "📤", label: "Sending your scan…", className: "bg-indigo-100 text-indigo-700" },
    "waiting-agent": { icon: "🤖", label: "AI Coach is thinking…", className: "bg-indigo-100 text-indigo-700" },
    "showing-decision": { icon: "✅", label: "Here's your result!", className: "bg-emerald-100 text-emerald-700" },
    cooldown: {
      icon: "⏳",
      label: `Cooldown — ${Math.ceil(cooldownRemainingMs / 1000)}s`,
      className: "bg-amber-100 text-amber-700",
    },
    stabilizing: { icon: "🎯", label: "Hold steady…", className: "bg-indigo-100 text-indigo-700" },
    detecting: { icon: "🔍", label: "Detecting an object…", className: "bg-sky-100 text-sky-700" },
    ready: { icon: "✅", label: "Ready — point at an item", className: "bg-emerald-100 text-emerald-700" },
  };
  const phaseMeta = APP_PHASE_META[appPhase];

  return (
    <>
      <Script
        src={TF_SRC}
        strategy="afterInteractive"
        onLoad={() => setTfLoaded(true)}
        onError={() => {
          setModelState("error");
          setModelError("Failed to load TensorFlow.js from the CDN.");
        }}
      />
      {tfLoaded && (
        <Script
          src={TM_SRC}
          strategy="afterInteractive"
          onLoad={() => setTmScriptLoaded(true)}
          onError={() => {
            setModelState("error");
            setModelError("Failed to load the Teachable Machine library from the CDN.");
          }}
        />
      )}

      <header className="sticky top-0 z-10 bg-slate-900 px-4 py-3 shadow-md">
        <h1 className="text-center text-base font-semibold text-white">
          🥤 AI Desk Snack &amp; Health Coach
        </h1>
      </header>

      <div className="flex-1 pb-8">
        {/* Help — compact, collapsed by default */}
        <div className="mx-4 mt-4 rounded-2xl bg-white shadow">
          <button
            onClick={() => setShowHelp((prev) => !prev)}
            aria-expanded={showHelp}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-slate-700"
          >
            <span>❓ How to Play</span>
            <span className={`transition-transform ${showHelp ? "rotate-180" : ""}`}>⌄</span>
          </button>
          {showHelp && (
            <ol className="flex flex-col gap-1.5 px-4 pb-4 text-sm text-slate-600">
              <li>1. Allow camera access.</li>
              <li>2. Show the requested object.</li>
              <li>3. Hold it steady.</li>
              <li>4. Wait for the AI Agent.</li>
              <li>5. Complete as many challenges as possible.</li>
            </ol>
          )}
        </div>

        {/* App status — single, clear answer to "what is happening right now" */}
        <div
          className={`mx-4 mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${phaseMeta.className}`}
        >
          <span>{phaseMeta.icon}</span>
          <span className="truncate">{phaseMeta.label}</span>
        </div>

        {/* Current Challenge — highly visible banner */}
        <div
          className={`mx-4 mt-4 flex items-center gap-3 rounded-2xl p-4 text-white shadow-lg ${challengeTheme.className}`}
        >
          <span className="text-3xl leading-none">{challengeTheme.icon}</span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/80">
              🎯 Current Challenge
            </p>
            <p className="mt-0.5 text-base font-bold leading-snug">{challengeText}</p>
          </div>
        </div>

        {/* Camera card — large mobile-first preview */}
        <div className="relative mx-4 mt-4 aspect-[4/5] overflow-hidden rounded-2xl bg-black shadow-lg">
          <video
            ref={videoRef}
            muted
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />

          {appPhase === "stabilizing" && (
            <div className="absolute left-2 right-2 top-2 h-1.5 overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full rounded-full bg-white transition-[width] duration-100"
                style={{ width: `${Math.round(stabilizeProgress * 100)}%` }}
              />
            </div>
          )}

          {cameraState !== "active" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-900/90 px-6 text-center">
              {cameraState === "denied" || cameraState === "error" ? (
                <>
                  <p className="text-sm text-rose-300">{cameraError}</p>
                  <button
                    onClick={startCamera}
                    className="rounded-full bg-white px-6 py-3 text-sm font-medium text-slate-900 shadow"
                  >
                    Try Again
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-300">
                    Start your camera to begin scanning your water, snacks, and drinks.
                  </p>
                  <button
                    onClick={startCamera}
                    disabled={cameraState === "requesting"}
                    className="rounded-full bg-emerald-500 px-6 py-3 text-base font-medium text-white shadow disabled:opacity-60"
                  >
                    {cameraState === "requesting" ? "Requesting camera…" : "📷 Start Camera"}
                  </button>
                </>
              )}
            </div>
          )}

          {cameraState === "active" && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-3">
              <div className="flex items-center justify-between text-white">
                <span
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${CLASS_BADGE_CLASS[topKey]}`}
                >
                  <span>{CLASS_ICONS[topKey]}</span>
                  {DISPLAY_LABELS[topKey]}
                </span>
                <span className="rounded-full bg-black/50 px-2.5 py-1 text-sm font-mono">
                  {(topConfidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Score & Streak — easy to see at a glance */}
        <div className="mx-4 mt-4 flex items-center justify-between rounded-2xl bg-white p-4 shadow">
          <div>
            <p className="text-xs font-medium text-slate-500">🏆 Score</p>
            <p className="mt-0.5 text-4xl font-extrabold tabular-nums text-slate-900">{score}</p>
          </div>
          <div className="h-10 w-px bg-slate-200" />
          <div className="text-right">
            <p className="text-xs font-medium text-slate-500">🔥 Streak</p>
            <p className="mt-0.5 text-4xl font-extrabold tabular-nums text-amber-500">{streak}</p>
          </div>
        </div>

        {/* Reset session */}
        <div className="mx-4 mt-3">
          <button
            onClick={resetSession}
            className="w-full rounded-full border border-slate-300 bg-white py-3 text-sm font-medium text-slate-600 shadow-sm active:bg-slate-100"
          >
            🔄 Reset Session
          </button>
        </div>

        {/* Agent feedback — styled like a message from an AI Coach */}
        <div className="mx-4 mt-4 flex items-start gap-2">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg shadow ${
              agentStatus === "error" ? "bg-rose-100" : "bg-indigo-100"
            }`}
          >
            🤖
          </span>
          <div
            className={`min-w-0 flex-1 rounded-2xl rounded-tl-sm p-3 shadow ${
              agentStatus === "error" ? "bg-rose-50" : "bg-white"
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              AI Coach
            </p>
            {agentStatus === "thinking" ? (
              <p className="mt-1 flex items-center gap-1 text-sm text-slate-500">
                <span className="inline-flex gap-0.5">
                  <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                  <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                  <span className="animate-bounce">.</span>
                </span>
                thinking…
              </p>
            ) : (
              <p
                className={`mt-1 text-sm leading-snug ${
                  agentStatus === "error" ? "text-rose-600" : "text-slate-700"
                }`}
              >
                {agentStatus === "error" ? agentErrorMessage : agentMessage}
              </p>
            )}
            {tip && agentStatus === "idle" && (
              <p className="mt-2 text-xs leading-snug text-emerald-600">♻️ {tip}</p>
            )}
            {agentStatus === "error" && (
              <p className="mt-2 text-xs leading-snug text-slate-400">
                Last coach tip: {agentMessage}
              </p>
            )}
          </div>
        </div>

        {/* Live predictions (all classes, always visible) */}
        {predictions.length > 0 && (
          <div className="mx-4 mt-4 rounded-2xl bg-white p-4 shadow">
            <p className="mb-2 text-xs font-medium text-slate-500">📊 Live Predictions</p>
            <div className="flex flex-col gap-2">
              {predictions.map((p) => (
                <div key={p.className} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-xs text-slate-600">
                    {DISPLAY_LABELS[normalizeClassName(p.className)] ?? p.className}
                  </span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-700"
                      style={{ width: `${(p.probability * 100).toFixed(0)}%` }}
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right text-xs text-slate-500">
                    {(p.probability * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Session statistics */}
        <div className="mx-4 mt-4">
          <p className="mb-2 text-xs font-medium text-slate-500">📈 Session Statistics</p>
          <div className="grid grid-cols-2 gap-3">
            <StatTile icon="💧" label="Water" value={stats.water} />
            <StatTile icon="🥗" label="Healthy Snack" value={stats.healthy} />
            <StatTile icon="🍟" label="Unhealthy Snack" value={stats.unhealthy} />
            <StatTile icon="✅" label="Total Scans" value={stats.total} />
          </div>
        </div>

        {modelState === "error" && modelError && (
          <p className="mx-4 mt-4 text-center text-xs text-rose-600">{modelError}</p>
        )}
      </div>
    </>
  );
}

function StatTile({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-white p-4 text-center shadow">
      <p className="text-2xl font-bold tabular-nums text-slate-900">
        {icon} {value}
      </p>
      <p className="mt-1 text-xs font-medium text-slate-500">{label}</p>
    </div>
  );
}
