/// <reference lib="webworker" />
/**
 * Media worker: all heavy video/audio work runs here, off the main thread, using Mediabunny (WebCodecs).
 * Tasks: probe, analyze (audio → 16 kHz PCM + loudness features, visual → motion / cuts / subject tracking),
 * thumbs (9:16 poster frames) and export (1080×1920 H.264/AAC MP4 with burned-in captions).
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  canEncodeAudio,
  canEncodeVideo,
  type VideoSample,
} from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";
import { AUDIO_RATE, Resampler16k, VisualAnalyzer, analyzeAudio } from "../engine/signals";
import { drawReelFrame, type FrameSource } from "../engine/renderer";
import type { CaptionLine, CaptionStyle, CropPath, ReframeMode } from "../types";

declare const self: DedicatedWorkerGlobalScope;

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

export type WorkerRequest =
  | { task: "probe"; file: Blob }
  | { task: "analyze"; file: Blob; info: ProbeInfo }
  | { task: "thumbs"; file: Blob; width: number; height: number; items: { key: string; time: number; rel: number; crop: CropPath; mode: ReframeMode }[] }
  | {
      task: "export";
      file: Blob;
      start: number;
      end: number;
      width: number;
      height: number;
      mode: ReframeMode;
      crop: CropPath;
      captions: CaptionLine[];
      style: CaptionStyle;
      /** Pre-decoded clip audio (used when WebCodecs can't decode the source audio). */
      audio?: { channels: Float32Array[]; sampleRate: number };
    };

const post = (msg: unknown, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

function open(file: Blob) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

async function probe(file: Blob): Promise<ProbeInfo | { unsupported: string }> {
  const input = open(file);
  try {
    try {
      await input.getFormat();
    } catch {
      return { unsupported: "container" };
    }
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error("No video track found in this file.");
    if (!(await vt.canDecode())) return { unsupported: `video codec ${vt.codec ?? "unknown"}` };
    const duration = await input.computeDuration();
    const stats = await vt.computePacketStats(120).catch(() => null);
    const at = await input.getPrimaryAudioTrack();
    const hasAudio = !!at && (await at.canDecode());
    return {
      duration,
      width: vt.displayWidth,
      height: vt.displayHeight,
      fps: stats?.averagePacketRate && isFinite(stats.averagePacketRate) ? stats.averagePacketRate : 30,
      hasAudio,
      videoCodec: vt.codec,
      audioCodec: at?.codec ?? null,
    };
  } finally {
    input.dispose();
  }
}

async function analyze(file: Blob, info: ProbeInfo) {
  const input = open(file);
  try {
    // ---- audio (non-fatal: some browsers report AAC as supported but fail to decode it)
    if (info.hasAudio) {
      try {
        const at = (await input.getPrimaryAudioTrack())!;
        const sink = new AudioSampleSink(at);
        const rs = new Resampler16k(at.sampleRate);
        let lastPost = 0;
        for await (const s of sink.samples()) {
          const n = s.numberOfFrames;
          const ch = s.numberOfChannels;
          const mono = new Float32Array(n);
          const tmp = new Float32Array(n);
          for (let c = 0; c < ch; c++) {
            s.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
            for (let i = 0; i < n; i++) mono[i] += tmp[i];
          }
          if (ch > 1) for (let i = 0; i < n; i++) mono[i] /= ch;
          const ts = s.timestamp;
          s.close();
          rs.push(mono);
          const now = performance.now();
          if (now - lastPost > 150) {
            lastPost = now;
            post({ type: "progress", stage: "audio", value: Math.min(0.99, ts / Math.max(1, info.duration)) });
          }
        }
        const pcm = rs.result();
        const signal = analyzeAudio(pcm);
        post({ type: "audio", pcm, signal, rate: AUDIO_RATE }, [pcm.buffer]);
      } catch (err) {
        post({ type: "audio-failed", message: err instanceof Error ? err.message : String(err) });
      }
    }

    // ---- visual (low-res frames, ~2 fps; adaptively sparser for long videos)
    const vt = (await input.getPrimaryVideoTrack())!;
    const fps = Math.max(0.5, Math.min(2, 1800 / Math.max(1, info.duration)));
    const aw = info.width >= info.height ? 160 : 96;
    const ah = Math.max(2, 2 * Math.round((aw * info.height) / info.width / 2));
    const analyzer = new VisualAnalyzer(aw, ah, info.width, info.height, fps);
    const count = Math.max(1, Math.floor(info.duration * fps));
    const stamps = Array.from({ length: count }, (_, i) => i / fps);
    const sink = new CanvasSink(vt, { width: aw, height: ah, fit: "fill", poolSize: 2 });
    let last: Uint8ClampedArray | null = null;
    let i = 0;
    let lastPost = 0;
    for await (const wc of sink.canvasesAtTimestamps(stamps)) {
      if (wc) {
        const ctx = (wc.canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
        last = ctx.getImageData(0, 0, aw, ah).data;
      }
      if (last) analyzer.push(last);
      i++;
      const now = performance.now();
      if (now - lastPost > 150) {
        lastPost = now;
        post({ type: "progress", stage: "visual", value: Math.min(0.99, i / count) });
      }
    }
    post({ type: "visual", signal: analyzer.finish() });
  } finally {
    input.dispose();
  }
}

function sampleSource(sample: VideoSample): FrameSource {
  return {
    width: sample.displayWidth,
    height: sample.displayHeight,
    draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => sample.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh),
  };
}

const noCaptions: CaptionStyle = {
  preset: "none",
  fontFamily: "Arial",
  fontSize: 10,
  textColor: "#ffffff",
  highlightColor: "#ffffff",
  outlineColor: "#000000",
  outlineWidth: 0,
  background: false,
  backgroundColor: "#000000",
  positionY: 50,
  uppercase: false,
  wordsPerLine: 1,
  highlightActiveWord: false,
  popAnimation: false,
  enabled: false,
};

async function thumbs(req: Extract<WorkerRequest, { task: "thumbs" }>) {
  const input = open(req.file);
  try {
    const vt = (await input.getPrimaryVideoTrack())!;
    const sink = new VideoSampleSink(vt);
    const canvas = new OffscreenCanvas(req.width, req.height);
    const ctx = canvas.getContext("2d")!;
    const results: { key: string; blob: Blob }[] = [];
    let i = 0;
    for await (const sample of sink.samplesAtTimestamps(req.items.map((it) => it.time))) {
      const item = req.items[i++];
      if (!sample) continue;
      drawReelFrame(ctx, req.width, req.height, sampleSource(sample), { mode: item.mode, crop: item.crop, captions: [], style: noCaptions, t: item.rel });
      sample.close();
      results.push({ key: item.key, blob: await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 }) });
      post({ type: "progress", stage: "thumbs", value: i / req.items.length });
    }
    post({ type: "thumbs", results });
  } finally {
    input.dispose();
  }
}

