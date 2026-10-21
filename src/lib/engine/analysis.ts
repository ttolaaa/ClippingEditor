import type { Moment, MomentType, PlotTwist, Transcript } from "../types";
import type { AudioSignal, VisualSignal } from "./signals";

export const BIN = 0.5;

/** Per-0.5s-bin feature timeline shared by moment detection and clip scoring. */
export interface Timeline {
  n: number;
  duration: number;
  loud: number[]; // 0..1 relative loudness
  silent: boolean[];
  transient: number[]; // 0..1 sudden loudness jumps
  dynamics: number[]; // 0..1 loudness variability (lively speech, laughter)
  motion: number[]; // 0..1
  cut: number[]; // 1 if hard cut in bin
  face: number[]; // 0..1 person presence
  words: number[]; // words per bin
  sentenceStart: boolean[];
  sentenceEnd: boolean[];
  lex: Record<LexKey, number[]>; // 0..1 lexical cue strength per bin
  ai: number[]; // 0..1 AI-detected moment strength
  twist: number[]; // 0..1 plot-twist strength
}

type LexKey = "funny" | "emotional" | "excite" | "twist" | "hook";

const LEXICON: Record<LexKey, RegExp[]> = {
  twist: [
    /\bplot twist\b/,
    /\bturns? out\b/,
    /\bbut then\b/,
    /\bsuddenly\b/,
    /\bout of nowhere\b/,
    /\b(it|he|she|they) (was|were) actually\b/,
    /\bactually\b/,
    /\bthe truth\b/,
    /\b(never|didn'?t|did not) (expect|see it coming|see that coming)\b/,
    /\bwait\b/,
    /\bgets? (even )?(crazier|worse|better|weirder)\b/,
    /\bsecret(ly)?\b/,
    /\bhiding\b/,
    /\breveal(ed|s)?\b/,
    /\brealized\b/,
    /\bthat'?s when\b/,
    /\bnobody knew\b/,
    /\bsurpris(e|ed|ing)\b/,
    /\bshock(ed|ing)?\b/,
    /\bnever told\b/,
    /\bbut here'?s the thing\b/,
    /\bplanned the whole thing\b/,
  ],
  funny: [/\bha(ha)+\b/, /\bha ha\b/, /\blol\b/, /\blmao\b/, /\bfunny\b/, /\bhilarious\b/, /\bjok(e|ing)\b/, /\blaugh(ing|ed)?\b/, /\bridiculous\b/, /\bjust kidding\b/, /\bwhat the\b/],
  emotional: [
    /\blove\b/,
    /\bcr(y|ied|ying)\b/,
    /\btears?\b/,
    /\bheart\b/,
    /\bmiss(ed)?\b/,
    /\bscared\b/,
    /\bafraid\b/,
    /\bnervous\b/,
    /\bproud\b/,
    /\bsorry\b/,
    /\bdied\b/,
    /\bhate\b/,
    /\bangry\b/,
    /\bsad\b/,
    /\bbeautiful\b/,
    /\bfamily\b/,
    /\b(mom|dad|mother|father|brother|sister|parents)\b/,
    /\blife\b/,
  ],
  excite: [
    /\binsane\b/,
    /\bcrazy\b/,
    /\bcrazier\b/,
    /\bunbelievable\b/,
    /\bcan(not|'?t) believe\b/,
    /\boh my (god|gosh)\b/,
    /\bomg\b/,
    /\bno way\b/,
    /\bincredible\b/,
    /\bwow\b/,
    /\b(best|worst) .* ever\b/,
    /\bscream(ed|ing)?\b/,
    /\bliterally\b/,
    /\bamazing\b/,
    /\bholy\b/,
    /\bstrangest\b/,
    /\bwild\b/,
  ],
  hook: [
    /\?$/,
    /^(how|why|what|who|when|imagine|here'?s|this is|you won'?t|did you know|let me tell|the (secret|reason|truth))\b/,
    /\bstory\b/,
    /\bsecret\b/,
    /\byou need to\b/,
    /\bnobody\b/,
    /\bnever\b/,
    /\bstop\b/,
  ],
};

function lexScore(text: string, key: LexKey): number {
  const t = text.toLowerCase().trim();
  let hits = 0;
  for (const re of LEXICON[key]) if (re.test(t)) hits++;
  if (key === "excite") hits += Math.min(2, (text.match(/!/g) ?? []).length);
  return Math.min(1, hits * 0.45);
}

function robustNorm(values: number[], mask?: boolean[]): number[] {
  const pool = values.filter((_, i) => !mask || !mask[i]).filter((v) => isFinite(v));
  if (!pool.length) return values.map(() => 0);
  const sorted = [...pool].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  const span = Math.max(1e-6, hi - lo);
  return values.map((v) => Math.max(0, Math.min(1, (v - lo) / span)));
}

export function buildTimeline(
  duration: number,
  audio: AudioSignal | null,
  visual: VisualSignal | null,
  transcript: Transcript,
): Timeline {
  const n = Math.max(1, Math.ceil(duration / BIN));
  const z = () => new Array<number>(n).fill(0);
  const pad = (arr: number[] | undefined, fill = 0) => {
    const out = z();
    if (arr) for (let i = 0; i < n; i++) out[i] = arr[i] ?? arr[arr.length - 1] ?? fill;
    return out;
  };

  const rms = pad(audio?.rmsDb, -100);
  const sortedRms = [...rms].sort((a, b) => a - b);
  const medianDb = sortedRms[Math.floor(n / 2)] ?? -60;
  const silentThresh = Math.max(-55, Math.min(medianDb - 14, -30));
  const silent = rms.map((v) => v < silentThresh);
  const loud = robustNorm(rms, silent).map((v, i) => (silent[i] ? 0 : v));

  const peaks = pad(audio?.peakDb, -100);
  // Jump of the loudest sub-window over the recent *non-silent* baseline (speech onsets after pauses don't count).
  const jumps = peaks.map((p, i) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - 12); k < i; k++) {
      if (silent[k]) continue;
      s += rms[k];
      c++;
    }
    return c >= 4 ? p - s / c : 0;
  });
  const transient = jumps.map((j) => Math.max(0, Math.min(1, (j - 8) / 12)));
  const dynamics = robustNorm(pad(audio?.variability), silent);

  const motion = robustNorm(pad(visual?.motion));
  const cut = z();
  for (const t of visual?.cuts ?? []) {
    const i = Math.floor(t / BIN);
    if (i < n) cut[i] = 1;
  }
  const face = pad(visual?.skinFrac).map((v) => Math.min(1, v / 0.04));

  const words = z();
  for (const w of transcript.words) {
    const i = Math.floor(((w.start + w.end) / 2) / BIN);
    if (i >= 0 && i < n) words[i]++;
  }
  const sentenceStart = new Array<boolean>(n).fill(false);
  const sentenceEnd = new Array<boolean>(n).fill(false);
  const lex = { funny: z(), emotional: z(), excite: z(), twist: z(), hook: z() } as Record<LexKey, number[]>;
  for (const seg of transcript.segments) {
    const a = Math.max(0, Math.floor(seg.start / BIN));
    const b = Math.min(n - 1, Math.floor(seg.end / BIN));
    sentenceStart[a] = true;
    sentenceEnd[b] = true;
    for (const key of Object.keys(lex) as LexKey[]) {
      const s = lexScore(seg.text, key);
      if (!s) continue;
      for (let i = a; i <= b; i++) lex[key][i] = Math.max(lex[key][i], s);
    }
  }

  return { n, duration, loud, silent, transient, dynamics, motion, cut, face, words, sentenceStart, sentenceEnd, lex, ai: z(), twist: z() };
}

