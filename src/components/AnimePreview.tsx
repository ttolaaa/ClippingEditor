"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { elementSource } from "@/lib/engine/renderer";
import { drawAnimeFrame } from "@/lib/anime/renderer";
import type { AnimeRenderOptions, AnimeSubtitle } from "@/lib/anime/types";

export interface AnimePreviewHandle {
  toggle(): void;
  seek(absolute: number): void;
  currentTime(): number;
}

interface Props extends AnimeRenderOptions {
  src: string | undefined;
  start: number;
  end: number;
  subtitles: AnimeSubtitle[];
  className?: string;
  muted?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  onTime?: (absolute: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

/** Live 9:16 preview: plays the source and draws the exact export frame (video + subtitles) on a canvas. */
const AnimePreview = forwardRef<AnimePreviewHandle, Props>(function AnimePreview(
  { src, start, end, layout, background, subtitles, className, muted, autoPlay, loop = false, onTime, onPlayingChange },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ start, end, layout, background, subtitles, onTime, loop });
  props.current = { start, end, layout, background, subtitles, onTime, loop };

  const draw = useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const p = props.current;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(2, Math.round(rect.width * dpr));
    const H = Math.max(2, Math.round(rect.height * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    if (v.readyState >= 2 && v.videoWidth) {
      drawAnimeFrame(ctx, W, H, elementSource(v, v.videoWidth, v.videoHeight), { layout: p.layout, background: p.background, subtitles: p.subtitles, t: v.currentTime });
    } else {
      ctx.fillStyle = "#0b0b12";
      ctx.fillRect(0, 0, W, H);
    }
    p.onTime?.(v.currentTime);
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const p = props.current;
        if (v.currentTime >= p.end - 0.03) {
          if (p.loop && !v.paused) v.currentTime = p.start;
          else {
            v.pause();
            v.currentTime = p.start;
          }
        } else if (!v.paused && v.currentTime < p.start - 0.5) v.currentTime = p.start;
        if (!v.paused) draw();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw, layout, background, subtitles]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const reset = () => {
      v.currentTime = start;
      if (autoPlay) v.play().catch(() => undefined);
    };
    if (v.readyState >= 1) reset();
    else v.addEventListener("loadedmetadata", reset, { once: true });
    return () => v.removeEventListener("loadedmetadata", reset);
  }, [src, start, autoPlay]);

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) {
          if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
          v.play().catch(() => undefined);
        } else v.pause();
      },
      seek: (t: number) => {
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(0, Math.min(v.duration || t, t));
      },
      currentTime: () => videoRef.current?.currentTime ?? 0,
    }),
    [start, end],
  );

  return (
    <div className={className} style={{ position: "relative" }}>
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        playsInline
        preload="auto"
        className="hidden"
        onSeeked={draw}
        onLoadedData={draw}
        onPlay={() => onPlayingChange?.(true)}
        onPause={() => {
          onPlayingChange?.(false);
          draw();
        }}
      />
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
});

export default AnimePreview;
