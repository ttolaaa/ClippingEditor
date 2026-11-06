/// <reference lib="webworker" />
/**
 * In-browser speech recognition (Whisper via transformers.js / ONNX Runtime Web).
 * The model is downloaded once from Hugging Face and cached by the browser; audio never leaves the device.
 */
import { AutoModel, Tensor, env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { downloadTracker, withRetry } from "./model-loading";
import { cleanWindow, collapseRepeats, maxTokensFor } from "../engine/hallucination";

declare const self: DedicatedWorkerGlobalScope;

export interface WhisperRequest {
  pcm: Float32Array; // 16 kHz mono
  model: string;
  language?: string;
  /** Only transcribe detected speech (Silero VAD). Prevents hallucinated text over music/silence. */
  vad?: boolean;
}

const RATE = 16000;
const PIECE = 30;

env.allowLocalModels = false;
env.useBrowserCache = true;

const post = (m: unknown) => self.postMessage(m);
type Engine = "webgpu" | "wasm";
let cached: { model: string; engine: Engine; asr: AutomaticSpeechRecognitionPipeline } | null = null;

/** A real (non-software) GPU adapter, or null. Software adapters are slower than multi-threaded WASM. */
async function gpuAdapter(): Promise<{ info?: { vendor?: string; description?: string; isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<unknown> } }).gpu;
    if (!gpu) return null;
    const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" })) as Awaited<ReturnType<typeof gpuAdapter>>;
    if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return null;
    const id = `${adapter.info?.vendor ?? ""} ${adapter.info?.description ?? ""}`;
    if (/swiftshader|llvmpipe|software|basic render/i.test(id)) return null;
    // Measured: on integrated Intel graphics Whisper is no faster than multi-threaded WASM and needs a second, larger
    // model download (fp32 encoder). Use the GPU only where it clearly wins.
    if (!/nvidia|amd|ati|apple|qualcomm/i.test(id)) return null;
    return adapter;
  } catch {
    return null;
  }
}

/**
 * Load Whisper on the GPU (WebGPU: fp32 encoder + 4-bit decoder, the combination recommended for Whisper) when available,
 * otherwise on the CPU (multi-threaded WASM, 8-bit). Returns the engine in use.
 */
async function load(model: string, forceWasm = false): Promise<Engine> {
  const want: Engine = !forceWasm && (await gpuAdapter()) ? "webgpu" : "wasm";
  if (cached && cached.model === model && cached.engine === want) return want;
  post({ type: "progress", value: 0, detail: "Loading speech model (first run downloads it once)…" });
  const progress_callback = downloadTracker((pct) =>
    post({ type: "progress", value: 0, detail: `Loading speech model ${pct}% (downloaded once, then cached)` }),
  );
  const retry = (n: number) => post({ type: "progress", value: 0, detail: `Network problem while downloading the speech model — retrying (${n})…` });
  let engine: Engine = want;
  let asr: AutomaticSpeechRecognitionPipeline;
  // The large model is only practical 4-bit quantised (~720 MB instead of ~1.6 GB).
  const large = /large/.test(model);
  try {
    asr = await withRetry(
      async () =>
        (await pipeline("automatic-speech-recognition", model, {
          ...(want === "webgpu"
            ? { device: "webgpu", dtype: large ? { encoder_model: "q4", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q4" } }
            : { device: "wasm", dtype: large ? { encoder_model: "q4", decoder_model_merged: "q4" } : "q8" }),
          progress_callback,
        } as Record<string, unknown>)) as AutomaticSpeechRecognitionPipeline,
      retry,
    );
  } catch (err) {
    if (want !== "webgpu") throw err;
    console.warn("WebGPU speech model failed to load, using WASM", err);
    engine = "wasm";
    asr = await withRetry(
      async () =>
        (await pipeline("automatic-speech-recognition", model, {
          device: "wasm",
          dtype: large ? { encoder_model: "q4", decoder_model_merged: "q4" } : "q8",
          progress_callback,
        } as Record<string, unknown>)) as AutomaticSpeechRecognitionPipeline,
      retry,
    );
  }
  cached = { model, engine, asr };
  const threads = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) >> 1)) : 1;
  post({ type: "engine", value: engine === "webgpu" ? "WebGPU (GPU)" : `WASM · ${threads} thread${threads > 1 ? "s" : ""}` });
  post({ type: "progress", value: 0, detail: `Speech model ready on the ${engine === "webgpu" ? "GPU" : "CPU"} — recognising speech…` });
  return engine;
}

