/// <reference lib="webworker" />
/**
 * In-browser Japanese -> English machine translation (Marian opus-mt-ja-en via transformers.js / ONNX Runtime Web).
 * Used when cloud AI isn't available; the model (~110 MB quantized) is downloaded once and cached by the browser.
 */
import { env, pipeline } from "@huggingface/transformers";

declare const self: DedicatedWorkerGlobalScope;

export interface TranslateRequest {
  lines: string[];
}

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL = "Xenova/opus-mt-ja-en";
const post = (m: unknown) => self.postMessage(m);

type Translator = (text: string, opts?: Record<string, unknown>) => Promise<{ translation_text: string }[]>;
let translator: Translator | null = null;

self.onmessage = async (e: MessageEvent<TranslateRequest>) => {
  try {
    if (!translator) {
      post({ type: "progress", value: 0, detail: "Loading translation model (first run downloads it once)…" });
      let lastDl = 0;
      translator = (await pipeline("translation", MODEL, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p: { status: string; progress?: number; total?: number }) => {
          if (p.status === "progress" && (p.total ?? 0) > 1e6 && Date.now() - lastDl > 400) {
            lastDl = Date.now();
            post({ type: "progress", value: 0, detail: `Downloading translation model ${Math.round(p.progress ?? 0)}%` });
          }
        },
      })) as unknown as Translator;
    }
    const { lines } = e.data;
    const translations: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      let out = "";
      if (text) {
        const res = await translator(text, { max_new_tokens: 160, num_beams: 2 });
        out = String(res?.[0]?.translation_text ?? "").trim();
      }
      translations.push(out);
      post({ type: "progress", value: (i + 1) / lines.length, detail: `Translated ${i + 1} of ${lines.length} lines` });
    }
    post({ type: "done", translations });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
