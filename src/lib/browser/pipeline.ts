"use client";

import type { Clip, Job, JobSettings, Moment, PlotTwist, Stage, StageId, Transcript, Word } from "../types";
import { groupWordsIntoLines, presetStyle } from "../captions";
import type { AudioSignal, VisualSignal } from "../engine/signals";
import { applyMomentsToTimeline, buildTimeline, detectPlotTwists, heuristicMoments, interestCurve, mergeTwists } from "../engine/analysis";
import { clipText, heuristicMeta, selectClips, type Candidate } from "../engine/select";
import { describeRules, effectiveRules, hasRules } from "../engine/rules";
import { computeCropPath } from "../engine/reframe";
import { LANGUAGES, buildSegments, normalizeWords, spreadWords } from "../engine/transcript";
import { activeJobs, getBlob, getJob, loadJobs, putBlob, putData, putJob, updateClip, updateJob } from "./store";
import { canPlayInVideoElement, runMediaTask } from "./workers";
import type { ProbeInfo } from "./media.worker";
import { requestPersistence } from "./db";

const STAGE_DEFS: { id: StageId; label: string; weight: number }[] = [
  { id: "probe", label: "Reading video", weight: 0.02 },
  { id: "convert", label: "Converting format", weight: 0.1 },
  { id: "audio", label: "Decoding audio", weight: 0.06 },
  { id: "transcribe", label: "Transcribing speech", weight: 0.42 },
  { id: "visual", label: "Scene & speaker tracking", weight: 0.22 },
  { id: "analyze", label: "Detecting viral moments & plot twists", weight: 0.05 },
  { id: "select", label: "Ranking clips", weight: 0.03 },
  { id: "render", label: "Preparing 9:16 previews", weight: 0.1 },
];

