"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { CaptionLine, CaptionStyle, CropPath, ReframeMode } from "@/lib/types";
import { drawReelFrame, elementSource } from "@/lib/engine/renderer";

export interface ReelPlayerHandle {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(rel: number): void;
}

interface Props {
  src: string | undefined;
  start: number;
  end: number;
  mode: ReframeMode;
  crop: CropPath;
  captions: CaptionLine[];
  style: CaptionStyle;
  muted?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  className?: string;
  onTime?: (rel: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

/**
 * Live 9:16 preview: plays the original video and renders the smart crop + captions onto a canvas every
 * frame using the same renderer as the exporter — no pre-rendered preview files needed.
 */
const ReelPlayer = forwardRef<ReelPlayerHandle, Props>(function ReelPlayer(
  { src, start, end, mode, crop, captions, style, muted, autoPlay, loop = true, className, onTime, onPlayingChange },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ start, end, mode, crop, captions, style, loop, onTime });
  props.current = { start, end, mode, crop, captions, style, loop, onTime };

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
    const t = Math.max(0, v.currentTime - p.start);
    if (v.readyState >= 2 && v.videoWidth) {
      drawReelFrame(ctx, W, H, elementSource(v, v.videoWidth, v.videoHeight), { mode: p.mode, crop: p.crop, captions: p.captions, style: p.style, t });
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    }
    p.onTime?.(t);
  }, []);

  // Render loop while playing; keep the clip window bounded.
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
        } else if (v.currentTime < p.start - 0.5) v.currentTime = p.start;
        if (!v.paused) draw();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // Redraw when the edit changes while paused.
  useEffect(() => {
    draw();
  }, [draw, mode, crop, captions, style]);

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
      play: () => videoRef.current?.play().catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      toggle: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => undefined);
        else v.pause();
      },
      seek: (rel: number) => {
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(start, Math.min(end - 0.05, start + rel));
      },
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

export default ReelPlayer;
