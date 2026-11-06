"use client";

import type { Clip, Job, JobSettings, Moment, PlotTwist, Stage, StageId, Transcript, Word } from "../types";
import type { AnimeSubtitle } from "../anime/types";
import { groupWordsIntoLines, presetStyle } from "../captions";
import type { AudioSignal, VisualSignal } from "../engine/signals";
import { applyMomentsToTimeline, buildTimeline, detectPlotTwists, heuristicMoments, interestCurve, mergeTwists } from "../engine/analysis";
import { clipText, heuristicMeta, selectClips, type Candidate } from "../engine/select";
import { describeRules, effectiveRules, hasRules } from "../engine/rules";
import { computeCropPath } from "../engine/reframe";
import { LANGUAGES, buildSegments, normalizeWords, spreadWords } from "../engine/transcript";
import { activeJobs, getBlob, getData, getJob, loadJobs, putBlob, putData, putJob, updateClip, updateJob } from "./store";
import { canPlayInVideoElement, runMediaTask } from "./workers";
import type { ProbeInfo } from "./media.worker";
import { requestPersistence } from "./db";
import { slugify } from "../client";
import type { Cue } from "../anime/subfile";

/** A transcript built from subtitle cues: each cue is one segment (and one "word" spanning it). */
function transcriptFromCues(cues: Cue[]): Transcript {
  const words = cues.map((c) => ({ text: c.text, start: c.start, end: c.end }));
  return { provider: "file", language: "japanese", words, segments: cues.map((c) => ({ text: c.text, start: c.start, end: c.end })) };
}

const STAGE_DEFS: { id: StageId; label: string; weight: number }[] = [
  { id: "probe", label: "Reading video", weight: 0.02 },
  { id: "convert", label: "Converting format", weight: 0.1 },
  { id: "audio", label: "Decoding audio", weight: 0.06 },
  { id: "transcribe", label: "Transcribing speech", weight: 0.42 },
  { id: "visual", label: "Scene & speaker tracking", weight: 0.22 },
  { id: "analyze", label: "Detecting viral moments & plot twists", weight: 0.05 },
  { id: "select", label: "Ranking clips", weight: 0.03 },
  { id: "subtitle", label: "Translating & adding furigana", weight: 0.12 },
  { id: "render", label: "Preparing 9:16 previews", weight: 0.1 },
];

export const WHISPER_MODELS = {
  tiny: "onnx-community/whisper-tiny_timestamped",
  base: "onnx-community/whisper-base_timestamped",
  small: "onnx-community/whisper-small_timestamped",
} as const;

export interface ServerCaps {
  /** Cloud AI usable by this browser (configured on the server and, if required, unlocked with the access code). */
  cloudAI: boolean;
  aiModel: string | null;
  cloudTranscription: boolean;
  /** The server has an OpenAI key at all. */
  cloudAvailable: boolean;
  accessRequired: boolean;
  budgetExhausted?: boolean;
}

const ACCESS_KEY = "clipping.aiAccessCode";
const noCaps: ServerCaps = { cloudAI: false, aiModel: null, cloudTranscription: false, cloudAvailable: false, accessRequired: false };

