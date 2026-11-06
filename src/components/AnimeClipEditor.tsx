"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnimeClipData, Clip } from "@/lib/types";
import type { AnimeSubtitle } from "@/lib/anime/types";
import { formatTime } from "@/lib/captions";
import { slugify } from "@/lib/client";
import { updateClip } from "@/lib/browser/store";
import { cancelExport } from "@/lib/browser/pipeline";
import { newSubtitleId, sortSubtitles, toSubtitleFile } from "@/lib/anime/subtitles";
import AnimePreview, { type AnimePreviewHandle } from "./AnimePreview";
import { LayoutPicker, SubtitleRow, downloadBlob } from "./AnimeControls";
import { ScoreRing, Tag, tagTone } from "./ui";

/** Editor for one Anime Clipper clip: bilingual subtitles, layout, and export. Edits are saved to this browser. */
export default function AnimeClipEditor({
  jobId,
  clip,
  srcUrl,
  onClose,
  onDownload,
}: {
  jobId: string;
  clip: Clip;
  srcUrl: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  const data: AnimeClipData = clip.anime ?? { layout: "both", background: "blur", subtitles: [] };
  const [now, setNow] = useState(clip.start);
  const [playing, setPlaying] = useState(false);
  const player = useRef<AnimePreviewHandle>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastTick = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const save = (patch: Partial<AnimeClipData>) => updateClip(jobId, clip.id, (c) => (c.anime = { ...data, ...c.anime, ...patch }));
  const setSubs = (subs: AnimeSubtitle[]) => save({ subtitles: sortSubtitles(subs) });

  const activeId = useMemo(() => data.subtitles.find((s) => now >= s.start && now < s.end)?.id, [data.subtitles, now]);
  useEffect(() => {
    if (!playing || !activeId) return;
    listRef.current?.querySelector(`[data-sub="${activeId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId, playing]);

  const addAtPlayhead = () => {
    const t = Math.max(clip.start, Math.min(now, clip.end - 0.5));
    setSubs([...data.subtitles, { id: newSubtitleId(), start: t, end: Math.min(clip.end, t + 2.5), ja: [], en: "" }]);
  };

  const exportJson = () => {
    const doc = toSubtitleFile(data.subtitles, { name: clip.title, clip: { start: clip.start, end: clip.end } });
    downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), `${String(clip.rank).padStart(2, "0")}-${slugify(clip.title)}-subtitles.json`);
  };

  const exporting = clip.export.status === "rendering";
  const toReview = data.subtitles.filter((s) => s.review).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-0 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-white sm:h-[94vh] sm:rounded-2xl lg:flex-row" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 flex-col items-center justify-center gap-3 bg-ink p-4 lg:p-6">
          <div className="relative aspect-[9/16] h-[52vh] overflow-hidden rounded-xl bg-black shadow-2xl lg:h-[calc(94vh-7.5rem)]" onClick={() => player.current?.toggle()}>
            <AnimePreview
              ref={player}
              src={srcUrl}
              start={clip.start}
              end={clip.end}
              layout={data.layout}
              background={data.background}
              subtitles={data.subtitles}
              className="h-full w-full"
              onTime={(t) => {
                const ts = performance.now();
                if (ts - lastTick.current < 90) return;
                lastTick.current = ts;
                setNow(t);
              }}
              onPlayingChange={setPlaying}
            />
            {!playing && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-ink shadow-lg">
                  <svg viewBox="0 0 24 24" className="ml-1 h-7 w-7" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </div>
            )}
          </div>
          <div className="flex w-full max-w-[min(100%,calc((94vh-7.5rem)*9/16))] items-center gap-3 text-white">
            <input
              type="range"
              min={clip.start}
              max={clip.end}
              step={0.05}
              value={Math.min(clip.end, Math.max(clip.start, now))}
              onChange={(e) => player.current?.seek(Number(e.target.value))}
              className="w-full"
              aria-label="Playhead"
            />
            <span className="shrink-0 text-xs tabular-nums text-white/60">
              {formatTime(Math.max(0, now - clip.start))} / {formatTime(clip.duration)}
            </span>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-4 border-b border-black/10 px-5 py-4">
            <ScoreRing score={clip.viralScore} size={52} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-black/45">
                #{clip.rank} · {clip.targetDuration}s reel · {formatTime(clip.start)}–{formatTime(clip.end)}
              </p>
              <h2 className="truncate text-lg font-bold">{clip.title}</h2>
              <div className="mt-1 flex flex-wrap gap-1">
                {clip.hasPlotTwist && <Tag tone="danger">plot twist @ {formatTime(clip.twistAt ?? 0)}</Tag>}
                {clip.tags
                  .filter((t) => t !== "plot twist")
                  .map((t) => (
                    <Tag key={t} tone={tagTone(t)}>
                      {t}
                    </Tag>
                  ))}
              </div>
              {clip.reason && <p className="mt-1.5 text-xs text-black/50">{clip.reason}</p>}
            </div>
            <button onClick={onClose} className="rounded-full p-2 text-black/40 hover:bg-black/5 hover:text-black" aria-label="Close">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/45">Subtitle layout</h3>
            <LayoutPicker compact layout={data.layout} background={data.background} onLayout={(layout) => save({ layout })} onBackground={(background) => save({ background })} />

            <div className="mb-2 mt-6 flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-xs font-semibold uppercase tracking-wider text-black/45">
                Subtitles · {data.subtitles.length}
                {toReview > 0 && (
                  <button
                    type="button"
                    onClick={() => listRef.current?.querySelector("[data-review]")?.scrollIntoView({ block: "center", behavior: "smooth" })}
                    className="ml-2 rounded-full bg-amber-400 px-2 py-0.5 normal-case tracking-normal text-amber-950 hover:bg-amber-300"
                  >
                    {toReview} need{toReview === 1 ? "s" : ""} review
                  </button>
                )}
              </h3>
              <button type="button" onClick={addAtPlayhead} className="rounded-full border border-black/15 px-3 py-1 text-xs font-medium hover:border-black">
                + Add line at playhead
              </button>
              <button
                type="button"
                disabled={!data.subtitles.length}
                onClick={exportJson}
                className="rounded-full border border-black/15 px-3 py-1 text-xs font-medium hover:border-black disabled:opacity-40"
              >
                Download JSON
              </button>
            </div>
            {!data.subtitles.length ? (
              <p className="rounded-xl border border-dashed border-black/15 px-4 py-6 text-center text-sm text-black/50">
                No speech was recognised in this clip. Add lines at the playhead to subtitle it by hand.
              </p>
            ) : (
              <ul ref={listRef} className="space-y-2">
                {data.subtitles.map((s) => (
                  <SubtitleRow
                    key={s.id}
                    sub={s}
                    active={s.id === activeId}
                    outside={s.end <= clip.start || s.start >= clip.end}
                    onChange={(next) => setSubs(data.subtitles.map((x) => (x.id === s.id ? next : x)))}
                    onDelete={() => setSubs(data.subtitles.filter((x) => x.id !== s.id))}
                    onSeek={() => player.current?.seek(Math.max(s.start, clip.start))}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-black/10 px-5 py-3">
            <span className="flex items-center gap-1.5 text-xs text-black/50">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Saved on this device
            </span>
            <div className="ml-auto flex items-center gap-3">
              {exporting && (
                <button onClick={() => cancelExport(clip.id)} className="text-xs font-medium text-black/50 hover:text-danger">
                  Cancel
                </button>
              )}
              <button
                onClick={onDownload}
                disabled={exporting}
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-dark disabled:cursor-wait disabled:opacity-70"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14" />
                </svg>
                {exporting ? `Rendering in browser… ${Math.round(clip.export.progress * 100)}%` : "Download 1080×1920 MP4"}
              </button>
            </div>
          </div>
          {clip.export.status === "error" && <p className="bg-danger/10 px-5 py-2 text-xs text-danger">Export failed: {clip.export.error}</p>}
          {clip.export.status === "ready" && <p className="bg-success/10 px-5 py-2 text-xs text-success">✓ Reel rendered on your device and saved to your downloads.</p>}
        </div>
      </div>
    </div>
  );
}
