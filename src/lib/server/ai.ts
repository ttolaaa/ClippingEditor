import type { Moment, MomentType, PlotTwist, TranscriptSegment } from "../types";
import { chatJSON, type UsageSink } from "./openai";

const MOMENT_TYPES: MomentType[] = ["funny", "emotional", "unexpected", "plot_twist", "insightful", "high_energy"];

export const MOMENTS_MAX_OUTPUT = 3000;
export const META_MAX_OUTPUT = 4000;
/** Prompt overhead (system prompt + instructions to the model) in characters, for budget estimates. */
export const PROMPT_OVERHEAD_CHARS = 1500;

interface AIMomentResponse {
  summary?: string;
  moments?: { start: number; end: number; type: string; score: number; reason: string; is_plot_twist?: boolean; twist_time?: number }[];
}

/** Ask GPT for viral moments and plot twists in one transcript window (text only). */
export async function aiMomentsForChunk(segments: TranscriptSegment[], duration: number, instructions = "", usage?: UsageSink) {
  const moments: Moment[] = [];
  const twists: PlotTwist[] = [];
  const system =
    "You are an elite short-form video editor who finds viral moments for TikTok, Reels and Shorts. " +
    "Given a timestamped transcript, identify the most engaging moments: funny, emotional, unexpected, plot twists (reveals, reversals, surprising outcomes), insightful or high-energy. " +
    "Prefer self-contained moments with a strong hook and a payoff. Respond with JSON only." +
    (instructions ? ` The creator gave these clipping rules — follow them strictly: "${instructions}"` : "");
  const lines = segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n").slice(0, 45000);
  const user =
    `Transcript (seconds):\n${lines}\n\nReturn JSON: {"summary": string (1 sentence), "moments": [{"start": number, "end": number, "type": one of ${JSON.stringify(MOMENT_TYPES)}, ` +
    `"score": number 0-1 (viral potential), "reason": string (max 15 words), "is_plot_twist": boolean, "twist_time": number|null}]}. ` +
    "Return up to 10 moments, each 5-60 seconds, timestamps must come from the transcript.";
  const res = await chatJSON<AIMomentResponse>(system, user, MOMENTS_MAX_OUTPUT, usage);
  for (const m of res?.moments ?? []) {
    const start = Number(m.start);
    const end = Number(m.end);
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const type = (MOMENT_TYPES.includes(m.type as MomentType) ? m.type : "unexpected") as MomentType;
    const score = Math.max(0, Math.min(1, Number(m.score) || 0.5));
    moments.push({ start, end: Math.min(end, duration), type, score, reason: String(m.reason ?? ""), source: "ai" });
    if (m.is_plot_twist || type === "plot_twist") {
      const tt = Number(m.twist_time);
      twists.push({
        time: isFinite(tt) && tt >= start && tt <= end ? tt : (start + end) / 2,
        confidence: Math.min(0.99, 0.55 + score * 0.4),
        reason: String(m.reason ?? "AI-detected reveal"),
        source: "ai",
      });
    }
  }
  return { moments, twists, summary: res?.summary ?? "" };
}

export const TRANSLATE_MAX_OUTPUT = 4000;

/** Sanitise furigana pairs from the model: kanji words with kana-only readings, bounded size. */
export function cleanRuby(x: unknown): { w: string; r: string }[] {
  if (!Array.isArray(x)) return [];
  return x
    .slice(0, 40)
    .map((p) => ({ w: String((p as { w?: unknown })?.w ?? "").trim().slice(0, 30), r: String((p as { r?: unknown })?.r ?? "").trim().slice(0, 60) }))
    .filter((p) => /[\u3400-\u9fff\uf900-\ufaff\u3005]/.test(p.w) && /^[\u3041-\u309f\u30a0-\u30ffー]+$/.test(p.r));
}

/**
 * Translate numbered Japanese subtitle lines to natural English, keeping one output per input line. With `readings`,
 * also returns context-aware furigana pairs per line.
 */
export async function aiTranslateLines(lines: string[], usage?: UsageSink, readings = false): Promise<{ en: string[]; ruby: { w: string; r: string }[][] }> {
  const res = await chatJSON<{ translations?: { id: number; en: string; ruby?: unknown }[] }>(
    "You are a professional anime and film subtitle translator. Translate Japanese dialogue into accurate, natural, concise English subtitles " +
      "that keep the speaker's meaning and tone. The lines are consecutive dialogue from one scene, so use earlier and later lines as context " +
      "(who is speaking to whom, what was just said). Dialects such as Kansai-ben must be understood correctly (e.g. はる/はった is respectful, " +
      "あかん = no good, ほんま = really). Keep names in romaji. Keep the speaker's own voice (first person stays first person; never rewrite a line as reported speech). Never add content that is not in the Japanese. " +
      "The Japanese may come from speech recognition and contain small errors; infer the intended meaning. Respond with JSON only.",
    readings
      ? `Translate every line, and give its furigana: "ruby" lists every word of the line that contains kanji, in order, as {"w": the word exactly as written (with okurigana), "r": its hiragana reading as pronounced in this context, e.g. 一人→ひとり, 今日→きょう}. ` +
          `Return {"translations":[{"id":number,"en":string,"ruby":[{"w":string,"r":string}]}]} with exactly one entry per id.\n\nLines:\n${JSON.stringify(lines.map((text, id) => ({ id, text })))}`
      : `Translate every line. Return {"translations":[{"id":number,"en":string}]} with exactly one entry per id.\n\nLines:\n${JSON.stringify(lines.map((text, id) => ({ id, text })))}`,
    readings ? TRANSLATE_MAX_OUTPUT * 2 : TRANSLATE_MAX_OUTPUT,
    usage,
  );
  const out = lines.map(() => "");
  const ruby: { w: string; r: string }[][] = lines.map(() => []);
  for (const t of res?.translations ?? []) {
    const id = Number(t?.id);
    if (Number.isInteger(id) && id >= 0 && id < out.length) {
      out[id] = String(t.en ?? "").trim().slice(0, 400);
      if (readings) ruby[id] = cleanRuby(t.ruby);
    }
  }
  return { en: out, ruby };
}

export interface MetaItem {
  id: number;
  seconds: number;
  plot_twist: boolean;
  tags: string[];
  transcript: string;
}

export async function aiMetaFor(items: MetaItem[], instructions = "", usage?: UsageSink) {
  const res = await chatJSON<{ clips?: { id: number; title: string; hook: string; hashtags: string[]; reason?: string }[] }>(
    "You write scroll-stopping metadata for TikTok, Instagram Reels, YouTube Shorts and Facebook Reels. Respond with JSON only." +
      (instructions ? ` Respect the creator's instructions: "${instructions}"` : ""),
    `For each clip, write: "title" (max 60 chars, curiosity-driven), "hook" (on-screen opening text, max 8 words, may include 1 emoji), ` +
      `"hashtags" (5-8, lowercase, with #), "reason" (why it can go viral, max 18 words).\n` +
      `Return {"clips":[{"id":number,"title":string,"hook":string,"hashtags":string[],"reason":string}]}.\n\nClips:\n${JSON.stringify(items)}`,
    META_MAX_OUTPUT,
    usage,
  );
  return (res?.clips ?? [])
    .filter((c) => c && c.title)
    .map((c) => ({
      id: Number(c.id),
      title: String(c.title).slice(0, 90),
      hook: String(c.hook ?? "").slice(0, 90),
      hashtags: (c.hashtags ?? []).map((h) => (String(h).startsWith("#") ? String(h) : `#${h}`)).slice(0, 8),
      reason: c.reason ? String(c.reason) : undefined,
    }));
}
