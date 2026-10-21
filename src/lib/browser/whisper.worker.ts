/// <reference lib="webworker" />
/**
 * In-browser speech recognition (Whisper via transformers.js / ONNX Runtime Web).
 * The model is downloaded once from Hugging Face and cached by the browser; audio never leaves the device.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

declare const self: DedicatedWorkerGlobalScope;

export interface WhisperRequest {
  pcm: Float32Array; // 16 kHz mono
  model: string;
  language?: string;
}

const RATE = 16000;
const PIECE = 60;

env.allowLocalModels = false;
env.useBrowserCache = true;

const post = (m: unknown) => self.postMessage(m);
let cached: { model: string; asr: AutomaticSpeechRecognitionPipeline } | null = null;

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
  const { pcm, model, language } = e.data;
  try {
    if (!cached || cached.model !== model) {
      post({ type: "progress", value: 0, detail: "Loading speech model (first run downloads it once)…" });
      let lastDl = 0;
      const asr = (await pipeline("automatic-speech-recognition", model, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p: { status: string; progress?: number; file?: string; total?: number }) => {
          if (p.status === "progress" && (p.total ?? 0) > 1e6 && Date.now() - lastDl > 400) {
            lastDl = Date.now();
            post({ type: "progress", value: 0, detail: `Downloading speech model ${Math.round(p.progress ?? 0)}%` });
          }
        },
      })) as AutomaticSpeechRecognitionPipeline;
      cached = { model, asr };
    }
    const threads = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) >> 1)) : 1;
    post({ type: "engine", value: `WASM · ${threads} thread${threads > 1 ? "s" : ""}` });
    const words: { text: string; start: number; end: number }[] = [];
    let start = 0;
    while (start < pcm.length) {
      let end = Math.min(pcm.length, start + PIECE * RATE);
      if (end < pcm.length) end = quietest(pcm, end, 4 * RATE);
      const piece = pcm.subarray(start, end);
      const offset = start / RATE;
      const opts: Record<string, unknown> = { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 };
      if (language) {
        opts.language = language;
        opts.task = "transcribe";
      }
      const res = (await cached.asr(piece, opts)) as { chunks?: { text: string; timestamp: [number | null, number | null] }[] };
      for (const c of res.chunks ?? []) {
        const text = String(c.text ?? "").trim();
        if (!text) continue;
        const [s, en] = c.timestamp ?? [null, null];
        const ws = offset + (Number.isFinite(s) ? (s as number) : 0);
        const we = offset + (Number.isFinite(en) ? (en as number) : Number.isFinite(s) ? (s as number) + 0.3 : piece.length / RATE);
        words.push({ text, start: ws, end: Math.max(ws + 0.05, we) });
      }
      start = end;
      post({ type: "progress", value: Math.min(0.999, start / pcm.length), detail: `Transcribed ${Math.round(start / RATE)}s of ${Math.round(pcm.length / RATE)}s` });
    }
    post({ type: "done", words });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
