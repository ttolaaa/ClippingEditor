"use client";

import { normalizeWords } from "../engine/transcript";
import { aiHeaders, serverCaps } from "../browser/pipeline";
import { runMediaTask, canPlayInVideoElement } from "../browser/workers";
import type { ProbeInfo } from "../browser/media.worker";
import { annotateFurigana } from "./furigana";
import { newSubtitleId, segmentJapanese } from "./subtitles";
import type { AnimeSubtitle, BackgroundMode, SubtitleLayout } from "./types";

export const ANIME_WHISPER_MODELS = {
  tiny: { id: "onnx-community/whisper-tiny_timestamped", label: "Fast", note: "~40 MB · rough Japanese" },
  base: { id: "onnx-community/whisper-base_timestamped", label: "Balanced", note: "~80 MB" },
  small: { id: "onnx-community/whisper-small_timestamped", label: "Accurate", note: "~250 MB · best Japanese, slower" },
} as const;
export type AnimeWhisperModel = keyof typeof ANIME_WHISPER_MODELS;

export type Status = (detail: string, progress?: number) => void;

export interface PreparedVideo {
  file: Blob;
  info: ProbeInfo;
  converted: boolean;
  /** The audio track exists but WebCodecs can't decode it here, so ffmpeg.wasm decodes it. */
  audioFallback: boolean;
}

/** Probe the file and, when the browser can't decode/play it (AVI, MKV, odd codecs), transcode it to MP4 on-device. */
export async function prepareVideo(file: File, onStatus: Status): Promise<PreparedVideo> {
  onStatus("Reading video…");
  let blob: Blob = file;
  let probe = (await runMediaTask({ task: "probe", file: blob }, "probe")).result as ProbeInfo | { unsupported: string };
  let converted = false;
  if ("unsupported" in probe || !(await canPlayInVideoElement(blob))) {
    onStatus("Converting to MP4 in your browser (ffmpeg.wasm)…", 0);
    const { convertToMp4 } = await import("../browser/convert");
    blob = await convertToMp4(file, file.name, (f) => onStatus("Converting to MP4 in your browser (ffmpeg.wasm)…", f));
    converted = true;
    probe = (await runMediaTask({ task: "probe", file: blob }, "probe")).result as ProbeInfo | { unsupported: string };
    if ("unsupported" in probe) throw new Error("This video could not be decoded even after conversion.");
  }
  if (!probe.duration || probe.duration < 1) throw new Error("Video is too short or its duration could not be read.");
  // probe.hasAudio is false when WebCodecs can't decode the track; decoding and export fall back to ffmpeg.wasm then.
  const info = { ...probe, hasAudio: probe.hasAudio || !!probe.audioCodec };
  return { file: blob, info, converted, audioFallback: !probe.hasAudio && !!probe.audioCodec };
}

async function decodeRange(file: Blob, start: number, end: number, onProgress: (f: number) => void): Promise<Float32Array> {
  try {
    const res = await runMediaTask({ task: "pcm", file, start, end }, "pcm", (m) => {
      if (m.type === "progress") onProgress(m.value as number);
    });
    return res.pcm as Float32Array;
  } catch (e) {
    console.warn("WebCodecs audio decode failed, falling back to ffmpeg.wasm", e);
    const { decodeAudioPcm } = await import("../browser/convert");
    const [pcm] = await decodeAudioPcm(file, { rate: 16000, channels: 1, start, duration: end - start });
    return pcm;
  }
}

function runWorker<T>(make: () => Worker, message: unknown, transfer: Transferable[], onProgress: (value: number, detail?: string) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = make();
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.value, m.detail);
      else if (m.type === "done") {
        worker.terminate();
        resolve(m as T);
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Worker crashed"));
    };
    worker.postMessage(message, transfer);
  });
}

async function translateLocal(lines: string[], onStatus: Status): Promise<string[]> {
  const res = await runWorker<{ translations: string[] }>(
    () => new Worker(new URL("../browser/translate.worker.ts", import.meta.url), { type: "module" }),
    { lines },
    [],
    (v, d) => onStatus(d ?? "Translating…", v),
  );
  return res.translations;
}

const CLOUD_BATCH = 40;

