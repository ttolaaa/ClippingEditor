/**
 * Rule-based Japanese clean-up before machine translation. The on-device translator (opus-mt-ja-en) was trained on
 * standard written Japanese, so dialect (anime is full of Kansai-ben), casual contractions and elongated vowels make it
 * guess — often flipping the meaning. This rewrites the most common forms to standard Japanese. The subtitles keep the
 * original text; only the translator sees the normalised version.
 */

// Order matters: longer / more specific patterns first. Each rule only fires on whole forms (anchored by the
// following character class) to avoid mangling ordinary words.
const END = "(?=[、。！？!?…\\s」』]|$)";
const RULES: [RegExp, string][] = [
  // Words that merely contain dialect-looking endings: protect them first.
  [/たいへん/g, "大変"],
  [/やったら/g, "なら"],
  [/(?<=っ)とって/g, "ていて"],
  // Kansai copula / sentence endings
  [new RegExp(`やねん${END}`, "g"), "なんだ"],
  [new RegExp(`ねん${END}`, "g"), "のだ"],
  [new RegExp(`やんか${END}`, "g"), "じゃないか"],
  [new RegExp(`やろか${END}`, "g"), "だろうか"],
  [new RegExp(`やろ${END}`, "g"), "だろう"],
  [new RegExp(`やで${END}`, "g"), "だよ"],
  [new RegExp(`やな${END}`, "g"), "だね"],
  [new RegExp(`やん${END}`, "g"), "じゃないか"],
  [new RegExp(`(?<=[\\u3400-\\u9fffー])や${END}`, "g"), "だ"],
  [new RegExp(`(?<=[ぁ-ん])んや${END}`, "g"), "のだ"],
  [new RegExp(`(?<=[ぁ-ん])んよ${END}`, "g"), "のよ"],
  [new RegExp(`(?<=[ぁ-ん])ん[？?]`, "g"), "の？"],
  // Kansai negatives
  [/あらへん/g, "ない"],
  [/あれへん/g, "ない"],
  [/(?<=[ぁ-ん])(?<!たい)へん(?![なだに])/g, "ない"],
  [/(?<=[ぁ-ん])ひん/g, "ない"],
  [/あかん/g, "だめだ"],
  [/ちゃう/g, "違う"],
  [/せやから/g, "だから"],
  [/せや(?=[、。！？!?]|$)/g, "そうだ"],
  [/ほんまに/g, "本当に"],
  [/ほんま/g, "本当"],
  [/めっちゃ/g, "とても"],
  [/おおきに/g, "ありがとう"],
  [/^ほな/g, "それじゃ"],
  [/(?<=[、。\s])ほな/g, "それじゃ"],
  [/おかん/g, "お母さん"],
  [/おとん/g, "お父さん"],
  [/お母ちゃん/g, "お母さん"],
  [/お父ちゃん/g, "お父さん"],
  [/うちら/g, "私たち"],
  [/うち(?=[はがもの])/g, "私"],
  // -とる / -とった (= -ている / -ていた), 言うた
  [/言うとった/g, "言っていた"],
  [/(?<=[ぁ-ん])とった/g, "ていた"],
  [/(?<=[ぁ-ん])とる(?=[、。！？!?よねな]|$)/g, "ている"],
  [/言うた/g, "言った"],
  [/こうた/g, "買った"],
  // casual / elongated forms
  [/早よ|はよ(?=[うぉ]|[、！!]|$|\s|[ぁ-ん])/g, "早く"],
  [/気ぃつけ/g, "気をつけ"],
  [/(?<=[ぁ-ん])ぃ(?=[ぁ-ん])/g, ""],
  [/よう(?=聞|見|言|分|知)/g, "よく"],
  [/っす(?=[、。！？!?]|$)/g, "です"],
  [/じゃん(?=[、。！？!?]|$)/g, "じゃないか"],
  [/なきゃ/g, "なければ"],
  [/ちゃった/g, "てしまった"],
  [/てる(?=[、。！？!?よねなわ]|$)/g, "ている"],
  [/ってる/g, "っている"],
  [/ー{2,}/g, "ー"],
  [/([ぁ-んァ-ン])\1{2,}/g, "$1$1"],
  [/[〜~]+/g, ""],
  [/\u3000/g, "、"],
];

export function normalizeForTranslation(text: string): string {
  let t = text.trim();
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  return t.replace(/、{2,}/g, "、").replace(/^、|、$/g, "");
}

// ---------------------------------------------------------------- names (romaji)

/** Kinship / generic words that also end in ちゃん・くん・さん and must not be treated as names. */
export const NOT_NAMES = /^(お?兄|お?姉|お?母|お?父|お?じい|お?ばあ|おじ|おば|赤|ばあ|じい|かあ|とう|にい|ねえ|みな|皆|お客|おまわり|お嬢|坊|ぼっ|あん|おにい|おねえ|おかあ|おとう|おじい|おばあ|奥|先生|兵隊|隊長|お巡り)$/;

const KANA: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to", な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo", ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo", だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
};
const YOON: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };

export function romaji(kana: string): string {
  const hira = kana.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  let out = "";
  for (let i = 0; i < hira.length; i++) {
    const c = hira[i];
    const next = hira[i + 1];
    if (c === "っ") {
      const r = KANA[next] ?? "";
      out += r.startsWith("ch") ? "t" : r[0] ?? "";
      continue;
    }
    if (c === "ー") continue;
    let r = KANA[c] ?? "";
    if (next && YOON[next]) {
      r = /^(shi|chi|ji)$/.test(r) ? r.slice(0, -1) + YOON[next] : r.slice(0, -1) + "y" + YOON[next];
      i++;
    }
    out += r;
  }
  return out ? out[0].toUpperCase() + out.slice(1) : kana;
}
