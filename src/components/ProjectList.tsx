"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEta, formatTime } from "@/lib/captions";
import { formatBytes } from "@/lib/client";
import { deleteJob, summarize, useBlobUrl, useJobs } from "@/lib/browser/store";
import { storageEstimate } from "@/lib/browser/db";
import type { JobSummary } from "@/lib/types";
import { ProgressBar, ScoreBadge, StatusDot } from "./ui";

export default function ProjectList() {
  const jobs = useJobs();
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    storageEstimate().then(setUsage);
  }, [jobs?.length]);

  const remove = async (id: string) => {
    if (!confirm("Delete this project and its video from your browser?")) return;
    await deleteJob(id);
    storageEstimate().then(setUsage);
  };

  if (jobs === null) return <div className="h-24 animate-pulse rounded-xl bg-black/5" />;
  return (
    <div>
      {usage && usage.quota > 0 && (
        <p className="-mt-2 mb-4 text-xs text-black/45">
          Stored privately in this browser · {formatBytes(usage.usage)} used of {formatBytes(usage.quota)} available
        </p>
      )}
      {!jobs.length ? (
        <div className="rounded-xl border border-dashed border-black/15 px-6 py-10 text-center text-sm text-black/50">
          No projects yet — drop a video above to generate your first reels.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {jobs.map((j) => (
            <ProjectCard key={j.id} job={summarize(j)} onDelete={() => remove(j.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ job: j, onDelete }: { job: JobSummary; onDelete: () => void }) {
  const thumb = useBlobUrl(j.id, j.thumbnail);
  const busy = j.status === "processing" || j.status === "queued";
  return (
    <div className="group relative flex gap-4 rounded-xl border border-black/10 bg-white p-3 transition hover:border-black/40">
      <Link href={`/jobs/${j.id}`} className="absolute inset-0 z-0" aria-label={`Open ${j.name}`} />
      <div className="pointer-events-none relative aspect-[9/16] w-16 shrink-0 overflow-hidden rounded-md bg-black">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-white/40">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </div>
      <div className="pointer-events-none min-w-0 flex-1 py-0.5">
        <p className="truncate font-semibold">{j.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-black/50">
          <StatusDot status={j.status} />
          <span className="capitalize">{j.status}</span>
          {j.duration ? <span>· {formatTime(j.duration)}</span> : null}
          <span>· {new Date(j.createdAt).toLocaleDateString()}</span>
        </p>
        {busy ? (
          <div className="mt-3">
            <ProgressBar value={j.progress} />
            <p className="mt-1 text-[11px] text-black/50">
              {Math.round(j.progress * 100)}% · {formatEta(j.etaSeconds)} left
            </p>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-xs text-black/60">
            <span>{j.clipCount} clips</span>
            {j.topScore !== undefined && <ScoreBadge score={j.topScore} />}
          </div>
        )}
      </div>
      {!busy && (
        <button
          onClick={onDelete}
          className="relative z-10 self-start rounded-md p-1 text-black/30 opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
          aria-label="Delete project"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
          </svg>
        </button>
      )}
    </div>
  );
}