/** Translate Japanese lines to English: cloud GPT when the server allows it, otherwise an on-device model. */
export async function translateToEnglish(lines: string[], onStatus: Status): Promise<{ translations: string[]; provider: "cloud" | "browser"; note?: string }> {
  const out = lines.map(() => "");
  let note: string | undefined;
  let usedCloud = false;
  const caps = await serverCaps();
  if (caps.cloudAI) {
    for (let i = 0; i < lines.length; i += CLOUD_BATCH) {
      onStatus("Translating with cloud AI (text only)…", i / lines.length);
      const batch = lines.slice(i, i + CLOUD_BATCH);
      try {
        const res = await fetch("/api/ai/translate", { method: "POST", headers: aiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ lines: batch }) });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          note = `Cloud translation unavailable (${d.error ?? res.status}) — used the on-device model instead.`;
          break;
        }
        const d = (await res.json()) as { translations: string[] };
        d.translations.forEach((t, j) => (out[i + j] = t));
        usedCloud = true;
      } catch {
        note = "Cloud translation failed — used the on-device model instead.";
        break;
      }
    }
  }
  const missing = out.map((t, i) => (t.trim() ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const local = await translateLocal(
      missing.map((i) => lines[i]),
      onStatus,
    );
    missing.forEach((i, j) => (out[i] = local[j] ?? ""));
  }
  return { translations: out, provider: usedCloud && !missing.length ? "cloud" : "browser", note };
}

export interface GenerateOptions {
  file: Blob;
  start: number;
  end: number;
  whisperModel: AnimeWhisperModel;
  onStatus: Status;
}

export interface GenerateResult {
  subtitles: AnimeSubtitle[];
  translationProvider: "cloud" | "browser";
  warnings: string[];
}

/**
 * Japanese speech -> timestamped subtitles with furigana and an English translation:
 * decode the clip's audio -> Whisper (Japanese) -> sentence segmentation -> translate -> furigana.
 */
export async function generateSubtitles(o: GenerateOptions): Promise<GenerateResult> {
  const warnings: string[] = [];
  const stage = (label: string, from: number, to: number): Status => (detail, p) => o.onStatus(detail || label, p === undefined ? undefined : from + (to - from) * p);

  o.onStatus("Decoding audio…", 0);
  const pcm = await decodeRange(o.file, o.start, o.end, (f) => o.onStatus("Decoding audio…", f * 0.05));
  if (pcm.length < 16000 * 0.5) throw new Error("No audio found in the selected range.");

  const words = await runWorker<{ words: { text: string; start: number; end: number }[] }>(
    () => new Worker(new URL("../browser/whisper.worker.ts", import.meta.url), { type: "module" }),
    { pcm, model: ANIME_WHISPER_MODELS[o.whisperModel].id, language: "japanese" },
    [pcm.buffer],
    (v, d) => stage("Recognising Japanese speech…", 0.05, 0.55)(d ?? "Recognising Japanese speech…", v),
  );
  const lines = segmentJapanese(normalizeWords(words.words).map((w) => ({ ...w, start: w.start + o.start, end: w.end + o.start })));
  if (!lines.length) throw new Error("No Japanese speech was recognised in this range. Try the Accurate model or a different range.");

  const tr = await translateToEnglish(
    lines.map((l) => l.text),
    stage("Translating to English…", 0.55, 0.9),
  );
  if (tr.note) warnings.push(tr.note);

  o.onStatus("Adding furigana…", 0.9);
  const subtitles: AnimeSubtitle[] = [];
  for (let i = 0; i < lines.length; i++) {
    subtitles.push({ id: newSubtitleId(), start: lines[i].start, end: lines[i].end, ja: await annotateFurigana(lines[i].text), en: tr.translations[i] ?? "" });
    o.onStatus("Adding furigana…", 0.9 + 0.1 * ((i + 1) / lines.length));
  }
  return { subtitles, translationProvider: tr.provider, warnings };
}

/** Render the final 1080×1920 MP4 in a worker (WebCodecs) and return it. */
export async function exportAnimeVideo(
  o: { file: Blob; start: number; end: number; subtitles: AnimeSubtitle[]; layout: SubtitleLayout; background: BackgroundMode; hasAudio: boolean; audioFallback: boolean },
  onProgress: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const decodeExternal = async () => {
    const { decodeAudioPcm } = await import("../browser/convert");
    const channels = await decodeAudioPcm(o.file, { rate: 48000, channels: 2, start: o.start, duration: o.end - o.start });
    return { channels, sampleRate: 48000 };
  };
  const run = (audio?: { channels: Float32Array[]; sampleRate: number }) =>
    runMediaTask(
      { task: "anime-export", file: o.file, start: o.start, end: o.end, width: 1080, height: 1920, layout: o.layout, background: o.background, subtitles: o.subtitles, audio },
      "export",
      (m) => {
        if (m.type === "progress") onProgress(m.value as number);
      },
      signal,
    );
  // Mediabunny silently drops an audio track it can't decode, so decode it with ffmpeg.wasm up front.
  if (o.hasAudio && o.audioFallback) return (await run(await decodeExternal())).blob as Blob;
  try {
    return (await run()).blob as Blob;
  } catch (e) {
    const cannotEncode = e instanceof Error && /cannot encode/i.test(e.message);
    if (!o.hasAudio || cannotEncode || (e instanceof DOMException && e.name === "AbortError")) throw e;
    return (await run(await decodeExternal())).blob as Blob;
  }
}
