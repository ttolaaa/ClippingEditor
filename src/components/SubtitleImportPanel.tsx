"use client";

import { useState } from "react";
import { importSubtitleFiles } from "@/lib/browser/pipeline";
import type { Job } from "@/lib/types";
import SubtitleFilePicker, { cuesFromEntries, type SubFileEntry } from "./SubtitleFilePicker";

/** Project-page panel: rebuild an Anime project's clip subtitles from the user's own subtitle/transcript files. */
export default function SubtitleImportPanel({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<SubFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const used = job.settings.subtitleFiles;

  const redo = async () => {
    if (!confirm("Redo the subtitles of every clip? This replaces the current subtitles, including your edits.")) return;
    setBusy(true);
    setError(null);
    setStatus("Redoing subtitles…");
    try {
      await importSubtitleFiles(job.id, {}, (d) => setStatus(d));
      setStatus("✓ Subtitles redone. Your previous edits in the clip editors were replaced.");
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const cues = cuesFromEntries(files);
    if (!cues.ja && !cues.en) return;
    setBusy(true);
    setError(null);
    setStatus("Rebuilding subtitles…");
    try {
      await importSubtitleFiles(job.id, cues, (d) => setStatus(d));
      setStatus(
        `✓ Subtitles rebuilt from your ${[cues.ja && "Japanese", cues.en && "English"].filter(Boolean).join(" + ")} file${cues.ja && cues.en ? "s" : ""}. Your previous edits in the clip editors were replaced.`,
      );
      setFiles([]);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-6 rounded-2xl border border-black/10 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Subtitle / transcript files</p>
          <p className="text-xs text-black/50">
            {used?.ja || used?.en
              ? `Using your ${[used.ja && `Japanese (${used.ja} lines)`, used.en && `English (${used.en} lines)`].filter(Boolean).join(" + ")} file.`
              : "For exact subtitles, import the video's Japanese and/or English subtitle files (.srt, .vtt, .ass)."}
          </p>
        </div>
        {!open && (
          <>
            <button
              type="button"
              onClick={redo}
              disabled={busy}
              title="Transcribe and translate the clips again (uses Cloud AI when it's available)"
              className="rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium hover:border-black disabled:opacity-40"
            >
              {busy ? "Working…" : "Redo subtitles"}
            </button>
            <button type="button" onClick={() => setOpen(true)} disabled={busy} className="rounded-full border border-black/15 px-4 py-1.5 text-sm font-medium hover:border-black disabled:opacity-40">
              Import subtitles
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="mt-3 border-t border-black/10 pt-3">
          <SubtitleFilePicker value={files} onChange={setFiles} compact />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !files.length}
              onClick={apply}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-dark disabled:opacity-40"
            >
              {busy ? "Rebuilding…" : "Rebuild clip subtitles"}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-full px-3 py-1.5 text-sm text-black/55 hover:text-black">
              Cancel
            </button>
            <span className="text-xs text-black/45">Replaces the current subtitles of every clip (including edits).</span>
          </div>
        </div>
      )}
      {status && <p className={status.startsWith("✓") ? "mt-2 text-xs text-success" : "mt-2 text-xs text-black/55"}>{status}</p>}
      {error && <p className="mt-2 text-xs text-danger">Import failed: {error}</p>}
    </section>
  );
}
