/** One run of Japanese text. `ruby` (hiragana reading) is set only for runs that contain kanji. */
export interface RubySegment {
  text: string;
  ruby?: string;
}

/** A timestamped bilingual subtitle. Times are absolute seconds in the source video. */
export interface AnimeSubtitle {
  id: string;
  start: number;
  end: number;
  ja: RubySegment[];
  en: string;
}

/**
 * Subtitle stack options.
 *  both    = A: Japanese + furigana above English
 *  ja      = B: Japanese + furigana only
 *  en      = C: English only
 *  swapped = D: English above Japanese + furigana
 */
export type SubtitleLayout = "both" | "ja" | "en" | "swapped";

export type BackgroundMode = "blur" | "dark";

export interface AnimeRenderOptions {
  layout: SubtitleLayout;
  background: BackgroundMode;
}

export const SUBTITLE_LAYOUTS: { id: SubtitleLayout; label: string; letter: string; hint: string }[] = [
  { id: "both", letter: "A", label: "Japanese + English", hint: "Japanese with furigana on top, English below" },
  { id: "ja", letter: "B", label: "Japanese only", hint: "Japanese with furigana" },
  { id: "en", letter: "C", label: "English only", hint: "English translation" },
  { id: "swapped", letter: "D", label: "English + Japanese", hint: "English on top, Japanese with furigana below" },
];

/** Portable JSON document (what "Download JSON" saves and "Import JSON" reads). */
export interface AnimeSubtitleFile {
  version: 1;
  sourceLanguage: "ja";
  targetLanguage: "en";
  video?: { name?: string; duration?: number };
  clip?: { start: number; end: number };
  subtitles: {
    id: string;
    start: number;
    end: number;
    /** Plain Japanese text. */
    text: string;
    /** The same text with standard ruby markup: `<ruby>漢<rt>かん</rt></ruby>字`. */
    ruby: string;
    /** Structured form of `ruby`. */
    segments: RubySegment[];
    en: string;
  }[];
}