let aacReady: Promise<void> | null = null;
/** Verify AAC encoding with a real encode (isConfigSupported can lie); fall back to the WASM AAC encoder. */
function ensureAac() {
  aacReady ??= (async () => {
    let ok = false;
    try {
      if (await canEncodeAudio("aac")) {
        ok = await new Promise<boolean>((resolve) => {
          let got = false;
          const enc = new AudioEncoder({ output: () => (got = true), error: () => resolve(false) });
          enc.configure({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
          for (let i = 0; i < 4; i++)
            enc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 1024, timestamp: (i * 1024 * 1e6) / 48000, data: new Float32Array(2048) }));
          enc.flush().then(
            () => {
              enc.close();
              resolve(got);
            },
            () => resolve(false),
          );
        });
      }
    } catch {
      ok = false;
    }
    if (!ok) registerAacEncoder();
  })();
  return aacReady;
}

async function exportClip(req: Extract<WorkerRequest, { task: "export" }>) {
  await ensureAac();
  const input = open(req.file);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const W = req.width;
  const H = req.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  const avc = await canEncodeVideo("avc", { width: W, height: H });
  const external = req.audio;
  let first: number | null = null;
  const conversion = await Conversion.init({
    input,
    output,
    trim: { start: req.start, end: req.end },
    video: {
      frameRate: 30,
      ...(avc ? { codec: "avc" as const } : {}),
      bitrate: QUALITY_HIGH,
      processedWidth: W,
      processedHeight: H,
      process: (sample) => {
        if (first === null) first = sample.timestamp;
        // Timestamps may be reported relative to the trim start or to the source; handle both.
        const absolute = req.start > 0.25 && first >= req.start - 0.25;
        const t = absolute ? sample.timestamp - req.start : sample.timestamp;
        drawReelFrame(ctx, W, H, sampleSource(sample), { mode: req.mode, crop: req.crop, captions: req.captions, style: req.style, t });
        return canvas;
      },
    },
    audio: external ? { discard: true } : { codec: "aac", bitrate: 160_000 },
    composable: !!external,
  });
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(", ");
    throw new Error(`This browser cannot encode the reel (${reasons || "unknown reason"}).`);
  }
  let lastProgress = 0;
  conversion.onProgress = (p) => {
    const now = performance.now();
    if (now - lastProgress < 120 && p < 1) return;
    lastProgress = now;
    post({ type: "progress", stage: "export", value: p });
  };
  if (!external) {
    await conversion.execute();
  } else {
    // Audio decoded by ffmpeg.wasm on the main thread (WebCodecs couldn't decode it); encode it alongside the video.
    const source = new AudioSampleSource({ codec: "aac", bitrate: 160_000 });
    output.addAudioTrack(source);
    await output.start();
    const { channels, sampleRate } = external;
    const frames = channels[0]?.length ?? 0;
    const CHUNK = sampleRate; // 1 second per sample, stepped in lockstep with the video
    for (let off = 0; off < frames; off += CHUNK) {
      const n = Math.min(CHUNK, frames - off);
      const data = new Float32Array(n * channels.length);
      channels.forEach((ch, c) => data.set(ch.subarray(off, off + n), c * n));
      const sample = new AudioSample({ format: "f32-planar", sampleRate, numberOfChannels: channels.length, timestamp: off / sampleRate, data });
      await source.add(sample);
      sample.close();
      await conversion.execute({ until: (off + n) / sampleRate });
    }
    source.close();
    await conversion.execute();
    await output.finalize();
  }
  input.dispose();
  const buffer = output.target.buffer!;
  post({ type: "export", blob: new Blob([buffer], { type: "video/mp4" }) });
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.task === "probe") post({ type: "probe", result: await probe(req.file) });
    else if (req.task === "analyze") {
      await analyze(req.file, req.info);
      post({ type: "done" });
    } else if (req.task === "thumbs") await thumbs(req);
    else if (req.task === "export") await exportClip(req);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
