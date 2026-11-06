import type { Word } from "../types";
import { isFillerOnly, isPhantom } from "../engine/hallucination";
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
    const joined = joinTokens(cur.map((w) => w.text)).trim();
    // Phrase markers that chop a line into 1–2 character fragments ("ん　に　活動　節") are tokenizer noise, not pauses.
    const pieces = joined.split("\u200B").filter((p) => p.trim());
    const markers = pieces.length > 2 && joined.replace(/\u200B/g, "").length / pieces.length < 3 ? joined.replace(/\u200B/g, "") : joined;
    const text = markers
      // Whisper's phrase pauses (marked with U+200B by the worker) become a full-width space between Japanese words.
      .replace(/(?<=[\u3040-\u30ff\u3400-\u9fff\uff01-\uff5e、。！？!?])\u200B(?=[\u3040-\u30ff\u3400-\u9fff「『])/g, "\u3000")
      .replace(/\u200B/g, "")
      // A phrase recognised twice back to back ("本当に大丈夫ですか本当に大丈夫ですか") is a recognition artefact.
      .replace(/(.{4,}?)\1+/g, "$1");
    if (text && /[\p{L}\p{N}]/u.test(text) && !isPhantom(text) && !isFillerOnly(text)) {
      let start = cur[0].start;
      const end = cur[cur.length - 1].end;
      // A short line can't take 20 s to say: Whisper stretched the first word over music. Anchor it to its end.
      const maxDur = Math.max(3.5, text.length * 0.45);
      if (end - start > maxDur) start = end - maxDur;
      lines.push({ start, end, text });
    }
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > GAP_BREAK) flush();
    // A phrase boundary (marked by the worker) is a natural place to break a long line.
    if (cur.length && w.text.startsWith("\u200B") && cur.reduce((n, x) => n + x.text.length, 0) >= SOFT_CHARS) flush();
    cur.push(w);
    const chars = cur.reduce((n, x) => n + x.text.length, 0);
    const dur = w.end - cur[0].start;
    if (SENTENCE_END.test(w.text.slice(-1)) || chars >= MAX_CHARS || dur >= MAX_SECONDS || (chars >= SOFT_CHARS && /[、,]$/.test(w.text))) flush();
  }
  flush();

  // Punctuation split off from its sentence ("?心配…") belongs to the previous line.
  for (let i = 1; i < lines.length; i++) {
    const lead = /^[?？!！。、,.…]+/.exec(lines[i].text)?.[0];
    if (lead && lines[i].start - lines[i - 1].end < 1.5) {
      lines[i - 1].text += lead;
      lines[i].text = lines[i].text.slice(lead.length).trim();
    }
  }

  // Drop Whisper artefacts: the same line looped, or a sentence repeated "compressed" into a fraction of a second
  // (happens where recognition chunks overlap). Normal Japanese speech is roughly 5-12 characters per second.
  const norm = (s: string) => s.replace(/[\s、。？！?!,.…]/g, "");
  const out: RawLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const key = norm(l.text);
    if (!key) continue;
    const n = out.length;
    if (n >= 2 && out[n - 1].text === l.text && out[n - 2].text === l.text) continue;
    const cps = key.length / Math.max(0.05, l.end - l.start);
    if (cps > 20) {
      const near = lines.filter((o, j) => j !== i && Math.abs(o.start - l.start) < 15 && norm(o.text).length >= 3);
      const repeated = near.some((o) => {
        const k = norm(o.text);
        return k.includes(key) || key.includes(k);
      });
      if (repeated) continue;
    }
    out.push({ ...l });
  }
  // Neighbouring lines where one contains the other (within a second) are the same speech recognised twice.
  const edgePunct = /^[\s、。？！?!,.…]+|[\s、,]+$/g;
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    if (b.start - a.end > 1) continue;
    const ka = norm(a.text);
    const kb = norm(b.text);
    if (!(ka.includes(kb) || kb.includes(ka))) continue;
    const longIdx = ka.length >= kb.length ? i - 1 : i;
    const long = out[longIdx];
    const short = out[longIdx === i ? i - 1 : i];
    const kl = norm(long.text);
    const ks = norm(short.text);
    if (ks.length >= kl.length * 0.7) {
      // Near-identical: keep the one with the more natural reading speed.
      const cpsLong = kl.length / Math.max(0.05, long.end - long.start);
      const cpsShort = ks.length / Math.max(0.05, short.end - short.start);
      out.splice(cpsLong > cpsShort ? longIdx : out.indexOf(short), 1);
      continue;
    }
    // The longer line also contains the shorter one's words: cut that part off the longer line when it sits at
    // its start or end (timing scaled by characters), otherwise drop the shorter duplicate.
    const core = short.text.replace(/[。？！?!]+$/, "");
    const at = long.text.indexOf(core);
    const span = long.end - long.start;
    if (at === 0) {
      const rest = long.text.slice(core.length).replace(edgePunct, "");
      long.start += (span * core.length) / long.text.length;
      long.text = rest;
    } else if (at > 0 && at + core.length >= long.text.length - 2) {
      const rest = long.text.slice(0, at).replace(edgePunct, "");
      long.end = long.start + (span * at) / long.text.length;
      long.text = rest;
    } else {
      out.splice(out.indexOf(short), 1);
    }
    if (!norm(long.text)) out.splice(out.indexOf(long), 1);
  }
  out.sort((x, y) => x.start - y.start);
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
