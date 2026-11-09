import { NextResponse } from "next/server";
import { aiTranslateLines, PROMPT_OVERHEAD_CHARS, TRANSLATE_MAX_OUTPUT } from "@/lib/server/ai";
import { admit, estimateTokens, tooLarge } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Optional cloud translation of Japanese subtitle lines (text only) for Anime Clipper. */
export async function POST(req: Request) {
  const big = tooLarge(req, 200_000);
  if (big) return big;
  const body = (await req.json().catch(() => null)) as { lines?: unknown[]; readings?: boolean } | null;
  const lines = (body?.lines ?? []).slice(0, 60).map((l) => String(l ?? "").slice(0, 300));
  if (!lines.length) return NextResponse.json({ translations: [] });
  const readings = body?.readings === true;
  const chars = lines.reduce((n, l) => n + l.length + 20, 0) + PROMPT_OVERHEAD_CHARS;

  const lease = admit(req, "translate", { tokens: estimateTokens(chars, readings ? TRANSLATE_MAX_OUTPUT * 2 : TRANSLATE_MAX_OUTPUT) });
  if (lease instanceof NextResponse) return lease;
  const usage = { tokens: 0 };
  try {
    const { en, ruby } = await aiTranslateLines(lines, usage, readings);
    lease.settle({ tokens: usage.tokens });
    return NextResponse.json(readings ? { translations: en, ruby } : { translations: en });
  } catch (e) {
    lease.settle({ tokens: usage.tokens });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  } finally {
    lease.release();
  }
}
