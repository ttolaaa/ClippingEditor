"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cx, formatBytes } from "@/lib/client";
import { createProject, serverCaps } from "@/lib/browser/pipeline";
import { ANIME_QUALITY, type AnimeQuality } from "@/lib/anime/generate";
import type { BackgroundMode, SubtitleLayout } from "@/lib/anime/types";
import { Chip, LayoutPicker } from "./AnimeControls";
import SubtitleFilePicker, { cuesFromEntries, type SubFileEntry } from "./SubtitleFilePicker";

const ACCEPT = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";
const LENGTHS = [
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
  { value: 120, label: "2 min" },
];

/**
 * Auto mode: the whole video is analysed (Japanese speech, audio energy, scene cuts), the most viral moments are cut into
 * ranked 30s / 60s / 2 min clips, and each clip gets Japanese + furigana + English subtitles. Saved as a project.
 */
export default function AnimeAutoPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [durations, setDurations] = useState<number[]>([30, 60, 120]);
  const [perLength, setPerLength] = useState(3);
  const [quality, setQuality] = useState<AnimeQuality>("balanced");
  const [cloudModel, setCloudModel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    serverCaps().then((c) => {
      if (!alive || !c.cloudJapanese) return;
      setCloudModel(c.speechModel ?? "Gemini");
      setQuality((q) => (q === "balanced" ? "cloud" : q));
    });
    return () => {
      alive = false;
    };
  }, []);
  const qualities = (Object.keys(ANIME_QUALITY) as AnimeQuality[]).filter((q) => q !== "cloud" || cloudModel);
  const [subFiles, setSubFiles] = useState<SubFileEntry[]>([]);
  const [layout, setLayout] = useState<SubtitleLayout>("both");
  const [background, setBackground] = useState<BackgroundMode>("blur");
  const [romaji, setRomaji] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name)) {
      setError("Please choose a video file (MP4, MOV, WebM, MKV or AVI).");
      return;
    }
    setError(null);
    setFile(f);
  };

  const start = async () => {
    if (!file || !durations.length) return;
    setSaving(true);
    setError(null);
    try {
      const id = await createProject(file, {
        kind: "anime",
        anime: { layout, background, romaji, fontScale },
        durations,
        maxClipsPerDuration: perLength,
        captionPreset: "bold",
        reframeMode: "fit",
        language: "japanese",
        transcription: "browser",
        whisperModel: ANIME_QUALITY[quality].scan,
        subtitleModel: ANIME_QUALITY[quality].subtitles,
        vad: true,
      }, cuesFromEntries(subFiles));
      router.push(`/jobs/${id}`);
    } catch (e) {
      setError(`Couldn't save the video in your browser: ${(e as Error).message}`);
      setSaving(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04),0_20px_60px_-30px_rgba(0,0,0,0.35)]">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!saving) pick(e.dataTransfer.files?.[0]);
        }}
        onClick={() => !saving && inputRef.current?.click()}
        className={cx(
          "group m-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition",
          drag ? "border-accent bg-accent/5" : "border-black/15 hover:border-black/40",
          saving && "cursor-default",
        )}
      >
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        {!file ? (
          <>
            <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-black text-white transition group-hover:bg-accent">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              </svg>
            </div>
            <p className="text-lg font-semibold">Drop an anime episode or Japanese video</p>
            <p className="mt-1 text-sm text-black/50">MP4, MOV, WebM, MKV or AVI · processed privately in your browser — nothing is uploaded</p>
          </>
        ) : (
          <div className="flex w-full max-w-md items-center gap-4 text-left">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-black text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{file.name}</p>
              <p className="text-sm text-black/50">{formatBytes(file.size)}</p>
            </div>
            {!saving && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="rounded-full px-3 py-1 text-sm text-black/50 hover:bg-black/5 hover:text-black"
              >
                Change
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-5 border-t border-black/10 px-6 py-5 md:grid-cols-2">
        <Field label="Clip lengths">
          <div className="flex flex-wrap gap-2">
            {LENGTHS.map((l) => (
              <Chip
                key={l.value}
                active={durations.includes(l.value)}
                onClick={() => setDurations((cur) => (cur.includes(l.value) ? cur.filter((x) => x !== l.value) : [...cur, l.value].sort((a, b) => a - b)))}
              >
                {l.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label={`Clips per length · ${perLength}`}>
          <input type="range" min={1} max={6} value={perLength} onChange={(e) => setPerLength(Number(e.target.value))} className="w-full" />
        </Field>
        <Field label="Japanese speech recognition">
          <div className="flex flex-wrap items-center gap-2">
            {qualities.map((q) => (
              <Chip key={q} active={quality === q} onClick={() => setQuality(q)} title={ANIME_QUALITY[q].note}>
                {ANIME_QUALITY[q].label}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-black/45">
            {quality === "cloud" ? (
              <>
                {ANIME_QUALITY.cloud.note}. A quick on-device scan finds the viral moments, then the picked clips&apos; audio (only those minutes) is sent
                to {cloudModel}, which writes the Japanese and translates it with the scene&apos;s context.
              </>
            ) : (
              <>
                {ANIME_QUALITY[quality].note}. Music and silence are skipped (only speech is transcribed), then the picked clips are re-transcribed with
                Whisper {ANIME_QUALITY[quality].subtitles} for the subtitles.
              </>
            )}
          </p>
        </Field>
        <Field label="Subtitles">
          <p className="text-sm text-black/60">Japanese + furigana + English translation, generated automatically for every clip. Editable afterwards.</p>
        </Field>
        <div className="md:col-span-2">
          <Field label="Subtitle / transcript files (optional — most accurate)">
            <p className="mb-2 text-xs text-black/50">
              Have the video&apos;s subtitles? Add them (.srt, .vtt, .ass/.ssa, timestamped .txt or JSON). A <b>Japanese</b> file replaces speech recognition, so the
              Japanese is exact and processing is much faster. An <b>English</b> file is used as the translation, line by line. Without an English file the English is
              machine-translated and labelled as such.
            </p>
            <SubtitleFilePicker value={subFiles} onChange={setSubFiles} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Default subtitle layout (can be changed per clip)">
            <LayoutPicker
              layout={layout}
              background={background}
              onLayout={setLayout}
              onBackground={setBackground}
              romaji={romaji}
              onRomaji={setRomaji}
              fontScale={fontScale}
              onFontScale={setFontScale}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-black/10 px-6 py-4">
        <button
          type="button"
          disabled={!file || !durations.length || saving}
          onClick={start}
          className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving video…" : "Find viral anime clips"}
        </button>
        <p className="text-xs text-black/45">
          Everything runs in your browser. The first run downloads the speech and translation models once. A feature-length film takes very roughly
          30–60 minutes on a laptop.
        </p>
        {error && <p className="w-full text-sm text-danger">{error}</p>}
        {!durations.length && <p className="w-full text-sm text-danger">Pick at least one clip length.</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/45">{label}</p>
      {children}
    </div>
  );
}
