import { NextResponse } from "next/server";
import { config } from "@/lib/server/config";
import { cleanRuby } from "@/lib/server/ai";
import { geminiJSON } from "@/lib/server/gemini";
import { admit, tooLarge } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_SECONDS = 150;
const MAX_BYTES = Math.ceil((44 + MAX_SECONDS * 16000 * 2) * 1.37) + 20_000; // base64 WAV + JSON

const SYSTEM =
  "You are a professional Japanese subtitler for anime and films. You listen to Japanese audio and produce broadcast-quality subtitles.\n" +
  "Rules:\n" +
  "- Transcribe every line of spoken dialogue verbatim, written the way a native Japanese subtitler would (natural mix of kanji, hiragana and katakana; correct kanji chosen from context). Keep dialect such as Kansai-ben exactly as spoken; do not standardise it.\n" +
  "- Never invent speech. Skip music, singing, sound effects, breathing and silence. If there is no dialogue, return an empty list.\n" +
  "- One subtitle per utterance; split long utterances at natural pauses so each line is at most about 20 Japanese characters. Do not merge different speakers into one line.\n" +
  "- start/end are seconds from the beginning of THIS audio (decimals allowed), tightly matching when the words are actually spoken.\n" +
  "- en: an accurate, natural English subtitle for that line. Translate the meaning and tone (not word by word), using the surrounding lines and the scene as context. Keep the speaker's own voice: translate what this speaker says to the listener (first person stays first person; never turn a line into reported speech such as \"she said…\"). Keep names in romaji. Never leave it empty.\n" +
  "- ruby: furigana for the line. List every word of ja that contains kanji, in order of appearance, as {w: the word exactly as written in ja (include its okurigana), r: its reading in hiragana as actually pronounced here}. Choose the reading from context (e.g. 一人→ひとり, 今日→きょう, 後で→あとで, 何で→なんで). Omit words without kanji.";

const RUBY_SCHEMA = {
  type: "ARRAY",
  items: { type: "OBJECT", properties: { w: { type: "STRING" }, r: { type: "STRING" } }, required: ["w", "r"], propertyOrdering: ["w", "r"] },
};

const SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, ja: { type: "STRING" }, ruby: RUBY_SCHEMA, en: { type: "STRING" } },
        required: ["start", "end", "ja", "ruby", "en"],
        propertyOrdering: ["start", "end", "ja", "ruby", "en"],
      },
    },
  },
  required: ["lines"],
};

const SEGMENT_SYSTEM =
  "You are a professional Japanese subtitler for anime and films. You receive numbered audio snippets cut from a film's dialogue, in order. Each snippet is one stretch of speech found by a voice detector.\n" +
  "For EVERY snippet, return its subtitle lines (usually one; more if it holds several sentences or speakers, in spoken order):\n" +
  "- ja: the dialogue verbatim, written the way a native Japanese subtitler would (natural kanji/hiragana/katakana; correct kanji from context). Keep dialect such as Kansai-ben exactly as spoken. At most about 20 characters per line.\n" +
  "- en: an accurate, natural English subtitle for that line, using the neighbouring snippets as context. Keep the speaker's own voice (first person stays first person; never reported speech). Keep names in romaji.\n" +
  "- ruby: every word of ja containing kanji, in order, as {w: the word exactly as written (with okurigana), r: its hiragana reading as pronounced here} (e.g. 一人→ひとり, 今日→きょう).\n" +
  "- If a snippet has no intelligible speech (music, singing, shouting without words, noise), return an empty lines list for it. Never invent dialogue, and never move words between snippets.";

const SEGMENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER" },
          lines: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { ja: { type: "STRING" }, ruby: RUBY_SCHEMA, en: { type: "STRING" } }, required: ["ja", "ruby", "en"], propertyOrdering: ["ja", "ruby", "en"] },
          },
        },
        required: ["id", "lines"],
        propertyOrdering: ["id", "lines"],
      },
    },
  },
  required: ["segments"],
};

