import fs from "node:fs";
import path from "node:path";

/**
 * Gemini daily quota tracking. Google doesn't report the remaining quota, so the server counts its own requests per model
 * and quota day (the free tier resets at midnight US Pacific time), and records the exact reset time Google gives when a
 * model's daily quota runs out — then it stops calling that model until the reset, so no time or quota is wasted.
 */

interface ModelState {
  day: string;
  used: number;
  /** Epoch ms until which the model's daily quota is known to be used up. */
  exhaustedUntil?: number;
}

const FILE = process.env.GEMINI_QUOTA_FILE?.trim() || path.join(process.cwd(), ".cache", "gemini-quota.json");
export const DAILY_LIMIT = Math.max(1, Number(process.env.GEMINI_DAILY_LIMIT) || 20);

/** Daily request limit per model: Gemini (GEMINI_DAILY_LIMIT, free tier ~20) or Groq (free tier: speech 2,000, text 1,000). */
export function limitFor(model: string): number {
  if (/whisper/i.test(model)) return Math.max(1, Number(process.env.GROQ_SPEECH_DAILY_LIMIT) || 2000);
  if (!/gemini/i.test(model)) return Math.max(1, Number(process.env.GROQ_TEXT_DAILY_LIMIT) || 1000);
  return DAILY_LIMIT;
}

const g = globalThis as unknown as { __geminiQuota?: { models: Record<string, ModelState>; loaded: boolean; mtime: number; timer: ReturnType<typeof setTimeout> | null } };
const state = (g.__geminiQuota ??= { models: {}, loaded: false, mtime: 0, timer: null });

const PT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function ptParts(now = Date.now()) {
  const p = Object.fromEntries(PT.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, msIntoDay: ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 };
}

/** The quota day (Pacific date) and when it next resets (epoch ms). */
export function quotaDay(now = Date.now()) {
  const { day, msIntoDay } = ptParts(now);
  return { day, resetsAt: now - msIntoDay + 24 * 3600 * 1000 };
}

function load() {
  // Re-read when the file changed outside this process (another server instance, or edited by hand).
  if (state.timer) return;
  try {
    const mtime = fs.statSync(FILE).mtimeMs;
    if (state.loaded && mtime <= state.mtime) return;
    state.models = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state.mtime = mtime;
  } catch {
    // no saved quota yet
  }
  state.loaded = true;
}

function save() {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(state.models));
      state.mtime = fs.statSync(FILE).mtimeMs;
    } catch {
      // read-only filesystem: tracking still works in memory
    }
  }, 500);
}

function current(model: string): ModelState {
  load();
  const { day } = quotaDay();
  let s = state.models[model];
  if (!s || s.day !== day) s = state.models[model] = { day, used: 0, exhaustedUntil: s?.exhaustedUntil };
  if (s.exhaustedUntil && s.exhaustedUntil <= Date.now()) s.exhaustedUntil = undefined;
  return s;
}

/** A request reached Google (counts towards the daily quota). */
export function noteRequest(model: string) {
  current(model).used++;
  save();
}

/** Google said the model's daily quota is used up; `retrySeconds` is its reset hint, if given. */
export function noteExhausted(model: string, retrySeconds?: number) {
  const s = current(model);
  s.used = Math.max(s.used, limitFor(model));
  s.exhaustedUntil = retrySeconds && retrySeconds > 0 ? Date.now() + retrySeconds * 1000 : quotaDay().resetsAt;
  save();
}

export function isExhausted(model: string) {
  return !!current(model).exhaustedUntil;
}

export interface QuotaInfo {
  model: string;
  provider: "gemini" | "groq";
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  /** When the quota is available again (exhausted) or next resets (otherwise), epoch ms. */
  resetsAt: number;
}

export function quotaSnapshot(model: string): QuotaInfo {
  const s = current(model);
  const exhausted = !!s.exhaustedUntil;
  const limit = limitFor(model);
  return {
    model,
    provider: /gemini/i.test(model) ? "gemini" : "groq",
    used: s.used,
    limit,
    remaining: exhausted ? 0 : Math.max(0, limit - s.used),
    exhausted,
    resetsAt: s.exhaustedUntil ?? quotaDay().resetsAt,
  };
}
