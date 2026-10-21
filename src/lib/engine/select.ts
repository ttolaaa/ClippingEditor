import type { ClipRules, FocusType, Moment, PlotTwist, ScoreBreakdown, Transcript } from "../types";
import { BIN, type Timeline } from "./analysis";
import { FOCUS_LABEL, keywordRegex } from "./rules";

export interface Candidate {
  start: number;
  end: number;
  target: number;
  raw: number;
  /** Ranking score: viral potential plus how well the clip fits the creator's rules. */
  rank: number;
  viralScore: number;
  scores: ScoreBreakdown;
  tags: string[];
  twistAt?: number;
  hasPlotTwist: boolean;
  reason: string;
  ruleMatches: string[];
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Bell-shaped preference: 1 inside [lo, hi], decaying outside. */
const band = (v: number, lo: number, hi: number, soft: number) =>
  v < lo ? Math.max(0, 1 - (lo - v) / soft) : v > hi ? Math.max(0, 1 - (v - hi) / soft) : 1;

function scoreWindow(tl: Timeline, s: number, e: number, twists: PlotTwist[], moments: Moment[], hasTranscript: boolean) {
  const a = Math.max(0, Math.floor(s / BIN));
  const b = Math.min(tl.n, Math.ceil(e / BIN));
  const range = <T,>(arr: T[], from = a, to = b): T[] => arr.slice(from, to);
  const dur = e - s;
  const hookEnd = Math.min(b, a + Math.round(3 / BIN));

  const lexAll = (i: number) => Math.max(tl.lex.funny[i], tl.lex.emotional[i], tl.lex.excite[i], tl.lex.twist[i]);
  const lexWindow = range(tl.loud).map((_, k) => lexAll(a + k));

  // Hook: is the first 3 seconds loud, lively, and attention-grabbing?
  const hookAudio = mean(range(tl.loud, a, hookEnd));
  const hookMotion = mean(range(tl.motion, a, hookEnd));
  const hookLex = Math.max(...range(tl.lex.hook, a, hookEnd), ...range(tl.lex.excite, a, hookEnd), 0);
  const startsSilent = tl.silent[a] && tl.silent[Math.min(tl.n - 1, a + 1)];
  const cleanStart = hasTranscript ? (tl.sentenceStart[a] || tl.sentenceStart[Math.max(0, a - 1)] ? 1 : 0.3) : 1;
  const hook = clamp01(0.35 * hookAudio + 0.15 * hookMotion + 0.35 * hookLex + 0.25 * cleanStart - (startsSilent ? 0.25 : 0));

  // Emotion: humor / feelings / excitement plus AI-detected moments.
  const aiCover = mean(range(tl.ai));
  const aiPeak = Math.max(0, ...range(tl.ai));
  const emotion = clamp01(0.45 * pct(lexWindow, 0.9) + 0.25 * mean(lexWindow) * 2 + 0.3 * Math.max(aiPeak * 0.8, aiCover));

  // Energy: vocal intensity and dynamics.
  const loudW = range(tl.loud);
  const energy = clamp01(0.5 * mean(loudW) + 0.3 * pct(loudW, 0.9) + 0.2 * mean(range(tl.dynamics)));

  // Pacing: speech rate, cuts and motion.
  const wps = range(tl.words).reduce((x, y) => x + y, 0) / Math.max(1, dur);
  const cutsPer10 = (range(tl.cut).reduce((x, y) => x + y, 0) / Math.max(1, dur)) * 10;
  const speechPace = hasTranscript ? band(wps, 2, 3.8, 2) : 0.5;
  const cutPace = band(cutsPer10, 0.5, 4, 3);
  const pacing = clamp01(0.45 * speechPace + 0.25 * cutPace + 0.3 * mean(range(tl.motion)) * 1.5);

  // Retention: little dead air, ends on a complete thought.
  const silentRatio = range(tl.silent).filter(Boolean).length / Math.max(1, b - a);
  const endBin = Math.max(a, b - 1);
  const cleanEnd = hasTranscript
    ? tl.sentenceEnd[endBin] || tl.sentenceEnd[Math.max(0, endBin - 1)] || tl.sentenceEnd[Math.min(tl.n - 1, endBin + 1)]
      ? 1
      : 0.35
    : 0.8;
  const retention = clamp01(1 - silentRatio * 1.6) * 0.7 + 0.3 * cleanEnd;

  // Twist: a reveal that lands after the setup and leaves room for the reaction.
  let twist = 0;
  let twistAt: number | undefined;
  for (const t of twists) {
    if (t.time < s || t.time > e - 1) continue;
    const pos = (t.time - s) / dur;
    const placement = pos < 0.15 ? 0.45 : pos > 0.92 ? 0.6 : 1;
    const v = t.confidence * placement;
    if (v > twist) {
      twist = v;
      twistAt = t.time - s;
    }
  }

  const weights = { hook: 0.22, emotion: 0.2, energy: 0.14, pacing: 0.14, retention: 0.15, twist: 0.15 };
  const raw =
    weights.hook * hook +
    weights.emotion * emotion +
    weights.energy * energy +
    weights.pacing * pacing +
    weights.retention * retention +
    weights.twist * twist;

  const tags: string[] = [];
  if (twist >= 0.45) tags.push("plot twist");
  const fun = Math.max(...range(tl.lex.funny), 0);
  if (fun >= 0.4 || moments.some((m) => m.type === "funny" && overlaps(m, s, e))) tags.push("funny");
  if (Math.max(...range(tl.lex.emotional), 0) >= 0.4 || moments.some((m) => m.type === "emotional" && overlaps(m, s, e))) tags.push("emotional");
  if (Math.max(...range(tl.transient), 0) > 0.6 || moments.some((m) => m.type === "unexpected" && overlaps(m, s, e))) tags.push("unexpected");
  if (energy > 0.62) tags.push("high energy");
  if (hook > 0.6) tags.push("strong hook");
  if (aiPeak > 0.7) tags.push("ai pick");

  const scores: ScoreBreakdown = {
    hook: Math.round(hook * 100),
    emotion: Math.round(emotion * 100),
    energy: Math.round(energy * 100),
    pacing: Math.round(pacing * 100),
    retention: Math.round(retention * 100),
    twist: Math.round(twist * 100),
  };
  const best = (Object.keys(scores) as (keyof ScoreBreakdown)[]).sort((x, y) => scores[y] - scores[x]).slice(0, 2);
  const label: Record<keyof ScoreBreakdown, string> = {
    hook: "a strong opening hook",
    emotion: "emotional / funny beats",
    energy: "high vocal energy",
    pacing: "fast pacing",
    retention: "no dead air",
    twist: "a plot twist payoff",
  };
  const reason = `Stands out for ${best.map((k) => label[k]).join(" and ")}.`;
  return { raw, scores, tags, twist, twistAt, reason };
}

function overlaps(m: { start: number; end: number }, s: number, e: number) {
  return Math.min(m.end, e) - Math.max(m.start, s) > 1;
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / Math.max(0.01, Math.min(a.end - a.start, b.end - b.start));
}

function iou(a: { start: number; end: number }, b: { start: number; end: number }) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / Math.max(0.01, Math.max(a.end, b.end) - Math.min(a.start, b.start));
}