/**
 * Segment mode: the browser sends the speech snippets the voice detector found (timing stays on the device) and Gemini
 * only writes the text for each numbered snippet, so subtitle sync never depends on the model's timestamps.
 */
async function transcribeSegments(req: Request, body: { segments: unknown[]; context?: unknown[]; title?: string }) {
  const segs = body.segments.slice(0, 80).map((s) => (typeof s === "string" ? s : ""));
  if (!segs.length || segs.some((s) => s.length < 200)) return NextResponse.json({ error: "Expected base64 WAV snippets" }, { status: 400 });
  const seconds = segs.reduce((a, s) => a + (Math.floor((s.length * 3) / 4) - 44) / 32000, 0);
  if (seconds > MAX_SECONDS + 1) return NextResponse.json({ error: "Audio too long" }, { status: 413 });
  const lease = admit(req, "transcribe", { audioMin: seconds / 60, tokens: Math.ceil(seconds * 40) + 8000 });
  if (lease instanceof NextResponse) return lease;
  const usage = { tokens: 0 };
  try {
    const context = (body.context ?? []).slice(-6).map((l) => String(l ?? "").slice(0, 200)).filter(Boolean);
    const title = String(body.title ?? "").slice(0, 120);
    let result: { out: SnippetLines[]; model: string } | null = null;
    if (config.geminiKey) {
      try {
        result = await geminiSegments(segs, context, title, usage);
      } catch (e) {
        // Gemini's daily limit used up / Gemini unreachable: Groq takes over when it's set up.
        if (!config.groqKey) throw e;
        console.warn("Gemini segment transcription failed, using Groq:", (e as Error).message);
      }
    }
    if (!result) result = await groqSegments(segs, context, title, usage);
    lease.settle({ audioMin: seconds / 60, tokens: usage.tokens });
    return NextResponse.json({ segments: result.out, model: result.model });
  } catch (e) {
    lease.settle({ tokens: usage.tokens });
    const status = (e as { status?: number }).status;
    return NextResponse.json({ error: (e as Error).message }, { status: status === 429 ? 429 : 502 });
  } finally {
    lease.release();
  }
}

type SnippetLines = { ja: string; ruby: { w: string; r: string }[]; en: string }[];

function cleanSegments(n: number, segments: { id?: number; lines?: { ja?: string; ruby?: unknown; en?: string }[] }[] | undefined): SnippetLines[] {
  const out: SnippetLines[] = Array.from({ length: n }, () => []);
  for (const s of segments ?? []) {
    const id = Number(s?.id);
    if (!Number.isInteger(id) || id < 0 || id >= n) continue;
    out[id] = (s.lines ?? [])
      .map((l) => ({ ja: String(l.ja ?? "").trim().replace(/\s+/g, "\u3000").slice(0, 200), ruby: cleanRuby(l.ruby), en: String(l.en ?? "").trim().slice(0, 300) }))
      .filter((l) => l.ja);
  }
  return out;
}

/** Gemini hears every numbered snippet and writes its lines. */
async function geminiSegments(segs: string[], context: string[], title: string, usage: { tokens: number }) {
  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [
    {
      text:
        `${segs.length} speech snippets follow, numbered 0 to ${segs.length - 1}.` +
        (title ? ` Source video: ${title}.` : "") +
        (context.length ? `\nThe dialogue just before them (context only — do not repeat it):\n${context.join("\n")}` : ""),
    },
  ];
  segs.forEach((s, i) => parts.push({ text: `Snippet ${i}:` }, { inlineData: { mimeType: "audio/wav", data: s } }));
  parts.push({ text: `Return {"segments":[{"id","lines":[{"ja","ruby","en"}]}]} with exactly one entry for each snippet id 0–${segs.length - 1}.` });
  const meta: { model?: string } = {};
  const res = await geminiJSON<{ segments?: { id?: number; lines?: { ja?: string; ruby?: unknown; en?: string }[] }[] }>(parts, {
    system: SEGMENT_SYSTEM,
    schema: SEGMENT_SCHEMA,
    maxTokens: 24576,
    temperature: 0.1,
    usage,
    meta,
  });
  if (!res) throw Object.assign(new Error("Gemini returned no usable answer"), { status: 502 });
  return { out: cleanSegments(segs.length, res.segments), model: meta.model ?? config.geminiModel };
}