export const WHISPER_MODELS = {
  tiny: "onnx-community/whisper-tiny_timestamped",
  base: "onnx-community/whisper-base_timestamped",
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
function aiHeaders(extra: Record<string, string> = {}): Record<string, string> {
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

function initialStages(): Stage[] {
  return STAGE_DEFS.map((s) => ({ id: s.id, label: s.label, status: "pending", progress: 0 }));
}

// ---------------------------------------------------------------- project creation & queue

export async function createProject(file: File, settings: JobSettings): Promise<string> {
  await loadJobs();
  requestPersistence();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: Job = {
    id,
    name: file.name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    progress: 0,
    warnings: [],
    stages: initialStages(),
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
      j.stages = initialStages();
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
  const perSec = job.settings.whisperModel === "base" ? 1.1 : 0.5;
  return d * perSec + 20;
}

function convertExpected(job: Job): number {
  // ffmpeg.wasm ultrafast H.264 runs at roughly real-time to 2× slower, single-threaded.
  return (job.source?.size ?? 0) / 1e6 * 1.5 + 5;
}

function recompute(job: Job) {
  let p = 0;
  for (const def of STAGE_DEFS) {
    const s = job.stages.find((x) => x.id === def.id)!;
    const expected = s.id === "transcribe" ? transcribeExpected(job) : s.id === "convert" ? convertExpected(job) : 0;
    if (expected > 0 && s.status === "active" && s.startedAt) {
      s.progress = Math.max(s.progress, Math.min(0.9, (Date.now() - s.startedAt) / 1000 / expected));
    }
    p += def.weight * (s.status === "done" || s.status === "skipped" ? 1 : s.progress);
  }
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
  const info = probeRes;
  if (!info.duration || info.duration < 2) throw new Error("Video is too short or its duration could not be read.");
  updateJob(id, (j) => Object.assign(j.source!, { duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio }));
  stage(id, "probe", { status: "done", detail: `${info.width}×${info.height}, ${Math.round(info.fps)} fps, ${Math.round(info.duration)}s · ${info.videoCodec ?? "?"}/${info.audioCodec ?? "no audio"}` });
  if (!playable) warn(id, "Your browser can't play this video natively, so previews may not work.");

  // 2-4. Audio + visual analysis in the media worker; transcription starts as soon as audio is decoded.
  const job = getJob(id)!;
  const mode = info.hasAudio ? job.settings.transcription : "none";
  let audio: AudioSignal | null = null;
  let visual: VisualSignal | null = null;
  let resolveTranscript!: (t: Transcript) => void;
  const transcriptP = new Promise<Transcript>((r) => (resolveTranscript = r));
  const none: Transcript = { provider: "none", words: [], segments: [] };

  if (info.hasAudio) stage(id, "audio", { status: "active", detail: "Decoding audio with WebCodecs" });
  else {
    stage(id, "audio", { status: "skipped", detail: "No audio track" });
    warn(id, "This video has no audio track — captions and speech analysis are unavailable.");
  }
  if (mode === "none") {
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
      reframeMode: job.settings.reframeMode,
      crop,
      trackingConfidence: Math.round(crop.confidence * 100) / 100,
      captions: groupWordsIntoLines(words, style.wordsPerLine),
      style,
      export: { status: "idle", progress: 0 },
    };
  });
  updateJob(id, (j) => (j.clips = clips), true);
  stage(id, "select", { status: "done", detail: `${clips.length} clips ranked by viral score` });

  // 7. Poster frames (previews themselves render live in the browser — no waiting)
  stage(id, "render", { status: "active", detail: "Generating 9:16 poster frames" });
  try {
    const res = await runMediaTask(
      {
        task: "thumbs",
        file,
        width: 360,
        height: 640,
        items: clips.map((c) => {
          const rel = Math.min(c.duration / 3, 3);
          return { key: c.id, time: c.start + rel, rel, crop: c.crop, mode: c.reframeMode };
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
    const clean = normalizeWords(words);
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
    worker.postMessage({ pcm, model: WHISPER_MODELS[settings.whisperModel], language: settings.language }, [pcm.buffer]);
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

/** Render the final 1080×1920 MP4 in a worker (WebCodecs) and hand it to the browser as a download. */
export async function exportAndDownload(jobId: string, clipId: string, filename: string) {
  const job = getJob(jobId);
  const clip = job?.clips.find((c) => c.id === clipId);
  if (!job || !clip || clip.export.status === "rendering") return;
  const file = await getBlob(jobId, "source");
  if (!file) throw new Error("Source video missing from browser storage");
  const ctrl = new AbortController();
  exportControllers.set(clipId, ctrl);
  updateClip(jobId, clipId, (c) => (c.export = { status: "rendering", progress: 0 }));
  try {
    let audio: { channels: Float32Array[]; sampleRate: number } | undefined;
    if (job.source?.hasAudio && job.source.audioDecoder === "ffmpeg") {
      const { decodeAudioPcm } = await import("./convert");
      audio = { channels: await decodeAudioPcm(file, { rate: 48000, channels: 2, start: clip.start, duration: clip.end - clip.start }), sampleRate: 48000 };
    }
    const res = await runMediaTask(
      { task: "export", file, start: clip.start, end: clip.end, width: 1080, height: 1920, mode: clip.reframeMode, crop: clip.crop, captions: clip.captions, style: clip.style, audio },
      "export",
      (m) => m.type === "progress" && updateClip(jobId, clipId, (c) => (c.export = { status: "rendering", progress: m.value as number })),
      ctrl.signal,
    );
    const url = URL.createObjectURL(res.blob as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    updateClip(jobId, clipId, (c) => (c.export = { status: "ready", progress: 1 }));
  } catch (e) {
    if ((e as DOMException).name === "AbortError") updateClip(jobId, clipId, (c) => (c.export = { status: "idle", progress: 0 }));
    else updateClip(jobId, clipId, (c) => (c.export = { status: "error", progress: 0, error: e instanceof Error ? e.message : String(e) }));
  } finally {
    exportControllers.delete(clipId);
  }
}

export function cancelExport(clipId: string) {
  exportControllers.get(clipId)?.abort();
}
