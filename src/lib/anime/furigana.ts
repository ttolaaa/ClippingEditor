"use client";

import { alignReading, compact, hasKanji } from "./ruby";
import type { RubySegment } from "./types";

/**
 * On-device furigana: kuromoji (IPAdic morphological analyser) tokenizes the Japanese text and gives each word's
 * reading; `alignReading` then places the reading over just the kanji. The dictionary is self-hosted under
 * /kuromoji-dict (a root-relative path: the loader collapses "//", so absolute URLs would break) and downloaded once.
 */

interface Token {
  surface_form: string;
  word_type?: string;
  reading?: string;
  pronunciation?: string;
  pos?: string;
  pos_detail_1?: string;
  pos_detail_2?: string;
}
export interface Tokenizer {
  tokenize(text: string): Token[];
}
interface KuromojiModule {
  builder(o: { dicPath: string }): { build(cb: (err: Error | null, t: Tokenizer) => void): void };
}

let tokenizer: Promise<Tokenizer> | null = null;

export function loadFurigana(): Promise<Tokenizer> {
  tokenizer ??= (async () => {
    const mod = (await import("@sglkc/kuromoji")) as unknown as KuromojiModule & { default?: KuromojiModule };
    const kuromoji = mod.default ?? mod;
    return new Promise<Tokenizer>((resolve, reject) => {
      kuromoji.builder({ dicPath: "/kuromoji-dict/" }).build((err, t) => (err ? reject(new Error(`Couldn't load the furigana dictionary: ${String(err)}`)) : resolve(t)));
    });
  })().catch((e) => {
    tokenizer = null;
    throw e;
  });
  return tokenizer;
}

/** Share of characters in words the dictionary doesn't know (0..1) — high values usually mean misheard speech. */
export async function unknownRatio(text: string): Promise<number> {
  const clean = text.replace(/[\s、。！？!?…\u3000]/g, "");
  if (!clean) return 0;
  const t = await loadFurigana();
  let unknown = 0;
  for (const tok of t.tokenize(clean)) {
    // Unknown katakana is usually a real loanword or name; unknown kanji/hiragana runs are suspicious.
    if (tok.word_type === "UNKNOWN" && !/^[ァ-ヶー]+$/.test(tok.surface_form)) unknown += tok.surface_form.length;
  }
  return unknown / clean.length;
}

/**
 * Words the dictionary reads wrongly in everyday speech (it picks the formal / compound reading). Applied after
 * annotation: the matched characters get these segments instead.
 */
const READING_OVERRIDES: { match: string; segs: RubySegment[] }[] = [
  { match: "一人", segs: [{ text: "一人", ruby: "ひとり" }] },
  { match: "二人", segs: [{ text: "二人", ruby: "ふたり" }] },
  { match: "大人", segs: [{ text: "大人", ruby: "おとな" }] },
  { match: "一つ", segs: [{ text: "一", ruby: "ひと" }, { text: "つ" }] },
  { match: "二つ", segs: [{ text: "二", ruby: "ふた" }, { text: "つ" }] },
  { match: "一日", segs: [{ text: "一日", ruby: "いちにち" }] },
  { match: "今日", segs: [{ text: "今日", ruby: "きょう" }] },
  { match: "明日", segs: [{ text: "明日", ruby: "あした" }] },
  { match: "昨日", segs: [{ text: "昨日", ruby: "きのう" }] },
  { match: "後で", segs: [{ text: "後", ruby: "あと" }, { text: "で" }] },
  { match: "後から", segs: [{ text: "後", ruby: "あと" }, { text: "から" }] },
  { match: "上手", segs: [{ text: "上手", ruby: "じょうず" }] },
  { match: "下手", segs: [{ text: "下手", ruby: "へた" }] },
  { match: "何で", segs: [{ text: "何", ruby: "なん" }, { text: "で" }] },
  { match: "何人", segs: [{ text: "何人", ruby: "なんにん" }] },
  { match: "母ちゃん", segs: [{ text: "母", ruby: "かあ" }, { text: "ちゃん" }] },
  { match: "父ちゃん", segs: [{ text: "父", ruby: "とう" }, { text: "ちゃん" }] },
  { match: "兄ちゃん", segs: [{ text: "兄", ruby: "にい" }, { text: "ちゃん" }] },
  { match: "姉ちゃん", segs: [{ text: "姉", ruby: "ねえ" }, { text: "ちゃん" }] },
  // Character names in Grave of the Fireflies-style dialogue ("節ちゃん" is Setsu-chan, read せっちゃん).
  { match: "節ちゃん", segs: [{ text: "節", ruby: "せっ" }, { text: "ちゃん" }] },
  { match: "節子", segs: [{ text: "節子", ruby: "せつこ" }] },
  { match: "清太", segs: [{ text: "清太", ruby: "せいた" }] },
];