function smooth(arr: number[], radius: number): number[] {
  return arr.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(arr.length - 1, i + radius); k++) {
      s += arr[k];
      c++;
    }
    return s / c;
  });
}

/** Combined interest curve, also used for the timeline heatmap in the UI. */
export function interestCurve(tl: Timeline): number[] {
  return tl.loud.map((l, i) => {
    const lexical = Math.max(tl.lex.funny[i], tl.lex.emotional[i] * 0.8, tl.lex.excite[i], tl.lex.twist[i]);
    return 0.3 * l + 0.15 * tl.transient[i] + 0.15 * tl.motion[i] + 0.1 * tl.dynamics[i] + 0.3 * lexical;
  });
}

export function heuristicMoments(tl: Timeline): Moment[] {
  const curve = smooth(interestCurve(tl), 4);
  const sorted = [...curve].sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  const moments: Moment[] = [];
  for (let i = 1; i < curve.length - 1; i++) {
    if (curve[i] < p75 || curve[i] < curve[i - 1] || curve[i] < curve[i + 1]) continue;
    if (moments.length && i * BIN - moments[moments.length - 1].start < 8) continue;
    const scores: Record<MomentType, number> = {
      funny: tl.lex.funny[i],
      emotional: tl.lex.emotional[i] * 0.8,
      unexpected: Math.max(tl.transient[i], tl.lex.twist[i] * 0.7),
      plot_twist: tl.lex.twist[i] >= 0.45 ? tl.lex.twist[i] : 0,
      insightful: 0,
      high_energy: (tl.loud[i] + tl.motion[i]) / 2,
    };
    const type = (Object.keys(scores) as MomentType[]).reduce((a, b) => (scores[b] > scores[a] ? b : a));
    const reasons: Record<MomentType, string> = {
      funny: "Laughter / humor cues in speech",
      emotional: "Emotionally charged language",
      unexpected: "Sudden change in audio intensity",
      plot_twist: "Narrative reveal / twist language",
      insightful: "Key insight",
      high_energy: "High vocal energy and on-screen motion",
    };
    moments.push({
      start: Math.max(0, i * BIN - 4),
      end: Math.min(tl.duration, i * BIN + 4),
      type,
      score: Math.min(1, curve[i] * 1.2),
      reason: reasons[type],
      source: tl.lex[type === "high_energy" ? "excite" : "twist"][i] > 0 ? "transcript" : "audio",
    });
  }
  return moments.sort((a, b) => b.score - a.score).slice(0, 30);
}

