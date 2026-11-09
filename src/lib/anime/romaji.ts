import type { RubySegment } from "./types";

/**
 * Hepburn romaji for subtitle lines. Readings come from the line's own furigana (so the romaji always matches what's
 * shown above the kanji); the dictionary only supplies word boundaries (for spacing) and marks particles, which are read
 * the spoken way (は → wa, へ → e, を → o).
 */

const BASE: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to", だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n", ゔ: "vu",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o", ゃ: "ya", ゅ: "yu", ょ: "yo", ゎ: "wa",
};

// Combinations written with a small kana: きゃ → kya, しゃ → sha, ちゃ → cha, ふぁ → fa, てぃ → ti …
const SMALL_Y: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };
const SPECIAL: Record<string, string> = {
  しゃ: "sha", しゅ: "shu", しょ: "sho", じゃ: "ja", じゅ: "ju", じょ: "jo", ちゃ: "cha", ちゅ: "chu", ちょ: "cho",
  ぢゃ: "ja", ぢゅ: "ju", ぢょ: "jo", ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo", てぃ: "ti", でぃ: "di", とぅ: "tu", どぅ: "du",
  うぃ: "wi", うぇ: "we", うぉ: "wo", ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo", しぇ: "she", じぇ: "je", ちぇ: "che", つぁ: "tsa",
};

const PUNCT: Record<string, string> = { "、": ",", "。": ".", "？": "?", "！": "!", "…": "…", "「": "“", "」": "”", "『": "“", "』": "”", "（": "(", "）": ")", "・": " ", "〜": "~", "～": "~", "\u3000": " " };

const toHira = (s: string) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Hiragana/katakana → Hepburn romaji (other characters pass through, Japanese punctuation becomes Latin). */
export function kanaToRomaji(input: string): string {
  const s = toHira(input);
  let out = "";
  let geminate = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const pair = s.slice(i, i + 2);
    let r: string | undefined;
    if (SPECIAL[pair]) {
      r = SPECIAL[pair];
      i++;
    } else if (SMALL_Y[s[i + 1]] && BASE[c] && /i$/.test(BASE[c]) && BASE[c].length > 1) {
      r = BASE[c].slice(0, -1) + "y" + SMALL_Y[s[i + 1]];
      i++;
    } else if (c === "っ") {
      geminate = true;
      continue;
    } else if (c === "ー") {
      r = out.match(/[aeiou]$/)?.[0] ?? "";
    } else if (c === "ん") {
      // ん before a vowel or y is written n' so it isn't read as na/ni/ya…
      const next = BASE[s[i + 1]] ?? "";
      r = /^[aeiouy]/.test(next) ? "n'" : "n";
    } else {
      r = BASE[c] ?? PUNCT[c] ?? c;
    }
    if (geminate) {
      geminate = false;
      if (/^[a-z]/.test(r)) r = (r.startsWith("ch") ? "t" : r[0]) + r;
    }
    out += r;
  }
  return out;
}

const PARTICLE_READING: Record<string, string> = { は: "wa", へ: "e", を: "o" };

/** Romaji for a subtitle line, with spaces between words. Falls back to unspaced romaji if the dictionary is unavailable. */
export async function toRomaji(segs: RubySegment[]): Promise<string> {
  const text = segs.map((s) => s.text).join("");
  if (!text.trim()) return "";
  // Character-level units: a ruby segment is one unit (its reading can't be split per kanji), plain text is per character.
  const units: { from: number; to: number; kana: string }[] = [];
  let at = 0;
  for (const s of segs) {
    if (s.ruby) units.push({ from: at, to: at + s.text.length, kana: s.ruby });
    else [...s.text].forEach((ch, i) => units.push({ from: at + i, to: at + i + 1, kana: ch }));
    at += s.text.length;
  }
  let tokens: { surface_form: string; pos?: string; pos_detail_1?: string; reading?: string }[];
  try {
    const { loadFurigana } = await import("./furigana");
    tokens = (await loadFurigana()).tokenize(text);
  } catch {
    return tidy(kanaToRomaji(units.map((u) => u.kana).join("")));
  }
  const KANJI = /[\u3400-\u9fff\uf900-\ufaff\u3005]/;
  // Words: each token's kana (from the furigana; the dictionary's reading only for kanji the furigana doesn't cover),
  // merged while a ruby unit straddles token boundaries, with verb endings (た, て, ます, ない…) kept on their verb.
  const words: { kana: string; particle: string | null }[] = [];
  let pos = 0;
  let used = 0;
  let pending: { kana: string; particle: string | null; attach: boolean } | null = null;
  let prevPos = "";
  for (const t of tokens) {
    const from = pos;
    const to = pos + t.surface_form.length;
    pos = to;
    // Past the end of a ruby unit that spanned several tokens: that word is complete.
    if (pending && from >= used) {
      words.push({ kana: pending.kana, particle: null });
      pending = null;
    }
    const here = units.filter((u) => u.to > from && u.from < to && u.from >= used);
    if (here.length) used = Math.max(...here.map((u) => u.to));
    let kana = here.map((u) => u.kana).join("");
    if (KANJI.test(kana) && t.reading && t.reading !== "*") kana = t.reading;
    const prevVerbal = /^(動詞|形容詞|助動詞)$/.test(prevPos);
    const attach =
      ((t.pos === "助動詞" || t.pos_detail_1 === "非自立") && prevVerbal) ||
      t.pos_detail_1 === "接尾" ||
      (t.pos === "助詞" && t.pos_detail_1 === "接続助詞" && prevVerbal && /^(て|で|ちゃ|じゃ|ば)$/.test(t.surface_form));
    prevPos = t.pos ?? "";
    const particle = t.pos === "助詞" && PARTICLE_READING[t.surface_form] && here.length === 1 ? PARTICLE_READING[t.surface_form] : null;
    if (!kana) continue;
    if (pending && used > to) {
      // This token's ruby unit continues into the next token: keep collecting.
      pending.kana += kana;
      continue;
    }
    if (attach && words.length) {
      words[words.length - 1].kana += (pending?.kana ?? "") + kana;
      words[words.length - 1].particle = null;
      pending = null;
      continue;
    }
    if (pending) {
      words.push({ kana: pending.kana + kana, particle: null });
      pending = null;
      continue;
    }
    if (used > to) pending = { kana, particle: null, attach };
    else words.push({ kana, particle });
  }
  if (pending) words.push({ kana: pending.kana, particle: null });
  return tidy(words.map((w) => w.particle ?? kanaToRomaji(w.kana)).join(" "));
}

/** Text the romaji was made from: the Japanese plus its readings (editing either makes stored romaji stale). */
export const romajiKey = (segs: RubySegment[]) => segs.map((s) => (s.ruby ? `${s.text}(${s.ruby})` : s.text)).join("");

/** Fill in or refresh the romaji of subtitles whose Japanese changed. Returns the same array if nothing changed. */
export async function withRomaji<T extends { ja: RubySegment[]; romaji?: string; romajiFor?: string }>(subs: T[]): Promise<T[]> {
  let changed = false;
  const out: T[] = [];
  for (const s of subs) {
    const key = romajiKey(s.ja);
    if (s.romajiFor === key || !s.ja.length) {
      out.push(s);
      continue;
    }
    changed = true;
    out.push({ ...s, romaji: await toRomaji(s.ja), romajiFor: key });
  }
  return changed ? out : subs;
}

/** Attach punctuation to the previous word and collapse spaces. */
function tidy(s: string): string {
  return s
    .replace(/\s+([,.?!…”)~])/g, "$1")
    .replace(/([“(])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