export function getAccessCode(): string {
  try {
    return localStorage.getItem(ACCESS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Headers for /api/ai/* calls (includes the cloud AI access code if the user entered one). */
export function aiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const code = getAccessCode();
  return code ? { ...extra, "x-ai-access-code": code } : extra;
}

let capsPromise: Promise<ServerCaps> | null = null;
export function serverCaps(): Promise<ServerCaps> {
  capsPromise ??= fetch("/api/config", { headers: aiHeaders(), cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => ({ ...noCaps, ...(c ?? {}) }))
    .catch(() => noCaps);
  return capsPromise;
}

/** Save (or clear) the cloud AI access code and re-check what it unlocks. */
export async function setAccessCode(code: string): Promise<ServerCaps> {
  try {
    if (code) localStorage.setItem(ACCESS_KEY, code);
    else localStorage.removeItem(ACCESS_KEY);
  } catch {
    // storage unavailable
  }
  capsPromise = null;
  return serverCaps();
}

/** Turn a refused /api/ai/* response into a short, user-facing reason. */
async function cloudRefusal(res: Response): Promise<string | null> {
  if (![401, 403, 429, 503].includes(res.status)) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `Cloud AI unavailable (${res.status})`;
}

function initialStages(settings: JobSettings): Stage[] {
  // The subtitle stage (translation + furigana) only exists for Anime Clipper projects.
  return STAGE_DEFS.filter((s) => s.id !== "subtitle" || settings.kind === "anime").map((s) => ({ id: s.id, label: s.label, status: "pending", progress: 0 }));
}

// ---------------------------------------------------------------- project creation & queue

export async function createProject(file: File, settings: JobSettings, subtitleCues?: { ja?: Cue[]; en?: Cue[] }): Promise<string> {
  await loadJobs();
  requestPersistence();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (subtitleCues?.ja?.length || subtitleCues?.en?.length) {
    settings = { ...settings, subtitleFiles: { ja: subtitleCues.ja?.length || undefined, en: subtitleCues.en?.length || undefined } };
    if (subtitleCues.ja?.length) await putData(id, "subs-ja", subtitleCues.ja);
    if (subtitleCues.en?.length) await putData(id, "subs-en", subtitleCues.en);
  }
  const job: Job = {
    id,
    name: file.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    progress: 0,
    warnings: [],
    stages: initialStages(settings),
    settings,
    source: {
      originalName: file.name,
      mimeType: file.type || "video/mp4",
      converted: false,
      size: file.size,
      duration: 0,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: false,
    },
    clips: [],
  };
  await putBlob(id, "source", file);
  activeJobs.add(id);
  putJob(job);
  enqueue(id);
  return id;
}

export function retryProject(id: string) {
  updateJob(
    id,
    (j) => {
      j.status = "queued";
      j.error = undefined;
      j.warnings = [];
      j.progress = 0;
      j.etaSeconds = undefined;
      j.startedAt = undefined;
      j.finishedAt = undefined;
      j.stages = initialStages(j.settings);
      j.clips = [];
      j.analysis = undefined;
    },
    true,
  );
  activeJobs.add(id);
  enqueue(id);
}

let chain: Promise<void> = Promise.resolve();
function enqueue(id: string) {
  chain = chain.then(async () => {
    try {
      await processJob(id);
    } catch (e) {
      console.error("Processing failed", e);
      updateJob(
        id,
        (j) => {
          j.status = "error";
          j.error = e instanceof Error ? e.message : String(e);
          j.etaSeconds = undefined;
          for (const s of j.stages) if (s.status === "active") s.status = "error";
        },
        true,
      );
    } finally {
      activeJobs.delete(id);
    }
  });
}

// ---------------------------------------------------------------- progress & ETA

function transcribeExpected(job: Job): number {
  const d = job.source?.duration ?? 60;
  if (job.settings.transcription === "none" || !job.source?.hasAudio) return 0;
  if (job.settings.transcription === "cloud") return d * 0.08 + 5;
  const perSec = { tiny: 0.5, base: 1.1, small: 3 }[job.settings.whisperModel] ?? 1.1;
  // With voice activity detection only speech (typically 25–40 % of a film) is transcribed.
  if (job.settings.vad) return d * 0.02 + d * 0.35 * perSec + 20;
  return d * perSec + 20;
}

function convertExpected(job: Job): number {
  // ffmpeg.wasm ultrafast H.264 runs at roughly real-time to 2× slower, single-threaded.
  return (job.source?.size ?? 0) / 1e6 * 1.5 + 5;
}

function recompute(job: Job) {
  let p = 0;
  let totalWeight = 0;
  for (const def of STAGE_DEFS) {
    const s = job.stages.find((x) => x.id === def.id);
    if (!s) continue;
    totalWeight += def.weight;
    const expected = s.id === "transcribe" ? transcribeExpected(job) : s.id === "convert" ? convertExpected(job) : 0;
    if (expected > 0 && s.status === "active" && s.startedAt) {
      s.progress = Math.max(s.progress, Math.min(0.9, (Date.now() - s.startedAt) / 1000 / expected));
    }
    p += def.weight * (s.status === "done" || s.status === "skipped" ? 1 : s.progress);
  }
  p /= totalWeight || 1;
  job.progress = Math.min(0.999, p);
  if (!job.startedAt) return;
  const d = job.source?.duration || 60;
  const converting = job.stages.find((s) => s.id === "convert")?.status === "active";
  const prior = 5 + d * 0.15 + transcribeExpected(job) + (converting ? convertExpected(job) : 0);
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const priorRemaining = Math.max(0, prior * (1 - p));
  const empirical = p > 0.02 ? (elapsed / p) * (1 - p) : priorRemaining;
  const w = Math.min(1, p * 2.5);
  job.etaSeconds = Math.max(1, Math.round(w * empirical + (1 - w) * priorRemaining));
}

export function refreshProgress(id: string) {
  const job = getJob(id);
  if (job?.status === "processing") updateJob(id, recompute);
}

function stage(id: string, stageId: StageId, patch: Partial<Stage>) {
  updateJob(id, (j) => {
    const s = j.stages.find((x) => x.id === stageId)!;
    if (patch.status === "active" && s.status !== "active") s.startedAt = Date.now();
    if ((patch.status === "done" || patch.status === "skipped" || patch.status === "error") && !s.endedAt) s.endedAt = Date.now();
    const prev = s.progress;
    Object.assign(s, patch);
    if (patch.progress !== undefined && s.status === "active") s.progress = Math.max(prev, patch.progress);
    if (patch.status === "done") s.progress = 1;
    recompute(j);
  });
}

function warn(id: string, msg: string) {
  updateJob(id, (j) => {
    if (!j.warnings.includes(msg)) j.warnings.push(msg);
  });
}

// ---------------------------------------------------------------- pipeline

async function processJob(id: string) {
  const job0 = getJob(id);
  if (!job0) throw new Error("Project not found");
  let file = await getBlob(id, "source");
  if (!file) throw new Error("The source video is missing from browser storage.");
  updateJob(id, (j) => {
    j.status = "processing";
    j.startedAt = Date.now();
  }, true);

  // 1. Probe (+ convert unsupported formats in-browser)
  stage(id, "probe", { status: "active", detail: "Reading container & codecs" });
  let probeRes = (await runMediaTask({ task: "probe", file }, "probe")).result as ProbeInfo | { unsupported: string };
  let playable = "unsupported" in probeRes ? false : await canPlayInVideoElement(file);
  if ("unsupported" in probeRes || !playable) {
    const why = "unsupported" in probeRes ? `unsupported ${probeRes.unsupported}` : "not playable in this browser";
    stage(id, "probe", { status: "done", detail: `Needs conversion (${why})` });
    stage(id, "convert", { status: "active", detail: "Transcoding to MP4 with ffmpeg.wasm (in your browser)" });
    const { convertToMp4 } = await import("./convert");
    file = await convertToMp4(file, job0.name, (f) => stage(id, "convert", { progress: f }));
    await putBlob(id, "source", file);
    updateJob(id, (j) => {
      j.source!.converted = true;
      j.source!.mimeType = "video/mp4";
    });
    probeRes = (await runMediaTask({ task: "probe", file }, "probe")).result as ProbeInfo | { unsupported: string };
    if ("unsupported" in probeRes) throw new Error("This video could not be decoded even after conversion.");
    playable = await canPlayInVideoElement(file);
    stage(id, "convert", { status: "done", detail: "Converted to H.264/AAC MP4" });
  } else {
    stage(id, "convert", { status: "skipped", detail: "Not needed" });
  }
  // probe.hasAudio means "WebCodecs can decode it". If a track exists but can't be decoded here, still treat it as audio:
  // the analysis worker reports "audio-failed" and ffmpeg.wasm decodes it instead (and export reuses that fallback).
  const info = { ...probeRes, hasAudio: probeRes.hasAudio || !!probeRes.audioCodec };
  if (!info.duration || info.duration < 2) throw new Error("Video is too short or its duration could not be read.");
  updateJob(id, (j) => Object.assign(j.source!, { duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio }));
  stage(id, "probe", { status: "done", detail: `${info.width}×${info.height}, ${Math.round(info.fps)} fps, ${Math.round(info.duration)}s · ${info.videoCodec ?? "?"}/${info.audioCodec ?? "no audio"}` });
  if (!playable) warn(id, "Your browser can't play this video natively, so previews may not work.");

  // 2-4. Audio + visual analysis in the media worker; transcription starts as soon as audio is decoded.
  const job = getJob(id)!;
  // A Japanese subtitle/transcript file replaces speech recognition entirely: exact text, and much faster.
  const jaCues = job.settings.subtitleFiles?.ja ? ((await getData<Cue[]>(id, "subs-ja")) ?? []) : [];
  const mode = jaCues.length ? "none" : info.hasAudio ? job.settings.transcription : "none";
  let audio: AudioSignal | null = null;
  let visual: VisualSignal | null = null;
  let resolveTranscript!: (t: Transcript) => void;
  const transcriptP = new Promise<Transcript>((r) => (resolveTranscript = r));
  const none: Transcript = { provider: "none", words: [], segments: [] };

  if (info.hasAudio) stage(id, "audio", { status: "active", detail: "Decoding audio with WebCodecs" });
  else {
    stage(id, "audio", { status: "skipped", detail: "No audio track" });
    if (!jaCues.length) warn(id, "This video has no audio track — captions and speech analysis are unavailable.");
  }
  if (jaCues.length) {
    stage(id, "transcribe", { status: "done", detail: `Using your Japanese subtitle file (${jaCues.length} lines) — no speech recognition needed` });
    resolveTranscript(transcriptFromCues(jaCues));
  } else if (mode === "none") {
    stage(id, "transcribe", { status: "skipped", detail: info.hasAudio ? "Transcription turned off" : "No audio" });
    resolveTranscript(none);
  }

  let visualStarted = false;
  let audioFallback: Promise<void> | null = null;
  const onAudio = (pcm: Float32Array, signal: AudioSignal, decoder: "webcodecs" | "ffmpeg") => {
    audio = signal;
    updateJob(id, (j) => (j.source!.audioDecoder = decoder));
    stage(id, "audio", { status: "done", detail: `Loudness, transients & dynamics measured${decoder === "ffmpeg" ? " (ffmpeg.wasm)" : ""}` });
    if (mode !== "none") transcribeAudio(id, pcm, mode, job.settings).then(resolveTranscript);
  };
  const analyzeP = runMediaTask({ task: "analyze", file, info }, "done", (m) => {
    if (m.type === "progress" && m.stage === "audio") stage(id, "audio", { progress: m.value as number });
    else if (m.type === "progress" && m.stage === "visual") {
      if (!visualStarted) {
        visualStarted = true;
        stage(id, "visual", { status: "active", detail: "Tracking faces, motion & scene cuts" });
      }
      stage(id, "visual", { progress: m.value as number });
    } else if (m.type === "audio") {
      onAudio(m.pcm as Float32Array, m.signal as AudioSignal, "webcodecs");
    } else if (m.type === "audio-failed") {
      // WebCodecs couldn't decode this audio in this browser — decode it with ffmpeg.wasm instead (still on-device).
      stage(id, "audio", { detail: "WebCodecs can't decode this audio here — using ffmpeg.wasm" });
      audioFallback = (async () => {
        try {
          const { decodeAudioPcm } = await import("./convert");
          const { analyzeAudio } = await import("../engine/signals");
          const [pcm] = await decodeAudioPcm(file!, { rate: 16000, channels: 1 });
          onAudio(pcm, analyzeAudio(pcm), "ffmpeg");
        } catch (e) {
          console.error("Audio fallback failed", e);
          stage(id, "audio", { status: "error", detail: String((e as Error).message ?? e).slice(0, 140) });
          if (mode !== "none") stage(id, "transcribe", { status: "skipped", detail: "Audio could not be decoded" });
          warn(id, "This video's audio couldn't be decoded in your browser — clips were picked from visual signals only.");
          resolveTranscript(none);
        }
      })();
    } else if (m.type === "visual") {
      visual = m.signal as VisualSignal;
      stage(id, "visual", { status: "done", detail: `${visual.cuts.length} scene cuts, ${visual.motion.length} frames analysed` });
    }
  }).catch((e) => {
    console.error("Media analysis failed", e);
    if (!audio && !audioFallback && info.hasAudio) {
      stage(id, "audio", { status: "error", detail: String(e.message ?? e).slice(0, 140) });
      resolveTranscript(none);
    }
    if (!visual) {
      stage(id, "visual", { status: "error", detail: "Falling back to center crop" });
      warn(id, "Visual analysis failed — clips use a centered crop.");
    }
  });
  if (!visualStarted) stage(id, "visual", { status: "active", detail: "Waiting for audio decode…" });

  const [transcript] = await Promise.all([transcriptP, analyzeP]);
  if (!visual) stage(id, "visual", { status: "error", detail: "Falling back to center crop" });
  await putData(id, "transcript", transcript);

  // 5. Moments & plot twists
  const caps = await serverCaps();
  const useCloudAI = caps.cloudAI && transcript.words.length > 0;
  stage(id, "analyze", { status: "active", detail: useCloudAI ? "Asking GPT (text only) for viral moments" : "Scoring audio, visual & language signals on-device" });
  const tl = buildTimeline(info.duration, audio, visual, transcript);
  let moments: Moment[] = heuristicMoments(tl);
  let twists: PlotTwist[] = detectPlotTwists(tl, transcript);
  let summary = "";
  let aiProvider: "cloud" | "browser" = "browser";
  if (useCloudAI) {
    const ai = await cloudMoments(transcript, info.duration, (f) => stage(id, "analyze", { progress: f * 0.9 }), job.settings.rules?.instructions);
    if (ai.refused) warn(id, `Cloud AI skipped: ${ai.refused}. Moments were picked by on-device AI.`);
    if (ai.moments.length) {
      aiProvider = "cloud";
      moments = [...ai.moments, ...moments];
      twists = mergeTwists([...ai.twists, ...twists]);
      summary = ai.summary;
    }
  }
  applyMomentsToTimeline(tl, moments, twists);
  if (!summary) summary = buildSummary(transcript, twists.length, moments.length);
  await putData(id, "timeline", { bin: 0.5, interest: interestCurve(tl).map((v) => Math.round(v * 100) / 100) });
  updateJob(id, (j) => {
    j.analysis = { transcriptProvider: transcript.provider, aiProvider, summary, wordCount: transcript.words.length, plotTwists: twists, moments: moments.slice(0, 40) };
  });
  stage(id, "analyze", { status: "done", detail: `${moments.length} moments, ${twists.length} potential plot twists` });

  // 6. Select & rank clips (applying the creator's clipping rules)
  const rules = hasRules(job.settings.rules) ? effectiveRules(job.settings.rules!) : undefined;
  stage(id, "select", { status: "active", detail: rules ? `Applying your rules: ${describeRules(rules).join(" · ") || "custom instructions"}` : undefined });
  const { clips: cands, notes } = selectClips(tl, transcript, twists, moments, job.settings.durations, job.settings.maxClipsPerDuration, rules);
  for (const n of notes) warn(id, n);
  if (!cands.length) throw new Error("Could not find any clip candidates in this video.");
  let metas: ({ title: string; hook: string; hashtags: string[]; reason?: string } | null)[] = [];
  if (useCloudAI) {
    const m = await cloudMeta(cands, transcript, rules?.instructions);
    metas = m.metas;
    if (m.refused) warn(id, `Cloud titles skipped: ${m.refused}. Titles and hashtags were written on-device.`);
  }
  const used = new Set<string>();
  const anime = job.settings.kind === "anime";
  const clips: Clip[] = cands.map((c, i) => {
    const meta = metas[i] ?? heuristicMeta(c, transcript, i, used);
    const crop = computeCropPath(visual, c.start, c.end, info.width, info.height);
    const style = presetStyle(job.settings.captionPreset);
    const words: Word[] = transcript.words
      .filter((w) => w.start >= c.start - 0.05 && w.end <= c.end + 0.3)
      .map((w) => ({ text: w.text, start: Math.max(0, w.start - c.start), end: Math.min(c.end - c.start, w.end - c.start) }));
    return {
      id: `c${i + 1}-${Math.random().toString(36).slice(2, 7)}`,
      rank: i + 1,
      start: c.start,
      end: c.end,
      duration: c.end - c.start,
      targetDuration: c.target,
      viralScore: c.viralScore,
      scores: c.scores,
      tags: c.tags,
      title: meta.title,
      hook: meta.hook,
      reason: meta.reason ?? c.reason,
      hashtags: meta.hashtags,
      hasPlotTwist: c.hasPlotTwist,
      ruleMatches: c.ruleMatches,
      twistAt: c.twistAt,
      status: "rendering",
      progress: 0,
      reframeMode: anime ? "fit" : job.settings.reframeMode,
      crop,
      trackingConfidence: Math.round(crop.confidence * 100) / 100,
      captions: groupWordsIntoLines(words, style.wordsPerLine),
      style,
      ...(anime ? { anime: { layout: job.settings.anime?.layout ?? "both", background: job.settings.anime?.background ?? "blur", subtitles: [] } } : {}),
      export: { status: "idle", progress: 0 },
    };
  });
  updateJob(id, (j) => (j.clips = clips), true);
  stage(id, "select", { status: "done", detail: `${clips.length} clips ranked by viral score` });

  // 6b. Anime Clipper: Japanese subtitle lines -> English translation + furigana for every picked clip.
  if (anime) await buildAnimeSubtitles(id, transcript, file);

  // 7. Poster frames (previews themselves render live in the browser — no waiting)
  stage(id, "render", { status: "active", detail: "Generating 9:16 poster frames" });
  try {
    const res = await runMediaTask(
      {
        task: "thumbs",
        file,
        width: 360,
        height: 640,
        items: getJob(id)!.clips.map((c) => {
          const rel = Math.min(c.duration / 3, 3);
          return { key: c.id, time: c.start + rel, rel, crop: c.crop, mode: c.reframeMode, anime: c.anime };
        }),
      },
      "thumbs",
      (m) => m.type === "progress" && stage(id, "render", { progress: m.value as number }),
    );
    for (const { key, blob } of res.results as { key: string; blob: Blob }[]) {
      await putBlob(id, `thumb-${key}`, blob);
      updateClip(id, key, (c) => (c.thumbnail = `thumb-${key}`));
    }
  } catch (e) {
    console.warn("Thumbnail generation failed", e);
  }
  updateJob(id, (j) => {
    for (const c of j.clips) {
      c.status = "ready";
      c.progress = 1;
    }
  });
  stage(id, "render", { status: "done", detail: `${clips.length} reels ready to preview` });
  updateJob(id, (j) => {
    j.status = "ready";
    j.progress = 1;
    j.etaSeconds = 0;
    j.finishedAt = Date.now();
  }, true);
}

// ---------------------------------------------------------------- Anime Clipper subtitles

const ANIME_HASHTAGS = ["#anime", "#animeclips", "#learnjapanese", "#japanese", "#furigana"];

/**
 * Build each clip's bilingual subtitles. Japanese comes from the user's subtitle file when there is one (exact),
 * otherwise from speech recognition (with an accurate second pass). English comes from the user's English file when it
 * has a line at that moment, otherwise from machine translation (flagged when uncertain).
 */
async function buildAnimeSubtitles(id: string, transcript: Transcript, file: Blob) {
  stage(id, "subtitle", { status: "active", detail: "Preparing subtitle lines" });
  const [{ segmentJapanese, newSubtitleId }, { translateToEnglish, transcribeRanges, mergeRanges, reviewReason }, { annotateFurigana }, { cuesFor }] =
    await Promise.all([import("../anime/subtitles"), import("../anime/generate"), import("../anime/furigana"), import("../anime/subfile")]);
  const job = getJob(id)!;
  const clips = job.clips;
  const jaCues = job.settings.subtitleFiles?.ja ? ((await getData<Cue[]>(id, "subs-ja")) ?? []) : [];
  const enCues = job.settings.subtitleFiles?.en ? ((await getData<Cue[]>(id, "subs-en")) ?? []) : [];
  const inClips = (l: { start: number; end: number }) => clips.some((c) => l.end > c.start && l.start < c.end);

  let words = transcript.words;
  let lines: { start: number; end: number; text: string }[];
  if (jaCues.length) {
    lines = jaCues.filter(inClips).map((c) => ({ start: c.start, end: c.end, text: c.text }));
  } else {
    // Second pass: the quick scan only had to find good moments; re-transcribe just the picked clips with the accurate
    // model so the subtitles are as correct as possible (minutes of audio instead of the whole video).
    const subModel = job.settings.subtitleModel;
    if (subModel && subModel !== job.settings.whisperModel && clips.length) {
      try {
        const ranges = mergeRanges(clips, 1, job.source?.duration ?? Infinity);
        const minutes = Math.max(1, Math.round(ranges.reduce((a, r) => a + r.end - r.start, 0) / 60));
        words = await transcribeRanges(file, ranges, subModel, (detail, p) =>
          stage(id, "subtitle", { detail: `Accurate subtitles (Whisper ${subModel}, ${minutes} min of clips): ${detail}`, progress: (p ?? 0) * 0.6 }),
        );
        updateJob(id, (j) => (j.engine = `${j.engine ?? ""} · subtitles: Whisper ${subModel}`));
      } catch (e) {
        console.error("Accurate re-transcription failed", e);
        warn(id, `The accurate subtitle pass failed (${(e as Error).message.slice(0, 120)}), so subtitles use the quick scan.`);
        words = transcript.words;
      }
    }
    lines = segmentJapanese(words).filter(inClips);
  }
  if (!lines.length) {
    stage(id, "subtitle", { status: "skipped", detail: "No Japanese speech inside the clips" });
    if (transcript.words.length) warn(id, "No speech was found inside the picked clips, so they have no subtitles. You can add lines in the editor.");
    return;
  }

  // English: the user's file first, machine translation only for lines it doesn't cover.
  const english: string[] = lines.map((l) => (enCues.length ? cuesFor(enCues, l.start, l.end) : ""));
  const fromFile = english.map((t) => !!t);
  let uncertain: boolean[] = lines.map(() => false);
  const missing = lines.map((_, i) => i).filter((i) => !english[i]);
  if (missing.length) {
    try {
      const tr = await translateToEnglish(
        missing.map((i) => lines[i].text),
        (detail, p) => stage(id, "subtitle", { detail, progress: 0.6 + (p ?? 0) * 0.3 }),
      );
      uncertain = lines.map(() => false);
      missing.forEach((i, j) => {
        english[i] = tr.translations[j] ?? "";
        uncertain[i] = tr.uncertain[j] ?? !english[i];
      });
      if (tr.note) warn(id, tr.note);
    } catch (e) {
      console.error("Translation failed", e);
      missing.forEach((i) => (uncertain[i] = true));
      warn(id, `English translation failed (${(e as Error).message.slice(0, 120)}). Japanese subtitles were kept; you can type the English in the editor.`);
    }
  }

  // Lines the quick scan heard very differently are likely misheard by one of the passes (not relevant for file text).
  const scanWords = !jaCues.length && words !== transcript.words ? transcript.words : undefined;
  const subs: AnimeSubtitle[] = [];
  for (let i = 0; i < lines.length; i++) {
    let ja: AnimeSubtitle["ja"] = [{ text: lines[i].text }];
    try {
      ja = await annotateFurigana(lines[i].text);
    } catch (e) {
      if (i === 0) warn(id, `Furigana could not be added (${(e as Error).message.slice(0, 120)}).`);
    }
    const en = english[i] ?? "";
    let review: string | undefined;
    if (!jaCues.length) review = await reviewReason(lines[i], en, !fromFile[i] && (uncertain[i] ?? false), scanWords);
    else if (!en) review = "Check: no reliable English — please type it";
    else if (!fromFile[i] && uncertain[i]) review = "Check: translation was uncertain";
    subs.push({ id: newSubtitleId(), start: lines[i].start, end: lines[i].end, ja, en, enSource: fromFile[i] ? "file" : "machine", ...(review ? { review } : {}) });
    stage(id, "subtitle", { detail: "Adding furigana", progress: 0.9 + 0.1 * ((i + 1) / lines.length) });
  }
  const toReview = subs.filter((s) => s.review).length;
  if (toReview) warn(id, `${toReview} of ${subs.length} subtitle lines are marked “Needs review” (possible mishearing or uncertain translation). Check them in each clip's editor.`);

  updateJob(id, (j) => {
    const titles = new Set<string>();
    for (const c of j.clips) {
      const own = subs.filter((s) => s.end > c.start && s.start < c.end);
      c.anime = { ...(c.anime ?? { layout: "both", background: "blur" }), subtitles: own.map((s) => ({ ...s, id: newSubtitleId() })) };
      // English titles read better than the Japanese transcript on the clip grid.
      const best = own
        .map((s) => s.en.trim())
        .filter((t) => t.length > 3 && !titles.has(t))
        .sort((a, b) => Number(/[!?]/.test(b)) - Number(/[!?]/.test(a)) || Math.abs(a.length - 45) - Math.abs(b.length - 45))[0];
      if (best) {
        c.title = best.length > 70 ? `${best.slice(0, 67).trimEnd()}…` : best;
        c.hook = best.slice(0, 80);
        titles.add(best);
      }
      c.hashtags = [...new Set([...ANIME_HASHTAGS, ...c.hashtags.filter((h) => /^#[a-z0-9]+$/i.test(h))])].slice(0, 8);
    }
  }, true);
  const translated = english.filter((t) => t.trim()).length;
  const fileEn = fromFile.filter(Boolean).length;
  stage(id, "subtitle", {
    status: "done",
    detail: `${subs.length} lines${jaCues.length ? " (Japanese from your file)" : ""} · ${translated} with English${fileEn ? ` (${fileEn} from your file)` : ""} · furigana added`,
  });
}

/**
 * Import subtitle/transcript files into an existing Anime project: the clip subtitles are rebuilt from them (Japanese
 * file → exact Japanese; English file → English for matching lines; machine translation fills the rest).
 */
export async function importSubtitleFiles(jobId: string, cues: { ja?: Cue[]; en?: Cue[] }, onStatus?: (detail: string) => void) {
  const job = getJob(jobId);
  if (!job) throw new Error("Project not found");
  const file = await getBlob(jobId, "source");
  if (!file) throw new Error("The source video is missing from browser storage.");
  if (cues.ja?.length) await putData(jobId, "subs-ja", cues.ja);
  if (cues.en?.length) await putData(jobId, "subs-en", cues.en);
  updateJob(
    jobId,
    (j) => {
      j.settings.subtitleFiles = {
        ja: cues.ja?.length || j.settings.subtitleFiles?.ja,
        en: cues.en?.length || j.settings.subtitleFiles?.en,
      };
      j.warnings = j.warnings.filter((w) => !/Needs review/.test(w));
    },
    true,
  );
  const transcript = cues.ja?.length ? transcriptFromCues(cues.ja) : ((await getData<Transcript>(jobId, "transcript")) ?? { provider: "none", words: [], segments: [] });
  const stop = onStatus ? watchStage(jobId, "subtitle", onStatus) : () => undefined;
  try {
    await buildAnimeSubtitles(jobId, transcript, file);
  } finally {
    stop();
    updateJob(jobId, (j) => {
      j.progress = 1;
      j.etaSeconds = 0;
    }, true);
  }
}

function watchStage(jobId: string, stageId: StageId, fn: (detail: string) => void) {
  let last = "";
  const t = setInterval(() => {
    const s = getJob(jobId)?.stages.find((x) => x.id === stageId);
    if (s?.detail && s.detail !== last) fn((last = s.detail));
  }, 300);
  return () => clearInterval(t);
}

function buildSummary(t: Transcript, twistCount: number, momentCount: number): string {
  if (!t.words.length) return `Signal-based analysis found ${momentCount} high-energy moments and ${twistCount} potential twists.`;
  const first = t.segments[0]?.text ?? "";
  return `${t.words.length} spoken words analysed on your device. Opens with: “${first.slice(0, 100)}${first.length > 100 ? "…" : ""}” — ${momentCount} engaging moments and ${twistCount} potential plot twists detected.`;
}

// ---------------------------------------------------------------- transcription

class CloudRefused extends Error {}

async function transcribeAudio(id: string, pcm: Float32Array, mode: "browser" | "cloud", settings: JobSettings): Promise<Transcript> {
  stage(id, "transcribe", { status: "active", detail: mode === "cloud" ? "Sending audio to Whisper API" : "Starting in-browser Whisper" });
  try {
    let used: "browser" | "cloud" = mode;
    let words: Word[];
    if (mode === "cloud") {
      try {
        words = await transcribeCloud(id, pcm, settings.language);
      } catch (e) {
        if (!(e instanceof CloudRefused)) throw e;
        // Limit reached / access denied: keep going with free on-device transcription instead.
        warn(id, `Cloud transcription unavailable (${e.message}) — transcribed in your browser instead.`);
        stage(id, "transcribe", { detail: "Falling back to in-browser Whisper" });
        used = "browser";
        words = await transcribeBrowser(id, pcm, settings);
      }
    } else words = await transcribeBrowser(id, pcm, settings);
    const clean = normalizeWords(words.map((w) => ({ ...w, text: w.text.replace(/\u200B/g, "") })));
    stage(id, "transcribe", { status: "done", detail: `${clean.length} words (${used === "cloud" ? "Whisper API" : `in-browser Whisper ${settings.whisperModel}`})` });
    return { provider: used, language: settings.language, words: clean, segments: buildSegments(clean) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Transcription failed", e);
    stage(id, "transcribe", { status: "error", detail: msg.slice(0, 160) });
    warn(id, `Transcription failed (${msg.slice(0, 120)}). Clips were generated from audio/visual signals; you can type captions manually.`);
    return { provider: "none", words: [], segments: [] };
  }
}

function transcribeBrowser(id: string, pcm: Float32Array, settings: JobSettings): Promise<Word[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") stage(id, "transcribe", { progress: m.value, ...(m.detail ? { detail: m.detail } : {}) });
      else if (m.type === "engine") updateJob(id, (j) => (j.engine = `Whisper ${settings.whisperModel} · ${m.value}`));
      else if (m.type === "done") {
        worker.terminate();
        resolve(m.words);
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Speech worker crashed"));
    };
    worker.postMessage({ pcm, model: WHISPER_MODELS[settings.whisperModel], language: settings.language, vad: !!settings.vad }, [pcm.buffer]);
  });
}

function wav16k(pcm: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

async function transcribeCloud(id: string, pcm: Float32Array, language?: string): Promise<Word[]> {
  const CHUNK = 600 * 16000;
  const words: Word[] = [];
  const pieces = Math.ceil(pcm.length / CHUNK);
  const lang = language ? (LANGUAGES[language] ?? "") : "";
  for (let i = 0; i < pieces; i++) {
    stage(id, "transcribe", { progress: i / pieces, detail: `Whisper API part ${i + 1} of ${pieces}` });
    const res = await fetch(`/api/ai/transcribe?language=${lang}`, { method: "POST", headers: aiHeaders(), body: wav16k(pcm.subarray(i * CHUNK, (i + 1) * CHUNK)) });
    const refused = await cloudRefusal(res.clone());
    if (refused) throw new CloudRefused(refused);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Cloud transcription failed (${res.status})`);
    const off = (i * CHUNK) / 16000;
    if (data.words?.length) for (const w of data.words) words.push({ text: w.text, start: w.start + off, end: w.end + off });
    else for (const s of data.segments ?? []) words.push(...spreadWords(s.text, s.start + off, s.end + off));
  }
  return words;
}

// ---------------------------------------------------------------- optional cloud AI (text only)

async function cloudMoments(t: Transcript, duration: number, onProgress: (f: number) => void, instructions?: string) {
  const WINDOW = 900;
  const moments: Moment[] = [];
  const twists: PlotTwist[] = [];
  const summaries: string[] = [];
  let refused: string | null = null;
  const chunks = [];
  for (let s = 0; s < duration; s += WINDOW) {
    const c = t.segments.filter((x) => x.start >= s && x.start < s + WINDOW);
    if (c.length) chunks.push(c);
  }
  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetch("/api/ai/moments", { method: "POST", headers: aiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ segments: chunks[i], duration, instructions }) });
      if (res.ok) {
        const d = await res.json();
        moments.push(...(d.moments ?? []));
        twists.push(...(d.twists ?? []));
        if (d.summary) summaries.push(d.summary);
      } else if ((refused = await cloudRefusal(res))) break;
    } catch (e) {
      console.warn("Cloud moment analysis failed", e);
    }
    onProgress((i + 1) / chunks.length);
  }
  return { moments, twists, summary: summaries.join(" "), refused };
}

async function cloudMeta(cands: Candidate[], t: Transcript, instructions?: string): Promise<{ metas: ({ title: string; hook: string; hashtags: string[]; reason?: string } | null)[]; refused: string | null }> {
  try {
    const items = cands.map((c, i) => ({ id: i, seconds: Math.round(c.end - c.start), plot_twist: c.hasPlotTwist, tags: c.tags, transcript: clipText(t, c.start, c.end).slice(0, 1400) }));
    const res = await fetch("/api/ai/meta", { method: "POST", headers: aiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ items, instructions }) });
    if (!res.ok) return { metas: [], refused: await cloudRefusal(res) };
    const d = (await res.json()) as { clips: { id: number; title: string; hook: string; hashtags: string[]; reason?: string }[] };
    const map = new Map(d.clips.map((c) => [c.id, c]));
    return { metas: cands.map((_, i) => map.get(i) ?? null), refused: null };
  } catch {
    return { metas: [], refused: null };
  }
}

// ---------------------------------------------------------------- export

const exportControllers = new Map<string, AbortController>();

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Default download name for a clip, e.g. "01-the-weather-is-nice-9x16.mp4". */
export function clipFilename(c: Clip) {
  return `${String(c.rank).padStart(2, "0")}-${slugify(c.title) || "clip"}-9x16.mp4`;
}

/** Render one clip to a 1080×1920 MP4 in a worker (WebCodecs), tracking progress on the clip. Returns null if cancelled. */
async function renderClip(jobId: string, clipId: string, signal?: AbortSignal): Promise<Blob | null> {
  const job = getJob(jobId);
  const clip = job?.clips.find((c) => c.id === clipId);
  if (!job || !clip || clip.export.status === "rendering") return null;
  const file = await getBlob(jobId, "source");
  if (!file) throw new Error("Source video missing from browser storage");
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  exportControllers.set(clipId, ctrl);
  updateClip(jobId, clipId, (c) => (c.export = { status: "rendering", progress: 0 }));
  try {
    let audio: { channels: Float32Array[]; sampleRate: number } | undefined;
    if (job.source?.hasAudio && job.source.audioDecoder === "ffmpeg") {
      const { decodeAudioPcm } = await import("./convert");
      audio = { channels: await decodeAudioPcm(file, { rate: 48000, channels: 2, start: clip.start, duration: clip.end - clip.start }), sampleRate: 48000 };
    }
    const common = { file, start: clip.start, end: clip.end, width: 1080, height: 1920, audio };
    const res = await runMediaTask(
      clip.anime
        ? { task: "anime-export", ...common, layout: clip.anime.layout, background: clip.anime.background, subtitles: clip.anime.subtitles }
        : { task: "export", ...common, mode: clip.reframeMode, crop: clip.crop, captions: clip.captions, style: clip.style },
      "export",
      (m) => m.type === "progress" && updateClip(jobId, clipId, (c) => (c.export = { status: "rendering", progress: m.value as number })),
      ctrl.signal,
    );
    updateClip(jobId, clipId, (c) => (c.export = { status: "ready", progress: 1 }));
    return res.blob as Blob;
  } catch (e) {
    if ((e as DOMException).name === "AbortError") {
      updateClip(jobId, clipId, (c) => (c.export = { status: "idle", progress: 0 }));
      return null;
    }
    updateClip(jobId, clipId, (c) => (c.export = { status: "error", progress: 0, error: e instanceof Error ? e.message : String(e) }));
    throw e;
  } finally {
    signal?.removeEventListener("abort", abort);
    exportControllers.delete(clipId);
  }
}

/** Render the final 1080×1920 MP4 in a worker (WebCodecs) and hand it to the browser as a download. */
export async function exportAndDownload(jobId: string, clipId: string, filename: string) {
  try {
    const blob = await renderClip(jobId, clipId);
    if (blob) saveBlob(blob, filename);
  } catch {
    // The error is shown on the clip (export.status = "error").
  }
}

export interface BatchProgress {
  done: number;
  total: number;
  /** Progress of the clip being rendered right now (0..1). */
  current: number;
  failed: number;
}

let batchController: AbortController | null = null;

/**
 * Render several clips one after another and download them as a single ZIP (one file, so the browser doesn't ask to
 * allow multiple downloads). Clips that fail are skipped and reported; returns the number of clips in the ZIP.
 */
export async function exportAllAsZip(jobId: string, clipIds: string[], zipName: string, onProgress: (p: BatchProgress) => void): Promise<{ saved: number; failed: number; cancelled: boolean }> {
  batchController?.abort();
  const ctrl = new AbortController();
  batchController = ctrl;
  const { createZip } = await import("./zip");
  const entries: { name: string; data: Blob }[] = [];
  let failed = 0;
  const total = clipIds.length;
  try {
    for (let i = 0; i < total; i++) {
      if (ctrl.signal.aborted) break;
      const clip = getJob(jobId)?.clips.find((c) => c.id === clipIds[i]);
      if (!clip) continue;
      onProgress({ done: i, total, current: 0, failed });
      const unsubscribe = watchClipProgress(jobId, clip.id, (current) => onProgress({ done: i, total, current, failed }));
      try {
        const blob = await renderClip(jobId, clip.id, ctrl.signal);
        if (blob) entries.push({ name: clipFilename(clip), data: blob });
      } catch {
        failed++;
      } finally {
        unsubscribe();
      }
    }
    const cancelled = ctrl.signal.aborted;
    if (!cancelled && entries.length) {
      onProgress({ done: total, total, current: 1, failed });
      saveBlob(await createZip(entries), zipName);
    }
    return { saved: cancelled ? 0 : entries.length, failed, cancelled };
  } finally {
    if (batchController === ctrl) batchController = null;
  }
}

export function cancelExportAll() {
  batchController?.abort();
}

/** Poll a clip's export progress (export progress lives in the store, updated by the worker callbacks). */
function watchClipProgress(jobId: string, clipId: string, fn: (p: number) => void) {
  const t = setInterval(() => {
    const c = getJob(jobId)?.clips.find((x) => x.id === clipId);
    if (c?.export.status === "rendering") fn(c.export.progress);
  }, 250);
  return () => clearInterval(t);
}

export function cancelExport(clipId: string) {
  exportControllers.get(clipId)?.abort();
}
