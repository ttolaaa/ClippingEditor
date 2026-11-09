"use client";

import { aiHeaders } from "../browser/pipeline";

/** A subtitle line heard by the cloud model: absolute source times, Japanese and its English translation. */
export interface CloudLine {
  start: number;
  end: number;
  text: string;
  en: string;
  /** Context-aware furigana from the model: kanji words and their readings, in order. */
  ruby?: { w: string; r: string }[];
  /** The model's timestamps were unusable and the line was re-timed from loudness (worth a check in films). */
  retimed?: boolean;
}

type Status = (detail: string, progress?: number) => void;

const RATE = 16000;
const FRAME = 320; // 20 ms
const TARGET_PIECE = 90;
const MAX_PIECE = 120;

/** Per-20 ms loudness in dB. */
function frameDb(pcm: Float32Array): Float32Array {
  const n = Math.floor(pcm.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += pcm[i] * pcm[i];
    out[f] = 10 * Math.log10(sum / FRAME + 1e-10);
  }
  return out;
}

/**
 * Cut audio into pieces of about TARGET_PIECE seconds, at the quietest half second near each target so words are not cut
 * in half. Returns [startSample, endSample) pairs.
 */
export function splitAtPauses(pcm: Float32Array): [number, number][] {
  const total = pcm.length / RATE;
  if (total <= MAX_PIECE) return [[0, pcm.length]];
  const db = frameDb(pcm);
  const pieces: [number, number][] = [];
  let from = 0;
  while (pcm.length - from > MAX_PIECE * RATE) {
    // Search 60–120 s into the piece for the quietest 0.5 s window; prefer later cuts slightly.
    const lo = Math.floor((from + 60 * RATE) / FRAME);
    const hi = Math.floor((from + MAX_PIECE * RATE) / FRAME) - 25;
    let best = Math.floor((from + TARGET_PIECE * RATE) / FRAME);
    let bestScore = Infinity;
    let win = 0;
    for (let f = lo; f < lo + 25; f++) win += db[f] ?? 0;
    for (let f = lo; f <= hi; f++) {
      const score = win / 25 - (f - lo) * 0.002;
      if (score < bestScore) {
        bestScore = score;
        best = f + 12;
      }
      win += (db[f + 25] ?? 0) - (db[f] ?? 0);
    }
    const cut = best * FRAME;
    pieces.push([from, cut]);
    from = cut;
  }
  pieces.push([from, pcm.length]);
  return pieces;
}

function wavBase64(pcm: Float32Array): string {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** Loudness threshold separating voice from background, or null when the audio is loud throughout (music bed). */
function voiceThreshold(db: Float32Array): number | null {
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)];
  const threshold = Math.max(floor + 12, -50);
  const loudShare = db.filter((d) => d > threshold).length / db.length;
  return loudShare > 0.75 ? null : threshold;
}

/** Stretches of voice in seconds: loud runs, joined across gaps < 0.35 s, ignoring blips < 0.2 s. */
function voicedRegions(db: Float32Array, threshold: number): [number, number][] {
  const sec = FRAME / RATE;
  const raw: [number, number][] = [];
  let s = -1;
  for (let f = 0; f <= db.length; f++) {
    const on = f < db.length && db[f] > threshold;
    if (on && s < 0) s = f;
    else if (!on && s >= 0) {
      raw.push([s * sec, f * sec]);
      s = -1;
    }
  }
  const merged: [number, number][] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 0.35) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([a, b]) => b - a >= 0.2);
}

/**
 * Some models (the fast fallback) return text that is right but timestamps packed back-to-back from 0:00, ignoring the
 * pauses. Only that pattern is re-timed — never "the lines don't cover all the loud audio", because in films music and
 * effects are loud too. Re-timing lays the lines over the voiced stretches in order, in proportion to their length,
 * moves each boundary to the nearest pause, and never stretches a line far beyond its speaking time.
 * Returns true when it re-timed.
 */
