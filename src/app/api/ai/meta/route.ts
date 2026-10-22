import { NextResponse } from "next/server";
import { aiMetaFor, META_MAX_OUTPUT, PROMPT_OVERHEAD_CHARS, type MetaItem } from "@/lib/server/ai";
import { admit, estimateTokens, tooLarge } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const big = tooLarge(req, 500_000);
  if (big) return big;
  const body = (await req.json().catch(() => null)) as { items?: MetaItem[]; instructions?: string } | null;
  const items = (body?.items ?? []).slice(0, 60).map((i) => ({
    id: Number(i.id),
    seconds: Number(i.seconds) || 0,
    plot_twist: !!i.plot_twist,
    tags: (i.tags ?? []).map(String).slice(0, 8),
    transcript: String(i.transcript ?? "").slice(0, 1400),
  }));
  if (!items.length) return NextResponse.json({ clips: [] });
  const instructions = String(body?.instructions ?? "").slice(0, 1000);
  const chars = JSON.stringify(items).length + instructions.length + PROMPT_OVERHEAD_CHARS;

  const lease = admit(req, "meta", { tokens: estimateTokens(chars, META_MAX_OUTPUT) });
  if (lease instanceof NextResponse) return lease;
  const usage = { tokens: 0 };
  try {
    const clips = await aiMetaFor(items, instructions, usage);
    lease.settle({ tokens: usage.tokens });
    return NextResponse.json({ clips });
  } catch (e) {
    lease.settle({ tokens: usage.tokens });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  } finally {
    lease.release();
  }
}
