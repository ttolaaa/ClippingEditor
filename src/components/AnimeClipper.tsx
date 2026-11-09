"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx, formatBytes, slugify } from "@/lib/client";
import { ProgressBar } from "@/components/ui";
import AnimePreview, { type AnimePreviewHandle } from "@/components/AnimePreview";
import { type AnimeSubtitle, type BackgroundMode, type SubtitleLayout } from "@/lib/anime/types";
import { annotateFurigana, furiganaFromPairs } from "@/lib/anime/furigana";
import { romajiKey, withRomaji } from "@/lib/anime/romaji";
import { formatTime, newSubtitleId, parseSubtitleFile, parseTime, sortSubtitles, toSubtitleFile } from "@/lib/anime/subtitles";
import { ANIME_WHISPER_MODELS, exportAnimeVideo, generateSubtitles, prepareVideo, type AnimeWhisperModel, type PreparedVideo } from "@/lib/anime/generate";
import { serverCaps } from "@/lib/browser/pipeline";
import { Chip, LayoutPicker, SubtitleRow, downloadBlob as download } from "@/components/AnimeControls";

type Phase = { kind: "idle" } | { kind: "preparing" | "generating" | "exporting"; detail: string; progress?: number };

export const ANIME_ACCEPT = "video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi";
const ACCEPT = ANIME_ACCEPT;

