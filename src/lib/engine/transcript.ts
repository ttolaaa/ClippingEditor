import type { TranscriptSegment, Word } from "../types";

/** Trim, merge stray punctuation tokens, and enforce monotonic timings. */
export function normalizeWords(words: Word[]): Word[] {
  const out: Word[] = [];
  const sorted = [...words].sort((a, b) => a.start - b.start);
  for (const w of sorted) {
    const text = w.text.trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && /^[^\p{L}\p{N}]+$/u.test(text)) {
      prev.text += text;
      prev.end = Math.max(prev.end, w.end);
      continue;
    }
    let start = w.start;
    if (prev && start < prev.end) start = prev.end;
    out.push({ text, start, end: Math.max(start + 0.04, w.end) });
  }
  return out;
}

export function buildSegments(words: Word[]): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 1.0 || cur.length > 40)) flush();
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text)) flush();
  }
  flush();
  return segs;
}

export function spreadWords(text: string, start: number, end: number): Word[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => Math.max(2, t.length));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return tokens.map((tok, i) => {
    const d = ((end - start) * weights[i]) / total;
    const w = { text: tok, start: t, end: t + d };
    t += d;
    return w;
  });
}

export const LANGUAGES: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  hindi: "hi",
  arabic: "ar",
  russian: "ru",
  indonesian: "id",
  thai: "th",
  vietnamese: "vi",
  khmer: "km",
};
