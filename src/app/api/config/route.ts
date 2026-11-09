import { NextResponse } from "next/server";
import { cloudConfigured, config, textModelName } from "@/lib/server/config";
import { quotaSnapshot } from "@/lib/server/gemini-quota";
import { checkAccessCode, limits, usageSnapshot } from "@/lib/server/guard";

export const dynamic = "force-dynamic";

/**
 * Tells the browser which optional cloud AI features it may use (API keys never leave the server).
 * Send the access code in `x-ai-access-code` to learn whether it unlocks cloud AI.
 */
export async function GET(req: Request) {
  const enabled = cloudConfigured();
  const accessRequired = enabled && !!limits.accessCode;
  const granted = enabled && checkAccessCode(req.headers.get("x-ai-access-code"));
  const usage = enabled ? usageSnapshot() : null;
  return NextResponse.json({
    cloudAI: granted,
    // Word-timed transcription for the Clipping mode needs OpenAI Whisper.
    cloudTranscription: granted && !!config.openaiKey,
    // Japanese speech → timed Japanese + English lines for Anime Clipper (Gemini listens; Groq takes over when needed).
    cloudJapanese: granted && !!(config.geminiKey || config.groqKey),
    aiModel: granted ? textModelName() : null,
    speechModel: granted ? (config.geminiKey ? config.geminiModel : config.groqKey ? `${config.groqSpeechModel} (Groq)` : null) : null,
    // Daily quotas (counted on this server; providers don't report them), for the in-app limit notice.
    geminiQuota: granted
      ? [
          ...(config.geminiKey ? [config.geminiModel, config.geminiFallbackModel] : []),
          ...(config.groqKey ? [config.groqSpeechModel, config.groqTextModel] : []),
        ]
          .filter((m, i, a) => m && a.indexOf(m) === i)
          .map((m) => quotaSnapshot(m))
      : null,
    cloudAvailable: enabled,
    accessRequired,
    budgetExhausted: !!usage && ((limits.dailyTokens > 0 && usage.tokens >= limits.dailyTokens) || false),
  });
}