export function looksSqueezed(lines: { start: number; end: number }[], duration = Infinity): boolean {
  if (lines.length < 2) return false;
  const s = [...lines].sort((a, b) => a.start - b.start);
  const n = s.length;
  // Other ways models break timestamps: zero-length lines, many lines at the same instant, lines stamped at the very end
  // of the audio, or one line spanning a huge stretch.
  const zero = s.filter((l) => l.end - l.start < 0.2).length;
  const starts = new Map<string, number>();
  for (const l of s) starts.set(l.start.toFixed(1), (starts.get(l.start.toFixed(1)) ?? 0) + 1);
  const sameStart = Math.max(...starts.values());
  const atEnd = Number.isFinite(duration) ? s.filter((l) => l.start >= duration - 0.5).length : 0;
  const huge = s.some((l) => l.end - l.start > 25);
  const many = (k: number) => k >= 2 && k / n >= 0.3;
  if (many(zero) || many(sameStart) || many(atEnd) || huge) return true;
  if (s[0].start > 0.3) return false;
  let touching = 0;
  for (let i = 1; i < s.length; i++) if (Math.abs(s[i].start - s[i - 1].end) < 0.06) touching++;
  return touching / (s.length - 1) >= 0.8;
}

export function retimeIfOff(lines: { start: number; end: number; text: string }[], pcm: Float32Array, speech?: [number, number][]): boolean {
  if (!looksSqueezed(lines, pcm.length / RATE)) return false;
  let regions: [number, number][];
  if (speech?.length) regions = speech;
  else {
    const db = frameDb(pcm);
    if (db.length < 50 || !lines.length) return false;
    const threshold = voiceThreshold(db);
    if (threshold === null) return false;
    regions = voicedRegions(db, threshold);
  }
  const V = regions.reduce((a, [s, e]) => a + e - s, 0);
  if (!regions.length || V < 0.5) return false;

  // Keep the model's reply order (the spoken order) — its timestamps are the broken part.
  const weight = lines.map((l) => Math.max(1, [...l.text.replace(/[\s\u3000、。，．！？!?…「」『』]/g, "")].length));
  const total = weight.reduce((a, b) => a + b, 0);
  // Positions on the "voice timeline" (only voiced seconds counted); gaps = where one region ends and the next begins.
  const cum: number[] = [];
  let acc = 0;
  for (const [s, e] of regions) cum.push((acc += e - s));
  const gaps = cum.slice(0, -1);
  const bounds: number[] = [0];
  let w = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    w += weight[i];
    const target = (w / total) * V;
    const reach = Math.max(1, (0.3 * V) / lines.length);
    const nearest = gaps.filter((g) => g > bounds[bounds.length - 1] + 0.3).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    bounds.push(nearest !== undefined && Math.abs(nearest - target) < reach ? nearest : Math.max(target, bounds[bounds.length - 1] + 0.3));
  }
  bounds.push(V);
  // Voice-timeline position -> real time. At a gap, a line start goes to the next region, a line end stays in the previous.
  const toReal = (x: number, side: "start" | "end") => {
    for (let k = 0; k < regions.length; k++) {
      const before = k ? cum[k - 1] : 0;
      const atGap = Math.abs(x - cum[k]) < 1e-6 && k < regions.length - 1;
      if (x < cum[k] - 1e-6 || (x <= cum[k] + 1e-6 && (side === "end" || !atGap))) return regions[k][0] + (x - before);
    }
    return regions[regions.length - 1][1];
  };
  for (let i = 0; i < lines.length; i++) {
    lines[i].start = toReal(bounds[i], "start");
    // A line is on screen about as long as it takes to say (plus a little), not across a whole stretch of music.
    const speak = 1.2 + weight[i] * 0.22;
    lines[i].end = Math.min(toReal(bounds[i + 1], "end") + 0.25, lines[i].start + speak);
  }
  return true;
}

