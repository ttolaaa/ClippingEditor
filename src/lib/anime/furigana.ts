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
  reading?: string;
  pronunciation?: string;
}
interface Tokenizer {
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
  return compact(segs);
}
