import type { CaptionLine, CaptionStyle, CropPath, ReframeMode } from "../types";
import { activeLineAt } from "../captions";
import { cropXAt } from "./reframe";

/**
 * Shared 9:16 frame renderer used by BOTH the live preview player and the MP4 exporter
 * (main thread or Web Worker), so what you see while editing is exactly what you download.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameSource {
  width: number; // display width of the source video
  height: number;
  draw(ctx: Ctx, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export interface ReelFrameOptions {
  mode: ReframeMode;
  crop: CropPath;
  captions: CaptionLine[];
  style: CaptionStyle;
  /** Seconds relative to clip start. */
  t: number;
}

let blurCanvas: OffscreenCanvas | null = null;

export function drawReelFrame(ctx: Ctx, W: number, H: number, src: FrameSource, o: ReelFrameOptions) {
  const sw = src.width;
  const sh = src.height;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (sw > 0 && sh > 0) {
    if (o.mode === "fit") drawFit(ctx, W, H, src);
    else drawTrack(ctx, W, H, src, o.crop, o.t);
  }
  ctx.restore();
  drawCaptions(ctx, W, H, o.captions, o.style, o.t);
}

function drawTrack(ctx: Ctx, W: number, H: number, src: FrameSource, crop: CropPath, t: number) {
  const sw = src.width;
  const sh = src.height;
  const target = W / H;
  if (sw / sh > target) {
    const cw = sh * target;
    const x = Math.max(0, Math.min(sw - cw, cropXAt(crop, t) * sw - cw / 2));
    src.draw(ctx, x, 0, cw, sh, 0, 0, W, H);
  } else {
    const ch = sw / target;
    const y = Math.max(0, Math.min(sh - ch, crop.y * sh - ch / 2));
    src.draw(ctx, 0, y, sw, ch, 0, 0, W, H);
  }
}

function drawFit(ctx: Ctx, W: number, H: number, src: FrameSource) {
  const sw = src.width;
  const sh = src.height;
  // Blurred, darkened "cover" background via a down/up-scale (works everywhere, unlike ctx.filter).
  const bw = Math.max(8, Math.round(W / 24));
  const bh = Math.max(8, Math.round(H / 24));
  if (typeof OffscreenCanvas !== "undefined") {
    if (!blurCanvas || blurCanvas.width !== bw || blurCanvas.height !== bh) blurCanvas = new OffscreenCanvas(bw, bh);
    const b = blurCanvas.getContext("2d")!;
    const s = Math.max(bw / sw, bh / sh);
    const cw = bw / s;
    const ch = bh / s;
    src.draw(b, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, bw, bh);
    ctx.drawImage(blurCanvas, 0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, W, H);
  }
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s;
  const dh = sh * s;
  src.draw(ctx, 0, 0, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

interface Laid {
  text: string;
  width: number;
  index: number;
}

export function drawCaptions(ctx: Ctx, W: number, H: number, lines: CaptionLine[], style: CaptionStyle, t: number) {
  if (!style.enabled) return;
  const line = activeLineAt(lines, t);
  if (!line) return;
  const k = W / 1080;
  const fs = style.fontSize * k;
  const words = line.words.length ? line.words : [{ text: line.text, start: line.start, end: line.end }];
  let active = -1;
  for (let i = 0; i < words.length; i++) if (t >= words[i].start) active = i;

  ctx.save();
  ctx.font = `700 ${fs}px "${style.fontFamily}", "Arial Black", Impact, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  const space = ctx.measureText(" ").width;
  const maxW = W * 0.88;
  const rows: Laid[][] = [[]];
  let rowW = 0;
  words.forEach((w, index) => {
    const text = style.uppercase ? w.text.toUpperCase() : w.text;
    const width = ctx.measureText(text).width;
    const cur = rows[rows.length - 1];
    if (cur.length && rowW + space + width > maxW) {
      rows.push([]);
      rowW = 0;
    }
    const r = rows[rows.length - 1];
    rowW += (r.length ? space : 0) + width;
    r.push({ text, width, index });
  });

  const lh = fs * 1.25;
  const cy = (style.positionY / 100) * H;
  const top = cy - (rows.length * lh) / 2 + lh / 2;
  // Whole-line pop when a new caption appears.
  const age = t - line.start;
  const linePop = style.popAnimation && age < 0.12 ? 0.85 + (0.15 * Math.max(0, age)) / 0.12 : 1;
  ctx.translate(W / 2, cy);
  ctx.scale(linePop, linePop);
  ctx.translate(-W / 2, -cy);

  const pad = Math.max(8, style.outlineWidth) * k;
  rows.forEach((row, ri) => {
    const width = row.reduce((a, w) => a + w.width, 0) + space * (row.length - 1);
    let x = (W - width) / 2;
    const y = top + ri * lh;
    if (style.background) {
      ctx.fillStyle = style.backgroundColor;
      roundRect(ctx, x - pad, y - lh / 2 - pad * 0.15, width + pad * 2, lh + pad * 0.3, pad * 0.6);
      ctx.fill();
    }
    for (const w of row) {
      const isActive = style.highlightActiveWord && w.index === active;
      ctx.save();
      if (isActive && style.popAnimation) {
        const cx = x + w.width / 2;
        ctx.translate(cx, y);
        ctx.scale(1.12, 1.12);
        ctx.translate(-cx, -y);
      }
      if (!style.background) {
        const sh = Math.max(1, style.outlineWidth / 2) * k;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        if (style.outlineWidth > 0) {
          ctx.lineWidth = style.outlineWidth * 2 * k;
          ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.strokeText(w.text, x + sh, y + sh);
        }
        ctx.fillText(w.text, x + sh, y + sh);
        if (style.outlineWidth > 0) {
          ctx.lineWidth = style.outlineWidth * 2 * k;
          ctx.strokeStyle = style.outlineColor;
          ctx.strokeText(w.text, x, y);
        }
      }
      ctx.fillStyle = isActive ? style.highlightColor : style.textColor;
      ctx.fillText(w.text, x, y);
      ctx.restore();
      x += w.width + space;
    }
  });
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Adapter for an HTMLVideoElement / image / canvas. */
export function elementSource(el: CanvasImageSource, width: number, height: number): FrameSource {
  return {
    width,
    height,
    draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh),
  };
}