/**
 * Re-timed lines (broken model timestamps) are anchored to the on-device scan transcript, which is tied to the audio:
 * each line, in order, is matched to the stretch of scan text that looks most alike (character-bigram similarity, so
 * mishearings still match) and takes its time. Returns how many lines were anchored.
 */
export function anchorToScan(lines: { start: number; end: number; text: string }[], words: { text: string; start: number; end: number }[]): number {
  const clean = (t: string) => [...t.replace(/[\s\u3000\u200B、。，．！？!?…「」『』ー・〜~-]/g, "")];
  const chars: { ch: string; t: number }[] = [];
  for (const w of words) {
    const c = clean(w.text);
    c.forEach((ch, i) => chars.push({ ch, t: w.start + ((w.end - w.start) * i) / Math.max(1, c.length) }));
  }
  if (chars.length < 4) return 0;
  const grams = (a: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i < a.length - 1; i++) m.set(a[i] + a[i + 1], (m.get(a[i] + a[i + 1]) ?? 0) + 1);
    return m;
  };
  const dice = (a: Map<string, number>, al: number, b: string[]) => {
    const g = grams(b);
    let c = 0;
    for (const [k, n] of a) c += Math.min(n, g.get(k) ?? 0);
    return (2 * c) / Math.max(1, al - 1 + b.length - 1);
  };
  // Candidate positions per line (reply order = spoken order), then the in-order choice with the best total similarity —
  // so text shared by two lines (e.g. both start with お母ちゃん) goes to the line it fits best.
  const cands: { t: number; s: number }[][] = lines.map((l) => {
    const line = clean(l.text);
    if (line.length < 3) return [];
    const lg = grams(line);
    const all: { t: number; s: number }[] = [];
    for (let k = 0; k < chars.length; k++) {
      if (Math.abs(chars[k].t - l.start) > 60) continue;
      const s = dice(lg, line.length, chars.slice(k, k + line.length).map((x) => x.ch));
      if (s >= 0.4) all.push({ t: chars[k].t, s });
    }
    return all.sort((a, b) => b.s - a.s).slice(0, 8);
  });
  type Node = { i: number; t: number; total: number; prev: Node | null };
  const nodes: Node[] = [];
  for (let i = 0; i < lines.length; i++)
    for (const c of cands[i]) {
      let bestPrev: Node | null = null;
      for (const n of nodes) if (n.i < i && n.t < c.t - 0.3 && (!bestPrev || n.total > bestPrev.total)) bestPrev = n;
      nodes.push({ i, t: c.t, total: c.s + (bestPrev?.total ?? 0), prev: bestPrev });
    }
  const found: (number | null)[] = lines.map(() => null);
  let end: Node | null = nodes.reduce<Node | null>((a, n) => (!a || n.total > a.total ? n : a), null);
  for (; end; end = end.prev) found[end.i] = end.t;
  const keep = new Set(found.map((t, i) => (t === null ? -1 : i)).filter((i) => i >= 0));
  const weight = lines.map((l) => Math.max(1, clean(l.text).length));
  const anchors = [...keep].sort((x, y) => x - y);
  for (const i of anchors) {
    const dur = lines[i].end - lines[i].start;
    lines[i].start = found[i] as number;
    lines[i].end = lines[i].start + Math.max(0.8, dur);
  }
  // Lines between two anchors are spread over the gap in proportion to their length.
  for (let a = 0; a + 1 < anchors.length; a++) {
    const [i, j] = [anchors[a], anchors[a + 1]];
    if (j - i < 2) continue;
    const from = lines[i].start + weight[i] * 0.15;
    const to = lines[j].start;
    const total = weight.slice(i + 1, j).reduce((x, y) => x + y, 0);
    let acc = 0;
    for (let k = i + 1; k < j; k++) {
      lines[k].start = from + ((to - from) * acc) / Math.max(1, total);
      acc += weight[k];
      lines[k].end = Math.min(to, lines[k].start + 1.2 + weight[k] * 0.2);
    }
  }
  // Before the first / after the last anchor: keep their order relative to it.
  if (anchors.length) {
    for (let k = anchors[0] - 1; k >= 0; k--) if (lines[k].start >= lines[k + 1].start) lines[k].start = lines[k + 1].start - (1 + weight[k] * 0.2);
    for (let k = anchors[anchors.length - 1] + 1; k < lines.length; k++) if (lines[k].start <= lines[k - 1].start) lines[k].start = lines[k - 1].start + 1 + weight[k - 1] * 0.2;
  }
  return anchors.length;
}