/** Manual mode: you pick one time range; subtitles are generated for that range only. */
export default function AnimeClipper() {
  const [file, setFile] = useState<File | null>(null);
  const [video, setVideo] = useState<PreparedVideo | null>(null);
  const [url, setUrl] = useState<string>();
  const [startText, setStartText] = useState("0:00");
  const [endText, setEndText] = useState("0:00");
  const [layout, setLayout] = useState<SubtitleLayout>("both");
  const [background, setBackground] = useState<BackgroundMode>("blur");
  const [romaji, setRomaji] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [model, setModel] = useState<AnimeWhisperModel | "cloud">("small");
  const [cloudModel, setCloudModel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    serverCaps().then((c) => {
      if (!alive || !c.cloudJapanese) return;
      setCloudModel(c.speechModel ?? "Gemini");
      setModel((m) => (m === "small" ? "cloud" : m));
    });
    return () => {
      alive = false;
    };
  }, []);
  const [subs, setSubs] = useState<AnimeSubtitle[]>([]);
  // With romaji on, (re)make it for lines whose Japanese or readings changed.
  const romajiStale = romaji ? subs.filter((s) => s.ja.length && s.romajiFor !== romajiKey(s.ja)).length : 0;
  useEffect(() => {
    if (!romajiStale) return;
    let alive = true;
    withRomaji(subs)
      .then((next) => alive && next !== subs && setSubs(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [romajiStale, romaji]);
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
  // Times are typed to whole/tenth seconds, so allow an End up to 1 s past the real end (it is clamped below).
  const rangeOk = startParsed !== null && endParsed !== null && startParsed >= 0 && endParsed > startParsed + 0.5 && endParsed <= duration + 1 && startParsed < duration - 0.5;
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
      setEndText(formatTime(Math.floor(Math.min(v.info.duration, 60) * 10) / 10, 1));
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
      setNotes([`Generated ${r.subtitles.length} subtitles (${r.translationProvider === "cloud" ? "cloud AI" : "on-device"} translation). Review and edit them below.`, ...r.warnings]);
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
        { file: video.file, start, end, subtitles: subs, layout, background, romaji, fontScale, hasAudio: video.info.hasAudio, audioFallback: video.audioFallback },
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
      // The app's own JSON keeps furigana, English and flags exactly.
      if (/\.json$/i.test(f.name)) {
        try {
          const imported = await parseSubtitleFile(JSON.parse(await f.text()), annotateFurigana);
          setSubs(imported);
          setNotes([`Imported ${imported.length} subtitles.`]);
          return;
        } catch {
          // not the app's format: fall through to the generic subtitle parser
        }
      }
      const { readSubtitleFile, detectCueLanguage, cuesFor } = await import("@/lib/anime/subfile");
      const cues = await readSubtitleFile(f);
      if (detectCueLanguage(cues) === "en") {
        // English file: fill the English of existing lines (or create English-only lines when there are none yet).
        if (subs.length) {
          let matched = 0;
          setSubs((cur) =>
            cur.map((s) => {
              const en = cuesFor(cues, s.start, s.end);
              if (!en) return s;
              matched++;
              return { ...s, en, enSource: "file", review: undefined };
            }),
          );
          setNotes([`English from ${f.name} matched ${matched} of ${subs.length} lines.`]);
        } else {
          setSubs(sortSubtitles(cues.map((c) => ({ id: newSubtitleId(), start: c.start, end: c.end, ja: [], en: c.text, enSource: "file" as const }))));
          setNotes([`Imported ${cues.length} English lines. Add a Japanese file or Generate to get the Japanese.`]);
        }
        return;
      }
      // Japanese file: exact Japanese lines → furigana, English from machine translation (labelled).
      setPhase({ kind: "generating", detail: "Adding furigana and translating your Japanese subtitles…", progress: 0 });
      const { translateToEnglish } = await import("@/lib/anime/generate");
      const tr = await translateToEnglish(
        cues.map((c) => c.text),
        (detail, progress) => setPhase({ kind: "generating", detail, progress: progress === undefined ? undefined : progress * 0.8 }),
      ).catch(() => ({ translations: cues.map(() => ""), uncertain: cues.map(() => true), provider: "browser" as const, note: "Translation failed — type the English.", fromCloud: cues.map(() => false), ruby: cues.map(() => undefined) }));
      const next: AnimeSubtitle[] = [];
      for (let i = 0; i < cues.length; i++) {
        const en = tr.translations[i] ?? "";
        const review = !en ? "Check: no reliable English — please type it" : tr.uncertain[i] && !tr.fromCloud[i] ? "Check: translation was uncertain" : undefined;
        next.push({ id: newSubtitleId(), start: cues[i].start, end: cues[i].end, ja: await furiganaFromPairs(cues[i].text, tr.ruby[i]).catch(() => [{ text: cues[i].text }]), en, enSource: tr.fromCloud[i] ? "cloud" : "machine", ...(review ? { review } : {}) });
        setPhase({ kind: "generating", detail: "Adding furigana…", progress: 0.8 + 0.2 * ((i + 1) / cues.length) });
      }
      setSubs(sortSubtitles(next));
      setNotes([`Imported ${cues.length} Japanese lines from ${f.name}. English is machine-translated; add an English subtitle file for exact English.`, ...(tr.note ? [tr.note] : [])]);
    } catch (e) {
      setError(`Couldn't import subtitles: ${(e as Error).message}`);
    } finally {
      setPhase({ kind: "idle" });
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
    <div>
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
                  romaji={romaji}
                  fontScale={fontScale}
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
            <LayoutPicker
              layout={layout}
              background={background}
              onLayout={setLayout}
              onBackground={setBackground}
              romaji={romaji}
              onRomaji={setRomaji}
              fontScale={fontScale}
              onFontScale={setFontScale}
            />
          </Card>

          <Card step={4} title="Subtitles" disabled={!video}>
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ANIME_WHISPER_MODELS) as AnimeWhisperModel[]).map((m) => (
                <Chip key={m} active={model === m} onClick={() => setModel(m)} title={ANIME_WHISPER_MODELS[m].note}>
                  {ANIME_WHISPER_MODELS[m].label}
                </Chip>
              ))}
              {cloudModel && (
                <Chip active={model === "cloud"} onClick={() => setModel("cloud")} title={`${cloudModel} listens to the audio and translates it`}>
                  Cloud AI (Gemini)
                </Chip>
              )}
              <span className="text-xs text-black/45">
                {model === "cloud" ? `Most accurate · ${cloudModel} listens to this range and translates it with context` : ANIME_WHISPER_MODELS[model].note}
              </span>
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
                Import subtitles
              </button>
              <input
                ref={jsonPicker}
                type="file"
                accept=".json,.srt,.vtt,.ass,.ssa,.txt,application/json,text/plain,text/vtt"
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
            {video && !busy && (!rangeOk || !video.info.hasAudio) && (
              <p className="mt-2 text-xs font-medium text-danger">
                {!video.info.hasAudio ? "Generate is unavailable: this video has no audio track." : "Generate is unavailable: fix the clip range above (start before end, within the video)."}
              </p>
            )}
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
                      onSeek={() => player.current?.seek(Math.max(s.start + 0.05, 0))}
                      playhead={now}
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

export function Card({ step, title, disabled, children }: { step: number; title: string; disabled?: boolean; children: React.ReactNode }) {
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
