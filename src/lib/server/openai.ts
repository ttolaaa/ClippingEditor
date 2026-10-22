import OpenAI from "openai";
import { config } from "./config";

let client: OpenAI | null | undefined;

export function getOpenAI(): OpenAI | null {
  if (client !== undefined) return client;
  client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey, baseURL: config.openaiBaseUrl }) : null;
  return client;
}

export interface UsageSink {
  tokens: number;
}

export async function chatJSON<T>(system: string, user: string, maxTokens = 3000, usage?: UsageSink): Promise<T | null> {
  const c = getOpenAI();
  if (!c) return null;
  const res = await c.chat.completions.create({
    model: config.openaiModel,
    temperature: 0.4,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  if (usage && res.usage) usage.tokens += res.usage.total_tokens;
  const text = res.choices[0]?.message?.content;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
