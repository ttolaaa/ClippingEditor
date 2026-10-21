"use client";

import { useEffect, useRef, useState } from "react";
import type { Clip, Job, PlotTwist } from "@/lib/types";
import { formatTime } from "@/lib/captions";
import { cx } from "@/lib/client";
import { getData } from "@/lib/browser/store";
import { Tag } from "./ui";

export default function AnalysisPanel({ job, srcUrl, onOpenClip }: { job: Job; srcUrl?: string; onOpenClip: (id: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [interest, setInterest] = useState<number[] | null>(null);
  const [time, setTime] = useState(0);
  const duration = job.source?.duration || 1;
  const analysis = job.analysis;

  useEffect(() => {
    if (!analysis || interest) return;
    getData<{ interest: number[] }>(job.id, "timeline")
      .then((d) => d && setInterest(d.interest))
      .catch(() => undefined);
  }, [analysis, interest, job.id]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t);
    v.play().catch(() => undefined);
  };

  if (!job.source) return null;
  const rows = [15, 30, 60].filter((d) => job.clips.some((c) => c.targetDuration === d));

  return (
    <div className="grid gap-5 rounded-2xl border border-black/10 bg-white p-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            src={srcUrl}
            controls
            preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            className="aspect-video w-full bg-black"
          />
        </div>
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-black/45">
            <span>Engagement heatmap</span>
            <span className="tabular-nums">{formatTime(duration)}</span>
          </div>
          <div
            className="relative h-10 cursor-pointer overflow-hidden rounded-md bg-black/5"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              seek(((e.clientX - r.left) / r.width) * duration);
            }}
          >
            {interest && (
              <svg viewBox={`0 0 ${interest.length} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                <path
                  d={`M0,100 ${interest.map((v, i) => `L${i},${100 - Math.min(1, v) * 95}`).join(" ")} L${interest.length},100 Z`}
                  fill="rgba(10,10,10,0.85)"
                />
              </svg>
            )}
            {analysis?.plotTwists.map((t, i) => (
              <span key={i} className="absolute top-0 h-full w-0.5 bg-danger" style={{ left: `${(t.time / duration) * 100}%` }} />
            ))}
            <span className="absolute top-0 h-full w-0.5 bg-accent" style={{ left: `${(time / duration) * 100}%` }} />
          </div>
          <div className="mt-2 space-y-1">
            {rows.map((d) => (
              <div key={d} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-[11px] font-semibold text-black/45 tabular-nums">{d}s</span>
                <div className="relative h-4 flex-1 rounded bg-black/[0.04]">
                  {job.clips
                    .filter((c) => c.targetDuration === d)
                    .map((c) => (
                      <ClipRange key={c.id} clip={c} duration={duration} onClick={() => onOpenClip(c.id)} />
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">AI analysis</h3>
          {analysis && (
            <>
              <Tag tone="success">{analysis.aiProvider === "cloud" ? "On-device + GPT" : "On-device AI"}</Tag>
              <Tag tone={analysis.transcriptProvider === "none" ? "danger" : "neutral"}>
                {analysis.transcriptProvider === "cloud" ? "Whisper API" : analysis.transcriptProvider === "browser" ? "In-browser Whisper" : "No transcript"}
              </Tag>
              {job.engine && <Tag>{job.engine}</Tag>}
            </>
          )}
        </div>
        <p className="mt-2 text-sm text-black/60">{analysis?.summary ?? "Analysis results will appear here once the video has been processed."}</p>

        <div className="mt-5 flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid h-5 w-5 place-items-center rounded bg-danger text-[10px] font-black text-white">!</span>
            Plot twists &amp; reveals
          </h4>
          <span className="text-xs text-black/45">{analysis?.plotTwists.length ?? 0} detected</span>
        </div>
        <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {analysis?.plotTwists.length ? (
            [...analysis.plotTwists]
              .sort((a, b) => b.confidence - a.confidence)
              .map((t, i) => <TwistRow key={i} twist={t} onClick={() => seek(t.time - 3)} />)
          ) : (
            <li className="rounded-lg border border-dashed border-black/15 px-3 py-4 text-center text-xs text-black/45">
              {analysis ? "No strong twists detected in this video." : "Waiting for analysis…"}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function TwistRow({ twist, onClick }: { twist: PlotTwist; onClick: () => void }) {
  const pct = Math.round(twist.confidence * 100);
  return (
    <li>
      <button onClick={onClick} className="group flex w-full items-start gap-3 rounded-lg border border-black/10 px-3 py-2 text-left transition hover:border-danger/50">
        <span className="mt-0.5 rounded bg-black px-1.5 py-0.5 font-mono text-[11px] text-white tabular-nums group-hover:bg-danger">{formatTime(twist.time)}</span>
        <span className="min-w-0 flex-1 text-xs text-black/70">
          <span className="line-clamp-2">{twist.reason}</span>
          <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-black/40">via {twist.source}</span>
        </span>
        <span className={cx("text-xs font-bold tabular-nums", pct >= 75 ? "text-danger" : pct >= 55 ? "text-accent" : "text-black/40")}>{pct}%</span>
      </button>
    </li>
  );
}

function ClipRange({ clip, duration, onClick }: { clip: Clip; duration: number; onClick: () => void }) {
  return (
    <button
      title={`#${clip.rank} · ${clip.title} · score ${clip.viralScore}`}
      onClick={onClick}
      className={cx(
        "absolute top-0 h-full rounded-sm border transition hover:z-10 hover:scale-y-125",
        clip.hasPlotTwist ? "border-danger bg-danger/70" : clip.viralScore >= 80 ? "border-success bg-success/70" : "border-accent bg-accent/70",
      )}
      style={{ left: `${(clip.start / duration) * 100}%`, width: `${Math.max(0.6, ((clip.end - clip.start) / duration) * 100)}%` }}
    />
  );
}
