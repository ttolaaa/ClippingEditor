import { NextResponse } from "next/server";
import { aiMomentsForChunk, MOMENTS_MAX_OUTPUT, PROMPT_OVERHEAD_CHARS } from "@/lib/server/ai";
import { admit, estimateTokens, tooLarge } from "@/lib/server/guard";
import type { TranscriptSegment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRANSCRIPT_CHARS = 45_000; // matches the prompt truncation in aiMomentsForChunk

export async function POST(req: Request) {
  const big = tooLarge(req, 1_000_000);
  if (big) return big;
  const body = (await req.json().catch(() => null)) as { segments?: TranscriptSegment[]; duration?: number; instructions?: string } | null;
  const segments = (body?.segments ?? [])
    .slice(0, 3000)
    .map((s) => ({ text: String(s.text ?? "").slice(0, 500), start: Number(s.start) || 0, end: Number(s.end) || 0 }));
  if (!segments.length) return NextResponse.json({ moments: [], twists: [], summary: "" });
  const instructions = String(body?.instructions ?? "").slice(0, 1000);
  const chars = Math.min(MAX_TRANSCRIPT_CHARS, segments.reduce((n, s) => n + s.text.length + 16, 0)) + instructions.length + PROMPT_OVERHEAD_CHARS;

  const lease = admit(req, "moments", { tokens: estimateTokens(chars, MOMENTS_MAX_OUTPUT) });
  if (lease instanceof NextResponse) return lease;
  const usage = { tokens: 0 };
  try {
    const result = await aiMomentsForChunk(segments, Number(body?.duration) || 0, instructions, usage);
    lease.settle({ tokens: usage.tokens });
    return NextResponse.json(result);
  } catch (e) {
    lease.settle({ tokens: usage.tokens });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  } finally {
    lease.release();
  }
}
