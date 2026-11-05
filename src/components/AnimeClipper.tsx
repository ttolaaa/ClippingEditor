"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx, formatBytes, slugify } from "@/lib/client";
import { ProgressBar } from "@/components/ui";
import AnimePreview, { type AnimePreviewHandle } from "@/components/AnimePreview";
import { SUBTITLE_LAYOUTS, type AnimeSubtitle, type BackgroundMode, type RubySegment, type SubtitleLayout } from "@/lib/anime/types";
import { parseMarkup, segmentsToMarkup, segmentsToText } from "@/lib/anime/ruby";
import { annotateFurigana } from "@/lib/anime/furigana";
import { formatTime, newSubtitleId, parseSubtitleFile, parseTime, sortSubtitles, toSubtitleFile } from "@/lib/anime/subtitles";
import { ANIME_WHISPER_MODELS, exportAnimeVideo, generateSubtitles, prepareVideo, type AnimeWhisperModel, type PreparedVideo } from "@/lib/anime/generate";

type Phase = { kind: "idle" } | { kind: "preparing" | "generating" | "exporting"; detail: string; progress?: number };

const ACCEPT = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function AnimeClipper() {
  const [file, setFile] = useState<File | null>(null);
  const [video, setVideo] = useState<PreparedVideo | null>(null);
  const [url, setUrl] = useState<string>();
  const [startText, setStartText] = useState("0:00");
  const [endText, setEndText] = useState("0:00");
  const [layout, setLayout] = useState<SubtitleLayout>("both");
  const [background, setBackground] = useState<BackgroundMode>("blur");
  const [model, setModel] = useState<AnimeWhisperModel>("base");
  const [subs, setSubs] = useState<AnimeSubtitle[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [drag, setDrag] = useState(false);
  const player = useRef<AnimePreviewHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const jsonPicker = useRef<HTMLInputElement>(null);
  const exportAbort = useRef<AbortController | null>(null);
  const lastTick = useRef(0);

  const duration = video?.info.duration ?? 0;
  const startParsed = parseTime(startText);
  const endParsed = parseTime(endText);
  const rangeOk = startParsed !== null && endParsed !== null && startParsed >= 0 && endParsed > startParsed + 0.5 && endParsed <= duration + 0.05;
  const start = rangeOk ? startParsed : 0;
  const end = rangeOk ? Math.min(endParsed, duration) : duration;
  const busy = phase.kind !== "idle";

  useEffect(() => {
    if (!video) return setUrl(undefined);
    const u = URL.createObjectURL(video.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [video]);

  const pick = useCallback(async (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name)) {
      setError("Please choose a video file (MP4, MOV, WebM, MKV or AVI).");
      return;
    }
    setError(null);
    setNotes([]);
    setFile(f);
    setVideo(null);
    setSubs([]);
    setPhase({ kind: "preparing", detail: "Reading video…" });
    try {
      const v = await prepareVideo(f, (detail, progress) => setPhase({ kind: "preparing", detail, progress }));
      setVideo(v);
      setStartText("0:00");
      setEndText(formatTime(Math.min(v.info.duration, 60), 0));
      if (v.converted) setNotes(["This format isn't playable in browsers, so it was converted to MP4 on your device."]);
      if (!v.info.hasAudio) setNotes((n) => [...n, "This video has no audio track, so speech can't be recognised. You can still type or import subtitles."]);
    } catch (e) {
      setError((e as Error).message);
      setFile(null);
    } finally {
      setPhase({ kind: "idle" });
    }
  }, []);

  const onTime = useCallback((t: number) => {
    const ts = performance.now();
    if (ts - lastTick.current < 90) return;
    lastTick.current = ts;
    setNow(t);
  }, []);

  const generate = async () => {
    if (!video || !rangeOk) return;
    setError(null);
    setNotes([]);
    setPhase({ kind: "generating", detail: "Starting…", progress: 0 });
    try {
      const r = await generateSubtitles({
        file: video.file,
        start,
        end,
        whisperModel: model,
        onStatus: (detail, progress) => setPhase({ kind: "generating", detail, progress }),
      });
      setSubs((cur) => sortSubtitles([...cur.filter((s) => s.end <= start || s.start >= end), ...r.subtitles]));
      setNotes([`Generated ${r.subtitles.length} subtitles (${r.translationProvider === "cloud" ? "cloud" : "on-device"} translation). Review and edit them below.`, ...r.warnings]);
    } catch (e) {
      setError(`Subtitle generation failed: ${(e as Error).message}`);
    } finally {
      setPhase({ kind: "idle" });
    }
  };

  const exportVideo = async () => {
    if (!video || !rangeOk) return;
    setError(null);
    const ctrl = new AbortController();
    exportAbort.current = ctrl;
    setPhase({ kind: "exporting", detail: "Rendering 1080×1920 MP4…", progress: 0 });
    try {
      const blob = await exportAnimeVideo(
        { file: video.file, start, end, subtitles: subs, layout, background, hasAudio: video.info.hasAudio, audioFallback: video.audioFallback },
        (f) => setPhase({ kind: "exporting", detail: "Rendering 1080×1920 MP4…", progress: f }),
        ctrl.signal,
      );
      download(blob, `${slugify(file?.name.replace(/\.[^.]+$/, "") || "anime")}-reel.mp4`);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(`Export failed: ${(e as Error).message}`);
    } finally {
      exportAbort.current = null;
      setPhase({ kind: "idle" });
    }
  };

  const exportJson = () => {
    const doc = toSubtitleFile(subs, { name: file?.name, duration, clip: rangeOk ? { start, end } : undefined });
    download(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), `${slugify(file?.name.replace(/\.[^.]+$/, "") || "anime")}-subtitles.json`);
  };

  const importJson = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const raw = JSON.parse(await f.text());
      const imported = await parseSubtitleFile(raw, annotateFurigana);
      setSubs(imported);
      setNotes([`Imported ${imported.length} subtitles.`]);
    } catch (e) {
      setError(`Couldn't import subtitles: ${(e as Error).message}`);
    }
  };

  const update = (id: string, next: AnimeSubtitle) => setSubs((cur) => sortSubtitles(cur.map((s) => (s.id === id ? next : s))));
  const remove = (id: string) => setSubs((cur) => cur.filter((s) => s.id !== id));
  const addAtPlayhead = () => {
    const t = Math.max(start, Math.min(now, end - 0.5));
    setSubs((cur) => sortSubtitles([...cur, { id: newSubtitleId(), start: t, end: Math.min(end, t + 2.5), ja: [], en: "" }]));
  };

  const activeId = useMemo(() => subs.find((s) => now >= s.start && now < s.end)?.id, [subs, now]);
  const inRange = subs.filter((s) => s.end > start && s.start < end).length;

  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-10">
      <div className="mb-8">
        <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-black/60">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Anime Clipper · Japanese → furigana + English
        </p>
        <h1 className="text-4xl font-black tracking-tight sm:text-5xl">
          Anime clips with <span className="text-accent">furigana</span> &amp; English subtitles.
        </h1>
        <p className="mt-3 max-w-2xl text-black/60">
          Pick a time range, let the app listen to the Japanese, translate it and add furigana, then export a 1080×1920 Reel. The original video keeps its aspect
          ratio and subtitles fill the space below it. Everything runs in your browser.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,360px)_1fr]">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <div className="mx-auto w-full max-w-[340px] overflow-hidden rounded-[28px] border-[6px] border-ink bg-ink shadow-xl">
            <div className="aspect-[9/16] w-full bg-[#0b0b12]">
              {url && video ? (
                <AnimePreview
                  ref={player}
                  src={url}
                  start={start}
                  end={end}
                  layout={layout}
                  background={background}
                  subtitles={subs}
                  className="h-full w-full"
                  onTime={onTime}
                  onPlayingChange={setPlaying}
                />
              ) : (
                <div className="grid h-full place-items-center px-6 text-center text-sm text-white/50">Preview appears here once you add a video</div>
              )}
            </div>
          </div>
          {video && (
            <div className="mx-auto mt-4 max-w-[340px]">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => player.current?.toggle()}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-white hover:bg-accent"
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? (
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min={start}
                  max={end}
                  step={0.05}
                  value={Math.min(end, Math.max(start, now))}
                  onChange={(e) => player.current?.seek(Number(e.target.value))}
                  className="w-full"
                  aria-label="Playhead"
                />
              </div>
              <p className="mt-1 text-center text-xs tabular-nums text-black/50">
                {formatTime(now)} · clip {formatTime(start, 0)}–{formatTime(end, 0)}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-6">
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
              <input ref={picker} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
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
                      {video.info.width}×{video.info.height} · {formatTime(video.info.duration, 0)} · {formatBytes(file.size)} · click to change
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold">Drop an anime video here, or click to browse</p>
                    <p className="text-sm text-black/50">Landscape or portrait · never uploaded, processed in your browser</p>
                  </>
                )}
              </div>
            </div>
            {phase.kind === "preparing" && <Progress phase={phase} />}
          </Card>

          <Card step={2} title="Clip range" disabled={!video}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TimeField label="Start" value={startText} onChange={setStartText} onUsePlayhead={() => setStartText(formatTime(now, 1))} />
              <TimeField label="End" value={endText} onChange={setEndText} onUsePlayhead={() => setEndText(formatTime(now, 1))} />
            </div>
            <p className={cx("mt-2 text-xs", rangeOk || !video ? "text-black/50" : "text-danger")}>
              {video
                ? rangeOk
                  ? `Clip length ${formatTime(end - start, 1)} of ${formatTime(duration, 0)} · format m:ss (or seconds)`
                  : "Enter a valid range: start before end, within the video."
                : "Add a video first."}
            </p>
          </Card>

          <Card step={3} title="Subtitle layout" disabled={!video}>
            <div className="grid gap-3 sm:grid-cols-2">
              {SUBTITLE_LAYOUTS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setLayout(o.id)}
                  className={cx("flex items-center gap-3 rounded-xl border p-3 text-left transition", layout === o.id ? "border-ink bg-ink/[0.03] ring-1 ring-ink" : "border-black/15 hover:border-black/40")}
                >
                  <LayoutGlyph layout={o.id} active={layout === o.id} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      <span className="mr-1.5 text-accent">{o.letter}</span>
                      {o.label}
                    </span>
                    <span className="block text-xs text-black/50">{o.hint}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-black/45">Letterbox fill</span>
              <Chip active={background === "blur"} onClick={() => setBackground("blur")}>
                Blurred video
              </Chip>
              <Chip active={background === "dark"} onClick={() => setBackground("dark")}>
                Solid dark
              </Chip>
            </div>
          </Card>

          <Card step={4} title="Subtitles" disabled={!video}>
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ANIME_WHISPER_MODELS) as AnimeWhisperModel[]).map((m) => (
                <Chip key={m} active={model === m} onClick={() => setModel(m)} title={ANIME_WHISPER_MODELS[m].note}>
                  {ANIME_WHISPER_MODELS[m].label}
                </Chip>
              ))}
              <span className="text-xs text-black/45">{ANIME_WHISPER_MODELS[model].note}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!video || !rangeOk || busy || !video.info.hasAudio}
                onClick={generate}
                className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
              >
                Generate Japanese + furigana + English
              </button>
              <button type="button" disabled={!video || busy} onClick={addAtPlayhead} className="rounded-full border border-black/15 px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-40">
                + Add line at playhead
              </button>
              <button type="button" disabled={busy} onClick={() => jsonPicker.current?.click()} className="rounded-full border border-black/15 px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-40">
                Import JSON
              </button>
              <input
                ref={jsonPicker}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  importJson(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <button type="button" disabled={!subs.length} onClick={exportJson} className="rounded-full border border-black/15 px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-40">
                Download JSON
              </button>
            </div>
            <p className="mt-2 text-xs text-black/45">
              Japanese speech is recognised, translated to English and given furigana automatically. The first run downloads the speech model, translation model and
              furigana dictionary once; they are cached afterwards.
            </p>
            {phase.kind === "generating" && <Progress phase={phase} />}

            {subs.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-xs text-black/50">
                  {subs.length} lines · {inRange} in the clip range. Japanese uses ruby markup, e.g. <code className="rounded bg-black/5 px-1">{"<ruby>漢<rt>かん</rt></ruby>字"}</code>
                </p>
                <ul className="space-y-2">
                  {subs.map((s) => (
                    <SubtitleRow
                      key={s.id}
                      sub={s}
                      active={s.id === activeId}
                      outside={s.end <= start || s.start >= end}
                      onChange={(next) => update(s.id, next)}
                      onDelete={() => remove(s.id)}
                      onSeek={() => player.current?.seek(Math.max(s.start, 0))}
                    />
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card step={5} title="Export" disabled={!video}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!video || !rangeOk || busy}
                onClick={exportVideo}
                className="rounded-full bg-ink px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                Download 1080×1920 MP4
              </button>
              {phase.kind === "exporting" && (
                <button type="button" onClick={() => exportAbort.current?.abort()} className="rounded-full border border-black/15 px-4 py-2 text-sm font-medium hover:border-black">
                  Cancel
                </button>
              )}
            </div>
            {phase.kind === "exporting" && <Progress phase={phase} />}
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
      </div>
    </div>
  );
}

function Card({ step, title, disabled, children }: { step: number; title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <section className={cx("rounded-2xl border border-black/10 bg-white p-5 shadow-[0_1px_0_rgba(0,0,0,0.04)] transition", disabled && "opacity-50")}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-black/70">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-ink text-[11px] text-white">{step}</span>
        {title}
      </h2>
      <div className={disabled ? "pointer-events-none" : undefined}>{children}</div>
    </section>
  );
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx("rounded-full border px-3.5 py-1.5 text-sm font-medium transition", active ? "border-ink bg-ink text-white" : "border-black/15 hover:border-black/40")}
    >
      {children}
    </button>
  );
}

