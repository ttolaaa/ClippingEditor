/**
 * Guards against Whisper "hallucinations": text it invents for music, noise or silence. Typical Japanese cases seen on
 * film audio: endless loops ("もう一度、もう一度、…", "んんんん…"), and phantom phrases learned from subtitled
 * YouTube videos ("ご視聴ありがとうございました", "字幕作成者", "作詞 作曲"…).
 */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** Phrases Whisper emits on non-speech in Japanese (closing lines and credits of the videos it was trained on). */
const PHANTOM = [
  /ご視聴(いただき)?(ありがとう|有難う)(ございました|ございます)?。?/,
  /ご覧(いただき|頂き)(ありがとう|有難う)(ございました|ございます)?。?/,
  /チャンネル登録(よろしく)?(お願いします)?。?/,
  /高評価(よろしく)?(お願いします)?。?/,
  /字幕(作成者?|制作|提供|by)\S*/i,
  /(作詞|作曲|編曲)\S*/,
  /(翻訳|提供)\s*[:：]\S*/,
  /次回(も|の)?お楽しみ(に)?。?/,
  /[【\[][^】\]]*[】\]]/,
  /[(（](音楽|拍手|笑い|BGM|笑)[)）]/i,
  /[♪♫][^♪♫]*[♪♫]?/,
  /[★☆◆◇■□●○][^★☆◆◇■□●○]*[★☆◆◇■□●○]?/,
  /(また|次回も?)(見|観)て(ね|ください)/,
  /最後までご(覧|視聴)/,
];

const strip = (s: string) => s.replace(/[\s、。，．,.!！?？…・「」『』【】()（）\[\]〜~ー-]/g, "");

/** True when a line is one of Whisper's known phantom phrases or only bracketed/sound-effect text. */
export function isPhantom(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (PHANTOM.some((re) => re.test(t))) {
    // Phantom if what's left after removing the phantom parts is (almost) nothing.
    let rest = t;
    for (const re of PHANTOM) rest = rest.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "");
    return strip(rest).length <= 2;
  }
  return !strip(t);
}

/** True for lines that are only a hesitation/filler sound ("あ", "ん", "うう"), which make useless subtitles. */
export function isFillerOnly(text: string): boolean {
  if (/[?？!！]/.test(text)) return false; // "え?" / "あっ!" are real reactions
  const k = strip(text);
  return k.length > 0 && k.length <= 3 && /^[あぁいぃうぅえぇおぉんっはへほふむうー]+$/.test(k);
}

/**
 * Collapse runs where the same 1–6 word sequence repeats: keep at most two copies ("さあ、さあ" is real speech,
 * "さて、さて、さて、さて…" is a loop). Also collapses character loops inside a single token ("んんんんん").
 */
export function collapseRepeats<T extends { text: string }>(words: T[]): T[] {
  const out: T[] = [];
  const key = (w: T) => strip(w.text) || w.text;
  // While inside a detected loop, words that continue the repeating pattern are skipped.
  let pattern: string[] | null = null;
  let pos = 0;
  for (const w of words) {
    const text = w.text.replace(/(.{1,4}?)\1{3,}/g, "$1$1");
    const word = text === w.text ? w : { ...w, text };
    if (pattern) {
      if (key(word) === pattern[pos % pattern.length]) {
        pos++;
        continue;
      }
      pattern = null;
    }
    let loopN = 0;
    for (let n = 1; n <= 6 && !loopN; n++) {
      if (out.length < 3 * n - 1) break;
      // Adding `word` would complete a third consecutive copy of the last n-word sequence.
      const cand = [...out.slice(out.length - n + 1), word].map(key).join("|");
      const prev1 = out.slice(out.length - 2 * n + 1, out.length - n + 1).map(key).join("|");
      const prev2 = out.slice(out.length - 3 * n + 1, out.length - 2 * n + 1).map(key).join("|");
      if (cand && cand === prev1 && cand === prev2) loopN = n;
    }
    if (loopN) {
      pattern = out.slice(out.length - 2 * loopN + 1, out.length - loopN + 1).map(key);
      out.splice(out.length - (loopN - 1), loopN - 1); // drop the partial third copy
      pos = 0;
      continue;
    }
    out.push(word);
  }
  return out;
}

/**
 * Clean the words Whisper returned for one speech window: collapse loops, drop the words of phantom phrases, and
 * return [] when the window is far more text than anyone can speak in that time (an invented/looping window).
 */
export function cleanWindow<T extends TimedWord>(words: T[], seconds: number): T[] {
  let kept = collapseRepeats(words.filter((w) => w.text.trim()));
  // Map each word to its character range in the joined text, then drop words overlapping a phantom phrase.
  const joined = kept.map((w) => w.text).join("");
  const bad = new Uint8Array(joined.length);
  for (const re of PHANTOM) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of joined.matchAll(g)) bad.fill(1, m.index!, m.index! + Math.max(1, m[0].length));
  }
  let at = 0;
  kept = kept.filter((w) => {
    const from = at;
    at += w.text.length;
    return !bad.subarray(from, at).some((b) => b === 1);
  });
  const text = kept.map((w) => w.text).join("");
  if (!strip(text)) return [];
  // Fast Japanese speech is ~10–12 characters per second; well above that is a loop or invented text.
  if (strip(text).length / Math.max(0.5, seconds) > 16) return [];
  return kept;
}

/** Cap on generated tokens for a window, so a runaway loop can't produce pages of text (Japanese ≈ 6 tokens/s). */
export function maxTokensFor(seconds: number): number {
  return Math.min(440, Math.round(12 + seconds * 9));
}
