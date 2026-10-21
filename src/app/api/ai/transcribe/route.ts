import { NextResponse } from "next/server";
import { toFile } from "openai";
import { config } from "@/lib/server/config";
import { getOpenAI } from "@/lib/server/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Optional cloud transcription: the browser sends one ≤10 min 16 kHz WAV chunk, we relay it to Whisper. */
export async function POST(req: Request) {
  const client = getOpenAI();
  if (!client) return NextResponse.json({ error: "Cloud transcription is not configured" }, { status: 501 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > 24 * 1024 * 1024) return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
  const language = new URL(req.url).searchParams.get("language") || undefined;
  try {
    const res = (await client.audio.transcriptions.create({
      file: await toFile(buf, "chunk.wav", { type: "audio/wav" }),
      model: config.openaiTranscribeModel,
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      ...(language && /^[a-z]{2}$/.test(language) ? { language } : {}),
    })) as unknown as { words?: { word: string; start: number; end: number }[]; segments?: { text: string; start: number; end: number }[] };
    return NextResponse.json({
      words: (res.words ?? []).map((w) => ({ text: w.word, start: w.start, end: w.end })),
      segments: (res.segments ?? []).map((s) => ({ text: s.text, start: s.start, end: s.end })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