/**
 * Align the model's lines to real speech found by the voice detector (Silero VAD, which ignores music and effects):
 *  - a start in music/silence moves to where the voice begins (next speech stretch within 1.5 s, else the nearest earlier
 *    one not used by the previous line); a start just inside a stretch snaps to its beginning;
 *  - an end in music/silence moves back to where the voice stops; an end just inside a stretch extends to its end;
 *  - two lines inside one continuous stretch keep the model's split; lines never overlap.
 * Lines with no speech nearby keep their times. Returns how many lines were moved.
 */
export function alignToSpeech(lines: { start: number; end: number; text: string }[], speech: [number, number][]): number {
  if (!speech.length) return 0;
  const at = (t: number) => speech.findIndex(([s, e]) => t >= s && t <= e);
  lines.sort((a, b) => a.start - b.start);
  const was = lines.map((l) => [l.start, l.end]);
  // Pass 1: starts (never into the previous line's speech).
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prevEnd = i ? was[i - 1][1] : -Infinity;
    const prevStart = i ? lines[i - 1].start : -Infinity;
    const inside = at(l.start);
    if (inside >= 0) {
      if (l.start - speech[inside][0] < 1.2 && speech[inside][0] >= prevEnd) l.start = speech[inside][0];
    } else {
      const after = speech.find(([s]) => s > l.start && s - l.start <= 1.5);
      const before = [...speech].reverse().find(([s, e]) => e < l.start && l.start - s <= 1.5 && s >= prevEnd);
      if (after) l.start = after[0];
      else if (before) l.start = before[0];
    }
    l.start = Math.max(l.start, prevStart + 0.3);
  }
  // Pass 2: ends (never past the next line's aligned start).
  let moved = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1];
    const limit = next ? Math.max(l.start + 0.3, next.start) : Infinity;
    const endIn = at(l.end);
    if (endIn >= 0) {
      const [, e] = speech[endIn];
      if (e - l.end < 0.6 && e <= limit) l.end = e;
    } else {
      // The voice stops at the last speech stretch inside the line (music/effects after it don't count).
      const back = [...speech].reverse().find(([, e]) => e <= l.end && e > l.start);
      if (back) l.end = back[1];
    }
    // Hold the text a moment after the voice stops, but stop before the next line.
    let end = Math.max(l.end + 0.25, l.start + 0.6);
    if (next) end = Math.min(end, Math.max(l.start + 0.3, next.start - 0.02));
    l.end = end;
    if (Math.abs(was[i][0] - l.start) > 0.05 || Math.abs(was[i][1] - l.end) > 0.3) moved++;
  }
  return moved;
}

/** Speech stretches of a 16 kHz clip (seconds), from the voice detector in the speech worker; null if it fails. */
export async function detectSpeech(pcm: Float32Array): Promise<[number, number][] | null> {
  const worker = new Worker(new URL("../browser/whisper.worker.ts", import.meta.url), { type: "module" });
  try {
    const copy = pcm.slice();
    const res = await new Promise<{ regions: { s: number; e: number }[] }>((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === "done") resolve(e.data);
        else if (e.data.type === "error") reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || "Speech worker crashed"));
      worker.postMessage({ task: "vad", pcm: copy, model: "" }, [copy.buffer]);
    });
    return res.regions.map((r) => [r.s, r.e]);
  } catch (e) {
    console.warn("Voice detection failed; using loudness for subtitle timing", e);
    return null;
  } finally {
    worker.terminate();
  }
}

