"use client";

import { useState } from "react";
import { cx } from "@/lib/client";
import AnimeAutoPanel from "./AnimeAutoPanel";
import AnimeClipper from "./AnimeClipper";
import ProjectList from "./ProjectList";

type Mode = "auto" | "manual";

/** Anime Clipper landing page: automatic viral clips (default) or one manually chosen range. */
export default function AnimeHome() {
  const [mode, setMode] = useState<Mode>("auto");
  return (
    <div className="mx-auto max-w-7xl px-5 pb-24 pt-10">
      <div className="mb-6">
        <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-black/60">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Anime Clipper · Japanese → furigana + English
        </p>
        <h1 className="text-4xl font-black tracking-tight sm:text-5xl">
          Viral anime clips with <span className="text-accent">furigana</span> &amp; English subtitles.
        </h1>
        <p className="mt-3 max-w-2xl text-black/60">
          Drop an episode: the app listens to the Japanese, finds the funniest, most emotional and most shocking moments, and cuts ranked 30s, 60s and 2-minute
          Reels with furigana and an English translation. The original frame is never cropped. Everything runs in your browser.
        </p>
      </div>

      <div className="mb-6 inline-flex rounded-full border border-black/10 bg-black/[0.03] p-1 text-sm font-medium" role="tablist" aria-label="Anime Clipper mode">
        {(
          [
            ["auto", "Auto viral clips"],
            ["manual", "Manual range"],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cx("rounded-full px-4 py-1.5 transition", mode === m ? "bg-ink text-white" : "text-black/60 hover:text-black")}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "auto" ? (
        <>
          <AnimeAutoPanel />
          <section className="mt-14">
            <h2 className="mb-4 text-xl font-bold tracking-tight">Your anime projects</h2>
            <ProjectList kind="anime" />
          </section>
        </>
      ) : (
        <AnimeClipper />
      )}
    </div>
  );
}