const GROQ_TEXT_SYSTEM =
  "You are a professional Japanese subtitler for anime and films. You get numbered snippets of Japanese dialogue as heard by speech recognition (it may mishear words or pick the wrong kanji). For EVERY snippet, return its subtitle lines (usually one; more if it holds several sentences or speakers):\n" +
  "- ja: the dialogue as a native Japanese subtitler would write it — fix obvious mishearings and wrong kanji using the context, keep dialect such as Kansai-ben as spoken. At most about 20 characters per line. Don't add content that isn't there.\n" +
  "- en: an accurate, natural English subtitle (keep the speaker's voice, names in romaji).\n" +
  "- ruby: every word of ja containing kanji, in order, as {w: the word as written (with okurigana), r: its hiragana reading here}.\n" +
  "- If a snippet is empty or not speech, return an empty lines list for it. Respond with JSON only.";

/**
 * Groq: Whisper hears all snippets in one request (joined with 1 s of silence; each word goes back to the snippet it falls
 * in), then the text model corrects, splits, translates and adds readings — 2 requests per batch.
 */
async function groqSegments(segs: string[], context: string[], title: string, usage: { tokens: number }) {
  if (!config.groqKey) throw Object.assign(new Error("No cloud speech provider is available (Gemini failed and Groq isn't set up)"), { status: 502 });
  const { groqJSON, groqTranscribe } = await import("@/lib/server/groq");
  const RATE = 16000;
  const pcm = segs.map((s) => {
    const b = Buffer.from(s, "base64");
    return new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)));
  });
  const gap = RATE; // 1 s of silence between snippets
  const total = pcm.reduce((a, p) => a + p.length + gap, 0);
  const joined = new Int16Array(total);
  const spans: [number, number][] = [];
  let at = 0;
  for (const p of pcm) {
    joined.set(p, at);
    spans.push([at / RATE, (at + p.length) / RATE]);
    at += p.length + gap;
  }
  const wav = new Uint8Array(44 + joined.length * 2);
  const v = new DataView(wav.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + joined.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, joined.length * 2, true);
  wav.set(new Uint8Array(joined.buffer), 44);
  const words = await groqTranscribe(wav);
  const heard = segs.map(() => "");
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    let best = 0;
    let dist = Infinity;
    spans.forEach(([s, e], i) => {
      const d = mid < s ? s - mid : mid > e ? mid - e : 0;
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    if (dist <= 0.6) heard[best] += w.text.trim();
  }
  const out: SnippetLines[] = segs.map(() => []);
  // The text model's free tier has a small per-minute token budget, so send ≤20 snippets per request.
  for (let from = 0; from < segs.length; from += 20) {
    const ids = heard.map((_, i) => i).slice(from, from + 20);
    const user =
      (title ? `Source video: ${title}\n` : "") +
      (context.length ? `Dialogue just before (context only):\n${context.join("\n")}\n` : "") +
      `Snippets:\n${JSON.stringify(ids.map((id) => ({ id, heard: heard[id] })))}\n` +
      `Return {"segments":[{"id":number,"lines":[{"ja":string,"ruby":[{"w":string,"r":string}],"en":string}]}]} with one entry per id.`;
    const res = await groqJSON<{ segments?: { id?: number; lines?: { ja?: string; ruby?: unknown; en?: string }[] }[] }>(GROQ_TEXT_SYSTEM, user, 6000, usage);
    const cleaned = cleanSegments(segs.length, res?.segments);
    for (const id of ids) {
      // If the text model dropped a snippet, keep what Whisper heard (English then comes from the translator).
      out[id] = cleaned[id].length ? cleaned[id] : heard[id] ? [{ ja: heard[id], ruby: [], en: "" }] : [];
    }
  }
  return { out, model: `${config.groqSpeechModel} + ${config.groqTextModel} (Groq)` };
}