export function selectClips(
  tl: Timeline,
  transcript: Transcript,
  twists: PlotTwist[],
  moments: Moment[],
  durations: number[],
  maxPerDuration: number,
  rules?: ClipRules,
): { clips: Candidate[]; notes: string[] } {
  const notes: string[] = [];
  const hasTranscript = transcript.words.length > 10;
  if (!rules) return { clips: pickClips(tl, transcript, twists, moments, durations, maxPerDuration, null), notes };
  if (!hasTranscript && (rules.includeKeywords.length || rules.excludeKeywords.length))
    notes.push("Keyword rules were skipped because no speech transcript is available.");
  const winStart = Math.max(0, rules.startAt || 0);
  const winEnd = Math.min(rules.endAt ?? tl.duration, tl.duration - (rules.skipEnd || 0));
  const tooLong = durations.filter((d) => d * 0.75 > winEnd - winStart);
  if (tooLong.length && tooLong.length < durations.length)
    notes.push(`Your time range is only ${Math.max(0, Math.round(winEnd - winStart))}s long, so no ${tooLong.map((d) => `${d}s`).join("/")} reels could be made from it.`);
  const attempts: [ClipRules, string | null][] = [
    [rules, null],
    [{ ...rules, minScore: 0, requireTwist: false, keywordMode: "prefer" }, "No clip matched every rule, so the minimum score / required twist / required keywords were relaxed."],
    [{ ...rules, minScore: 0, requireTwist: false, keywordMode: "prefer", excludeKeywords: [] }, "No clip matched your rules, so excluded keywords were also relaxed."],
    [{ ...rules, minScore: 0, requireTwist: false, keywordMode: "prefer", excludeKeywords: [], startAt: 0, endAt: null, skipEnd: 0 }, "Your time range was too short for the chosen clip lengths, so the whole video was used."],
  ];
  for (const [r, note] of attempts) {
    const clips = pickClips(tl, transcript, twists, moments, durations, maxPerDuration, r, true);
    if (clips.length) {
      if (note) notes.push(note);
      return { clips, notes };
    }
  }
  notes.push("No clip could satisfy your rules — showing the best clips without them.");
  return { clips: pickClips(tl, transcript, twists, moments, durations, maxPerDuration, null), notes };
}

