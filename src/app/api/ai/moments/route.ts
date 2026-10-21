import { NextResponse } from "next/server";
import { config } from "@/lib/server/config";
import { aiMomentsForChunk } from "@/lib/server/ai";
import type { TranscriptSegment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!config.openaiKey) return NextResponse.json({ error: "Cloud AI is not configured" }, { status: 501 });
  const body = (await req.json().catch(() => null)) as { segments?: TranscriptSegment[]; duration?: number } | null;
  const segments = (body?.segments ?? [])
    .slice(0, 3000)
    .map((s) => ({ text: String(s.text ?? "").slice(0, 500), start: Number(s.start) || 0, end: Number(s.end) || 0 }));
  if (!segments.length) return NextResponse.json({ moments: [], twists: [], summary: "" });
  try {
    return NextResponse.json(await aiMomentsForChunk(segments, Number(body?.duration) || 0));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
