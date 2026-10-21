"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Clip } from "@/lib/types";
import { formatTime } from "@/lib/captions";
import { cx, formatBytes, slugify } from "@/lib/client";
import { activeJobs, useBlobUrl, useJob } from "@/lib/browser/store";
import { exportAndDownload, refreshProgress, retryProject } from "@/lib/browser/pipeline";
import ProcessingPanel from "./ProcessingPanel";
import AnalysisPanel from "./AnalysisPanel";
import ClipCard from "./ClipCard";
import ClipEditor from "./ClipEditor";

type Filter = "all" | "15" | "30" | "60" | "twist";
type Sort = "score" | "time";

export default function JobView({ id }: { id: string }) {
  const { job, loading } = useJob(id);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("score");
  const [openId, setOpenId] = useState<string | null>(null);
  const srcUrl = useBlobUrl(id, job ? "source" : undefined, job?.source?.converted ? 1 : 0);
  const processing = job?.status === "processing" || job?.status === "queued";

  // Smoothly advance time-based progress/ETA while this tab is processing.
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => refreshProgress(id), 1000);
    return () => clearInterval(t);
  }, [id, processing]);

  // Warn before closing the tab mid-processing (work happens in this tab).
  useEffect(() => {
    if (!processing) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [processing]);

  const download = useCallback(
    (c: Clip) => {
      exportAndDownload(id, c.id, `${String(c.rank).padStart(2, "0")}-${slugify(c.title)}-9x16.mp4`);
    },
    [id],
  );

  const clips = useMemo(() => {
    if (!job) return [];
    let list = job.clips;
    if (filter === "twist") list = list.filter((c) => c.hasPlotTwist);
    else if (filter !== "all") list = list.filter((c) => c.targetDuration === Number(filter));
    return [...list].sort((a, b) => (sort === "score" ? b.viralScore - a.viralScore : a.start - b.start));
  }, [job, filter, sort]);

  if (!job) {
    return (
      <div className="mx-auto max-w-7xl px-5 py-16">
        {!loading ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
            <p className="font-semibold text-danger">Project not found in this browser.</p>
            <p className="mt-1 text-sm text-black/50">Projects are stored locally on the device and browser where they were created.</p>
            <Link href="/" className="mt-3 inline-block text-sm underline">
              Back to projects
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="h-10 w-1/3 animate-pulse rounded-lg bg-black/5" />
            <div className="h-56 animate-pulse rounded-2xl bg-black/5" />
          </div>
        )}
      </div>
    );
  }

  const openClip = job.clips.find((c) => c.id === openId);
  const counts = {
    all: job.clips.length,
    "15": job.clips.filter((c) => c.targetDuration === 15).length,
    "30": job.clips.filter((c) => c.targetDuration === 30).length,
    "60": job.clips.filter((c) => c.targetDuration === 60).length,
    twist: job.clips.filter((c) => c.hasPlotTwist).length,
  };

  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link href="/" className="text-xs font-medium text-black/45 hover:text-black">
            ← All projects
          </Link>
          <h1 className="mt-1 truncate text-3xl font-black tracking-tight">{job.name}</h1>
          {job.source && (
            <p className="mt-1 text-sm text-black/50">
              {job.source.duration ? `${formatTime(job.source.duration)} · ` : ""}
              {job.source.width ? `${job.source.width}×${job.source.height} · ` : ""}
              {formatBytes(job.source.size)} · {job.settings.durations.map((d) => `${d}s`).join(" / ")} reels
              {job.source.converted ? " · converted in-browser" : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {job.status === "error" && !activeJobs.has(job.id) && (
            <button onClick={() => retryProject(job.id)} className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-dark">
              Retry processing
            </button>
          )}
          {job.status === "ready" && (
            <div className="flex items-center gap-2 rounded-full bg-success/10 px-4 py-2 text-sm font-semibold text-success">
              <span className="h-2 w-2 rounded-full bg-success" />
              {job.clips.filter((c) => c.status === "ready").length} reels ready
            </div>
          )}
        </div>
      </div>

      {(processing || job.status === "error") && (
        <div className="mb-6">
          <ProcessingPanel job={job} />
          {processing && <p className="mt-2 text-xs text-black/45">Processing runs on this device — keep this tab open until it finishes.</p>}
        </div>
      )}

      {job.warnings.length > 0 && (
        <div className="mb-6 space-y-2">
          {job.warnings.map((w) => (
            <p key={w} className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-accent-dark">
              {w}
            </p>
          ))}
        </div>
      )}

      {job.clips.length > 0 && (
        <section className="mb-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1 rounded-full border border-black/10 p-1">
              {(
                [
                  ["all", "All clips"],
                  ["15", "15s"],
                  ["30", "30s"],
                  ["60", "60s"],
                  ["twist", "Plot twists"],
                ] as [Filter, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  disabled={!counts[f]}
                  className={cx(
                    "rounded-full px-3.5 py-1.5 text-sm font-medium transition disabled:opacity-30",
                    filter === f ? (f === "twist" ? "bg-danger text-white" : "bg-ink text-white") : "text-black/60 hover:text-black",
                  )}
                >
                  {label} <span className="ml-0.5 text-xs opacity-60">{counts[f]}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm text-black/50">
              Sort by
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg border border-black/15 bg-white px-2 py-1.5 text-ink outline-none">
                <option value="score">Viral score</option>
                <option value="time">Timeline</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {clips.map((c) => (
              <ClipCard key={c.id} jobId={job.id} clip={c} srcUrl={srcUrl} onOpen={() => setOpenId(c.id)} onDownload={() => download(c)} />
            ))}
          </div>
        </section>
      )}

      {job.source && (job.analysis || processing) && <AnalysisPanel job={job} srcUrl={srcUrl} onOpenClip={(cid) => setOpenId(cid)} />}

      {openClip && srcUrl && (
        <ClipEditor key={openClip.id} jobId={job.id} clip={openClip} srcUrl={srcUrl} onClose={() => setOpenId(null)} onDownload={() => download(openClip)} />
      )}
    </div>
  );
}