const toViral = (raw: number) => Math.round(Math.max(5, Math.min(99, 100 / (1 + Math.exp(-(raw - 0.5) * 8)))));

/** Fast word lookup for a time window (words are sorted by start time). */
function wordsBetween(words: Transcript["words"], s: number, e: number): string {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start < s - 0.05) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < words.length && words[i].start <= e; i++) if (words[i].end <= e + 0.3) out.push(words[i].text);
  return out.join(" ");
}

function pickClips(
  tl: Timeline,
  transcript: Transcript,
  twists: PlotTwist[],
  moments: Moment[],
  durations: number[],
  maxPerDuration: number,
  rules: ClipRules | null,
  strict = false,
): Candidate[] {
  const hasTranscript = transcript.words.length > 10;
  const total = tl.duration;
  const segs = transcript.segments;
  const winStart = rules ? Math.max(0, Math.min(total, rules.startAt || 0)) : 0;
  const winEnd = rules ? Math.max(winStart, Math.min(rules.endAt ?? total, total - (rules.skipEnd || 0))) : total;
  const includeRe = rules && hasTranscript ? rules.includeKeywords.map((k) => [k, keywordRegex(k)] as const) : [];
  const excludeRe = rules && hasTranscript ? rules.excludeKeywords.map((k) => keywordRegex(k)) : [];

  // Candidate start points: sentence starts (clean entry) or a grid + scene cuts.
  let starts: number[] = [];
  if (hasTranscript) {
    starts = segs.map((sg) => Math.max(0, sg.start - 0.15));
  } else {
    const step = total > 1200 ? 3 : 1;
    for (let t = 0; t < total; t += step) starts.push(t);
    for (let i = 0; i < tl.n; i++) if (tl.cut[i]) starts.push(i * BIN);
  }
  starts = [...new Set(starts.map((s) => Math.round(s * 10) / 10))].sort((a, b) => a - b).filter((s) => s >= winStart - 0.2);
  const ends = hasTranscript ? segs.map((sg) => Math.min(total, sg.end + 0.25)) : [];

  const all: Candidate[] = [];
  const sortedDurations = [...durations].sort((a, b) => a - b);
  for (const D of sortedDurations) {
    const minLen = D * 0.75;
    const maxLen = D === 60 ? 60 : D * 1.12;
    if (winEnd - winStart < minLen) continue;
    const cands: Candidate[] = [];
    for (const s of starts) {
      if (s + minLen > winEnd) break;
      let e = Math.min(winEnd, s + D);
      if (hasTranscript) {
        // Snap to the sentence end closest to the target length.
        let bestEnd = -1;
        let bestDiff = Infinity;
        for (const en of ends) {
          if (en < s + minLen) continue;
          if (en > s + maxLen || en > winEnd + 0.3) break;
          const diff = Math.abs(en - s - D);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestEnd = en;
          }
        }
        if (bestEnd > 0) e = Math.min(bestEnd, total);
      }
      if (e - s < minLen) continue;
      const sc = scoreWindow(tl, s, e, twists, moments, hasTranscript);
      const hasPlotTwist = sc.twist >= 0.45;
      const viralScore = toViral(sc.raw);
      let rank = sc.raw;
      const ruleMatches: string[] = [];
      if (rules) {
        if (rules.requireTwist && !hasPlotTwist) continue;
        if (rules.minScore && viralScore < rules.minScore) continue;
        if (includeRe.length || excludeRe.length) {
          const text = wordsBetween(transcript.words, s, e);
          if (excludeRe.some((re) => re.test(text))) continue;
          const hits = includeRe.filter(([, re]) => re.test(text)).map(([k]) => k);
          if (rules.keywordMode === "require" && includeRe.length && !hits.length) continue;
          if (hits.length) {
            rank += Math.min(0.24, 0.12 * hits.length);
            ruleMatches.push(`Mentions “${hits.join("”, “")}”`);
          }
        }
        if (rules.focus.length) {
          const a = Math.max(0, Math.floor(s / BIN));
          const b = Math.min(tl.n, Math.ceil(e / BIN));
          const peak = (arr: number[]) => Math.max(0, ...arr.slice(a, b));
          const values: Record<FocusType, number> = {
            funny: Math.max(peak(tl.lex.funny), sc.tags.includes("funny") ? 0.6 : 0),
            emotional: Math.max(sc.scores.emotion / 100, peak(tl.lex.emotional)),
            plot_twist: sc.scores.twist / 100,
            high_energy: sc.scores.energy / 100,
            insightful: peak(tl.lex.insight),
            hook: sc.scores.hook / 100,
          };
          const v = rules.focus.map((f) => values[f]);
          rank += 0.3 * (v.reduce((x, y) => x + y, 0) / v.length);
          for (const f of rules.focus) if (values[f] >= 0.45) ruleMatches.push(FOCUS_LABEL[f]);
        }
        if (rules.requireTwist) ruleMatches.push("Plot twist");
        if (rules.minScore) ruleMatches.push(`Score ≥ ${rules.minScore}`);
      }
      cands.push({
        start: s,
        end: e,
        target: D,
        raw: sc.raw,
        rank,
        viralScore,
        scores: sc.scores,
        tags: sc.tags,
        twistAt: sc.twistAt,
        hasPlotTwist,
        reason: sc.reason,
        ruleMatches: [...new Set(ruleMatches)],
      });
    }
    cands.sort((a, b) => b.rank - a.rank);
    const picked: Candidate[] = [];
    for (const c of cands) {
      if (picked.length >= maxPerDuration) break;
      if (picked.some((p) => overlapRatio(p, c) > 0.3)) continue;
      // Across durations, only skip near-identical windows (a 60s reel may contain a 15s highlight).
      if (all.some((p) => iou(p, c) > 0.8)) continue;
      picked.push(c);
    }
    all.push(...picked);
  }

  // Very short source: offer the whole video as a single reel.
  if (!all.length && total > 2 && !strict) {
    const sc = scoreWindow(tl, 0, total, twists, moments, hasTranscript);
    all.push({
      start: 0,
      end: total,
      target: total <= 15 ? 15 : total <= 30 ? 30 : 60,
      raw: sc.raw,
      rank: sc.raw,
      viralScore: toViral(sc.raw),
      scores: sc.scores,
      tags: sc.tags,
      twistAt: sc.twistAt,
      hasPlotTwist: sc.twist >= 0.45,
      reason: sc.reason,
      ruleMatches: [],
    });
  }

  for (const c of all) if (c.twistAt !== undefined) c.twistAt = Math.round(c.twistAt * 100) / 100;
  // Best match first: with rules this blends viral potential and how well the clip fits the rules.
  return all.sort((a, b) => b.rank - a.rank);
}

