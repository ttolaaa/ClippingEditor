/**
 * Subtitle / transcript file import: SRT, WebVTT, ASS/SSA, timestamped plain text and the app's own JSON.
 * Japanese files are often Shift_JIS or UTF-16, so the bytes are decoded with the right charset first.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export type CueLanguage = "ja" | "en" | "other";

/** Decode subtitle bytes: UTF-8 (with/without BOM), UTF-16 LE/BE (BOM), otherwise Shift_JIS / EUC-JP fallbacks. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    // not valid UTF-8
  }
  for (const enc of ["shift_jis", "euc-jp", "windows-1252"]) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch {
      // try the next charset
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** "00:01:02,345" / "01:02.345" / "0:01:02.34" (ASS) → seconds. */
function parseClock(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + f;
}

/** Remove styling: HTML-like tags, ASS override blocks, karaoke markers, speaker labels in brackets stay. */
function cleanCueText(t: string): string {
  return t
    .replace(/\{[^}]*\}/g, "") // ASS overrides {\an8}{\i1}
    .replace(/\\N|\\n/g, "\n") // ASS line breaks
    .replace(/\\h/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "") // <i>, <font>, <c.color>, <v Speaker>
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // Lines of one cue: Japanese is joined with a full-width space, other text with a normal space.
    .reduce((acc, l) => (!acc ? l : /[\u3040-\u30ff\u3400-\u9fff。、！？]$/.test(acc) && /^[\u3040-\u30ff\u3400-\u9fff「]/.test(l) ? `${acc}\u3000${l}` : `${acc} ${l}`), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseSrtOrVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = parseClock(a);
    const end = parseClock(b.trim().split(/\s+/)[0]);
    if (start === null || end === null || end <= start) continue;
    const body = cleanCueText(lines.slice(i + 1).join("\n"));
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let format: string[] = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  let inEvents = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (/^\[events\]/i.test(line)) inEvents = true;
    else if (/^\[/.test(line)) inEvents = false;
    if (!inEvents) continue;
    if (/^format:/i.test(line)) {
      format = line.slice(7).split(",").map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) continue;
    const parts = line.slice(9).split(",");
    // The text field is last and may itself contain commas.
    const fields = [...parts.slice(0, format.length - 1), parts.slice(format.length - 1).join(",")];
    const get = (k: string) => fields[format.indexOf(k)]?.trim() ?? "";
    const start = parseClock(get("start"));
    const end = parseClock(get("end"));
    const body = cleanCueText(get("text"));
    // Skip signs/karaoke/typesetting lines that aren't dialogue.
    if (start === null || end === null || end <= start || !body || /sign|song|op|ed|karaoke|title/i.test(get("style")) && !/default|main|dialog/i.test(get("style"))) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

/** "[00:01:02] text" / "00:01:02.5 text" / "1:02 - text" lines; each line lasts until the next one (max 6 s). */
function parseTimestampedText(text: string): Cue[] {
  const rows: { t: number; text: string }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\s*\[?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*[-–:]?\s*(.+)$/.exec(raw);
    if (!m) continue;
    const t = parseClock(m[1]);
    const body = cleanCueText(m[2]);
    if (t !== null && body) rows.push({ t, text: body });
  }
  return rows.map((r, i) => ({ start: r.t, end: Math.min(rows[i + 1]?.t ?? r.t + 4, r.t + 6), text: r.text })).filter((c) => c.end > c.start);
}

function parseAppJson(text: string): Cue[] {
  const raw = JSON.parse(text) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { subtitles?: unknown[] })?.subtitles;
  if (!Array.isArray(list)) return [];
  return list
    .map((o) => o as { start?: number; end?: number; text?: string; ruby?: string; segments?: { text: string }[] })
    .map((o) => ({
      start: Number(o.start),
      end: Number(o.end),
      text: o.text ?? o.segments?.map((s) => s.text).join("") ?? (o.ruby ?? "").replace(/<rt>.*?<\/rt>|<\/?ruby>|<\/?rb>|<rp>.*?<\/rp>/g, ""),
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text.trim());
}

/** Parse a subtitle/transcript file of any supported format into time-sorted cues. Throws with a helpful message. */
export function parseSubtitleText(text: string, fileName = ""): Cue[] {
  const name = fileName.toLowerCase();
  let cues: Cue[] = [];
  if (name.endsWith(".json") || /^\s*[[{]/.test(text)) {
    try {
      cues = parseAppJson(text);
    } catch {
      cues = [];
    }
  }
  if (!cues.length && (name.endsWith(".ass") || name.endsWith(".ssa") || /^\s*\[script info\]/im.test(text))) cues = parseAss(text);
  if (!cues.length && text.includes("-->")) cues = parseSrtOrVtt(text);
  if (!cues.length) cues = parseTimestampedText(text);
  if (!cues.length)
    throw new Error("No timed lines found. Supported: .srt, .vtt, .ass/.ssa, the app's subtitle JSON, or text lines starting with a time like [01:23].");
  // Merge exact duplicates (some files repeat a line for positioning) and sort.
  const seen = new Set<string>();
  return cues
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((c) => {
      const k = `${c.start.toFixed(2)}|${c.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export async function readSubtitleFile(file: File): Promise<Cue[]> {
  return parseSubtitleText(decodeSubtitleBytes(new Uint8Array(await file.arrayBuffer())), file.name);
}

/** Japanese when a good share of the characters are kana/kanji, English when mostly Latin letters. */
export function detectCueLanguage(cues: Cue[]): CueLanguage {
  const sample = cues
    .slice(0, 200)
    .map((c) => c.text)
    .join("");
  const ja = (sample.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
  const latin = (sample.match(/[a-z]/gi) ?? []).length;
  if (ja > 0 && ja >= latin * 0.3) return "ja";
  if (latin > 0) return "en";
  return "other";
}

/** Text of the cues that overlap [start, end] by at least 40 % of the shorter span, joined in order. */
export function cuesFor(cues: Cue[], start: number, end: number, joiner = " "): string {
  const hits = cues.filter((c) => {
    const overlap = Math.min(end, c.end) - Math.max(start, c.start);
    return overlap > 0 && overlap >= 0.4 * Math.min(end - start, c.end - c.start);
  });
  return hits.map((c) => c.text).join(joiner).trim();
}

/** Shift every cue (for files timed against a slightly different cut of the video). */
export function offsetCues(cues: Cue[], seconds: number): Cue[] {
  return seconds ? cues.map((c) => ({ ...c, start: c.start + seconds, end: c.end + seconds })).filter((c) => c.end > 0) : cues;
}