/**
 * The model's timestamps are close but not exact (in testing 0.3–0.7 s early). Nudge each line's start to where the voice
 * actually starts and its end to where it stops (within ±0.8 s, never into the previous line), using loudness. Skipped
 * when the piece is loud throughout (music under the dialogue), because then loudness doesn't tell speech apart.
 */
export function snapToVoice(lines: { start: number; end: number; text: string }[], pcm: Float32Array) {
  const db = frameDb(pcm);
  if (db.length < 50) return;
  const threshold = voiceThreshold(db);
  if (threshold === null) return;
  const voiced = (f: number) => (db[f] ?? -100) > threshold && (db[f + 1] ?? -100) > threshold;
  const toFrame = (t: number) => Math.round((t * RATE) / FRAME);
  const W = 40; // look 0.8 s back
  const AHEAD = 75; // and up to 1.5 s ahead (the model sometimes starts a line a second early)
  let prevEnd = 0;
  for (const l of lines.sort((a, b) => a.start - b.start)) {
    const s0 = toFrame(l.start);
    for (let f = Math.max(toFrame(prevEnd) + 1, s0 - W); f <= s0 + AHEAD; f++) {
      if (voiced(f)) {
        l.start = (f * FRAME) / RATE;
        break;
      }
    }
    const e0 = toFrame(l.end);
    for (let f = Math.min(db.length - 2, e0 + W); f >= e0 - AHEAD && f > toFrame(l.start); f--) {
      if (voiced(f)) {
        l.end = ((f + 2) * FRAME) / RATE + 0.35;
        break;
      }
    }
    prevEnd = Math.max(prevEnd, l.end);
  }
}

/** Keep lines in order, non-overlapping and long enough to read. */
export function tidyLines<T extends { start: number; end: number; text: string }>(lines: T[], maxEnd: number): T[] {
  const out = lines
    .filter((l) => l.text.trim())
    .sort((a, b) => a.start - b.start)
    .map((l) => ({ ...l }));
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    const chars = [...l.text].length;
    const minLen = Math.min(4, Math.max(0.8, chars * 0.12));
    if (l.end < l.start + minLen) l.end = l.start + minLen;
    // Even with a bad timestamp, a subtitle shouldn't stay up much longer than it takes to say.
    l.end = Math.min(l.end, l.start + 2.5 + chars * 0.3);
    const next = out[i + 1];
    if (next && l.end > next.start) l.end = Math.max(l.start + 0.3, next.start - 0.02);
    l.end = Math.min(l.end, maxEnd);
  }
  return out.filter((l) => l.end > l.start);
}

type PieceReply = { model?: string; lines: { start: number; end: number; ja: string; en: string; ruby?: { w: string; r: string }[] }[] };
type SegmentReply = { model?: string; segments: { ja: string; en: string; ruby?: { w: string; r: string }[] }[][] };

async function postPiece<T = PieceReply>(body: string, onWait: (s: number) => void): Promise<T> {
  let dropped = 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch("/api/ai/anime-transcribe", { method: "POST", headers: aiHeaders({ "Content-Type": "application/json" }), body });
    } catch (e) {
      // Network drop (Wi-Fi blip, PC waking from sleep): wait and try again instead of abandoning the whole pass.
      if (++dropped > 5) throw new Error(`network unavailable (${(e as Error).message})`);
      const wait = Math.min(60, 5 * 2 ** (dropped - 1));
      onWait(wait);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.ok) return res.json();
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    // A used-up daily limit won't come back by retrying: fail now so the on-device model takes over.
    if (res.status === 429 && /daily limit/i.test(data.error ?? "")) throw new Error(data.error);
    // The server already retried Gemini (and its fallback model); retry overload once more here, rate limits up to 3x.
    const retryable = res.status === 429 ? attempt < 3 : (res.status === 503 || res.status === 502) && attempt < 1;
    if (!retryable) throw new Error(data.error || `Cloud speech recognition failed (${res.status})`);
    const wait = Math.min(60, Number(res.headers.get("Retry-After")) || 5 * 2 ** attempt);
    onWait(wait);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

