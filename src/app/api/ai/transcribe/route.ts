import { NextResponse } from "next/server";
import { toFile } from "openai";
import { config } from "@/lib/server/config";
import { getOpenAI } from "@/lib/server/openai";
import { admit, tooLarge } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 24 * 1024 * 1024; // ~12.5 min of 16 kHz mono 16-bit WAV
const BYTES_PER_MINUTE = 16000 * 2 * 60;

/** Optional cloud transcription: the browser sends one ≤10 min 16 kHz WAV chunk, we relay it to Whisper. */
export async function POST(req: Request) {
  const big = tooLarge(req, MAX_BYTES);
  if (big) return big;
  const declared = Number(req.headers.get("content-length") || 0);
  // Reserve audio minutes before reading the body so oversized/rapid uploads are refused cheaply.
  const lease = admit(req, "transcribe", { audioMin: Math.max(0.1, (declared || MAX_BYTES) / BYTES_PER_MINUTE) });
  if (lease instanceof NextResponse) return lease;
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      lease.settle({ audioMin: 0 });
      return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
    }
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      lease.settle({ audioMin: 0 });
      return NextResponse.json({ error: "Expected a WAV audio chunk" }, { status: 400 });
    }
    lease.settle({ audioMin: (buf.length - 44) / BYTES_PER_MINUTE });
    const language = new URL(req.url).searchParams.get("language") || undefined;
    const res = (await getOpenAI()!.audio.transcriptions.create({
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
  } finally {
    lease.release();
  }
}
