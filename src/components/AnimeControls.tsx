"use client";

import { useEffect, useState } from "react";
import { cx } from "@/lib/client";
import { SUBTITLE_LAYOUTS, type AnimeSubtitle, type BackgroundMode, type RubySegment, type SubtitleLayout } from "@/lib/anime/types";
import { parseMarkup, segmentsToMarkup, segmentsToText } from "@/lib/anime/ruby";
import { annotateFurigana } from "@/lib/anime/furigana";
import { formatTime, parseTime } from "@/lib/anime/subtitles";

/** Controls shared by the manual Anime Clipper and the per-clip Anime subtitle editor. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function LayoutPicker({
  layout,
  background,
  onLayout,
  onBackground,
  compact,
  romaji,
  onRomaji,
  fontScale,
  onFontScale,
}: {
  layout: SubtitleLayout;
  background: BackgroundMode;
  onLayout: (l: SubtitleLayout) => void;
  onBackground: (b: BackgroundMode) => void;
  compact?: boolean;
  romaji?: boolean;
  onRomaji?: (on: boolean) => void;
  fontScale?: number;
  onFontScale?: (scale: number) => void;
}) {
  const scale = fontScale ?? 1;
  return (
    <div>
      <div className={cx("grid gap-3", compact ? "grid-cols-2" : "sm:grid-cols-2")}>
        {SUBTITLE_LAYOUTS.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onLayout(o.id)}
            className={cx("flex items-center gap-3 rounded-xl border p-3 text-left transition", layout === o.id ? "border-ink bg-ink/[0.03] ring-1 ring-ink" : "border-black/15 hover:border-black/40")}
          >
            <LayoutGlyph layout={o.id} active={layout === o.id} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                <span className="mr-1.5 text-accent">{o.letter}</span>
                {o.label}
              </span>
              {!compact && <span className="block text-xs text-black/50">{o.hint}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-black/45">Letterbox fill</span>
        <Chip active={background === "blur"} onClick={() => onBackground("blur")}>
          Blurred video
        </Chip>
        <Chip active={background === "dark"} onClick={() => onBackground("dark")}>
          Solid dark
        </Chip>
      </div>
      {(onRomaji || onFontScale) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          {onRomaji && (
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-black/45">Romaji</span>
              <Chip active={!!romaji} onClick={() => onRomaji(!romaji)} title="Show the reading in Latin letters under the Japanese, e.g. watashi wa…">
                {romaji ? "On · watashi wa…" : "Off"}
              </Chip>
            </span>
          )}
          {onFontScale && (
            <label className="flex items-center gap-2 text-xs">
              <span className="font-semibold uppercase tracking-wider text-black/45">Text size</span>
              <button type="button" aria-label="Smaller text" onClick={() => onFontScale(Math.max(0.7, Math.round((scale - 0.1) * 10) / 10))} className="rounded-full border border-black/15 px-2 py-0.5 font-bold hover:border-black">
                A−
              </button>
              <input
                type="range"
                min={0.7}
                max={1.5}
                step={0.05}
                value={scale}
                onChange={(e) => onFontScale(Number(e.target.value))}
                className="w-28"
                aria-label="Subtitle text size"
              />
              <button type="button" aria-label="Bigger text" onClick={() => onFontScale(Math.min(1.5, Math.round((scale + 0.1) * 10) / 10))} className="rounded-full border border-black/15 px-2 py-0.5 font-bold hover:border-black">
                A+
              </button>
              <span className="w-10 tabular-nums text-black/55">{Math.round(scale * 100)}%</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

export function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
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

export function LayoutGlyph({ layout, active }: { layout: SubtitleLayout; active: boolean }) {
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

export function Ruby({ segs }: { segs: RubySegment[] }) {
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

export function SubtitleRow({
  sub,
  active,
  outside,
  onChange,
  onDelete,
  onSeek,
  playhead,
}: {
  sub: AnimeSubtitle;
  active: boolean;
  outside: boolean;
  onChange: (s: AnimeSubtitle) => void;
  onDelete: () => void;
  onSeek: () => void;
  /** Current preview time (source seconds): enables "Start/End at playhead" for quick sync fixes. */
  playhead?: number;
}) {
  const [markup, setMarkup] = useState(() => segmentsToMarkup(sub.ja));
  const [from, setFrom] = useState(() => formatTime(sub.start, 2));
  const [to, setTo] = useState(() => formatTime(sub.end, 2));
  const [working, setWorking] = useState(false);
  const [furiganaError, setFuriganaError] = useState<string | null>(null);

  const jaMarkup = segmentsToMarkup(sub.ja);
  // Depend on the markup string, not the array: saves clone every subtitle, which would reset rows being edited.
  useEffect(() => setMarkup(jaMarkup), [jaMarkup]);
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
      // Adding readings doesn't confirm the words are right, so a review flag stays.
      onChange({ ...sub, ja: await annotateFurigana(plain) });
    } catch (e) {
      setFuriganaError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const small = "rounded-md border border-black/15 bg-white px-2 py-1 text-xs tabular-nums outline-none focus:border-black";
  // Any edit means a person looked at the line, so it no longer needs review.
  const edit = (next: AnimeSubtitle) => onChange({ ...next, review: undefined });
  return (
    <li
      data-sub={sub.id}
      data-review={sub.review ? "1" : undefined}
      className={cx("rounded-xl border p-3 transition", active ? "border-accent bg-accent/5" : sub.review ? "border-amber-400 bg-amber-50" : "border-black/10", outside && "opacity-50")}
    >
      {sub.review && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-amber-400 px-2 py-0.5 font-semibold text-amber-950">Needs review</span>
          <span className="text-amber-900">{sub.review.replace(/^Check: /, "")}</span>
          <button
            type="button"
            onClick={() => onChange({ ...sub, review: undefined })}
            className="ml-auto rounded-md border border-amber-500 px-2 py-0.5 font-medium text-amber-900 hover:bg-amber-100"
          >
            ✓ Looks right
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={from} onChange={(e) => setFrom(e.target.value)} onBlur={commitTimes} className={cx(small, "w-20")} aria-label="Start" />
        <span className="text-black/30">→</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} onBlur={commitTimes} className={cx(small, "w-20")} aria-label="End" />
        <button type="button" onClick={onSeek} className="rounded-md px-2 py-1 text-xs text-black/55 hover:bg-black/5 hover:text-black">
          ▶ Go to
        </button>
        {playhead !== undefined && (
          <>
            <button
              type="button"
              title="Set this line's start to the current preview time (pause where the voice starts, then click)"
              onClick={() => {
                const s = Math.round(playhead * 100) / 100;
                edit({ ...sub, start: s, end: sub.end > s + 0.3 ? sub.end : s + Math.max(1, sub.end - sub.start) });
              }}
              className="rounded-md px-2 py-1 text-xs text-black/55 hover:bg-black/5 hover:text-black"
            >
              ⇤ Start at playhead
            </button>
            <button
              type="button"
              title="Set this line's end to the current preview time (pause where the voice stops, then click)"
              disabled={playhead <= sub.start + 0.2}
              onClick={() => edit({ ...sub, end: Math.round(playhead * 100) / 100 })}
              className="rounded-md px-2 py-1 text-xs text-black/55 hover:bg-black/5 hover:text-black disabled:opacity-40"
            >
              End at playhead ⇥
            </button>
          </>
        )}
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
          onBlur={() => {
            const ja = parseMarkup(markup);
            if (segmentsToMarkup(ja) !== segmentsToMarkup(sub.ja)) edit({ ...sub, ja });
          }}
          placeholder="日本語 (ruby markup allowed)"
          lang="ja"
          className="w-full rounded-md border border-black/15 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-black"
        />
        {sub.ja.length > 0 && <Ruby segs={parseMarkup(markup)} />}
        <input
          value={sub.en}
          onChange={(e) => edit({ ...sub, en: e.target.value, enSource: "user" })}
          placeholder="English translation"
          className="w-full rounded-md border border-black/15 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-black"
        />
        {furiganaError && <p className="text-xs text-danger">Furigana failed: {furiganaError}</p>}
        {sub.en && sub.enSource && (
          <p className="text-[11px] text-black/45">
            English:{" "}
            {sub.enSource === "file"
              ? "from your subtitle file"
              : sub.enSource === "user"
                ? "edited by you"
                : sub.enSource === "cloud"
                  ? "cloud AI translation from the audio"
                  : "machine translation — check it before posting"}
          </p>
        )}
      </div>
    </li>
  );
}