// ---------------------------------------------------------------- metadata

export interface ClipMeta {
  title: string;
  hook: string;
  hashtags: string[];
  reason?: string;
}

const STOP = new Set(
  "the a an and or but so to of in on at for with is was were be been are i you he she it we they me my your our their this that these those just like really very then there here what when where who how why not no yes do did does have had has get got go going gonna can could would should will about from up out into over all some any one two im its dont thats ive youre".split(
    " ",
  ),
);

function keywords(text: string, n: number): string[] {
  const freq = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    const w = raw.replace(/'/g, "");
    if (w.length < 4 || STOP.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1 + w.length / 20);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export function clipText(transcript: Transcript, s: number, e: number) {
  return transcript.words
    .filter((w) => w.start >= s - 0.05 && w.end <= e + 0.3)
    .map((w) => w.text)
    .join(" ");
}

export function heuristicMeta(c: Candidate, transcript: Transcript, index: number, usedTitles: Set<string> = new Set()): ClipMeta {
  const text = clipText(transcript, c.start, c.end);
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 3);
  const tagHash: Record<string, string> = {
    "plot twist": "#plottwist",
    funny: "#funny",
    emotional: "#storytime",
    unexpected: "#unexpected",
    "high energy": "#hype",
  };
  const hashtags = ["#fyp", "#viral", ...c.tags.map((t) => tagHash[t]).filter(Boolean), ...keywords(text, 2).map((k) => `#${k}`), "#shorts", "#reels"];
  const uniq = [...new Set(hashtags)].slice(0, 8);
  let title: string;
  if (sentences.length) {
    const scored = sentences
      .map((s) => ({ s, v: (/[!?]/.test(s) ? 2 : 0) + (/\b(never|secret|truth|crazy|insane|believe|actually|turns out)\b/i.test(s) ? 2 : 0) - Math.abs(s.length - 50) / 40 }))
      .sort((a, b) => b.v - a.v);
    const pick = scored.find((x) => !usedTitles.has(x.s.replace(/[.,]+$/, ""))) ?? scored[0];
    title = pick.s.replace(/[.,]+$/, "");
    if (title.length > 70) title = title.slice(0, 67).trimEnd() + "…";
    if (usedTitles.has(title)) title = `${title} (part ${index + 1})`;
  } else {
    title = c.hasPlotTwist ? `Wait for the twist… (#${index + 1})` : `Highlight #${index + 1}`;
  }
  usedTitles.add(title);
  const hook = c.hasPlotTwist
    ? "You won't see this coming… 👀"
    : c.tags.includes("funny")
      ? "I can't stop laughing at this 😂"
      : sentences[0]
        ? sentences[0].slice(0, 80)
        : "Watch till the end 🔥";
  return { title, hook, hashtags: uniq };
}
