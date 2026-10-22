import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "./config";

/**
 * Abuse protection for the optional OpenAI proxy (/api/ai/*), so a public deployment can't be used to
 * burn through the server's OpenAI credit:
 *   1. Global daily budget (tokens + audio minutes) — hard cap, persisted across restarts.
 *   2. Per-client rate limits (requests/minute, requests/day) and per-client daily token/audio quotas.
 *   3. Same-site check — other websites can't call the API from their visitors' browsers.
 *   4. Optional access code (AI_ACCESS_CODE) — without it, public visitors only get on-device AI.
 *   5. Concurrency cap on in-flight OpenAI calls.
 */

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export const limits = {
  accessCode: process.env.AI_ACCESS_CODE?.trim() || "",
  perMinute: num(process.env.AI_RATE_PER_MINUTE, 20),
  perDay: num(process.env.AI_RATE_PER_DAY, 200),
  clientDailyTokens: num(process.env.AI_CLIENT_DAILY_TOKENS, 200_000),
  clientDailyAudioMin: num(process.env.AI_CLIENT_DAILY_AUDIO_MINUTES, 60),
  dailyTokens: num(process.env.AI_DAILY_TOKENS, 2_000_000),
  dailyAudioMin: num(process.env.AI_DAILY_AUDIO_MINUTES, 180),
  maxConcurrent: Math.max(1, num(process.env.AI_MAX_CONCURRENT, 4)),
  usageFile: process.env.AI_USAGE_FILE?.trim() || path.join(process.cwd(), ".cache", "ai-usage.json"),
};

export type AiKind = "moments" | "meta" | "transcribe";

interface Counter {
  minute: number; // epoch minute of `minuteCount`
  minuteCount: number;
  dayCount: number;
  tokens: number;
  audioMin: number;
}

interface State {
  day: string; // UTC yyyy-mm-dd
  tokens: number;
  audioMin: number;
  requests: number;
  blocked: number;
  clients: Map<string, Counter>;
  inFlight: number;
  loaded: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

const g = globalThis as unknown as { __aiGuard?: State };
const state: State = (g.__aiGuard ??= {
  day: "",
  tokens: 0,
  audioMin: 0,
  requests: 0,
  blocked: 0,
  clients: new Map(),
  inFlight: 0,
  loaded: false,
  saveTimer: null,
});

const today = () => new Date().toISOString().slice(0, 10);

function rollDay() {
  if (!state.loaded) {
    state.loaded = true;
    try {
      const saved = JSON.parse(fs.readFileSync(limits.usageFile, "utf8")) as { day: string; tokens: number; audioMin: number; requests: number; blocked?: number };
      if (saved.day === today()) Object.assign(state, { day: saved.day, tokens: saved.tokens, audioMin: saved.audioMin, requests: saved.requests, blocked: saved.blocked ?? 0 });
    } catch {
      // no saved usage yet
    }
  }
  const d = today();
  if (state.day !== d) {
    state.day = d;
    state.tokens = 0;
    state.audioMin = 0;
    state.requests = 0;
    state.blocked = 0;
    state.clients.clear();
    persist();
  }
}

function persist() {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(limits.usageFile), { recursive: true });
      fs.writeFileSync(limits.usageFile, JSON.stringify({ day: state.day, tokens: state.tokens, audioMin: state.audioMin, requests: state.requests, blocked: state.blocked }));
    } catch {
      // read-only filesystem: limits still apply in memory
    }
  }, 1000);
}

/**
 * Client identity for rate limiting. Behind a reverse proxy (Caddy/nginx/Cloudflare) the proxy appends the real
 * client address as the last X-Forwarded-For entry. Without a proxy the header can be spoofed — the global
 * daily budget below still caps total spend, and the README recommends publishing the app port on 127.0.0.1 only.
 */
function clientKey(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && process.env.TRUST_CLOUDFLARE === "true") return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop() || req.headers.get("x-real-ip")?.trim() || "unknown";
  return ip.replace(/^::ffff:/, "");
}

function sameSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients without Origin are handled by the other limits
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function checkAccessCode(code: string | null | undefined): boolean {
  if (!limits.accessCode) return true;
  if (!code) return false;
  const a = crypto.createHash("sha256").update(code).digest();
  const b = crypto.createHash("sha256").update(limits.accessCode).digest();
  return crypto.timingSafeEqual(a, b);
}

const deny = (status: number, error: string, extra: Record<string, unknown> = {}, retryAfter?: number) => {
  state.blocked++;
  persist();
  return NextResponse.json({ error, ...extra }, { status, headers: retryAfter ? { "Retry-After": String(Math.ceil(retryAfter)) } : undefined });
};