function quietest(audio: Float32Array, center: number, radius: number) {
  const win = Math.round(RATE * 0.1);
  let best = center;
  let bestE = Infinity;
  for (let s = Math.max(win, center - radius); s < Math.min(audio.length - win, center + radius); s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += audio[i] * audio[i];
    if (e < bestE) {
      bestE = e;
      best = s + (win >> 1);
    }
  }
  return best;
}

self.onmessage = async (e: MessageEvent<WhisperRequest>) => {
  const { pcm, model, language, vad } = e.data;
  try {
    const total = pcm.length / RATE;
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    // What to transcribe: only detected speech (VAD), or the whole audio in ~30 s pieces cut at quiet points.
    let spans: { s: number; e: number }[];
    if (vad) {
      spans = await speechWindows(pcm, (f) => post({ type: "progress", value: f * 0.08, detail: `Finding speech (skipping music & silence)… ${Math.round(f * 100)}%` }));
      const speech = spans.reduce((a, w) => a + w.e - w.s, 0);
      post({ type: "progress", value: 0.08, detail: `Speech found in ${fmt(speech)} of ${fmt(total)} — loading speech model…` });
    } else {
      spans = [];
      let start = 0;
      while (start < pcm.length) {
        let end = Math.min(pcm.length, start + PIECE * RATE);
        if (end < pcm.length) end = quietest(pcm, end, 4 * RATE);
        spans.push({ s: start / RATE, e: end / RATE });
        start = end;
      }
    }
    let engine = await load(model);
    const base = vad ? 0.08 : 0;
    const spanTotal = spans.reduce((a, w) => a + w.e - w.s, 0) || 1;
    let doneSec = 0;
    const words: { text: string; start: number; end: number }[] = [];
    for (const span of spans) {
      const piece = pcm.subarray(Math.floor(span.s * RATE), Math.ceil(span.e * RATE));
      const seconds = piece.length / RATE;
      post({
        type: "progress",
        value: Math.min(0.999, base + (1 - base) * (doneSec / spanTotal)),
        detail: vad ? `Recognising speech at ${fmt(span.s)} (${fmt(doneSec)} of ${fmt(spanTotal)} of speech)…` : `Recognising speech ${fmt(span.s)}–${fmt(span.e)} of ${fmt(total)}…`,
      });
      const opts: Record<string, unknown> = { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 };
      // Cap generated tokens to what can be spoken in this span, so a runaway loop can't produce pages of text.
      if (vad) opts.max_new_tokens = maxTokensFor(seconds);
      if (language) {
        opts.language = language;
        opts.task = "transcribe";
      }
      let res: { chunks?: { text: string; timestamp: [number | null, number | null] }[] };
      try {
        res = (await cached!.asr(piece, opts)) as typeof res;
      } catch (err) {
        // A GPU problem (driver, memory, unsupported op) must not lose the job: redo this piece on the CPU.
        if (engine !== "webgpu") throw err;
        console.warn("WebGPU speech recognition failed, switching to WASM", err);
        engine = await load(model, true);
        res = (await cached!.asr(piece, opts)) as typeof res;
      }
      const pieceWords: { text: string; start: number; end: number }[] = [];
      for (const c of res.chunks ?? []) {
        const raw = String(c.text ?? "");
        const trimmed = raw.trim();
        if (!trimmed) continue;
        // Keep Whisper's phrase boundary (a leading space) as an invisible marker for Japanese subtitle line breaks.
        const text = vad && pieceWords.length && /^\s/.test(raw) ? `\u200B${trimmed}` : trimmed;
        const [s, en] = c.timestamp ?? [null, null];
        const ws = span.s + Math.min(seconds, Number.isFinite(s) ? (s as number) : 0);
        const we = span.s + Math.min(seconds, Number.isFinite(en) ? (en as number) : Number.isFinite(s) ? (s as number) + 0.3 : seconds);
        pieceWords.push({ text, start: ws, end: Math.max(ws + 0.05, we) });
      }
      words.push(...(vad ? cleanWindow(pieceWords, seconds) : collapseRepeats(pieceWords)));
      doneSec += seconds;
    }
    post({ type: "done", words, speechSeconds: vad ? spanTotal : undefined });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

// ---------------------------------------------------------------- voice activity detection (Silero VAD)

const VAD_FRAME = 512; // 32 ms at 16 kHz
type VadModel = (inputs: Record<string, Tensor>) => Promise<{ output: Tensor; stateN: Tensor }>;
let vadModel: VadModel | null = null;

/**
 * Speech windows for Whisper: Silero VAD finds speech frames (robust to music), short gaps are bridged, each region is
 * padded, and neighbouring regions are grouped into windows of at most ~25 s. Whisper invents text for music and
 * silence, so it only ever sees these windows.
 */
async function speechWindows(pcm: Float32Array, onProgress: (f: number) => void): Promise<{ s: number; e: number }[]> {
  vadModel ??= (await withRetry(
    () => AutoModel.from_pretrained("onnx-community/silero-vad", { config: { model_type: "custom" }, dtype: "fp32", device: "wasm" } as never),
    () => undefined,
  )) as unknown as VadModel;
  const step = VAD_FRAME / RATE;
  const sr = new Tensor("int64", [BigInt(RATE)], []);
  let state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const regions: { s: number; e: number }[] = [];
  let cur: { s: number; e: number } | null = null;
  let quiet = 0;
  const frames = Math.floor(pcm.length / VAD_FRAME);
  let lastPost = 0;
  for (let i = 0; i < frames; i++) {
    const out = await vadModel({ input: new Tensor("float32", pcm.slice(i * VAD_FRAME, (i + 1) * VAD_FRAME), [1, VAD_FRAME]), sr, state });
    state = out.stateN;
    const p = (out.output.data as Float32Array)[0];
    const t = i * step;
    if (p >= 0.5) {
      if (!cur) cur = { s: t, e: t + step };
      else cur.e = t + step;
      quiet = 0;
    } else if (cur) {
      if (p < 0.35) quiet += step;
      if (quiet > 0.4) {
        regions.push(cur);
        cur = null;
        quiet = 0;
      } else cur.e = t + step;
    }
    if (performance.now() - lastPost > 250) {
      lastPost = performance.now();
      onProgress(i / frames);
    }
  }
  if (cur) regions.push(cur);
  const total = pcm.length / RATE;
  const padded = regions.filter((r) => r.e - r.s >= 0.25).map((r) => ({ s: Math.max(0, r.s - 0.25), e: Math.min(total, r.e + 0.3) }));
  const windows: { s: number; e: number }[] = [];
  for (const r of padded) {
    const w = windows[windows.length - 1];
    if (w && r.s - w.e <= 1.5 && r.e - w.s <= 25) w.e = Math.max(w.e, r.e);
    else windows.push({ ...r });
  }
  // A region longer than 25 s (continuous talking) is split into ≤25 s windows.
  return windows.flatMap((w) => {
    const parts: { s: number; e: number }[] = [];
    for (let s = w.s; s < w.e; s += 25) parts.push({ s, e: Math.min(w.e, s + 25) });
    return parts;
  });
}
