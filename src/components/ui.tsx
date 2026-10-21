"use client";

import { cx, scoreColor } from "@/lib/client";

export function ScoreRing({ score, size = 56, stroke = 5, dark = false }: { score: number; size?: number; stroke?: number; dark?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const { ring } = scoreColor(score);
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.08)"} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ring}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          style={{ transition: "stroke-dashoffset 600ms ease" }}
        />
      </svg>
      <span className={cx("absolute font-bold tabular-nums", dark ? "text-white" : "text-ink")} style={{ fontSize: size * 0.32 }}>
        {score}
      </span>
    </div>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  const { bg } = scoreColor(score);
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold text-white tabular-nums", bg)}>
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
      {score}
    </span>
  );
}

export function StatusDot({ status }: { status: "queued" | "rendering" | "ready" | "error" | "processing" | "pending" | "active" | "done" | "skipped" }) {
  const map: Record<string, string> = {
    queued: "bg-black/25",
    pending: "bg-black/20",
    rendering: "bg-accent animate-pulse",
    processing: "bg-accent animate-pulse",
    active: "bg-accent animate-pulse",
    ready: "bg-success",
    done: "bg-success",
    skipped: "bg-black/30",
    error: "bg-danger",
  };
  return <span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", map[status])} />;
}

export function ProgressBar({ value, tone = "accent", className }: { value: number; tone?: "accent" | "success" | "danger" | "ink"; className?: string }) {
  const tones = { accent: "bg-accent", success: "bg-success", danger: "bg-danger", ink: "bg-ink" };
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full bg-black/10", className)}>
      <div
        className={cx("relative h-full rounded-full transition-[width] duration-500", tones[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
      >
        {tone === "accent" && value < 1 && <div className="shimmer absolute inset-0" />}
      </div>
    </div>
  );
}

export function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "danger" | "accent" | "success" | "dark" }) {
  const tones = {
    neutral: "border-black/15 text-black/70",
    danger: "border-danger/30 bg-danger/10 text-danger",
    accent: "border-accent/30 bg-accent/10 text-accent-dark",
    success: "border-success/30 bg-success/10 text-success",
    dark: "border-white/20 bg-black/60 text-white",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", tones[tone])}>{children}</span>;
}

export function tagTone(tag: string): "neutral" | "danger" | "accent" | "success" {
  if (tag === "plot twist") return "danger";
  if (tag === "funny" || tag === "high energy" || tag === "strong hook") return "accent";
  if (tag === "ai pick") return "success";
  return "neutral";
}