/**
 * Anime Clipper cloud speech: the browser sends ≤150 s of 16 kHz mono WAV (base64) and Gemini returns timed Japanese
 * lines with English translations made from the audio itself (so tone and context are kept). With `segments` (speech
 * snippets from the voice detector) the AI only writes the text and the timing comes from the detector; Groq takes over
 * when Gemini is not set up or its daily limit is used up.
 */
export async function POST(req: Request) {
  if (!config.geminiKey && !config.groqKey) return NextResponse.json({ error: "No cloud speech provider is configured on this server" }, { status: 501 });
  const big = tooLarge(req, MAX_BYTES);
  if (big) return big;
  const body = (await req.json().catch(() => null)) as { audio?: string; segments?: unknown[]; context?: unknown[]; title?: string } | null;
  if (Array.isArray(body?.segments)) return transcribeSegments(req, body as { segments: unknown[] });
  if (!config.geminiKey) return NextResponse.json({ error: "Whole-audio transcription needs Gemini" }, { status: 501 });
  const audio = typeof body?.audio === "string" ? body.audio : "";
  const bytes = Math.floor((audio.length * 3) / 4);
  if (bytes < 1000) return NextResponse.json({ error: "Expected base64 WAV audio" }, { status: 400 });
  const seconds = (bytes - 44) / 32000;
  if (seconds > MAX_SECONDS + 1) return NextResponse.json({ error: "Audio chunk too long" }, { status: 413 });

  const lease = admit(req, "transcribe", { audioMin: seconds / 60, tokens: Math.ceil(seconds * 40) + 6000 });
  if (lease instanceof NextResponse) return lease;
  const usage = { tokens: 0 };
  try {
    const context = (body?.context ?? []).slice(-6).map((l) => String(l ?? "").slice(0, 200)).filter(Boolean);
    const title = String(body?.title ?? "").slice(0, 120);
    const prompt =
      `Audio length: ${seconds.toFixed(1)} seconds.` +
      (title ? `\nSource video: ${title}` : "") +
      (context.length ? `\nThe dialogue just before this audio (context only — do not repeat it):\n${context.join("\n")}` : "") +
      `\nReturn {"lines":[{"start","end","ja","ruby","en"}]} for all dialogue in the audio.`;
    const meta: { model?: string } = {};
    const res = await geminiJSON<{ lines?: { start?: number; end?: number; ja?: string; ruby?: { w?: string; r?: string }[]; en?: string }[] }>(
      [{ inlineData: { mimeType: "audio/wav", data: audio } }, { text: prompt }],
      { system: SYSTEM, schema: SCHEMA, maxTokens: 24576, temperature: 0.1, usage, meta },
    );
    lease.settle({ audioMin: seconds / 60, tokens: usage.tokens });
    if (!res) return NextResponse.json({ error: "Gemini returned no usable answer" }, { status: 502 });
    const lines = (res.lines ?? [])
      .map((l) => ({
        start: Math.max(0, Math.min(seconds, Number(l.start) || 0)),
        end: Math.max(0, Math.min(seconds, Number(l.end) || 0)),
        // Phrase breaks: the app uses full-width spaces in Japanese lines.
        ja: String(l.ja ?? "").trim().replace(/\s+/g, "\u3000").slice(0, 200),
        ruby: cleanRuby(l.ruby),
        en: String(l.en ?? "").trim().slice(0, 300),
      }))
      .filter((l) => l.ja);
    return NextResponse.json({ lines, model: meta.model ?? config.geminiModel });
  } catch (e) {
    lease.settle({ tokens: usage.tokens });
    const status = (e as { status?: number }).status;
    return NextResponse.json({ error: (e as Error).message }, { status: status === 429 ? 429 : 502 });
  } finally {
    lease.release();
  }
}
