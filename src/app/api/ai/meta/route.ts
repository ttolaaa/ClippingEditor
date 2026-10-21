import { NextResponse } from "next/server";
import { config } from "@/lib/server/config";
import { aiMetaFor, type MetaItem } from "@/lib/server/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!config.openaiKey) return NextResponse.json({ error: "Cloud AI is not configured" }, { status: 501 });
  const body = (await req.json().catch(() => null)) as { items?: MetaItem[]; instructions?: string } | null;
  const items = (body?.items ?? []).slice(0, 60).map((i) => ({
    id: Number(i.id),
    seconds: Number(i.seconds) || 0,
    plot_twist: !!i.plot_twist,
    tags: (i.tags ?? []).map(String).slice(0, 8),
    transcript: String(i.transcript ?? "").slice(0, 1400),
  }));
  try {
    return NextResponse.json({ clips: await aiMetaFor(items, String(body?.instructions ?? "").slice(0, 1000)) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
