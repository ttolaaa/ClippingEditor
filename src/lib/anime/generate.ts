"use client";

import { normalizeWords } from "../engine/transcript";
import { aiHeaders, serverCaps } from "../browser/pipeline";
import { runMediaTask, canPlayInVideoElement } from "../browser/workers";
import type { ProbeInfo } from "../browser/media.worker";
import { furiganaFromPairs } from "./furigana";
import { newSubtitleId, readableTiming, segmentJapanese } from "./subtitles";
import type { AnimeSubtitle, BackgroundMode, SubtitleLayout } from "./types";

export const ANIME_WHISPER_MODELS = {
  tiny: { id: "onnx-community/whisper-tiny_timestamped", label: "Fast", note: "~40 MB · rough Japanese" },
  base: { id: "onnx-community/whisper-base_timestamped", label: "Balanced", note: "~80 MB" },
  small: { id: "onnx-community/whisper-small_timestamped", label: "Accurate", note: "~250 MB · good Japanese, slower" },
  large: { id: "onnx-community/whisper-large-v3-turbo_timestamped", label: "Best (large)", note: "~720 MB · best Japanese, slowest" },
} as const;
export type AnimeWhisperModel = keyof typeof ANIME_WHISPER_MODELS;

/**
 * Auto mode quality presets: a quick model scans the whole video to find the clips, then the subtitles of the picked
 * clips are re-transcribed with an accurate model (only minutes of audio, so the slow model stays affordable).
 */
export const ANIME_QUALITY = {
  fast: { label: "Fast", scan: "tiny", subtitles: "base", note: "~120 MB · quickest, rougher subtitles" },
  balanced: { label: "Balanced", scan: "base", subtitles: "small", note: "~330 MB · accurate subtitles (recommended)" },
  best: { label: "Best", scan: "base", subtitles: "large", note: "~800 MB · large Whisper for the subtitles, slowest" },
  cloud: { label: "Cloud AI (Gemini)", scan: "base", subtitles: "cloud", note: "Most accurate · Gemini listens to the picked clips and translates them" },
} as const satisfies Record<string, { label: string; scan: Exclude<AnimeWhisperModel, "large">; subtitles: AnimeWhisperModel | "cloud"; note: string }>;
export type AnimeQuality = keyof typeof ANIME_QUALITY;

export type Status = (detail: string, progress?: number) => void;

/**
 * Transcribe Japanese in the given source ranges (seconds) with voice activity detection, one worker so the model loads
 * once. Returns words with absolute source times, cleaned of Whisper loops/phantom phrases.
 */
export async function transcribeRanges(
  file: Blob,
  ranges: { start: number; end: number }[],
  model: AnimeWhisperModel,
  onStatus: Status,
): Promise<{ text: string; start: number; end: number }[]> {
  const total = ranges.reduce((a, r) => a + r.end - r.start, 0) || 1;
  const worker = new Worker(new URL("../browser/whisper.worker.ts", import.meta.url), { type: "module" });
  const words: { text: string; start: number; end: number }[] = [];
  let done = 0;
  try {
    for (const r of ranges) {
      const share = (r.end - r.start) / total;
      const pcm = await decodeRange(file, r.start, r.end, (f) => onStatus("Decoding audio…", (done + f * 0.05 * share) / 1));
      const res = await new Promise<{ words: { text: string; start: number; end: number }[] }>((resolve, reject) => {
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === "progress") onStatus(m.detail ?? "Recognising Japanese speech…", done + share * (0.05 + 0.95 * m.value));
          else if (m.type === "done") resolve(m);
          else if (m.type === "error") reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || "Speech worker crashed"));
        worker.postMessage({ pcm, model: ANIME_WHISPER_MODELS[model].id, language: "japanese", vad: true }, [pcm.buffer]);
      });
      for (const w of res.words) words.push({ text: w.text, start: w.start + r.start, end: w.end + r.start });
      done += share;
    }
  } finally {
    worker.terminate();
  }
  return normalizeWords(words);
}

/** Merge padded clip ranges that overlap or nearly touch, so shared audio is transcribed once. */
export function mergeRanges(ranges: { start: number; end: number }[], pad: number, maxEnd: number) {
  const sorted = ranges.map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(maxEnd, r.end + pad) })).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 2) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

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

