import type { RubySegment } from "./types";

const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3006\u30f6]/;
const KANJI_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3006\u30f6]+/g;

export const hasKanji = (s: string) => KANJI.test(s);

export function katakanaToHiragana(s: string): string {
  return s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Attach a reading to the kanji of one word, leaving okurigana plain:
 * 食べる + たべる -> [食 (た)] [べる]; 振り返る + ふりかえる -> [振 (ふ)] [り] [返 (かえ)] [る].
 * Falls back to one ruby over the whole word when the reading can't be aligned.
 */
export function alignReading(surface: string, reading: string): RubySegment[] {
  const read = katakanaToHiragana(reading);
  if (!hasKanji(surface) || !read || read === katakanaToHiragana(surface)) return [{ text: surface }];

  const parts: { text: string; kanji: boolean }[] = [];
  let last = 0;
  for (const m of surface.matchAll(KANJI_RUN)) {
    if (m.index! > last) parts.push({ text: surface.slice(last, m.index), kanji: false });
    parts.push({ text: m[0], kanji: true });
    last = m.index! + m[0].length;
  }
  if (last < surface.length) parts.push({ text: surface.slice(last), kanji: false });

  const pattern = parts.map((p) => (p.kanji ? "(.+?)" : escapeRegex(katakanaToHiragana(p.text)))).join("");
  const match = new RegExp(`^${pattern}$`).exec(read);
  if (!match) return [{ text: surface, ruby: read }];

  let g = 1;
  return parts.map((p) => (p.kanji ? { text: p.text, ruby: match[g++] } : { text: p.text }));
}

/** Merge neighbouring segments that have no ruby. */
export function compact(segs: RubySegment[]): RubySegment[] {
  const out: RubySegment[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const prev = out[out.length - 1];
    if (prev && !prev.ruby && !s.ruby) prev.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

export const segmentsToText = (segs: RubySegment[]) => segs.map((s) => s.text).join("");

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** `<ruby>漢<rt>かん</rt></ruby>字` */
export function segmentsToMarkup(segs: RubySegment[]): string {
  return segs.map((s) => (s.ruby ? `<ruby>${escapeHtml(s.text)}<rt>${escapeHtml(s.ruby)}</rt></ruby>` : escapeHtml(s.text))).join("");
}

/** Parse ruby markup (also accepts `<rb>` and `<rp>` parts); text outside tags becomes plain segments. */
export function parseMarkup(markup: string): RubySegment[] {
  const out: RubySegment[] = [];
  const re = /<ruby>([\s\S]*?)<\/ruby>/gi;
  let last = 0;
  for (const m of markup.matchAll(re)) {
    if (m.index! > last) out.push({ text: unescapeHtml(markup.slice(last, m.index)) });
    const inner = m[1].replace(/<rp>[\s\S]*?<\/rp>/gi, "");
    const rt = /<rt>([\s\S]*?)<\/rt>/i.exec(inner);
    const base = inner.replace(/<rt>[\s\S]*?<\/rt>/gi, "").replace(/<\/?rb>/gi, "");
    const text = unescapeHtml(base);
    const ruby = rt ? unescapeHtml(rt[1]).trim() : "";
    out.push(ruby ? { text, ruby } : { text });
    last = m.index! + m[0].length;
  }
  if (last < markup.length) out.push({ text: unescapeHtml(markup.slice(last)) });
  return compact(out);
}

/** Characters that must not start a line when wrapping. */
export const NO_LINE_START = /[、。，．・：；？！）〕］｝〉》」』】ゝゞーぁぃぅぇぉっゃゅょァィゥェォッャュョ,.:;?!)\]}%]/;

export const SENTENCE_END = /[。！？!?]/;
