"use client";

import { loadFurigana } from "./furigana";
import { NOT_NAMES, romaji } from "./normalize";

/**
 * Character names confuse the on-device translator: it "translates" them ("せっちゃん" → "old man", "清太" → "Narita").
 * Before translating, names are swapped for placeholders the model handles reliably ("トム" → "Tom"), and the real name
 * (in romaji, e.g. "Setsuko", "Seita") is put back into the English afterwards.
 */

const PLACEHOLDERS = [
  { ja: "トム", en: "Tom" },
  { ja: "ケン", en: "Ken" },
  { ja: "ボブ", en: "Bob" },
];

export interface ProtectedLine {
  text: string;
  names: { en: string; name: string }[];
}

const HONORIFIC = /^(ちゃん|くん|君|さん|さま|様)$/;
const kanaToRomaji = (reading: string) => romaji(reading.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)));

function honorificSuffix(hon: string, nameKana: string): string {
  if (hon === "ちゃん") return nameKana.endsWith("っ") || nameKana.endsWith("ッ") ? "tchan" : "-chan";
  if (hon === "くん" || hon === "君") return "-kun";
  if (hon === "さん") return "-san";
  return "-sama";
}

/** Replace up to three names in a line with placeholders. Falls back to the original text if the dictionary can't load. */
export async function protectNames(text: string): Promise<ProtectedLine> {
  const names: ProtectedLine["names"] = [];
  // 1. Kana names before an honorific ("せっちゃん", "たかしくん"): the dictionary often splits these oddly.
  const pre = text.replace(/(^|[、。！？!?\s\u3000「])([ぁ-んァ-ヶー]{1,6}?)(ちゃん|くん|さん|さま)(?=[、。！？!?\s\u3000」はがもにのをと]|$)/g, (m, lead: string, kana: string, hon: string) => {
    const slot = PLACEHOLDERS[names.length];
    if (!slot || NOT_NAMES.test(kana)) return m;
    const name = kanaToRomaji(kana.replace(/[っッ]$/, "")) + honorificSuffix(hon, kana);
    if (/[^\u0020-\u007e]/.test(name)) return m;
    const existing = names.findIndex((n) => n.name === name);
    if (existing >= 0) return lead + PLACEHOLDERS[existing].ja;
    names.push({ en: slot.en, name });
    return lead + slot.ja;
  });
  let tokens: { surface_form: string; reading?: string; pos_detail_1?: string; pos_detail_2?: string }[];
  try {
    tokens = (await loadFurigana()).tokenize(pre);
  } catch {
    return { text: pre, names };
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const slot = PLACEHOLDERS[names.length];
    if (PLACEHOLDERS.some((p) => p.ja === t.surface_form)) {
      out.push(t.surface_form);
      continue;
    }
    const isPerson = t.pos_detail_1 === "固有名詞" && t.pos_detail_2 === "人名";
    // A name right before an honorific: "せっちゃん", "清太くん"; or a dictionary person name: "節子", "清太".
    const beforeHonorific = !!next && HONORIFIC.test(next.surface_form) && !NOT_NAMES.test(t.surface_form) && /^[ぁ-んァ-ヶー一-龯々]+$/.test(t.surface_form);
    if (slot && (isPerson || beforeHonorific)) {
      // Join family + given name tokens ("横山清太").
      let surface = t.surface_form;
      let reading = t.reading && t.reading !== "*" ? t.reading : t.surface_form;
      while (isPerson && tokens[i + 1]?.pos_detail_2 === "人名") {
        i++;
        surface += tokens[i].surface_form;
        reading += tokens[i].reading && tokens[i].reading !== "*" ? tokens[i].reading : tokens[i].surface_form;
      }
      let name = kanaToRomaji(reading.replace(/[っッ]$/, ""));
      if (/[^\u0020-\u007e]/.test(name) || !name) {
        out.push(surface);
        continue;
      }
      if (tokens[i + 1] && HONORIFIC.test(tokens[i + 1].surface_form)) {
        name += honorificSuffix(tokens[i + 1].surface_form, reading);
        i++;
      }
      const existing = names.find((n) => n.name === name);
      if (existing) out.push(PLACEHOLDERS[names.indexOf(existing)].ja);
      else {
        names.push({ en: slot.en, name });
        out.push(slot.ja);
      }
      continue;
    }
    out.push(t.surface_form);
  }
  return { text: out.join(""), names };
}

/** Put the real names back: "Tom, wait!" → "Setchan, wait!". */
export function restoreNames(en: string, names: ProtectedLine["names"]): string {
  let out = en;
  for (const n of names) out = out.replace(new RegExp(`\\b${n.en}\\b`, "g"), n.name);
  return out;
}
