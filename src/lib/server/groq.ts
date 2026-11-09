import { config } from "./config";
import { isExhausted, noteExhausted, noteRequest } from "./gemini-quota";
import type { UsageSink } from "./openai";

/** Minimal Groq client (OpenAI-compatible REST): Whisper speech-to-text and JSON chat, with daily-limit tracking. */

const BASE = "https://api.groq.com/openai/v1";

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(model: string, url: string, init: RequestInit): Promise<Response> {
  if (!config.groqKey) throw new GroqError("Groq is not configured", 501);
  if (isExhausted(model)) throw new GroqError(`Groq's daily limit for ${model} is used up`, 429);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${config.groqKey}` }, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      if (attempt >= 2) throw new GroqError(`Couldn't reach Groq (${(e as Error).message})`, 503);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      noteRequest(model);
      return res;
    }
    const detail = await res.text().catch(() => "");
    const retryAfter = Number(res.headers.get("retry-after"));
    if (res.status === 429) {
      // Per-day limits (requests, audio seconds or tokens per day) won't recover soon: remember until Groq's reset.
      if (/per day|\bRPD\b|\bASD\b|\bTPD\b/i.test(detail)) {
        noteExhausted(model, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
        throw new GroqError(`Groq's daily limit for ${model} is used up`, 429);
      }
      // Per-minute limits: wait as told, a few times.
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, Math.min(60, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter + 1 : 10) * 1000));
        continue;
      }
    }
    if ([500, 502, 503, 504].includes(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    noteRequest(model);
    throw new GroqError(`Groq ${res.status}: ${detail.slice(0, 300)}`, res.status);
  }
}

/** Japanese speech → words with times (seconds) via Groq Whisper. */
export async function groqTranscribe(wav: Uint8Array<ArrayBuffer>): Promise<{ text: string; start: number; end: number }[]> {
  const model = config.groqSpeechModel;
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", model);
  form.append("language", "ja");
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const res = await call(model, `${BASE}/audio/transcriptions`, { method: "POST", body: form });
  const data = (await res.json()) as { words?: { word: string; start: number; end: number }[]; segments?: { text: string; start: number; end: number }[] };
  if (data.words?.length) return data.words.map((w) => ({ text: w.word, start: w.start, end: w.end }));
  return (data.segments ?? []).map((s) => ({ text: s.text, start: s.start, end: s.end }));
}

/** JSON chat completion via Groq's text model. */
export async function groqJSON<T>(system: string, user: string, maxTokens = 3000, usage?: UsageSink): Promise<T | null> {
  const model = config.groqTextModel;
  const res = await call(model, `${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
  if (usage && data.usage?.total_tokens) usage.tokens += data.usage.total_tokens;
  const text = data.choices?.[0]?.message?.content ?? "";
  // Reasoning models may wrap the JSON in <think>…</think>; keep only the JSON object.
  const json = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try {
    return JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1)) as T;
  } catch {
    return null;
  }
}
