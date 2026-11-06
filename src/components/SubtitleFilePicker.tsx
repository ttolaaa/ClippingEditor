"use client";

import { useRef, useState } from "react";
import { cx } from "@/lib/client";
import { detectCueLanguage, offsetCues, readSubtitleFile, type Cue } from "@/lib/anime/subfile";

export interface SubFileEntry {
  name: string;
  cues: Cue[];
  lang: "ja" | "en";
  /** Seconds added to every cue (for files timed against a slightly different cut). */
  offset: number;
}

/** Combine picked files into Japanese / English cue lists (offsets applied). */
export function cuesFromEntries(entries: SubFileEntry[]): { ja?: Cue[]; en?: Cue[] } {
  const pick = (lang: "ja" | "en") => {
    const all = entries.filter((e) => e.lang === lang).flatMap((e) => offsetCues(e.cues, e.offset));
    return all.length ? all.sort((a, b) => a.start - b.start) : undefined;
  };
  return { ja: pick("ja"), en: pick("en") };
}

const ACCEPT = ".srt,.vtt,.ass,.ssa,.txt,.json,text/plain,text/vtt,application/json";
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Pick Japanese and/or English subtitle/transcript files; the language is detected and can be changed. */
export default function SubtitleFilePicker({
  value,
  onChange,
  compact,
}: {
  value: SubFileEntry[];
  onChange: (v: SubFileEntry[]) => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const next = [...value];
    for (const f of Array.from(files)) {
      try {
        const cues = await readSubtitleFile(f);
        const detected = detectCueLanguage(cues);
        next.push({ name: f.name, cues, lang: detected === "en" ? "en" : "ja", offset: 0 });
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      }
    }
    onChange(next);
  };

  const update = (i: number, patch: Partial<SubFileEntry>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {value.map((e, i) => (
            <li key={`${e.name}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium" title={e.name}>
                {e.name}
              </span>
              <span className="text-xs text-black/50">
                {e.cues.length} lines · {fmt(e.cues[0]?.start ?? 0)}–{fmt(e.cues[e.cues.length - 1]?.end ?? 0)}
              </span>
              <select
                value={e.lang}
                onChange={(ev) => update(i, { lang: ev.target.value as "ja" | "en" })}
                className="rounded-md border border-black/15 bg-white px-1.5 py-0.5 text-xs"
                aria-label="Subtitle language"
              >
                <option value="ja">Japanese</option>
                <option value="en">English</option>
              </select>
              <label className="flex items-center gap-1 text-xs text-black/55" title="Shift every line if the file is timed for a slightly different version of the video">
                Offset
                <input
                  type="number"
                  step={0.1}
                  value={e.offset}
                  onChange={(ev) => update(i, { offset: Number(ev.target.value) || 0 })}
                  className="w-16 rounded-md border border-black/15 bg-white px-1.5 py-0.5 text-xs tabular-nums"
                />
                s
              </label>
              <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-xs text-danger hover:underline">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => input.current?.click()}
        className={cx("rounded-full border border-dashed border-black/25 px-4 py-1.5 text-sm font-medium hover:border-black", compact && "px-3 py-1 text-xs")}
      >
        + Add subtitle / transcript file
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
