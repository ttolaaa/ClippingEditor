"use client";

import { useState } from "react";
import type { Clip } from "@/lib/types";
import { formatTime } from "@/lib/captions";
import { cx } from "@/lib/client";
import { useBlobUrl } from "@/lib/browser/store";
import ReelPlayer from "./ReelPlayer";
import { ProgressBar, ScoreRing, StatusDot, Tag, tagTone } from "./ui";

export default function ClipCard({
  jobId,
  clip,
  srcUrl,
  onOpen,
  onDownload,
}: {
  jobId: string;
  clip: Clip;
  srcUrl?: string;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const [hover, setHover] = useState(false);
  const thumb = useBlobUrl(jobId, clip.thumbnail);
  const ready = clip.status === "ready";
  const exporting = clip.export.status === "rendering";

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-black/10 bg-white transition hover:-translate-y-0.5 hover:border-black/30 hover:shadow-[0_20px_40px_-24px_rgba(0,0,0,0.4)]">
      <button
        onClick={onOpen}
        disabled={!ready}
        className="relative aspect-[9/16] w-full overflow-hidden bg-ink text-left"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {ready ? (
          <>
            {thumb && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" />
            )}
            {hover && srcUrl && (
              <ReelPlayer
                src={srcUrl}
                start={clip.start}
                end={clip.end}
                mode={clip.reframeMode}
                crop={clip.crop}
                captions={clip.captions}
                style={clip.style}
                muted
                autoPlay
                className="absolute inset-0 h-full w-full"
              />
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
            {clip.status === "error" ? (
              <>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-danger text-lg font-bold text-white">!</span>
                <span className="text-xs">Preview failed</span>
              </>
            ) : (
              <>
                <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
                <span className="text-xs">Preparing 9:16 preview</span>
                <ProgressBar value={clip.progress} className="w-2/3 bg-white/10" />
              </>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/70 to-transparent p-3">
          <span className="rounded-md bg-white px-1.5 py-0.5 text-[11px] font-black text-ink">#{clip.rank}</span>
          <div className="rounded-full bg-black/60 p-0.5 backdrop-blur">
            <ScoreRing score={clip.viralScore} size={44} stroke={4} dark />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-3 pt-10">
          <div className="flex flex-wrap gap-1">
            {clip.hasPlotTwist && <span className="rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Plot twist</span>}
            <span className="rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold text-ink">{Math.round(clip.duration)}s</span>
          </div>
          {ready && !hover && (
            <span className="grid h-9 w-9 place-items-center rounded-full bg-white text-ink opacity-0 transition group-hover:opacity-100">
              <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          )}
        </div>
      </button>

      <div className="flex flex-1 flex-col p-4">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-black/45">
          <StatusDot status={clip.status} />
          <span className="tabular-nums">
            {formatTime(clip.start)} – {formatTime(clip.end)}
          </span>
          <span>· {clip.targetDuration}s reel</span>
        </div>
        <h3 className="line-clamp-2 font-semibold leading-snug">{clip.title}</h3>
        <div className="mt-2 flex flex-wrap gap-1">
          {clip.tags.slice(0, 4).map((t) => (
            <Tag key={t} tone={tagTone(t)}>
              {t}
            </Tag>
          ))}
        </div>
        <div className="mt-auto flex gap-2 pt-4">
          <button
            onClick={onOpen}
            disabled={!ready}
            className="flex-1 rounded-full border border-black/15 px-3 py-2 text-sm font-medium transition hover:border-black disabled:opacity-40"
          >
            Edit captions
          </button>
          <button
            onClick={onDownload}
            disabled={!ready || exporting}
            className={cx(
              "inline-flex min-w-[7.5rem] items-center justify-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold text-white transition disabled:cursor-wait",
              exporting ? "bg-accent/80" : "bg-ink hover:bg-accent disabled:bg-black/20",
            )}
          >
            {exporting ? (
              `${Math.round(clip.export.progress * 100)}%`
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14" />
                </svg>
                Download
              </>
            )}
          </button>
        </div>
        {clip.export.status === "error" && <p className="mt-2 text-xs text-danger">Export failed: {clip.export.error}</p>}
        {clip.export.status === "ready" && <p className="mt-2 text-xs text-success">✓ Saved to your downloads</p>}
      </div>
    </div>
  );
}
