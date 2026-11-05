import type { Word } from "../types";
import { compact, parseMarkup, segmentsToMarkup, segmentsToText, SENTENCE_END } from "./ruby";
import type { AnimeSubtitle, AnimeSubtitleFile, RubySegment } from "./types";

let counter = 0;
export const newSubtitleId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export interface RawLine {
  start: number;
  end: number;
  text: string;
}

const MAX_CHARS = 26;
const SOFT_CHARS = 14;
const MAX_SECONDS = 6;
const GAP_BREAK = 0.7;

const isJa = (s: string) => /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
const joinTokens = (tokens: string[]) => tokens.reduce((acc, t) => (acc && !isJa(acc.slice(-1)) && !isJa(t[0]) ? `${acc} ${t}` : acc + t), "");

/** Group Whisper word/token timings into readable subtitle lines (sentence ends, pauses, length limits). */
export function segmentJapanese(words: Word[]): RawLine[] {
  const lines: RawLine[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = joinTokens(cur.map((w) => w.text)).trim();
    if (text && /[\p{L}\p{N}]/u.test(text)) lines.push({ start: cur[0].start, end: cur[cur.length - 1].end, text });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > GAP_BREAK) flush();
    cur.push(w);
    const chars = cur.reduce((n, x) => n + x.text.length, 0);
    const dur = w.end - cur[0].start;
    if (SENTENCE_END.test(w.text.slice(-1)) || chars >= MAX_CHARS || dur >= MAX_SECONDS || (chars >= SOFT_CHARS && /[、,]$/.test(w.text))) flush();
  }
  flush();

  // Drop Whisper "loops" (the same line repeated many times) and give very short lines time to be read.
  const out: RawLine[] = [];
  for (const l of lines) {
    const n = out.length;
    if (n >= 2 && out[n - 1].text === l.text && out[n - 2].text === l.text) continue;
    out.push({ ...l });
  }
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const wanted = out[i].start + Math.min(2.5, Math.max(0.8, out[i].text.length * 0.12));
    if (out[i].end < wanted) out[i].end = next ? Math.min(wanted, next.start - 0.02) : wanted;
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.5;
  }
  return out;
}

export function activeSubtitleAt(subs: AnimeSubtitle[], t: number): AnimeSubtitle | null {
  for (let i = subs.length - 1; i >= 0; i--) {
    const s = subs[i];
    if (t >= s.start && t < s.end) return s;
  }
  return null;
}

export function sortSubtitles(subs: AnimeSubtitle[]): AnimeSubtitle[] {
  return [...subs].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function toSubtitleFile(subs: AnimeSubtitle[], meta: { name?: string; duration?: number; clip?: { start: number; end: number } } = {}): AnimeSubtitleFile {
  return {
    version: 1,
    sourceLanguage: "ja",
    targetLanguage: "en",
    video: { name: meta.name, duration: meta.duration },
    clip: meta.clip,
    subtitles: sortSubtitles(subs).map((s) => ({
      id: s.id,
      start: round(s.start),
      end: round(s.end),
      text: segmentsToText(s.ja),
      ruby: segmentsToMarkup(s.ja),
      segments: s.ja,
      en: s.en,
    })),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function readSegments(v: unknown): RubySegment[] | null {
  if (!Array.isArray(v)) return null;
  const segs = v
    .filter((x): x is { text: unknown; ruby?: unknown } => !!x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string")
    .map((x) => {
      const ruby = typeof x.ruby === "string" ? x.ruby.trim() : "";
      return ruby ? { text: x.text as string, ruby } : { text: x.text as string };
    });
  return segs.length ? compact(segs) : null;
}

/**
 * Parse a subtitle document. Japanese text may be given as `segments`, as ruby markup (`ruby`),
 * or as plain `text` (then `annotate` adds furigana, if provided).
 */
export async function parseSubtitleFile(raw: unknown, annotate?: (text: string) => Promise<RubySegment[]>): Promise<AnimeSubtitle[]> {
  const list = Array.isArray(raw) ? raw : (raw as { subtitles?: unknown })?.subtitles;
  if (!Array.isArray(list)) throw new Error('Not a subtitle file: expected a "subtitles" array.');
  const out: AnimeSubtitle[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const start = Number(o.start);
    const end = Number(o.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    let ja = readSegments(o.segments ?? o.ja);
    if (!ja && typeof o.ruby === "string" && o.ruby) ja = parseMarkup(o.ruby);
    if (!ja && typeof o.text === "string" && o.text) ja = annotate ? await annotate(o.text) : [{ text: o.text }];
    out.push({ id: typeof o.id === "string" && o.id ? o.id : newSubtitleId(), start, end, ja: ja ?? [], en: typeof o.en === "string" ? o.en : "" });
  }
  if (!out.length) throw new Error("No valid subtitles found in this file.");
  return sortSubtitles(out);
}

export function formatTime(sec: number, decimals = 1): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0")}`;
}

/** Accepts "83", "1:23", "1:23.5" or "0:01:23". Returns null when invalid. */
export function parseTime(input: string): number | null {
  const parts = input.trim().split(":");
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}
