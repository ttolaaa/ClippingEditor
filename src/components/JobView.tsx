"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Clip } from "@/lib/types";
import { formatTime } from "@/lib/captions";
import { cx, formatBytes, slugify } from "@/lib/client";
import { activeJobs, useBlobUrl, useJob } from "@/lib/browser/store";
import { cancelExportAll, clipFilename, exportAllAsZip, exportAndDownload, refreshProgress, retryProject, type BatchProgress } from "@/lib/browser/pipeline";
import { describeRules, effectiveRules, hasRules } from "@/lib/engine/rules";
import type { ClipRules } from "@/lib/types";
import ProcessingPanel from "./ProcessingPanel";
import AnalysisPanel from "./AnalysisPanel";
import ClipCard from "./ClipCard";
import ClipEditor from "./ClipEditor";
import AnimeClipEditor from "./AnimeClipEditor";
import SubtitleImportPanel from "./SubtitleImportPanel";

type Filter = "all" | "twist" | `${number}`;
type Sort = "match" | "score" | "time";

const lengthLabel = (d: number) => (d >= 120 && d % 60 === 0 ? `${d / 60} min` : `${d}s`);

export default function JobView({ id }: { id: string }) {
  const { job, loading } = useJob(id);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("match");
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
      exportAndDownload(id, c.id, clipFilename(c));
    },
    [id],
  );

  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const downloadAll = async (list: Clip[]) => {
    if (!job || batch || !list.length) return;
    setBatchNote(null);
    setBatch({ done: 0, total: list.length, current: 0, failed: 0 });
    const zipName = `${slugify(job.name.replace(/\.[^.]+$/, ""))}-${list.length}-reels.zip`;
    try {
      const r = await exportAllAsZip(id, list.map((c) => c.id), zipName, setBatch);
      if (r.cancelled) setBatchNote("Download all was cancelled.");
      else if (!r.saved) setBatchNote("None of the clips could be rendered, so no ZIP was saved.");
      else setBatchNote(`✓ Saved ${r.saved} reel${r.saved === 1 ? "" : "s"} as ${zipName}${r.failed ? ` (${r.failed} failed — see the cards)` : ""}.`);
    } catch (e) {
      setBatchNote(`Download all failed: ${(e as Error).message}`);
    } finally {
      setBatch(null);
    }
  };

  const clips = useMemo(() => {
    if (!job) return [];
    let list = job.clips;
    if (filter === "twist") list = list.filter((c) => c.hasPlotTwist);
    else if (filter !== "all") list = list.filter((c) => c.targetDuration === Number(filter));
    return [...list].sort((a, b) => (sort === "match" ? a.rank - b.rank : sort === "score" ? b.viralScore - a.viralScore : a.start - b.start));
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
  const isAnime = job.settings.kind === "anime";
  const durations = [...job.settings.durations].sort((a, b) => a - b);
  const counts: Record<string, number> = {
    all: job.clips.length,
    twist: job.clips.filter((c) => c.hasPlotTwist).length,
  };
  for (const d of durations) counts[String(d)] = job.clips.filter((c) => c.targetDuration === d).length;
  const filters: [Filter, string][] = [["all", "All clips"], ...durations.map((d) => [String(d) as Filter, lengthLabel(d)] as [Filter, string]), ["twist", "Plot twists"]];

  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link href={isAnime ? "/anime" : "/"} className="text-xs font-medium text-black/45 hover:text-black">
            ← {isAnime ? "Anime projects" : "All projects"}
          </Link>
          <h1 className="mt-1 truncate text-3xl font-black tracking-tight">
            {isAnime && <span className="mr-2 inline-block rounded-md bg-accent px-2 py-0.5 align-middle text-xs font-bold uppercase tracking-wider text-white">Anime</span>}
            {job.name}
          </h1>
          {job.source && (
            <p className="mt-1 text-sm text-black/50">
              {job.source.duration ? `${formatTime(job.source.duration)} · ` : ""}
              {job.source.width ? `${job.source.width}×${job.source.height} · ` : ""}
              {formatBytes(job.source.size)} · {durations.map(lengthLabel).join(" / ")} reels
              {isAnime ? " · Japanese + furigana + English" : ""}
              {job.source.converted ? " · converted in-browser" : ""}
            </p>
          )}
          {hasRules(job.settings.rules) && <RulesSummary rules={job.settings.rules!} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          {job.status === "ready" && clips.some((c) => c.status === "ready") && (
            <DownloadAllButton
              count={clips.filter((c) => c.status === "ready").length}
              filtered={filter !== "all"}
              batch={batch}
              onStart={() => downloadAll(clips.filter((c) => c.status === "ready"))}
              onCancel={cancelExportAll}
            />
          )}
        </div>
      </div>
      {batchNote && (
        <p className={cx("-mt-3 mb-6 text-right text-sm", batchNote.startsWith("✓") ? "text-success" : "text-danger")}>{batchNote}</p>
      )}

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

      {isAnime && job.status === "ready" && job.clips.length > 0 && <SubtitleImportPanel job={job} />}

      {job.clips.length > 0 && (
        <section className="mb-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1 rounded-full border border-black/10 p-1">
              {filters.map(([f, label]) => (
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
                <option value="match">Best match</option>
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

      {openClip && srcUrl && openClip.anime && (
        <AnimeClipEditor key={openClip.id} jobId={job.id} clip={openClip} srcUrl={srcUrl} onClose={() => setOpenId(null)} onDownload={() => download(openClip)} />
      )}
      {openClip && srcUrl && !openClip.anime && (
        <ClipEditor key={openClip.id} jobId={job.id} clip={openClip} srcUrl={srcUrl} onClose={() => setOpenId(null)} onDownload={() => download(openClip)} />
      )}
    </div>
  );
}

function DownloadAllButton({
  count,
  filtered,
  batch,
  onStart,
  onCancel,
}: {
  count: number;
  filtered: boolean;
  batch: BatchProgress | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  if (batch) {
    const overall = Math.min(1, (batch.done + batch.current) / Math.max(1, batch.total));
    return (
      <div className="flex items-center gap-3 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
        <span className="tabular-nums">
          {batch.done >= batch.total ? "Packing ZIP…" : `Rendering ${batch.done + 1} of ${batch.total} · ${Math.round(overall * 100)}%`}
        </span>
        <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-white/20 sm:block">
          <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${overall * 100}%` }} />
        </span>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-white/60 hover:text-white">
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      title="Render every clip and download them together as one ZIP file"
      className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14" />
      </svg>
      {filtered ? `Download ${count} shown` : `Download all ${count}`} (.zip)
    </button>
  );
}

function RulesSummary({ rules }: { rules: ClipRules }) {
  const chips = describeRules(effectiveRules(rules));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1 font-semibold text-accent-dark">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
          <circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="18" r="2" />
        </svg>
        Clipping rules:
      </span>
      {chips.map((c) => (
        <span key={c} className="rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-accent-dark">
          {c}
        </span>
      ))}
      {rules.instructions.trim() && (
        <span className="max-w-md truncate text-black/45" title={rules.instructions}>
          “{rules.instructions.trim()}”
        </span>
      )}
    </div>
  );
}
