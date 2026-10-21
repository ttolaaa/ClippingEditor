import type { CaptionLine, CaptionStyle, Word } from "./types";

const base: Omit<CaptionStyle, "preset"> = {
  fontFamily: "Arial Black",
  fontSize: 76,
  textColor: "#FFFFFF",
  highlightColor: "#FF7A00",
  outlineColor: "#000000",
  outlineWidth: 6,
  background: false,
  backgroundColor: "#000000",
  positionY: 68,
  uppercase: true,
  wordsPerLine: 3,
  highlightActiveWord: true,
  popAnimation: true,
  enabled: true,
};

export const CAPTION_PRESETS: Record<string, { label: string; style: CaptionStyle }> = {
  bold: { label: "Bold Pop", style: { ...base, preset: "bold" } },
  minimal: {
    label: "Minimal",
    style: {
      ...base,
      preset: "minimal",
      fontFamily: "Arial",
      fontSize: 58,
      outlineWidth: 3,
      uppercase: false,
      wordsPerLine: 5,
      highlightActiveWord: false,
      popAnimation: false,
      positionY: 78,
    },
  },
  boxed: {
    label: "Boxed",
    style: {
      ...base,
      preset: "boxed",
      fontFamily: "Arial",
      fontSize: 60,
      textColor: "#000000",
      highlightColor: "#E5371F",
      backgroundColor: "#FFFFFF",
      outlineColor: "#FFFFFF",
      outlineWidth: 14,
      background: true,
      uppercase: false,
      wordsPerLine: 4,
      popAnimation: false,
      positionY: 74,
    },
  },
  impact: {
    label: "Impact Green",
    style: {
      ...base,
      preset: "impact",
      fontFamily: "Impact",
      fontSize: 92,
      highlightColor: "#22C55E",
      outlineWidth: 7,
      wordsPerLine: 2,
      positionY: 55,
    },
  },
  alert: {
    label: "Red Alert",
    style: {
      ...base,
      preset: "alert",
      fontFamily: "Arial Black",
      fontSize: 84,
      textColor: "#FFFFFF",
      highlightColor: "#EF4444",
      wordsPerLine: 1,
      positionY: 50,
    },
  },
};

export const FONT_OPTIONS = ["Arial Black", "Arial", "Impact", "Verdana", "Georgia", "Trebuchet MS", "Comic Sans MS"];

export function presetStyle(preset: string): CaptionStyle {
  return { ...(CAPTION_PRESETS[preset] ?? CAPTION_PRESETS.bold).style };
}

let idCounter = 0;
export function lineId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `l${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Group words into caption lines, breaking on punctuation, pauses and max words. */
export function groupWordsIntoLines(words: Word[], wordsPerLine: number): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let cur: Word[] = [];
  const maxWords = Math.max(1, Math.round(wordsPerLine));
  const flush = () => {
    if (!cur.length) return;
    lines.push({
      id: lineId(),
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map((w) => w.text).join(" "),
      words: cur,
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.6 || cur.length >= maxWords || w.end - cur[0].start > 3.2)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text) && cur.length >= Math.min(2, maxWords)) flush();
  }
  flush();
  // Close tiny gaps so captions do not flicker between lines.
  for (let i = 0; i < lines.length - 1; i++) {
    const gap = lines[i + 1].start - lines[i].end;
    if (gap > 0 && gap < 0.35) lines[i].end = lines[i + 1].start;
  }
  return lines;
}

/** Re-derive word timings after a user edits a line's text. */
export function retimeLine(line: CaptionLine, text: string, start = line.start, end = line.end): CaptionLine {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const dur = Math.max(0.1, end - start);
  let words: Word[];
  if (tokens.length === line.words.length && start === line.start && end === line.end) {
    words = line.words.map((w, i) => ({ ...w, text: tokens[i] }));
  } else if (tokens.length === line.words.length && line.end > line.start) {
    const scale = dur / (line.end - line.start);
    words = line.words.map((w, i) => ({
      text: tokens[i],
      start: start + (w.start - line.start) * scale,
      end: start + (w.end - line.start) * scale,
    }));
  } else {
    const weights = tokens.map((t) => Math.max(2, t.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let t = start;
    words = tokens.map((tok, i) => {
      const d = (weights[i] / total) * dur;
      const w = { text: tok, start: t, end: t + d };
      t += d;
      return w;
    });
  }
  return { ...line, text: tokens.join(" "), start, end, words };
}

export function flattenWords(lines: CaptionLine[]): Word[] {
  return lines.flatMap((l) => l.words);
}

export function activeLineAt(lines: CaptionLine[], t: number): CaptionLine | undefined {
  return lines.find((l) => t >= l.start && t < l.end);
}

export function formatTime(sec: number, withTenths = false): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const tenths = Math.floor((sec * 10) % 10);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const base = `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
  return withTenths ? `${base}.${tenths}` : base;
}

export function formatEta(sec?: number): string {
  if (sec === undefined || !isFinite(sec)) return "estimating…";
  if (sec < 5) return "a few seconds";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
