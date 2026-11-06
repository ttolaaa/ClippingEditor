/// <reference lib="webworker" />
/**
 * In-browser Japanese -> English machine translation (Marian opus-mt-ja-en via transformers.js / ONNX Runtime Web).
 * Used when cloud AI isn't available; the model (~110 MB quantized) is downloaded once and cached by the browser.
 */
import { env, pipeline } from "@huggingface/transformers";
import { downloadTracker, withRetry } from "./model-loading";
import { normalizeForTranslation } from "../anime/normalize";
import { fixedTranslation, generationOptions, looksBroken, repeatedUnit, tidyEnglish } from "../anime/translate-guard";

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
      const progress_callback = downloadTracker((pct) =>
        post({ type: "progress", value: 0, detail: `Loading translation model ${pct}% (downloaded once, then cached)` }),
      );
      translator = await withRetry(
        async () => (await pipeline("translation", MODEL, { dtype: "q8", device: "wasm", progress_callback } as Record<string, unknown>)) as unknown as Translator,
        (n) => post({ type: "progress", value: 0, detail: `Network problem while downloading the translation model — retrying (${n})…` }),
      );
    }
    const { lines } = e.data;
    const translations: string[] = [];
    const uncertain: boolean[] = [];
    const run = async (ja: string, strict = false) =>
      tidyEnglish(String((await translator!(normalizeForTranslation(ja), generationOptions(ja, strict)))?.[0]?.translation_text ?? ""));
    for (let i = 0; i < lines.length; i++) {
      const r = await translateLine(lines[i].trim(), run);
      translations.push(r.en);
      uncertain.push(r.uncertain);
      post({ type: "progress", value: (i + 1) / lines.length, detail: `Translated ${i + 1} of ${lines.length} lines` });
    }
    post({ type: "done", translations, uncertain });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

/**
 * One subtitle line: fixed phrases first, repeated phrases translated once, dialect normalised (inside `run`), and any
 * broken output retried with strict settings, then split at commas — or left empty rather than shown wrong.
 * `uncertain` marks lines that needed a fallback, so the editor can ask a person to check them.
 */
async function translateLine(ja: string, run: (ja: string, strict?: boolean) => Promise<string>): Promise<{ en: string; uncertain: boolean }> {
  if (!ja) return { en: "", uncertain: false };
  const fixed = fixedTranslation(ja);
  if (fixed) return { en: fixed, uncertain: false };
  const rep = repeatedUnit(ja);
  if (rep) {
    const one = fixedTranslation(rep.unit) ?? (await run(rep.unit));
    if (!looksBroken(rep.unit, one))
      return { en: Array(Math.min(2, rep.times)).fill(one.replace(/[.!?…]$/, "")).join(", ") + (/[?？]/.test(ja) ? "?" : "!"), uncertain: false };
  }
  let en = await run(ja);
  if (!looksBroken(ja, en)) return { en, uncertain: false };
  en = await run(ja, true);
  if (!looksBroken(ja, en)) return { en, uncertain: true };
  // Last resort: translate comma-separated parts on their own and join them.
  const parts = ja.split(/[、\u3000]/).filter((p) => p.trim());
  if (parts.length > 1) {
    const out: string[] = [];
    for (const p of parts) {
      const t = fixedTranslation(p) ?? (await run(p, true));
      if (looksBroken(p, t)) return { en: "", uncertain: true };
      out.push(t.replace(/[.]$/, ""));
    }
    return { en: out.join(", ") + (/[?？]\s*$/.test(ja) ? "?" : "."), uncertain: true };
  }
  return { en: "", uncertain: true };
}