export function detectPlotTwists(tl: Timeline, transcript: Transcript): PlotTwist[] {
  const twists: PlotTwist[] = [];
  // Transcript cues: reveal language, boosted when followed by a vocal reaction spike.
  for (const seg of transcript.segments) {
    const s = lexScore(seg.text, "twist");
    if (s < 0.45) continue;
    const a = Math.floor(seg.start / BIN);
    let reaction = 0;
    for (let i = a; i < Math.min(tl.n, a + 10); i++) reaction = Math.max(reaction, tl.transient[i], tl.loud[i] > 0.85 ? 0.6 : 0);
    const excl = /!/.test(seg.text) ? 0.1 : 0;
    twists.push({
      time: seg.start,
      confidence: Math.min(0.97, 0.35 + s * 0.4 + reaction * 0.25 + excl),
      reason: `“${truncate(seg.text, 90)}”`,
      source: "transcript",
    });
  }
  // Signal cues: calm build-up followed by a sudden spike (gasps, screams, music hits, hard cuts).
  for (let i = 12; i < tl.n; i++) {
    let calm = 0;
    let voiced = 0;
    for (let k = i - 12; k < i; k++) {
      if (tl.silent[k]) continue;
      calm += tl.loud[k];
      voiced++;
    }
    if (voiced < 6) continue;
    calm /= voiced;
    const spike = Math.max(tl.transient[i], tl.cut[i] && tl.motion[i] > 0.7 ? 0.6 : 0);
    if (calm < 0.5 && spike > 0.75 && tl.loud[i] > 0.8) {
      twists.push({
        time: i * BIN,
        confidence: Math.min(0.8, 0.3 + spike * 0.35 + (0.45 - calm)),
        reason: "Calm build-up followed by a sudden intensity spike",
        source: "signal",
      });
    }
  }
  return mergeTwists(twists);
}

export function mergeTwists(list: PlotTwist[]): PlotTwist[] {
  const sorted = [...list].sort((a, b) => b.confidence - a.confidence);
  const kept: PlotTwist[] = [];
  for (const t of sorted) {
    if (kept.some((k) => Math.abs(k.time - t.time) < 4)) continue;
    kept.push(t);
  }
  return kept.slice(0, 15).sort((a, b) => a.time - b.time);
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function applyMomentsToTimeline(tl: Timeline, moments: Moment[], twists: PlotTwist[]) {
  for (const m of moments) {
    if (m.source !== "ai") continue;
    for (let i = Math.floor(m.start / BIN); i <= Math.min(tl.n - 1, Math.floor(m.end / BIN)); i++) tl.ai[i] = Math.max(tl.ai[i], m.score);
  }
  for (const t of twists) {
    const i = Math.floor(t.time / BIN);
    for (let k = Math.max(0, i - 1); k <= Math.min(tl.n - 1, i + 2); k++) tl.twist[k] = Math.max(tl.twist[k], t.confidence);
  }
}
