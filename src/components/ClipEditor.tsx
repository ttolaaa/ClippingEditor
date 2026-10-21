"use client";

import { useEffect, useRef, useState } from "react";
import type { CaptionLine, CaptionStyle, Clip, ReframeMode, ScoreBreakdown } from "@/lib/types";
import { CAPTION_PRESETS, FONT_OPTIONS, activeLineAt, flattenWords, formatTime, groupWordsIntoLines, lineId, retimeLine } from "@/lib/captions";
import { cx } from "@/lib/client";
import { updateClip } from "@/lib/browser/store";
import { cancelExport } from "@/lib/browser/pipeline";
import ReelPlayer, { type ReelPlayerHandle } from "./ReelPlayer";
import { ScoreRing, Tag, tagTone } from "./ui";

interface Draft {
  captions: CaptionLine[];
  style: CaptionStyle;
  title: string;
  hook: string;
  hashtags: string[];
}

type Tab = "captions" | "style" | "details";

export default function ClipEditor({
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
  const [draft, setDraft] = useState<Draft>(() => ({
    captions: clip.captions,
    style: clip.style,
    title: clip.title,
    hook: clip.hook,
    hashtags: clip.hashtags,
  }));
  const [tab, setTab] = useState<Tab>("captions");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const player = useRef<ReelPlayerHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  /** Edits apply instantly to the live preview and are saved to this browser (IndexedDB). */
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    updateClip(jobId, clip.id, (c) => Object.assign(c, patch));
  };

  const seek = (t: number) => {
    player.current?.seek(t);
    setTime(Math.max(0, Math.min(clip.duration, t)));
  };

  const setLine = (id: string, fn: (l: CaptionLine) => CaptionLine) => update({ captions: draft.captions.map((l) => (l.id === id ? fn(l) : l)) });
  const removeLine = (id: string) => update({ captions: draft.captions.filter((l) => l.id !== id) });
  const addLine = () => {
    const start = Math.min(time, clip.duration - 0.5);
    const next = draft.captions.find((l) => l.start > start);
    const end = Math.min(clip.duration, next ? Math.max(start + 0.4, next.start) : start + 1.5);
    const line = retimeLine({ id: lineId(), start, end, text: "", words: [] }, "New caption", start, end);
    update({ captions: [...draft.captions, line].sort((a, b) => a.start - b.start) });
  };

  const setStyle = (patch: Partial<CaptionStyle>) => {
    const style = { ...draft.style, ...patch };
    if (style.wordsPerLine !== draft.style.wordsPerLine) update({ style, captions: groupWordsIntoLines(flattenWords(draft.captions), style.wordsPerLine) });
    else update({ style });
  };

  const setReframe = (mode: ReframeMode) => updateClip(jobId, clip.id, (c) => (c.reframeMode = mode));

  const activeLine = activeLineAt(draft.captions, time);
  useEffect(() => {
    if (!playing || !activeLine || tab !== "captions") return;
    listRef.current?.querySelector(`[data-line="${activeLine.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeLine, playing, tab]);

  const exporting = clip.export.status === "rendering";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-0 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-white sm:h-[94vh] sm:rounded-2xl lg:flex-row" onClick={(e) => e.stopPropagation()}>
        {/* Player */}
        <div className="flex shrink-0 flex-col items-center justify-center gap-3 bg-ink p-4 lg:p-6">
          <div className="relative aspect-[9/16] h-[52vh] overflow-hidden rounded-xl bg-black shadow-2xl lg:h-[calc(94vh-7.5rem)]" onClick={() => player.current?.toggle()}>
            <ReelPlayer
              ref={player}
              src={srcUrl}
              start={clip.start}
              end={clip.end}
              mode={clip.reframeMode}
              crop={clip.crop}
              captions={draft.captions}
              style={draft.style}
              className="h-full w-full"
              onTime={setTime}
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
          <Scrubber clip={clip} lines={draft.captions} time={time} onSeek={seek} playing={playing} onToggle={() => player.current?.toggle()} />
        </div>

        {/* Side panel */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-4 border-b border-black/10 px-5 py-4">
            <ScoreRing score={clip.viralScore} size={52} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-black/45">
                #{clip.rank} · {clip.targetDuration}s reel · {formatTime(clip.start)}–{formatTime(clip.end)}
              </p>
              <h2 className="truncate text-lg font-bold">{draft.title}</h2>
              <div className="mt-1 flex flex-wrap gap-1">
                {clip.hasPlotTwist && <Tag tone="danger">plot twist @ {formatTime(clip.twistAt ?? 0)}</Tag>}
                {clip.ruleMatches?.map((m) => (
                  <Tag key={m} tone="accent">
                    ✓ {m}
                  </Tag>
                ))}
                {clip.tags
                  .filter((t) => t !== "plot twist")
                  .map((t) => (
                    <Tag key={t} tone={tagTone(t)}>
                      {t}
                    </Tag>
                  ))}
              </div>
            </div>
            <button onClick={onClose} className="rounded-full p-2 text-black/40 hover:bg-black/5 hover:text-black" aria-label="Close">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="flex gap-1 border-b border-black/10 px-5">
            {(["captions", "style", "details"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cx(
                  "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium capitalize transition",
                  tab === t ? "border-accent text-ink" : "border-transparent text-black/45 hover:text-black",
                )}
              >
                {t}
                {t === "captions" && <span className="ml-1.5 text-xs text-black/35">{draft.captions.length}</span>}
              </button>
            ))}
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === "captions" && (
              <CaptionsTab lines={draft.captions} activeId={activeLine?.id} duration={clip.duration} onSeek={seek} onChange={setLine} onRemove={removeLine} onAdd={addLine} />
            )}
            {tab === "style" && <StyleTab style={draft.style} onChange={setStyle} />}
            {tab === "details" && <DetailsTab clip={clip} draft={draft} onChange={(p) => update(p)} onReframe={setReframe} />}
          </div>

          <div className="flex items-center gap-3 border-t border-black/10 bg-black/[0.02] px-5 py-3">
            <span className="flex items-center gap-1.5 text-xs text-black/50">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Saved on this device
            </span>
            <div className="ml-auto flex items-center gap-3">
              {exporting && (
                <>
                  <div className="hidden w-32 sm:block">
                    <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${clip.export.progress * 100}%` }} />
                    </div>
                  </div>
                  <button onClick={() => cancelExport(clip.id)} className="text-xs font-medium text-black/50 hover:text-danger">
                    Cancel
                  </button>
                </>
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

function Scrubber({
  clip,
  lines,
  time,
  onSeek,
  playing,
  onToggle,
}: {
  clip: Clip;
  lines: CaptionLine[];
  time: number;
  onSeek: (t: number) => void;
  playing: boolean;
  onToggle: () => void;
}) {
  const d = clip.duration || 1;
  return (
    <div className="flex w-full max-w-[min(100%,28rem)] items-center gap-3 text-white">
      <button onClick={onToggle} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-ink hover:bg-accent hover:text-white" aria-label={playing ? "Pause" : "Play"}>
        {playing ? (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="ml-0.5 h-3.5 w-3.5" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div
        className="relative h-6 flex-1 cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * d);
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15" />
        {lines.map((l) => (
          <div key={l.id} className="absolute top-1/2 h-1 -translate-y-1/2 bg-white/30" style={{ left: `${(l.start / d) * 100}%`, width: `${((l.end - l.start) / d) * 100}%` }} />
        ))}
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" style={{ width: `${(time / d) * 100}%` }} />
        {clip.hasPlotTwist && clip.twistAt !== undefined && (
          <div className="absolute top-0 h-6 w-0.5 bg-danger" style={{ left: `${(clip.twistAt / d) * 100}%` }} title="Plot twist" />
        )}
        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" style={{ left: `${(time / d) * 100}%` }} />
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-[11px] text-white/60 tabular-nums">
        {formatTime(time)} / {formatTime(d)}
      </span>
    </div>
  );
}

function CaptionsTab({
  lines,
  activeId,
  duration,
  onSeek,
  onChange,
  onRemove,
  onAdd,
}: {
  lines: CaptionLine[];
  activeId?: string;
  duration: number;
  onSeek: (t: number) => void;
  onChange: (id: string, fn: (l: CaptionLine) => CaptionLine) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-2">
      {!lines.length && (
        <div className="rounded-xl border border-dashed border-black/15 px-4 py-6 text-center text-sm text-black/50">
          No speech was transcribed for this clip. Add captions manually below.
        </div>
      )}
      {lines.map((l) => (
        <div
          key={l.id}
          data-line={l.id}
          className={cx("group flex items-start gap-2 rounded-xl border p-2 transition", l.id === activeId ? "border-accent bg-accent/5" : "border-black/10 hover:border-black/25")}
        >
          <div className="flex shrink-0 flex-col gap-1">
            <button onClick={() => onSeek(l.start + 0.01)} className="rounded bg-black px-1.5 py-0.5 font-mono text-[11px] text-white hover:bg-accent" title="Jump to line">
              {formatTime(l.start, true)}
            </button>
            <div className="flex items-center gap-0.5">
              <TimeInput value={l.start} max={duration} onChange={(v) => v < l.end && onChange(l.id, (x) => retimeLine(x, x.text, v, x.end))} />
              <TimeInput value={l.end} max={duration} onChange={(v) => v > l.start && onChange(l.id, (x) => retimeLine(x, x.text, x.start, v))} />
            </div>
          </div>
          <textarea
            value={l.text}
            rows={1}
            onFocus={() => onSeek(l.start + 0.01)}
            onChange={(e) => onChange(l.id, (x) => ({ ...retimeLine(x, e.target.value), text: e.target.value }))}
            className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm outline-none focus:border-black/20 focus:bg-white"
          />
          <button onClick={() => onRemove(l.id)} className="rounded-md p-1.5 text-black/25 opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100" aria-label="Delete line">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
      <button onClick={onAdd} className="w-full rounded-xl border border-dashed border-black/20 py-2.5 text-sm font-medium text-black/60 hover:border-black hover:text-black">
        + Add caption at playhead
      </button>
    </div>
  );
}

function TimeInput({ value, max, onChange }: { value: number; max: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(1));
  useEffect(() => setText(value.toFixed(1)), [value]);
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = Number(text);
        if (isFinite(v) && v >= 0 && v <= max) onChange(Math.round(v * 100) / 100);
        else setText(value.toFixed(1));
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="w-11 rounded border border-black/10 px-1 py-0.5 text-center font-mono text-[10px] text-black/60 outline-none focus:border-accent"
      aria-label="Time in seconds"
    />
  );
}

function StyleTab({ style, onChange }: { style: CaptionStyle; onChange: (p: Partial<CaptionStyle>) => void }) {
  return (
    <div className="space-y-6">
      <Section title="Preset">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.entries(CAPTION_PRESETS).map(([key, p]) => (
            <button
              key={key}
              onClick={() => onChange({ ...p.style, enabled: style.enabled })}
              className={cx(
                "rounded-xl border px-3 py-3 text-left transition",
                style.preset === key ? "border-ink ring-2 ring-ink" : "border-black/10 hover:border-black/40",
              )}
            >
              <span
                className="block truncate text-sm"
                style={{
                  fontFamily: `"${p.style.fontFamily}", sans-serif`,
                  fontWeight: 700,
                  color: p.style.background ? p.style.textColor : "#0a0a0a",
                  background: p.style.background ? p.style.backgroundColor : undefined,
                  textTransform: p.style.uppercase ? "uppercase" : "none",
                  border: p.style.background ? "1px solid #0001" : undefined,
                  padding: p.style.background ? "0 4px" : undefined,
                }}
              >
                Viral <span style={{ color: p.style.highlightColor }}>clips</span>
              </span>
              <span className="mt-1 block text-[11px] text-black/45">{p.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Typography">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs text-black/55">
            Font
            <select
              value={style.fontFamily}
              onChange={(e) => onChange({ fontFamily: e.target.value, preset: "custom" })}
              className="mt-1 w-full rounded-lg border border-black/15 bg-white px-2 py-2 text-sm text-ink outline-none focus:border-black"
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <Slider label="Size" value={style.fontSize} min={32} max={140} onChange={(v) => onChange({ fontSize: v, preset: "custom" })} />
          <Slider label="Words per line" value={style.wordsPerLine} min={1} max={6} onChange={(v) => onChange({ wordsPerLine: v, preset: "custom" })} />
          <Slider label="Vertical position" value={style.positionY} min={10} max={90} suffix="%" onChange={(v) => onChange({ positionY: v, preset: "custom" })} />
        </div>
      </Section>

      <Section title="Colors">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ColorInput label="Text" value={style.textColor} onChange={(v) => onChange({ textColor: v, preset: "custom" })} />
          <ColorInput label="Highlight" value={style.highlightColor} onChange={(v) => onChange({ highlightColor: v, preset: "custom" })} />
          <ColorInput label="Outline" value={style.outlineColor} onChange={(v) => onChange({ outlineColor: v, preset: "custom" })} />
          <ColorInput label="Box" value={style.backgroundColor} onChange={(v) => onChange({ backgroundColor: v, preset: "custom" })} />
        </div>
        <div className="mt-4">
          <Slider label="Outline width" value={style.outlineWidth} min={0} max={16} onChange={(v) => onChange({ outlineWidth: v, preset: "custom" })} />
        </div>
      </Section>

      <Section title="Effects">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle label="Show captions" checked={style.enabled} onChange={(v) => onChange({ enabled: v })} />
          <Toggle label="Highlight active word" checked={style.highlightActiveWord} onChange={(v) => onChange({ highlightActiveWord: v, preset: "custom" })} />
          <Toggle label="Pop animation" checked={style.popAnimation} onChange={(v) => onChange({ popAnimation: v, preset: "custom" })} />
          <Toggle label="UPPERCASE" checked={style.uppercase} onChange={(v) => onChange({ uppercase: v, preset: "custom" })} />
          <Toggle label="Background box" checked={style.background} onChange={(v) => onChange({ background: v, preset: "custom" })} />
        </div>
      </Section>
    </div>
  );
}

function DetailsTab({
  clip,
  draft,
  onChange,
  onReframe,
}: {
  clip: Clip;
  draft: Draft;
  onChange: (p: Partial<Draft>) => void;
  onReframe: (m: ReframeMode) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [tagText, setTagText] = useState(draft.hashtags.join(" "));
  const labels: Record<keyof ScoreBreakdown, string> = {
    hook: "Hook (first 3s)",
    emotion: "Emotion / humor",
    energy: "Energy",
    pacing: "Pacing",
    retention: "Retention",
    twist: "Plot twist",
  };
  const copy = async () => {
    await navigator.clipboard.writeText(`${draft.title}\n\n${draft.hook}\n\n${draft.hashtags.join(" ")}`).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-6">
      <Section title="Why it can go viral">
        <p className="text-sm text-black/70">{clip.reason}</p>
        <div className="mt-3 space-y-2">
          {(Object.keys(labels) as (keyof ScoreBreakdown)[]).map((k) => (
            <div key={k} className="flex items-center gap-3 text-xs">
              <span className="w-28 shrink-0 text-black/55">{labels[k]}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10">
                <div
                  className={cx("h-full rounded-full", k === "twist" ? "bg-danger" : clip.scores[k] >= 70 ? "bg-success" : clip.scores[k] >= 45 ? "bg-accent" : "bg-black/40")}
                  style={{ width: `${clip.scores[k]}%` }}
                />
              </div>
              <span className="w-7 text-right font-semibold tabular-nums">{clip.scores[k]}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Post copy">
        <div className="space-y-3">
          <label className="block text-xs text-black/55">
            Title
            <input
              value={draft.title}
              onChange={(e) => onChange({ title: e.target.value })}
              className="mt-1 w-full rounded-lg border border-black/15 px-3 py-2 text-sm text-ink outline-none focus:border-black"
            />
          </label>
          <label className="block text-xs text-black/55">
            Hook / on-screen opener
            <input
              value={draft.hook}
              onChange={(e) => onChange({ hook: e.target.value })}
              className="mt-1 w-full rounded-lg border border-black/15 px-3 py-2 text-sm text-ink outline-none focus:border-black"
            />
          </label>
          <label className="block text-xs text-black/55">
            Hashtags
            <input
              value={tagText}
              onChange={(e) => {
                setTagText(e.target.value);
                onChange({ hashtags: e.target.value.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`)) });
              }}
              className="mt-1 w-full rounded-lg border border-black/15 px-3 py-2 text-sm text-ink outline-none focus:border-black"
            />
          </label>
          <button onClick={copy} className="rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium hover:border-black">
            {copied ? "✓ Copied" : "Copy title, hook & hashtags"}
          </button>
        </div>
      </Section>

      <Section title="9:16 reframing">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["track", "Smart speaker tracking"],
              ["fit", "Fit + blurred background"],
            ] as [ReframeMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => onReframe(m)}
              disabled={clip.status !== "ready"}
              className={cx(
                "rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50",
                clip.reframeMode === m ? "border-ink bg-ink text-white" : "border-black/15 hover:border-black/40",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-black/50">
          Subject tracking confidence:{" "}
          <span className={cx("font-semibold", clip.trackingConfidence >= 0.5 ? "text-success" : clip.trackingConfidence >= 0.2 ? "text-accent" : "text-danger")}>
            {Math.round(clip.trackingConfidence * 100)}%
          </span>
          {clip.trackingConfidence < 0.2 && " — consider “Fit + blurred background” for wide shots."}
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-black/45">{title}</h4>
      {children}
    </section>
  );
}

function Slider({ label, value, min, max, suffix = "", onChange }: { label: string; value: number; min: number; max: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="block text-xs text-black/55">
      <span className="flex justify-between">
        {label}
        <span className="font-semibold text-ink tabular-nums">
          {value}
          {suffix}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-2 w-full" />
    </label>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-black/10 px-2 py-1.5 text-xs text-black/60">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0" />
      {label}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between rounded-lg border border-black/10 px-3 py-2 text-sm hover:border-black/30"
    >
      {label}
      <span className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-success" : "bg-black/15")}>
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[1.1rem]" : "left-0.5")} />
      </span>
    </button>
  );
}