function Progress({ phase }: { phase: Exclude<Phase, { kind: "idle" }> }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between text-xs text-black/55">
        <span>{phase.detail}</span>
        {phase.progress !== undefined && <span className="tabular-nums">{Math.round(phase.progress * 100)}%</span>}
      </div>
      <ProgressBar value={phase.progress ?? 0.05} />
    </div>
  );
}

function TimeField({ label, value, onChange, onUsePlayhead }: { label: string; value: string; onChange: (v: string) => void; onUsePlayhead: () => void }) {
  const invalid = parseTime(value) === null;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-black/45">{label}</span>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0:00"
          className={cx("w-full rounded-lg border bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-black", invalid ? "border-danger" : "border-black/15")}
        />
        <button type="button" onClick={onUsePlayhead} className="shrink-0 rounded-lg border border-black/15 px-3 text-xs font-medium hover:border-black">
          Use playhead
        </button>
      </div>
    </label>
  );
}

function LayoutGlyph({ layout, active }: { layout: SubtitleLayout; active: boolean }) {
  const ja = (
    <div key="ja" className="flex flex-col items-center leading-none">
      <span className="text-[6px] text-amber-500">にほん</span>
      <span className="text-[9px] font-bold">日本語</span>
    </div>
  );
  const en = (
    <span key="en" className="text-[8px] font-semibold text-sky-600">
      English
    </span>
  );
  const rows = layout === "both" ? [ja, en] : layout === "ja" ? [ja] : layout === "en" ? [en] : [en, ja];
  return (
    <span className={cx("flex h-16 w-10 shrink-0 flex-col items-center justify-end gap-1 rounded-md border pb-1.5", active ? "border-ink bg-white" : "border-black/15 bg-black/[0.03]")}>
      <span className="mb-auto mt-1.5 h-4 w-7 rounded-sm bg-black/15" />
      {rows}
    </span>
  );
}

