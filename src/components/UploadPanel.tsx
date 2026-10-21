"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CAPTION_PRESETS } from "@/lib/captions";
import { cx, formatBytes } from "@/lib/client";
import type { ReframeMode, TranscriptionMode } from "@/lib/types";
import { LANGUAGES } from "@/lib/engine/transcript";
import { createProject, serverCaps, type ServerCaps } from "@/lib/browser/pipeline";

const ACCEPT = [".mp4", ".mov", ".avi", ".m4v", ".webm", ".mkv"];

interface BrowserCaps {
  webcodecs: boolean;
  isolated: boolean;
  threads: number;
}

export default function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durations, setDurations] = useState<number[]>([15, 30, 60]);
  const [perDuration, setPerDuration] = useState(3);
  const [preset, setPreset] = useState("bold");
  const [reframe, setReframe] = useState<ReframeMode>("track");
  const [language, setLanguage] = useState("english");
  const [transcription, setTranscription] = useState<TranscriptionMode>("browser");
  const [whisperModel, setWhisperModel] = useState<"tiny" | "base">("base");
  const [saving, setSaving] = useState(false);
  const [caps, setCaps] = useState<ServerCaps | null>(null);
  const [browser, setBrowser] = useState<BrowserCaps | null>(null);

  useEffect(() => {
    serverCaps().then(setCaps);
    setBrowser({
      webcodecs: typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined",
      isolated: !!globalThis.crossOriginIsolated,
      threads: navigator.hardwareConcurrency || 1,
    });
  }, []);

  const pick = useCallback((f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPT.includes(ext)) {
      setError(`“${f.name}” isn’t supported. Upload an MP4, MOV or AVI video.`);
      return;
    }
    setFile(f);
  }, []);

  const start = async () => {
    if (!file || !durations.length) return;
    if (browser && !browser.webcodecs) {
      setError("This browser doesn't support WebCodecs. Please use a recent Chrome, Edge, Firefox or Safari.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const id = await createProject(file, {
        durations,
        maxClipsPerDuration: perDuration,
        captionPreset: preset,
        reframeMode: reframe,
        language,
        transcription,
        whisperModel,
      });
      router.push(`/jobs/${id}`);
    } catch (e) {
      setError(`Couldn't save the video in your browser: ${(e as Error).message}`);
      setSaving(false);
    }
  };

  return (
    <div id="upload" className="overflow-hidden rounded-2xl border border-black/10 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04),0_20px_60px_-30px_rgba(0,0,0,0.35)]">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        onClick={() => !saving && inputRef.current?.click()}
        className={cx(
          "group relative m-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition",
          drag ? "border-accent bg-accent/5" : "border-black/15 hover:border-black/40",
          saving && "cursor-default",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT.join(",") + ",video/mp4,video/quicktime,video/x-msvideo"}
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        {!file ? (
          <>
            <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-black text-white transition group-hover:bg-accent">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              </svg>
            </div>
            <p className="text-lg font-semibold">Drop your long video here</p>
            <p className="mt-1 text-sm text-black/50">MP4, MOV or AVI · processed privately in your browser — nothing is uploaded</p>
          </>
        ) : (
          <div className="flex w-full max-w-md items-center gap-4 text-left">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-black text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{file.name}</p>
              <p className="text-sm text-black/50">{formatBytes(file.size)}</p>
            </div>
            {!saving && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="rounded-full px-3 py-1 text-sm text-black/50 hover:bg-black/5 hover:text-black"
              >
                Change
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-5 border-t border-black/10 px-6 py-5 md:grid-cols-2">
        <Field label="Clip lengths">
          <div className="flex gap-2">
            {[15, 30, 60].map((d) => (
              <Chip
                key={d}
                active={durations.includes(d)}
                onClick={() => setDurations((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)))}
              >
                {d}s
              </Chip>
            ))}
          </div>
        </Field>
        <Field label={`Clips per length · ${perDuration}`}>
          <input type="range" min={1} max={8} value={perDuration} onChange={(e) => setPerDuration(Number(e.target.value))} className="w-full" />
        </Field>
        <Field label="Caption style">
          <div className="flex flex-wrap gap-2">
            {Object.entries(CAPTION_PRESETS).map(([key, p]) => (
              <Chip key={key} active={preset === key} onClick={() => setPreset(key)}>
                <span
                  className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full border border-black/20"
                  style={{ background: p.style.highlightColor }}
                />
                {p.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="9:16 reframing">
          <div className="flex gap-2">
            <Chip active={reframe === "track"} onClick={() => setReframe("track")}>
              Smart speaker tracking
            </Chip>
            <Chip active={reframe === "fit"} onClick={() => setReframe("fit")}>
              Fit + blur background
            </Chip>
          </div>
        </Field>
        <Field label="Spoken language">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm capitalize outline-none focus:border-black"
          >
            {Object.keys(LANGUAGES).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Captions / transcription">
          <div className="flex flex-wrap gap-2">
            <Chip active={transcription === "browser" && whisperModel === "base"} onClick={() => { setTranscription("browser"); setWhisperModel("base"); }}>
              In-browser · accurate
            </Chip>
            <Chip active={transcription === "browser" && whisperModel === "tiny"} onClick={() => { setTranscription("browser"); setWhisperModel("tiny"); }}>
              In-browser · fast
            </Chip>
            {caps?.cloudTranscription && (
              <Chip active={transcription === "cloud"} onClick={() => setTranscription("cloud")}>
                Cloud Whisper API
              </Chip>
            )}
            <Chip active={transcription === "none"} onClick={() => setTranscription("none")}>
              Off
            </Chip>
          </div>
        </Field>
        <div className="md:col-span-2">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/45">Runs on this device</p>
          <div className="flex flex-wrap gap-2 text-xs">
            {browser ? (
              <>
                <EngineBadge on={browser.webcodecs} label={browser.webcodecs ? "WebCodecs video engine" : "WebCodecs unsupported"} />
                <EngineBadge on={transcription !== "none"} label={transcription === "cloud" ? "Whisper API (audio sent to server)" : transcription === "none" ? "No transcription" : `Whisper ${whisperModel} in browser`} />
                <EngineBadge on={browser.isolated} label={browser.isolated ? `Multi-threaded WASM (${browser.threads} cores)` : "Single-threaded WASM"} />
                <EngineBadge on label="On-device moment & plot-twist AI" />
                {caps?.cloudAI && <EngineBadge on label={`+ GPT titles & moments (${caps.aiModel})`} />}
              </>
            ) : (
              <EngineBadge label="Checking browser capabilities…" />
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-black/10 bg-black/[0.02] px-6 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          {error && <p className="text-sm font-medium text-danger">{error}</p>}
          {!error && (
            <p className="text-sm text-black/50">
              {saving
                ? "Saving video to browser storage…"
                : durations.length
                  ? `Up to ${durations.length * perDuration} reels · captions · viral scores · plot-twist detection`
                  : "Pick at least one clip length"}
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={!file || saving || !durations.length}
          onClick={start}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-accent px-6 py-2.5 font-semibold text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:bg-black/20"
        >
          {saving ? "Starting…" : "Generate viral clips"}
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M5 12h14m-6-6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/45">{label}</p>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium transition",
        active ? "border-black bg-black text-white" : "border-black/15 text-black/70 hover:border-black/40",
      )}
    >
      {children}
    </button>
  );
}

function EngineBadge({ on, label }: { on?: boolean; label: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1", on ? "border-success/30 text-success" : "border-black/15 text-black/50")}>
      <span className={cx("h-1.5 w-1.5 rounded-full", on ? "bg-success" : "bg-black/30")} />
      {label}
    </span>
  );
}
