"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cx, formatBytes, slugify } from "@/lib/client";
import { ProgressBar } from "@/components/ui";
import { type BackgroundMode, type SubtitleLayout, type AnimeSubtitle } from "@/lib/anime/types";
import { withRomaji } from "@/lib/anime/romaji";
import { formatTime } from "@/lib/anime/subtitles";
import { ANIME_WHISPER_MODELS, exportAnimeVideo, generateSubtitles, prepareVideo, type AnimeWhisperModel, type PreparedVideo } from "@/lib/anime/generate";
import { serverCaps } from "@/lib/browser/pipeline";
import { Chip, LayoutPicker, downloadBlob } from "@/components/AnimeControls";
import { ANIME_ACCEPT, Card } from "@/components/AnimeClipper";

const LENGTHS = [
  { seconds: 30, label: "30 s" },
  { seconds: 60, label: "60 s" },
  { seconds: 120, label: "2 min" },
] as const;

/** A trailing piece shorter than this is dropped instead of becoming its own clip. */
const MIN_LAST_SEGMENT = 1;

type SegmentStatus = "pending" | "subtitles" | "rendering" | "done" | "error" | "skipped";
interface Segment {
  index: number;
  start: number;
  end: number;
  status: SegmentStatus;
  progress: number;
  note?: string;
  size?: number;
}

