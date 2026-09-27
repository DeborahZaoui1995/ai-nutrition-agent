# AI Desk Snack & Health Coach

A mobile-first web app that uses your phone's camera to recognize what's on your desk — water, a healthy snack, or an unhealthy snack — and an AI coach that turns healthy desk habits into a small scoring game.

## Project Goal

Encourage better hydration and snacking habits during desk work by gamifying it: point your camera at what you're about to drink or eat, get instant recognition, and let an AI coach decide whether it matches your current challenge, react with short encouraging feedback, and pick what to aim for next.

## Architecture

```
Browser (client component)                Server (Next.js API routes)
─────────────────────────────             ─────────────────────────────
Camera + Teachable Machine model    --->   /api/model   (serves model URLs)
(runs entirely in-browser via              /api/scan    (logs raw detections)
 TensorFlow.js)                            /api/agent   (calls Gemini, server-only)
        │                                          │
        │  stable detection (>=90% confidence,     │
        │  held ~1s, 3s cooldown between scans)     │
        └──────────────── AgentRequest ────────────>│
                                                     ▼
                                            Google Gemini API
                                            (gemini-3.8-flash,
                                             structured JSON output)
        <──────────────── AgentResult ───────────────┘
```

- **`src/components/SnackCoach.tsx`** — the entire client UI: camera access, loads the Teachable Machine model, runs the prediction loop, tracks session state (score, streak, challenge, per-category counts), and calls `/api/agent` after every stable, valid detection.
- **`src/app/api/model/route.ts`** — serves the Teachable Machine model/metadata URLs to the client.
- **`src/app/api/scan/route.ts`** — lightweight server-side logging of raw detection events.
- **`src/app/api/agent/route.ts`** — the Agent endpoint (see below).
- **`src/app/api/agent/status/route.ts`** — reports only whether `GEMINI_API_KEY` is configured (`{configured: boolean}`), never the key itself.
- **`src/lib/gemini.ts`** — server-only Gemini client (`import "server-only"`), lazily constructed, throws only when actually used without a key.
- **`src/lib/agent.ts`** — server-only Agent logic: input validation, the Gemini prompt, the JSON schema, and response sanitization.
- **`src/lib/challenge.ts`** — shared types/contract between client and server (safe for both, no server-only imports).

## Teachable Machine Classes

The camera model recognizes exactly four classes:

| Class | Meaning |
|---|---|
| `Water` | A water bottle / drink |
| `HEALTHY_SNACK` | A healthy snack |
| `UNHEALTHY_SNACK` | An unhealthy snack |
| `NO_OBJECT` | Nothing relevant in frame |

A detection only counts as a "scan" once it holds ≥90% confidence for about 1 second (stability gate), followed by a 3-second cooldown before the next scan can trigger. `NO_OBJECT` (and any unrecognized/low-confidence reading) never reaches the Agent.

## AI Agent Goal

Help the user complete a fun "healthy desk habits" challenge while giving short, useful nutrition and hydration feedback — the Agent makes a game decision about the detected item, it does not just describe it.

## Agent Input

Sent as JSON to `POST /api/agent` after every valid, stable scan:

```ts
{
  detectedClass: "WATER" | "HEALTHY_SNACK" | "UNHEALTHY_SNACK",
  confidence: number,           // 0-1
  currentScore: number,
  streak: number,
  totalScans: number,
  waterCount: number,
  healthySnackCount: number,
  unHealthySnackCount: number,
  currentChallenge: "Water" | "HEALTHY_SNACK" | "UNHEALTHY_SNACK",
  previousAgentMessage: string,
}
```

## Agent State

Session state (score, streak, current challenge, per-category counts, last coach message) lives entirely in React state in `SnackCoach.tsx` for the lifetime of the page — no database, no server-side session storage. It survives normal UI re-renders, and the **Reset Session** button zeroes everything and re-initializes the challenge. The latest state is sent to the Agent on every single request.

## Agent Decisions / Actions

The Agent (Gemini, with a server-side safety net regardless of what it returns) responds with:

```ts
{
  accepted: boolean,
  feedback: string,             // short, mobile-friendly coach message
  scoreDelta: number,           // clamped server-side to [-10, 30]
  nextChallenge: "Water" | "HEALTHY_SNACK" | "UNHEALTHY_SNACK",
  action: "ACCEPT_SCAN" | "RESCAN",
  tip: string,                  // short nutrition/hydration tip
}
```

Rules baked into the prompt *and* enforced server-side as a hard fallback:
- A scan matching the current challenge is rewarded generously (15–30 points).
- A valid but unrelated healthy scan (water/healthy snack) still counts, with a small reward (0–5).
- An unhealthy-snack scan that does **not** match the current challenge is never rewarded (clamped to 0 to -5), and the feedback nudges the user toward water or a healthy snack instead.
- Unclear/invalid input always returns `RESCAN` with no score change — this happens instantly server-side without even calling Gemini.

## Technologies Used

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript**
- **Tailwind CSS v4**
- **Teachable Machine** (`@teachablemachine/image`) + **TensorFlow.js** — runs entirely client-side
- **Google Gemini API** via `@google/genai` (model: `gemini-3.8-flash`), server-side only, with structured JSON-schema output
- **ESLint** (`eslint-config-next`)

## How to Run Locally

```bash
npm install
cp .env.example .env.local   # then fill in your real key, see below
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) on a device with a camera, allow camera permission, and tap **Start Camera**.

Other useful scripts: `npm run build` (production build), `npm run start` (serve the production build), `npm run lint`.

## Required Environment Variable

| Variable | Where | Required |
|---|---|---|
| `GEMINI_API_KEY` | `.env.local` (local) / project env vars (hosting) | Yes — the Agent returns a friendly "not configured" error without it, but the rest of the app still works |

Get a key from [Google AI Studio](https://aistudio.google.com/apikey). `.env.local` is git-ignored — never commit it.

## Deployment Overview

This is a standard Next.js App Router project — it deploys to **Vercel** with zero extra configuration:

1. Push this repo to GitHub.
2. Import it into Vercel.
3. In the Vercel project's **Settings → Environment Variables**, add `GEMINI_API_KEY` (do **not** prefix it with `NEXT_PUBLIC_`).
4. Deploy — Vercel auto-detects the Next.js build (`next build`) and runtime.

Without step 3, the app deploys fine but `/api/agent` responds with a "not configured" error until the key is added.

## Security Note

**`GEMINI_API_KEY` must remain server-side, always.** It is:
- read only inside modules explicitly marked `import "server-only"` (`src/lib/gemini.ts`, `src/lib/agent.ts`),
- used only from server-side API route handlers, never from a client component,
- never prefixed with `NEXT_PUBLIC_` (which would bundle it into browser JavaScript),
- never returned by any API response — `/api/agent/status` reports only a boolean,
- stored only in `.env.local`, which is excluded via `.gitignore` (`.env*`, with `.env.example` explicitly un-ignored as a safe template).

If you ever suspect the key has leaked (e.g., accidentally pasted somewhere public), rotate it immediately at [Google AI Studio](https://aistudio.google.com/apikey).
