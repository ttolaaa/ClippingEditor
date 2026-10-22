import { NextResponse } from "next/server";
import { config } from "@/lib/server/config";
import { checkAccessCode, limits, usageSnapshot } from "@/lib/server/guard";

export const dynamic = "force-dynamic";

/**
 * Tells the browser which optional cloud AI features it may use (the OpenAI key never leaves the server).
 * Send the access code in `x-ai-access-code` to learn whether it unlocks cloud AI.
 */
export async function GET(req: Request) {
  const enabled = !!config.openaiKey;
  const accessRequired = enabled && !!limits.accessCode;
  const granted = enabled && checkAccessCode(req.headers.get("x-ai-access-code"));
  const usage = enabled ? usageSnapshot() : null;
  return NextResponse.json({
    cloudAI: granted,
    cloudTranscription: granted,
    aiModel: granted ? config.openaiModel : null,
    cloudAvailable: enabled,
    accessRequired,
    budgetExhausted: !!usage && ((limits.dailyTokens > 0 && usage.tokens >= limits.dailyTokens) || false),
  });
}