/**
 * Speech snippets for segment mode: the detector's stretches, padded a little for clean word edges, with very long
 * stretches cut into ≤15 s parts. Times are relative to the range.
 */
export function speechSnippets(speech: [number, number][], duration: number): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  for (const [s, e] of speech) {
    const parts = Math.max(1, Math.ceil((e - s) / 15));
    for (let k = 0; k < parts; k++) out.push({ s: s + ((e - s) * k) / parts, e: s + ((e - s) * (k + 1)) / parts });
  }
  return out.filter((x) => x.e > x.s && x.s < duration);
}

/**
 * Segment mode: send the speech snippets (in batches of ≤ ~90 s / 40 snippets) and lay each snippet's returned lines over
 * its exact detected time, splitting a snippet's time between its lines by their length.
 */
async function transcribeBySegments(
  pcm: Float32Array,
  speech: [number, number][],
  offset: number,
  title: string | undefined,
  onWait: (detail: string) => void,
  onDone: (seconds: number) => void,
): Promise<CloudLine[]> {
  const duration = pcm.length / RATE;
  const snippets = speechSnippets(speech, duration);
  const batches: { s: number; e: number }[][] = [];
  let cur: { s: number; e: number }[] = [];
  let curSec = 0;
  for (const sn of snippets) {
    const len = sn.e - sn.s + 0.3;
    if (cur.length && (curSec + len > 90 || cur.length >= 40)) {
      batches.push(cur);
      cur = [];
      curSec = 0;
    }
    cur.push(sn);
    curSec += len;
  }
  if (cur.length) batches.push(cur);
  const out: CloudLine[] = [];
  const pad = 0.15;
  for (const batch of batches) {
    const audio = batch.map((sn) => wavBase64(pcm.subarray(Math.floor(Math.max(0, sn.s - pad) * RATE), Math.ceil(Math.min(duration, sn.e + pad) * RATE))));
    const body = JSON.stringify({ segments: audio, context: out.slice(-6).map((l) => l.text), title });
    const res = await postPiece<SegmentReply>(body, (s) => onWait(`Cloud AI is busy — retrying in ${Math.round(s)}s…`));
    console.info(`[cloud-speech] ${res.model ?? "?"} wrote ${res.segments.flat().length} lines for ${batch.length} speech snippets at ${(offset + batch[0].s).toFixed(1)}s`);
    batch.forEach((sn, i) => {
      const got = (res.segments[i] ?? []).filter((l) => l.ja?.trim());
      const weights = got.map((l) => Math.max(1, [...l.ja.replace(/[\s\u3000、。，．！？!?…「」『』]/g, "")].length));
      const total = weights.reduce((a, b) => a + b, 0);
      let acc = 0;
      got.forEach((l, k) => {
        const a = sn.s + ((sn.e - sn.s) * acc) / total;
        acc += weights[k];
        const b = sn.s + ((sn.e - sn.s) * acc) / total;
        out.push({ start: offset + a, end: offset + b, text: l.ja, en: l.en, ruby: l.ruby });
      });
    });
    onDone(batch.reduce((a, sn) => a + sn.e - sn.s, 0));
  }
  return out;
}

/**
 * Transcribe + translate the given source ranges with the server's Gemini model. Preferred path: the on-device voice
 * detector finds the speech (exact timing) and Gemini writes the text for each snippet. Fallback: audio in ~90 s pieces
 * with the model's own timestamps, repaired and aligned to the voice.
 */