type DirHandle = { getFileHandle: (name: string, o: { create: boolean }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>; name: string };

function splitRanges(duration: number, length: number) {
  const out: { start: number; end: number }[] = [];
  for (let s = 0; s < duration; s += length) {
    const e = Math.min(duration, s + length);
    if (e - s >= MIN_LAST_SEGMENT || out.length === 0) out.push({ start: s, end: e });
  }
  return out;
}

/** Split a whole video into back-to-back fixed-length 9:16 reels (30 s, 60 s or 2 min), optionally with subtitles. */
export default function AnimeSplitter() {
  const [file, setFile] = useState<File | null>(null);
  const [video, setVideo] = useState<PreparedVideo | null>(null);
  const [length, setLength] = useState<number>(60);
  const [withSubs, setWithSubs] = useState(true);
  const [layout, setLayout] = useState<SubtitleLayout>("both");
  const [background, setBackground] = useState<BackgroundMode>("blur");
  const [romaji, setRomaji] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [model, setModel] = useState<AnimeWhisperModel | "cloud">("small");
  const [cloudModel, setCloudModel] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<{ detail: string; progress?: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [folder, setFolder] = useState<DirHandle | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    serverCaps().then((c) => {
      if (!alive || !c.cloudJapanese) return;
      setCloudModel(c.speechModel ?? "Gemini");
      setModel((m) => (m === "small" ? "cloud" : m));
    });
    return () => {
      alive = false;
    };
  }, []);

  const duration = video?.info.duration ?? 0;
  const planned = video ? splitRanges(duration, length) : [];
  const busy = running || !!preparing;
  const [canPickFolder, setCanPickFolder] = useState(false);
  useEffect(() => setCanPickFolder("showDirectoryPicker" in window), []);
  const baseName = slugify(file?.name.replace(/\.[^.]+$/, "") || "anime");

  const pick = useCallback(async (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name)) {
      setError("Please choose a video file (MP4, MOV, WebM, MKV or AVI).");
      return;
    }
    setError(null);
    setNotes([]);
    setSegments([]);
    setFile(f);
    setVideo(null);
    setPreparing({ detail: "Reading video…" });
    try {
      const v = await prepareVideo(f, (detail, progress) => setPreparing({ detail, progress }));
      setVideo(v);
      if (v.converted) setNotes(["This format isn't playable in browsers, so it was converted to MP4 on your device."]);
      if (!v.info.hasAudio) setNotes((n) => [...n, "This video has no audio track, so clips will be exported without subtitles."]);
    } catch (e) {
      setError((e as Error).message);
      setFile(null);
    } finally {
      setPreparing(null);
    }
  }, []);

  const chooseFolder = async () => {
    try {
      const dir = await (window as unknown as { showDirectoryPicker: (o?: { mode: string }) => Promise<DirHandle> }).showDirectoryPicker({ mode: "readwrite" });
      setFolder(dir);
    } catch {
      // user cancelled
    }
  };

  const save = async (blob: Blob, name: string) => {
    if (folder) {
      const handle = await folder.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      downloadBlob(blob, name);
    }
  };

  const patch = (index: number, p: Partial<Segment>) => setSegments((cur) => cur.map((s) => (s.index === index ? { ...s, ...p } : s)));

  const run = async () => {
    if (!video || !planned.length) return;
    const ranges = planned;
    const subtitles = withSubs && video.info.hasAudio;
    setError(null);
    setNotes([]);
    setRunning(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSegments(ranges.map((r, i) => ({ index: i, start: r.start, end: r.end, status: "pending", progress: 0 })));
    const pad = String(ranges.length).length;
    let ok = 0;
    try {
      for (let i = 0; i < ranges.length; i++) {
        if (ctrl.signal.aborted) break;
        const { start, end } = ranges[i];
        let subs: AnimeSubtitle[] = [];
        let note: string | undefined;
        if (subtitles) {
          patch(i, { status: "subtitles", progress: 0 });
          try {
            const r = await generateSubtitles({
              file: video.file,
              start,
              end,
              whisperModel: model,
              title: file?.name,
              onStatus: (_d, p) => p !== undefined && patch(i, { progress: p }),
            });
            subs = romaji ? await withRomaji(r.subtitles) : r.subtitles;
          } catch (e) {
            note = /No Japanese speech/i.test((e as Error).message) ? "No speech — exported without subtitles" : `Subtitles failed: ${(e as Error).message.slice(0, 100)}`;
          }
        }
        if (ctrl.signal.aborted) break;
        patch(i, { status: "rendering", progress: 0, note });
        try {
          const blob = await exportAnimeVideo(
            { file: video.file, start, end, subtitles: subs, layout, background, romaji, fontScale, hasAudio: video.info.hasAudio, audioFallback: video.audioFallback },
            (f) => patch(i, { progress: f }),
            ctrl.signal,
          );
          await save(blob, `${baseName}-part${String(i + 1).padStart(pad, "0")}.mp4`);
          patch(i, { status: "done", progress: 1, size: blob.size });
          ok++;
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") break;
          patch(i, { status: "error", note: `Export failed: ${(e as Error).message.slice(0, 120)}` });
        }
      }
    } finally {
      const cancelled = ctrl.signal.aborted;
      setSegments((cur) => cur.map((s) => (s.status === "done" || s.status === "error" ? s : { ...s, status: "skipped", progress: 0 })));
      setNotes([`${cancelled ? "Cancelled. " : ""}Saved ${ok} of ${ranges.length} clips${folder ? ` to “${folder.name}”` : ""}.`]);
      abort.current = null;
      setRunning(false);
    }
  };

  const done = segments.filter((s) => s.status === "done").length;
  // With subtitles, each clip is half subtitle generation and half rendering.
  const subShare = withSubs && video?.info.hasAudio ? 0.5 : 0;
  const segmentProgress = (s: Segment) =>
    s.status === "done" ? 1 : s.status === "subtitles" ? subShare * s.progress : s.status === "rendering" ? subShare + (1 - subShare) * s.progress : 0;
  const overall = segments.length ? segments.reduce((a, s) => a + segmentProgress(s), 0) / segments.length : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card step={1} title="Video">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!busy) pick(e.dataTransfer.files?.[0]);
          }}
          onClick={() => !busy && picker.current?.click()}
          className={cx(
            "flex cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed px-5 py-6 transition",
            drag ? "border-accent bg-accent/5" : "border-black/15 hover:border-black/40",
            busy && "cursor-default opacity-70",
          )}
        >
          <input ref={picker} type="file" accept={ANIME_ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-black text-white">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            {file && video ? (
              <>
                <p className="truncate font-semibold">{file.name}</p>
                <p className="text-sm text-black/50">
                  {video.info.width}×{video.info.height} · {formatTime(duration, 0)} · {formatBytes(file.size)} · click to change
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">Drop an anime episode or movie here, or click to browse</p>
                <p className="text-sm text-black/50">The whole video is cut into back-to-back clips · processed in your browser</p>
              </>
            )}
          </div>
        </div>
        {preparing && <Progress detail={preparing.detail} progress={preparing.progress} />}
      </Card>

      <Card step={2} title="Clip length" disabled={!video || running}>
        <div className="flex flex-wrap items-center gap-2">
          {LENGTHS.map((l) => (
            <Chip key={l.seconds} active={length === l.seconds} onClick={() => setLength(l.seconds)}>
              {l.label}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-xs text-black/50">
          {video
            ? `${formatTime(duration, 0)} video → ${planned.length} clip${planned.length === 1 ? "" : "s"} of ${LENGTHS.find((l) => l.seconds === length)?.label}${duration % length >= MIN_LAST_SEGMENT && planned.length > 1 ? ` (last one ${formatTime(duration % length, 0)})` : ""}.`
            : "Add a video first."}
        </p>
      </Card>

      <Card step={3} title="Subtitles" disabled={!video || running}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={withSubs} onClick={() => setWithSubs(true)}>
            With subtitles
          </Chip>
          <Chip active={!withSubs} onClick={() => setWithSubs(false)}>
            No subtitles
          </Chip>
        </div>
        {withSubs ? (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ANIME_WHISPER_MODELS) as AnimeWhisperModel[]).map((m) => (
                <Chip key={m} active={model === m} onClick={() => setModel(m)} title={ANIME_WHISPER_MODELS[m].note}>
                  {ANIME_WHISPER_MODELS[m].label}
                </Chip>
              ))}
              {cloudModel && (
                <Chip active={model === "cloud"} onClick={() => setModel("cloud")} title={`${cloudModel} listens to the audio and translates it`}>
                  Cloud AI (Gemini)
                </Chip>
              )}
              <span className="text-xs text-black/45">{model === "cloud" ? `${cloudModel} listens to each clip and translates it` : ANIME_WHISPER_MODELS[model].note}</span>
            </div>
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
            <p className="text-xs text-black/45">Japanese speech in every clip is recognised, given furigana and translated to English. This takes longer than exporting without subtitles.</p>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-black/45">Letterbox fill</span>
            <Chip active={background === "blur"} onClick={() => setBackground("blur")}>
              Blurred video
            </Chip>
            <Chip active={background === "dark"} onClick={() => setBackground("dark")}>
              Solid dark
            </Chip>
          </div>
        )}
      </Card>

      <Card step={4} title="Export" disabled={!video}>
        {canPickFolder && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <button type="button" disabled={running} onClick={chooseFolder} className="rounded-full border border-black/15 px-4 py-2 font-medium hover:border-black disabled:opacity-40">
              {folder ? "Change folder" : "Choose save folder"}
            </button>
            <span className="text-xs text-black/50">{folder ? `Clips are saved straight into “${folder.name}”.` : "Optional — otherwise each clip is downloaded as soon as it's ready."}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!video || busy || !planned.length}
            onClick={run}
            className="rounded-full bg-ink px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export {planned.length || ""} clip{planned.length === 1 ? "" : "s"} (1080×1920 MP4)
          </button>
          {running && (
            <button type="button" onClick={() => abort.current?.abort()} className="rounded-full border border-black/15 px-4 py-2 text-sm font-medium hover:border-black">
              Cancel
            </button>
          )}
        </div>
        {!folder && planned.length > 1 && <p className="mt-2 text-xs text-black/45">Your browser may ask once to allow multiple downloads from this site.</p>}
        {segments.length > 0 && (
          <div className="mt-4">
            {running && <Progress detail={`Clip ${Math.min(done + 1, segments.length)} of ${segments.length}`} progress={overall} />}
            <ul className="mt-3 max-h-96 divide-y divide-black/5 overflow-y-auto rounded-xl border border-black/10 text-sm">
              {segments.map((s) => (
                <li key={s.index} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-14 shrink-0 font-semibold tabular-nums">#{s.index + 1}</span>
                  <span className="w-28 shrink-0 tabular-nums text-black/55">
                    {formatTime(s.start, 0)}–{formatTime(s.end, 0)}
                  </span>
                  <span className={cx("min-w-0 flex-1 truncate", s.status === "error" ? "text-danger" : "text-black/60")}>
                    {statusLabel(s)}
                    {s.note ? ` · ${s.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {error && <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}
      {notes.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-black/10 bg-black/[0.02] px-4 py-3 text-sm text-black/70">
          {notes.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function statusLabel(s: Segment) {
  switch (s.status) {
    case "pending":
      return "Waiting";
    case "subtitles":
      return `Making subtitles… ${Math.round(s.progress * 100)}%`;
    case "rendering":
      return `Rendering… ${Math.round(s.progress * 100)}%`;
    case "done":
      return `Saved${s.size ? ` · ${formatBytes(s.size)}` : ""}`;
    case "skipped":
      return "Not exported";
    case "error":
      return "Failed";
  }
}

function Progress({ detail, progress }: { detail: string; progress?: number }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between text-xs text-black/55">
        <span>{detail}</span>
        {progress !== undefined && <span className="tabular-nums">{Math.round(progress * 100)}%</span>}
      </div>
      <ProgressBar value={progress ?? 0.05} />
    </div>
  );
}
