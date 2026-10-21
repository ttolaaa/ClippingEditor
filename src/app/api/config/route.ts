import { NextResponse } from "next/server";
import { config } from "@/lib/server/config";

export const dynamic = "force-dynamic";

/** Tells the browser which optional cloud AI features the server can proxy (the key never leaves the server). */
export async function GET() {
  return NextResponse.json({
    cloudAI: !!config.openaiKey,
    aiModel: config.openaiKey ? config.openaiModel : null,
    cloudTranscription: !!config.openaiKey,
  });
}