export async function decodeRange(file: Blob, start: number, end: number, onProgress: (f: number) => void): Promise<Float32Array> {
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

async function translateLocal(lines: string[], onStatus: Status): Promise<{ en: string[]; uncertain: boolean[] }> {
  onStatus("Preparing names for translation…", 0);
  const { protectNames, restoreNames } = await import("./names");
  const prepared: Awaited<ReturnType<typeof protectNames>>[] = [];
  for (const l of lines) prepared.push(await protectNames(l));
  const res = await runWorker<{ translations: string[]; uncertain?: boolean[] }>(
    () => new Worker(new URL("../browser/translate.worker.ts", import.meta.url), { type: "module" }),
    { lines: prepared.map((p) => p.text) },
    [],
    (v, d) => onStatus(d ?? "Translating…", v),
  );
  return { en: res.translations.map((en, i) => restoreNames(en, prepared[i].names)), uncertain: res.uncertain ?? lines.map(() => false) };
}

const CLOUD_BATCH = 40;

/** Translate Japanese lines to English: cloud GPT when the server allows it, otherwise an on-device model. */
export async function translateToEnglish(
  lines: string[],
  onStatus: Status,
): Promise<{ translations: string[]; uncertain: boolean[]; provider: "cloud" | "browser"; note?: string; fromCloud: boolean[]; ruby: ({ w: string; r: string }[] | undefined)[] }> {
  const out = lines.map(() => "");
  const ruby: ({ w: string; r: string }[] | undefined)[] = lines.map(() => undefined);
  const uncertain = lines.map(() => false);
  let note: string | undefined;
  let usedCloud = false;
  const caps = await serverCaps();
  if (caps.cloudAI) {
    for (let i = 0; i < lines.length; i += CLOUD_BATCH) {
      onStatus(`Translating with cloud AI${caps.aiModel ? ` (${caps.aiModel})` : ""}…`, i / lines.length);
      const batch = lines.slice(i, i + CLOUD_BATCH);
      try {
        const res = await fetch("/api/ai/translate", { method: "POST", headers: aiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ lines: batch, readings: true }) });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          note = `Cloud translation unavailable (${d.error ?? res.status}) — used the on-device model instead.`;
          break;
        }
        const d = (await res.json()) as { translations: string[]; ruby?: { w: string; r: string }[][] };
        d.translations.forEach((t, j) => (out[i + j] = t));
        d.ruby?.forEach((r, j) => (ruby[i + j] = r?.length ? r : undefined));
        usedCloud = true;
      } catch {
        note = "Cloud translation failed — used the on-device model instead.";
        break;
      }
    }
  }
  const fromCloud = out.map((t) => !!t.trim());
  const missing = out.map((t, i) => (t.trim() ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const local = await translateLocal(
      missing.map((i) => lines[i]),
      onStatus,
    );
    missing.forEach((i, j) => {
      out[i] = local.en[j] ?? "";
      uncertain[i] = local.uncertain[j] ?? !out[i];
    });
  }
  return { translations: out, uncertain, provider: usedCloud && !missing.length ? "cloud" : "browser", note, fromCloud, ruby };
}

/**
 * Why a subtitle line deserves a human check, or undefined. Signals: the translation needed a fallback or is empty,
 * the dictionary doesn't know some of the Japanese words (typical of mishearings), or the quick scan heard something
 * clearly different at the same moment.
 */
export async function reviewReason(
  line: { text: string; start: number; end: number },
  en: string,
  uncertainTranslation: boolean,
  scanWords?: { text: string; start: number; end: number }[],
): Promise<string | undefined> {
  const reasons: string[] = [];
  if (!en.trim()) reasons.push("no reliable English — please type it");
  else if (uncertainTranslation) reasons.push("translation was uncertain");
  try {
    const { unknownRatio } = await import("./furigana");
    if ((await unknownRatio(line.text)) > 0.2) reasons.push("some words may be misheard");
  } catch {
    // dictionary unavailable: skip this check
  }
  if (scanWords && !reasons.some((r) => r.includes("misheard"))) {
    const scan = scanWords
      .filter((w) => w.end > line.start - 0.5 && w.start < line.end + 0.5)
      .map((w) => w.text)
      .join("");
    if (similarity(scan, line.text) < 0.25) reasons.push("the two speech passes heard different words");
  }
  return reasons.length ? `Check: ${reasons.join("; ")}` : undefined;
}

/** Character-bigram Dice similarity of two Japanese strings (punctuation ignored), 0..1. */
export function similarity(a: string, b: string): number {
  const clean = (s: string) => s.replace(/[\s、。，．,.!！?？…・「」『』\u200B\u3000ー-]/g, "");
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return x === y ? 1 : 0;
  if (x.length < 2 || y.length < 2) return x.includes(y) || y.includes(x) ? 1 : 0;
  const gx = grams(x);
  const gy = grams(y);
  let common = 0;
  for (const [g, n] of gx) common += Math.min(n, gy.get(g) ?? 0);
  return (2 * common) / (x.length - 1 + y.length - 1);
}

export interface GenerateOptions {
  file: Blob;
  start: number;
  end: number;
  whisperModel: AnimeWhisperModel | "cloud";
  onStatus: Status;
  /** Video name, given to the cloud model as context. */
  title?: string;
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

