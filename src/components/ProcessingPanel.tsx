"use client";

import { useEffect, useState } from "react";
import type { Job } from "@/lib/types";
import { formatEta, formatTime } from "@/lib/captions";
import { cx } from "@/lib/client";
import { StatusDot } from "./ui";

export default function ProcessingPanel({ job }: { job: Job }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const processing = job.status === "processing" || job.status === "queued";
  const elapsed = job.startedAt ? ((job.finishedAt ?? now) - job.startedAt) / 1000 : 0;
  const eta = job.etaSeconds;
  const counts = {
    ready: job.clips.filter((c) => c.status === "ready").length,
    rendering: job.clips.filter((c) => c.status === "rendering").length,
    queued: job.clips.filter((c) => c.status === "queued").length,
    error: job.clips.filter((c) => c.status === "error").length,
  };
  const pct = Math.round((job.status === "ready" ? 1 : job.progress) * 100);

  return (
    <div className="overflow-hidden rounded-2xl border border-black/10 bg-ink text-white">
      <div className="flex flex-wrap items-end justify-between gap-6 px-6 pt-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-white/50">
            {job.status === "queued" ? "Queued" : job.status === "error" ? "Failed" : processing ? "Processing" : "Completed"}
          </p>
          <p className="mt-1 text-6xl font-black tabular-nums tracking-tight">
            {pct}
            <span className="text-3xl text-white/40">%</span>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
          <Metric label="Est. remaining" value={processing ? formatEta(eta) : job.status === "ready" ? "Done" : "—"} accent={processing} />
          <Metric label="Elapsed" value={formatTime(elapsed)} />
          <Metric label="Clips" value={job.clips.length ? `${counts.ready}/${job.clips.length} ready` : "—"} />
        </div>
      </div>
      <div className="px-6 pt-5">
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cx("relative h-full rounded-full transition-[width] duration-700", job.status === "error" ? "bg-danger" : job.status === "ready" ? "bg-success" : "bg-accent")}
            style={{ width: `${pct}%` }}
          >
            {processing && <div className="shimmer absolute inset-0" />}
          </div>
        </div>
      </div>
      <ol className="grid gap-px p-6 sm:grid-cols-2 lg:grid-cols-4">
        {job.stages.map((s, i) => (
          <li key={s.id} className={cx("rounded-lg p-3 transition", s.status === "active" ? "bg-white/10" : "bg-transparent")}>
            <div className="flex items-center gap-2 text-sm">
              <StatusDot status={s.status} />
              <span className="text-white/40 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <span className={cx("font-medium", s.status === "pending" && "text-white/40")}>{s.label}</span>
            </div>
            {s.status === "active" && (
              <div className="mt-2">
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(s.progress * 100)}%` }} />
                </div>
              </div>
            )}
            {s.detail && (
              <p className={cx("mt-1.5 line-clamp-2 text-xs", s.status === "error" ? "text-danger" : "text-white/50")}>{s.detail}</p>
            )}
          </li>
        ))}
      </ol>
      {job.clips.length > 0 && processing && (
        <div className="flex flex-wrap gap-2 border-t border-white/10 px-6 py-3 text-xs">
          <Pill color="bg-success" label={`${counts.ready} ready`} />
          <Pill color="bg-accent" label={`${counts.rendering} rendering`} />
          <Pill color="bg-white/40" label={`${counts.queued} queued`} />
          {counts.error > 0 && <Pill color="bg-danger" label={`${counts.error} failed`} />}
        </div>
      )}
      {job.error && <p className="border-t border-white/10 bg-danger/20 px-6 py-3 text-sm text-white">{job.error}</p>}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-white/45">{label}</p>
      <p className={cx("font-semibold tabular-nums", accent && "text-accent")}>{value}</p>
    </div>
  );
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1">
      <span className={cx("h-1.5 w-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}