export interface Lease {
  /** Adjust the reservation with the real usage once the OpenAI call finishes. */
  settle(actual: { tokens?: number; audioMin?: number }): void;
  /** Must be called when the request finishes (success or failure). */
  release(): void;
}

/**
 * Admit an AI request. `estimate` is reserved up front (so bursts can't overshoot the budget) and corrected
 * with `lease.settle()` afterwards. Returns a NextResponse to send back when the request is refused.
 */
export function admit(req: Request, kind: AiKind, estimate: { tokens?: number; audioMin?: number }): Lease | NextResponse {
  if (!config.openaiKey) return NextResponse.json({ error: "Cloud AI is not configured" }, { status: 501 });
  rollDay();
  if (!sameSite(req)) return deny(403, "Cross-site requests are not allowed");
  if (!checkAccessCode(req.headers.get("x-ai-access-code"))) return deny(401, "Cloud AI requires an access code", { code: "access_code" });

  const key = clientKey(req);
  const minute = Math.floor(Date.now() / 60_000);
  let c = state.clients.get(key);
  if (!c) {
    if (state.clients.size > 50_000) state.clients.clear(); // memory guard against address spraying
    c = { minute, minuteCount: 0, dayCount: 0, tokens: 0, audioMin: 0 };
    state.clients.set(key, c);
  }
  if (c.minute !== minute) {
    c.minute = minute;
    c.minuteCount = 0;
  }
  const tokens = Math.max(0, Math.ceil(estimate.tokens ?? 0));
  const audioMin = Math.max(0, estimate.audioMin ?? 0);

  if (limits.perMinute && c.minuteCount >= limits.perMinute) return deny(429, "Too many AI requests — slow down", { code: "rate_minute" }, 60 - (Date.now() / 1000) % 60);
  if (limits.perDay && c.dayCount >= limits.perDay) return deny(429, "Daily AI request limit reached for your connection", { code: "rate_day" });
  if (tokens && limits.clientDailyTokens && c.tokens + tokens > limits.clientDailyTokens) return deny(429, "Daily AI usage limit reached for your connection", { code: "client_tokens" });
  if (audioMin && limits.clientDailyAudioMin && c.audioMin + audioMin > limits.clientDailyAudioMin) return deny(429, "Daily cloud transcription limit reached for your connection", { code: "client_audio" });
  if (tokens && limits.dailyTokens && state.tokens + tokens > limits.dailyTokens) return deny(429, "This site's daily cloud AI budget is used up — on-device AI still works", { code: "budget_tokens" });
  if (audioMin && limits.dailyAudioMin && state.audioMin + audioMin > limits.dailyAudioMin) return deny(429, "This site's daily cloud transcription budget is used up", { code: "budget_audio" });
  if (state.inFlight >= limits.maxConcurrent) return deny(503, "Cloud AI is busy — try again shortly", { code: "busy" }, 5);

  c.minuteCount++;
  c.dayCount++;
  c.tokens += tokens;
  c.audioMin += audioMin;
  state.tokens += tokens;
  state.audioMin += audioMin;
  state.requests++;
  state.inFlight++;
  persist();

  const counter = c;
  let reservedTokens = tokens;
  let reservedAudio = audioMin;
  let released = false;
  return {
    settle(actual) {
      if (actual.tokens !== undefined) {
        const d = Math.ceil(actual.tokens) - reservedTokens;
        counter.tokens = Math.max(0, counter.tokens + d);
        state.tokens = Math.max(0, state.tokens + d);
        reservedTokens = Math.ceil(actual.tokens);
      }
      if (actual.audioMin !== undefined) {
        const d = actual.audioMin - reservedAudio;
        counter.audioMin = Math.max(0, counter.audioMin + d);
        state.audioMin = Math.max(0, state.audioMin + d);
        reservedAudio = actual.audioMin;
      }
      persist();
    },
    release() {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
    },
  };
}

/** Rough token estimate for budget reservation (~4 characters per token). */
export const estimateTokens = (chars: number, maxOutput: number) => Math.ceil(chars / 4) + maxOutput;

export function usageSnapshot() {
  rollDay();
  return {
    day: state.day,
    tokens: state.tokens,
    tokenBudget: limits.dailyTokens,
    audioMinutes: Math.round(state.audioMin * 10) / 10,
    audioBudget: limits.dailyAudioMin,
    requests: state.requests,
    blocked: state.blocked,
  };
}

/** Reject bodies over `maxBytes` before reading them (Content-Length is checked again after reading). */
export function tooLarge(req: Request, maxBytes: number): NextResponse | null {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  return null;
}