function Ruby({ segs }: { segs: RubySegment[] }) {
  return (
    <span className="text-base leading-[2.1]">
      {segs.map((s, i) =>
        s.ruby ? (
          <ruby key={i}>
            {s.text}
            <rt className="text-[9px] text-amber-600">{s.ruby}</rt>
          </ruby>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

function SubtitleRow({
  sub,
  active,
  outside,
  onChange,
  onDelete,
  onSeek,
}: {
  sub: AnimeSubtitle;
  active: boolean;
  outside: boolean;
  onChange: (s: AnimeSubtitle) => void;
  onDelete: () => void;
  onSeek: () => void;
}) {
  const [markup, setMarkup] = useState(() => segmentsToMarkup(sub.ja));
  const [from, setFrom] = useState(() => formatTime(sub.start, 2));
  const [to, setTo] = useState(() => formatTime(sub.end, 2));
  const [working, setWorking] = useState(false);
  const [furiganaError, setFuriganaError] = useState<string | null>(null);

  useEffect(() => setMarkup(segmentsToMarkup(sub.ja)), [sub.ja]);
  useEffect(() => setFrom(formatTime(sub.start, 2)), [sub.start]);
  useEffect(() => setTo(formatTime(sub.end, 2)), [sub.end]);

  const commitTimes = () => {
    const s = parseTime(from);
    const e = parseTime(to);
    if (s !== null && e !== null && e > s) onChange({ ...sub, start: s, end: e });
    else {
      setFrom(formatTime(sub.start, 2));
      setTo(formatTime(sub.end, 2));
    }
  };

  const reannotate = async () => {
    setWorking(true);
    setFuriganaError(null);
    try {
      const plain = segmentsToText(parseMarkup(markup));
      onChange({ ...sub, ja: await annotateFurigana(plain) });
    } catch (e) {
      setFuriganaError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const small = "rounded-md border border-black/15 bg-white px-2 py-1 text-xs tabular-nums outline-none focus:border-black";
  return (
    <li className={cx("rounded-xl border p-3 transition", active ? "border-accent bg-accent/5" : "border-black/10", outside && "opacity-50")}>
      <div className="flex flex-wrap items-center gap-2">
        <input value={from} onChange={(e) => setFrom(e.target.value)} onBlur={commitTimes} className={cx(small, "w-20")} aria-label="Start" />
        <span className="text-black/30">→</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} onBlur={commitTimes} className={cx(small, "w-20")} aria-label="End" />
        <button type="button" onClick={onSeek} className="rounded-md px-2 py-1 text-xs text-black/55 hover:bg-black/5 hover:text-black">
          ▶ Go to
        </button>
        <button type="button" onClick={reannotate} disabled={working} className="rounded-md px-2 py-1 text-xs text-black/55 hover:bg-black/5 hover:text-black disabled:opacity-50">
          {working ? "Adding furigana…" : "↻ Auto furigana"}
        </button>
        <button type="button" onClick={onDelete} className="ml-auto rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10">
          Delete
        </button>
      </div>
      <div className="mt-2 grid gap-2">
        <input
          value={markup}
          onChange={(e) => setMarkup(e.target.value)}
          onBlur={() => onChange({ ...sub, ja: parseMarkup(markup) })}
          placeholder="日本語 (ruby markup allowed)"
          lang="ja"
          className="w-full rounded-md border border-black/15 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-black"
        />
        {sub.ja.length > 0 && <Ruby segs={parseMarkup(markup)} />}
        <input
          value={sub.en}
          onChange={(e) => onChange({ ...sub, en: e.target.value })}
          placeholder="English translation"
          className="w-full rounded-md border border-black/15 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-black"
        />
        {furiganaError && <p className="text-xs text-danger">Furigana failed: {furiganaError}</p>}
      </div>
    </li>
  );
}