  let lines: { start: number; end: number; text: string }[] = [];
  let cloudEn: string[] | null = null;
  let readings: ({ w: string; r: string }[] | undefined)[] = [];
  let retimed: boolean[] = [];
  if (o.whisperModel === "cloud") {
    try {
      const { transcribeCloudJapanese } = await import("./cloud-speech");
      const heard = await transcribeCloudJapanese(o.file, [{ start: o.start, end: o.end }], stage("Cloud AI is listening…", 0, 0.85), o.title);
      lines = heard;
      cloudEn = heard.map((l) => l.en);
      readings = heard.map((l) => l.ruby);
      retimed = heard.map((l) => !!l.retimed);
    } catch (e) {
      warnings.push(`Cloud AI failed (${(e as Error).message.slice(0, 160)}), so the on-device Accurate model was used instead.`);
    }
  }
  if (!cloudEn) {
    const model = o.whisperModel === "cloud" ? "small" : o.whisperModel;
    lines = segmentJapanese(await transcribeRanges(o.file, [{ start: o.start, end: o.end }], model, stage("Recognising Japanese speech…", 0, 0.55)));
  }
  if (!lines.length) throw new Error("No Japanese speech was recognised in this range. Try the Accurate model or a different range.");

  let tr: { translations: string[]; uncertain: boolean[]; provider: "cloud" | "browser"; note?: string; fromCloud: boolean[] } = {
    translations: cloudEn ?? lines.map(() => ""),
    uncertain: lines.map((_, i) => !cloudEn?.[i]),
    provider: cloudEn ? "cloud" : "browser",
    fromCloud: lines.map((_, i) => !!cloudEn?.[i]),
  };
  const missing = lines.map((_, i) => i).filter((i) => !tr.translations[i]?.trim());
  try {
    if (missing.length) {
      const more = await translateToEnglish(
        missing.map((i) => lines[i].text),
        stage("Translating to English…", cloudEn ? 0.85 : 0.55, 0.9),
      );
      missing.forEach((i, j) => {
        tr.translations[i] = more.translations[j] ?? "";
        tr.uncertain[i] = more.uncertain[j] ?? !tr.translations[i];
        tr.fromCloud[i] = more.fromCloud[j] ?? false;
        readings[i] ??= more.ruby[j];
      });
      if (!cloudEn) tr = { ...tr, provider: more.provider };
      if (more.note) warnings.push(more.note);
    }
  } catch (e) {
    // Keep the recognised Japanese even if the translation model can't be loaded (e.g. a network failure).
    console.error("Translation failed", e);
    warnings.push(`English translation failed (${(e as Error).message.slice(0, 120)}). The Japanese subtitles were kept; type the English or press Generate again.`);
  }

  o.onStatus("Adding furigana…", 0.9);
  const subtitles: AnimeSubtitle[] = [];
  let furiganaFailed = false;
  for (let i = 0; i < lines.length; i++) {
    let ja: AnimeSubtitle["ja"] = [{ text: lines[i].text }];
    if (!furiganaFailed) {
      try {
        ja = await furiganaFromPairs(lines[i].text, readings[i]);
      } catch (e) {
        furiganaFailed = true;
        warnings.push(`Furigana could not be added (${(e as Error).message.slice(0, 120)}). Use "Auto furigana" on a line to try again.`);
      }
    }
    const en = tr.translations[i] ?? "";
    // Cloud lines: the model heard the audio itself, so only flag missing English; on-device lines get the full check.
    let review = tr.fromCloud[i] ? (en ? undefined : "Check: no reliable English — please type it") : await reviewReason(lines[i], en, tr.uncertain[i] ?? false);
    if (retimed[i]) review = review ? `${review}; timing was estimated — check when it appears` : "Check: timing was estimated — check when it appears";
    subtitles.push({ id: newSubtitleId(), start: lines[i].start, end: lines[i].end, ja, en, enSource: tr.fromCloud[i] ? "cloud" : "machine", ...(review ? { review } : {}) });
    o.onStatus("Adding furigana…", 0.9 + 0.1 * ((i + 1) / lines.length));
  }
  return { subtitles: readableTiming(subtitles), translationProvider: tr.provider, warnings };
}

/** Render the final 1080×1920 MP4 in a worker (WebCodecs) and return it. */
export async function exportAnimeVideo(
  o: { file: Blob; start: number; end: number; subtitles: AnimeSubtitle[]; layout: SubtitleLayout; background: BackgroundMode; romaji?: boolean; fontScale?: number; hasAudio: boolean; audioFallback: boolean },
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
      { task: "anime-export", file: o.file, start: o.start, end: o.end, width: 1080, height: 1920, layout: o.layout, background: o.background, romaji: o.romaji, fontScale: o.fontScale, subtitles: o.subtitles, audio },
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
