import { config } from "./config";
import { isExhausted, noteExhausted, noteRequest, quotaSnapshot } from "./gemini-quota";
import type { UsageSink } from "./openai";

/** Minimal Gemini API client (REST generateContent), used when GEMINI_API_KEY is set. */

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiOptions {
  system?: string;
  /** OpenAPI-style response schema; the reply is JSON text. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  usage?: UsageSink;
  /** Filled with the model that actually answered (main or fallback). */
  meta?: { model?: string };
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** Both Gemini models' daily quotas are used up: a clear message with when it's available again. */
function quotaError() {
  const resetsAt = Math.min(...[config.geminiModel, config.geminiFallbackModel].filter(Boolean).map((m) => quotaSnapshot(m).resetsAt));
  const hours = Math.max(0, (resetsAt - Date.now()) / 3_600_000);
  const when = hours >= 1 ? `about ${Math.round(hours)} h` : `about ${Math.max(1, Math.round(hours * 60))} min`;
  return new GeminiError(`Gemini's daily limit is used up — it's available again in ${when}. Until then the on-device model is used.`, 429);
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Call Gemini and parse its JSON reply. Retries rate limits, overload and network drops; after the first failure on the
 * main model it switches to the fallback model (GEMINI_FALLBACK_MODEL), because an overloaded model can take minutes.
 */
export async function geminiJSON<T>(parts: Part[], o: GeminiOptions = {}): Promise<T | null> {
  if (!config.geminiKey) return null;
  const body = JSON.stringify({
    ...(o.system ? { systemInstruction: { parts: [{ text: o.system }] } } : {}),
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: o.temperature ?? 0.2,
      maxOutputTokens: o.maxTokens ?? 8192,
      responseMimeType: "application/json",
      ...(o.schema ? { responseSchema: o.schema } : {}),
    },
  });
  const fallback = config.geminiFallbackModel && config.geminiFallbackModel !== config.geminiModel ? config.geminiFallbackModel : config.geminiModel;
  const plan = [config.geminiModel, fallback, fallback, config.geminiModel];
  let lastError: GeminiError | null = null;
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const model = plan[attempt];
    // A model whose daily quota is known to be used up is skipped until it resets (saves time and requests).
    if (isExhausted(model)) {
      if (plan.slice(attempt + 1).some((m) => !isExhausted(m))) continue;
      throw quotaError();
    }
    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey },
        body,
        signal: AbortSignal.timeout(attempt === 0 ? 120_000 : 180_000),
      });
    } catch (e) {
      // Network drop / timeout: retry (on the fallback model) like a transient server error.
      lastError = new GeminiError(`Couldn't get an answer from Gemini (${(e as Error).message})`, 503);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (res.status !== 429) noteRequest(model);
    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        usageMetadata?: { totalTokenCount?: number };
      };
      if (o.usage && data.usageMetadata?.totalTokenCount) o.usage.tokens += data.usageMetadata.totalTokenCount;
      if (o.meta) o.meta.model = model;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("");
      if (!text) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        // A reply cut off by the token limit: salvage nothing rather than return broken JSON.
        return null;
      }
    }
    const detail = await res.text().catch(() => "");
    const message = (() => {
      try {
        return (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        return detail;
      }
    })();
    lastError = new GeminiError(`Gemini ${res.status}: ${message.slice(0, 300)}`, res.status);
    // A used-up daily quota (free tier: e.g. 20 requests/day) won't recover by retrying: remember it until the reset
    // Google reports, and try the other model; if both are used up, say so clearly.
    if (res.status === 429 && /per day|PerDay|daily/i.test(detail)) {
      const delay = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(detail)?.[1]);
      noteExhausted(model, Number.isFinite(delay) ? delay : undefined);
      if (plan.slice(attempt + 1).some((m) => !isExhausted(m))) continue;
      throw quotaError();
    }
    if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    // Gemini reports the suggested wait in the error details ("retryDelay": "17s") for quota errors.
    const hinted = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(detail)?.[1]);
    const wait = Math.min(30, Number.isFinite(hinted) && hinted > 0 ? hinted + 1 : 2 * (attempt + 1));
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  throw lastError ?? new GeminiError("Gemini request failed", 502);
}