/** Replace the readings of `READING_OVERRIDES` words, re-splitting segments at the word's boundaries. */
export function applyReadingOverrides(segs: RubySegment[]): RubySegment[] {
  const text = segs.map((s) => s.text).join("");
  // Only override where the word lines up with existing segment boundaries, so longer compounds the dictionary
  // already reads correctly (大人気 → だいにんき, 一人前) are left alone.
  const bounds = new Set<number>([0]);
  let p = 0;
  for (const s of segs) bounds.add((p += s.text.length));
  const hits: { at: number; o: (typeof READING_OVERRIDES)[number] }[] = [];
  for (const o of READING_OVERRIDES) {
    for (let at = text.indexOf(o.match); at >= 0; at = text.indexOf(o.match, at + o.match.length)) {
      if (!bounds.has(at) || !bounds.has(at + o.match.length)) continue;
      if (!hits.some((h) => at < h.at + h.o.match.length && h.at < at + o.match.length)) hits.push({ at, o });
    }
  }
  if (!hits.length) return segs;
  hits.sort((a, b) => a.at - b.at);
  // Walk the original segments; inside a hit emit the override segments, elsewhere keep text (a ruby segment cut by a
  // hit loses its reading for the cut-off part, which is then re-annotated below as plain text).
  const out: RubySegment[] = [];
  let pos = 0;
  let h = 0;
  for (const s of segs) {
    const sEnd = pos + s.text.length;
    let cursor = pos;
    while (cursor < sEnd) {
      const hit = hits[h];
      if (hit && cursor >= hit.at && cursor < hit.at + hit.o.match.length) {
        if (cursor === hit.at) out.push(...hit.o.segs.map((x) => ({ ...x })));
        const skip = Math.min(sEnd, hit.at + hit.o.match.length) - cursor;
        cursor += skip;
        if (cursor >= hit.at + hit.o.match.length) h++;
        continue;
      }
      const stop = Math.min(sEnd, hit ? hit.at : sEnd);
      const piece = s.text.slice(cursor - pos, stop - pos);
      if (piece) out.push(stop - cursor === s.text.length && s.ruby ? { ...s } : { text: piece });
      cursor = stop;
    }
    pos = sEnd;
  }
  return compact(out);
}

/** Split Japanese text into ruby segments (furigana on kanji only). Plain text without kanji is returned as-is. */
export async function annotateFurigana(text: string): Promise<RubySegment[]> {
  const clean = text.trim();
  if (!clean) return [];
  if (!hasKanji(clean)) return [{ text: clean }];
  const t = await loadFurigana();
  const segs: RubySegment[] = [];
  for (const tok of t.tokenize(clean)) {
    const surface = tok.surface_form;
    const reading = tok.reading && tok.reading !== "*" ? tok.reading : "";
    if (reading && hasKanji(surface)) segs.push(...alignReading(surface, reading));
    else segs.push({ text: surface });
  }
  // compact() merges plain segments, so overrides see the dictionary's word boundaries first.
  return compact(applyReadingOverrides(segs));
}