export async function transcribeCloudJapanese(
  file: Blob,
  ranges: { start: number; end: number }[],
  onStatus: Status,
  title?: string,
  /** Word timings from the on-device scan (absolute seconds), used to re-anchor lines whose timestamps came back broken. */
  scanWords?: { text: string; start: number; end: number }[],
): Promise<CloudLine[]> {
  const { decodeRange } = await import("./generate");
  const total = ranges.reduce((a, r) => a + r.end - r.start, 0) || 1;
  const lines: CloudLine[] = [];
  let heard = 0; // seconds of audio answered so far
  // Audio decoding shares one media worker, so decode one range at a time (requests still overlap).
  let decoding: Promise<unknown> = Promise.resolve();
  const report = (detail?: string) =>
    onStatus(detail ?? `Cloud AI listening (${Math.round(heard)}s of ${Math.round(total)}s of clip audio done)…`, Math.min(0.99, heard / total));
  // Each clip range keeps its own chain of context lines; two ranges run at once because Gemini's response time
  // (often 30–60 s per request under load) dominates.
  const one = async (r: { start: number; end: number }) => {
    const decoded = decoding.then(() => decodeRange(file, r.start, r.end, () => {}));
    decoding = decoded.catch(() => {});
    const pcm = await decoded;
    // Preferred: the voice detector finds every spoken stretch (exact timing) and Gemini only writes the text.
    const speechAll = await detectSpeech(pcm);
    if (speechAll?.length) {
      try {
        const got = await transcribeBySegments(pcm, speechAll, r.start, title, (detail) => report(detail), (sec) => {
          heard += sec;
          report();
        });
        lines.push(...got);
        return;
      } catch (e) {
        console.warn("Segment transcription failed; falling back to timestamped transcription", e);
      }
    }
    const speechP = Promise.resolve(speechAll);
    const chain: CloudLine[] = [];
    for (const [a, b] of splitAtPauses(pcm)) {
      const piece = pcm.subarray(a, b);
      const body = JSON.stringify({ audio: wavBase64(piece), context: chain.slice(-6).map((l) => l.text), title });
      const res = await postPiece(body, (s) => report(`Cloud AI is busy — retrying in ${Math.round(s)}s…`));
      console.info(`[cloud-speech] ${res.model ?? "?"} heard ${res.lines.length} lines in ${((b - a) / RATE).toFixed(0)}s at ${(r.start + a / RATE).toFixed(1)}s`, res.lines);
      const local: CloudLine[] = res.lines.map((l) => ({ start: l.start, end: l.end, text: l.ja, en: l.en, ruby: l.ruby }));
      const pa = a / RATE;
      const pb = b / RATE;
      const speech = (await speechP)
        ?.filter(([s, e]) => e > pa && s < pb)
        .map(([s, e]): [number, number] => [Math.max(0, s - pa), Math.min(pb - pa, e - pa)]);
      // Re-timed lines are placed by proportion over the detected speech, then anchored to the on-device scan's words
      // where they match, then snapped to the voice: close, but still worth a check.
      if (retimeIfOff(local, piece, speech ?? undefined)) {
        local.forEach((l) => (l.retimed = true));
        const abs = r.start + pa;
        const scan = (scanWords ?? []).filter((w) => w.end > abs && w.start < abs + (pb - pa)).map((w) => ({ text: w.text, start: w.start - abs, end: w.end - abs }));
        const anchored = anchorToScan(local, scan);
        console.info(`[cloud-speech] broken timestamps re-timed; ${anchored}/${local.length} lines anchored to the scan`);
        local.sort((x, y) => x.start - y.start);
        if (speech) alignToSpeech(local, speech);
      }
      else if (speech) alignToSpeech(local, speech);
      else snapToVoice(local, piece);
      const off = r.start + a / RATE;
      chain.push(...local.map((l) => ({ ...l, start: l.start + off, end: l.end + off })));
      heard += (b - a) / RATE;
      report();
    }
    lines.push(...chain);
  };
  report("Cloud AI is listening…");
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, ranges.length) }, async () => {
      while (next < ranges.length) await one(ranges[next++]);
    }),
  );
  onStatus("Cloud AI finished", 1);
  return tidyLines(lines, Math.max(...ranges.map((r) => r.end)));
}
