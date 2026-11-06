/**
 * Safety net around the on-device Japanese→English model (opus-mt-ja-en): fixed translations for short reactions,
 * de-duplication of repeated input, generation settings that prevent loops, and a check that rejects broken output
 * ("eight, eight, eight…", counting sequences, far too long) so it is retried — or left empty rather than shown wrong.
 */

const strip = (s: string) => s.replace(/[\s、。，．,.!！?？…・「」『』【】()（）\[\]〜~ー-]/g, "");

/** Short lines the model handles badly; exact subtitle-style translations. Keys are matched after stripping punctuation. */
const FIXED: Record<string, string> = {
  え: "Huh?",
  えっ: "Huh?",
  ええ: "Yeah.",
  えー: "Huh?",
  あ: "Ah!",
  あっ: "Ah!",
  ああ: "Ah…",
  うん: "Yeah.",
  ううん: "No.",
  はい: "Yes.",
  いいえ: "No.",
  いや: "No.",
  おい: "Hey!",
  ねえ: "Hey.",
  ねぇ: "Hey.",
  ほら: "Look!",
  さあ: "Come on.",
  さぁ: "Come on.",
  よし: "All right!",
  やった: "Yes!",
  なに: "What?",
  何: "What?",
  なんで: "Why?",
  なんでよ: "Why?",
  どうして: "Why?",
  だれ: "Who?",
  誰: "Who?",
  どこ: "Where?",
  ほんと: "Really?",
  本当: "Really?",
  まじ: "Seriously?",
  マジ: "Seriously?",
  ありがとう: "Thank you.",
  ありがとうございます: "Thank you very much.",
  ごめん: "Sorry.",
  ごめんなさい: "I'm sorry.",
  すみません: "Excuse me.",
  すいません: "Excuse me.",
  さようなら: "Goodbye.",
  さよなら: "Goodbye.",
  おはよう: "Good morning.",
  こんにちは: "Hello.",
  こんばんは: "Good evening.",
  おやすみ: "Good night.",
  おやすみなさい: "Good night.",
  いただきます: "Let's eat.",
  ごちそうさま: "Thanks for the meal.",
  ただいま: "I'm home.",
  おかえり: "Welcome home.",
  おかえりなさい: "Welcome home.",
  いってきます: "I'm off.",
  いってらっしゃい: "See you later.",
  大丈夫: "It's all right.",
  だいじょうぶ: "It's all right.",
  待って: "Wait!",
  まって: "Wait!",
  逃げろ: "Run!",
  助けて: "Help!",
  たすけて: "Help!",
  行くぞ: "Let's go!",
  いくぞ: "Let's go!",
  お兄ちゃん: "Big brother!",
  兄ちゃん: "Big brother!",
  お母さん: "Mom!",
  お母ちゃん: "Mom!",
  お父さん: "Dad!",
  お父ちゃん: "Dad!",
  大変: "This is bad!",
  たいへん: "This is bad!",
  うそ: "No way!",
  嘘: "No way!",
  まさか: "No way…",
  すごい: "Amazing!",
  すげえ: "Amazing!",
  やばい: "Oh no!",
  やめて: "Stop it!",
  やめろ: "Stop it!",
  わかった: "Got it.",
  分かった: "Got it.",
  了解: "Roger.",
};

/** Question forms where the statement translation doesn't fit. */
const FIXED_Q: Record<string, string> = {
  大丈夫: "Are you okay?",
  だいじょうぶ: "Are you okay?",
  本当: "Really?",
  ほんと: "Really?",
  わかった: "Got it?",
  分かった: "Got it?",
  いいえ: "No?",
  うん: "Yeah?",
  ええ: "Huh?",
};

/** Translation for a short reaction/greeting, or null. Questions keep their question mark. */
export function fixedTranslation(ja: string): string | null {
  const key = strip(ja);
  const question = /[?？]\s*$/.test(ja);
  if (question && FIXED_Q[key]) return FIXED_Q[key];
  const hit = FIXED[key];
  if (!hit) return null;
  if (question && !hit.endsWith("?")) return hit.replace(/[.!…]$/, "") + "?";
  return hit;
}

/** "一度、一度、" → { unit: "一度", times: 2 }; null when the line isn't one phrase repeated. */
export function repeatedUnit(ja: string): { unit: string; times: number } | null {
  const parts = ja
    .split(/[、,\s\u3000]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const k = strip(parts[0]);
  if (!k || !parts.every((p) => strip(p) === k)) return null;
  return { unit: parts[0].replace(/[、。,.]+$/, ""), times: parts.length };
}

const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred)\b/gi;
const SWEAR_JA = /くそ|クソ|糞|畜生|ちくしょう|チクショウ|てめえ|テメエ|てめぇ|野郎|やろう|バカ|ばか|馬鹿|アホ|あほ|ボケ|ぼけ|死ね|しね|くたばれ|ふざけ|最悪|くっそ|チッ/;
const FILLER_EN =
  /\b(a (few|couple of) examples|in (the|this) (next )?video|thank(s| you) for watching|(we're|i'm) going to (show|give) you|have a lot of fun|let's get started|subscribe|in this tutorial|a little bit (more|of a))\b/i;

/** True when an English output is clearly broken: loops, counting, or far longer than the Japanese could mean. */
export function looksBroken(ja: string, en: string): boolean {
  const words = en.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (!words.length) return true;
  // Stock filler the model falls back to when it can't make sense of the input (learned from video transcripts).
  if (FILLER_EN.test(en)) return true;
  // Profanity the Japanese doesn't contain is the model guessing on unclear input.
  if (/\b(fuck\w*|shit\w*|bitch\w*|bastard|asshole|dick|cunt|damn\w*|crap)\b/i.test(en) && !SWEAR_JA.test(ja)) return true;
  const jaLen = strip(ja).length;
  if (words.length > 8 + jaLen * 1.6) return true;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, c] of counts) if (c >= 4 && c / words.length > 0.25 && !["the", "a", "i", "you", "to"].includes(w)) return true;
  // Counting ("one, two, three, four…") when the Japanese has no numbers.
  if ((en.match(NUMBER_WORDS) ?? []).length >= 4 && !/[0-9０-９一二三四五六七八九十百千]/.test(ja)) return true;
  // The same 2–3 word phrase three or more times.
  for (const n of [2, 3]) {
    const seen = new Map<string, number>();
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n).join(" ");
      const c = (seen.get(g) ?? 0) + 1;
      if (c >= 3) return true;
      seen.set(g, c);
    }
  }
  return false;
}

/** Generation settings scaled to the line, with anti-repetition guards. `strict` is the retry after a broken output. */
export function generationOptions(ja: string, strict = false): Record<string, unknown> {
  const jaLen = strip(ja).length;
  return strict
    ? { max_new_tokens: Math.min(48, 6 + jaLen * 2), num_beams: 1, do_sample: false, no_repeat_ngram_size: 2, repetition_penalty: 1.6 }
    : { max_new_tokens: Math.min(96, 10 + Math.round(jaLen * 2.5)), num_beams: 4, no_repeat_ngram_size: 3, repetition_penalty: 1.2 };
}

/** Light clean-up of model output for subtitles. */
export function tidyEnglish(en: string): string {
  return en
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, "…")
    .replace(/…+/g, "…")
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/([,.!?])\1+/g, "$1")
    .replace(/^[-–—\s]+/, "")
    .trim();
}
