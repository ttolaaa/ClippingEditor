import { drawBlurBackground, type FrameSource } from "../engine/renderer";
import { computeGeometry } from "./frame";
import { NO_LINE_START } from "./ruby";
import { activeSubtitleAt } from "./subtitles";
import type { AnimeRenderOptions, AnimeSubtitle, RubySegment } from "./types";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Anime Clipper frame renderer, shared by the live preview and the MP4 exporter:
 *   background (blur / solid) -> untouched source video, centred -> subtitles in the free band below the video.
 */

const JA_FONT = `"Yu Gothic UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Meiryo", "MS Gothic", sans-serif`;
const EN_FONT = `"Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

const JA_SIZE = 64; // px on a 1080-wide canvas
const EN_SIZE = 46;
const RUBY_RATIO = 0.46;
const JA_COLOR = "#ffffff";
const RUBY_COLOR = "#ffd666";
const EN_COLOR = "#c9f1ff";

interface Cell {
  text: string;
  ruby?: string;
  width: number;
  baseW: number;
  rubyW: number;
}
interface JaLine {
  cells: Cell[];
  width: number;
  hasRuby: boolean;
}

export interface AnimeFrameOptions extends AnimeRenderOptions {
  /** Absolute source time in seconds. */
  t: number;
  subtitles: AnimeSubtitle[];
}

export function drawAnimeFrame(ctx: Ctx, W: number, H: number, src: FrameSource, o: AnimeFrameOptions) {
  ctx.save();
  ctx.fillStyle = "#0b0b12";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (src.width > 0 && src.height > 0) {
    if (o.background === "blur") drawBlurBackground(ctx, W, H, src);
    const g = computeGeometry(src.width, src.height, W, H);
    src.draw(ctx, 0, 0, src.width, src.height, g.video.x, g.video.y, g.video.w, g.video.h);
    const sub = activeSubtitleAt(o.subtitles, o.t);
    if (sub) drawSubtitle(ctx, W, g.text, sub, o.layout);
  }
  ctx.restore();
}

function drawSubtitle(ctx: Ctx, W: number, area: { x: number; y: number; w: number; h: number }, sub: AnimeSubtitle, layout: AnimeRenderOptions["layout"]) {
  const k = W / 1080;
  const showJa = layout !== "en" && sub.ja.length > 0;
  const showEn = layout !== "ja" && sub.en.trim().length > 0;
  if (!showJa && !showEn) return;
  const enFirst = layout === "swapped";
  const maxW = W * 0.9;
  const pad = 28 * k;
  const availH = Math.max(40, area.h - pad * 2);

  // Shrink the whole stack until it fits the band (wrapping changes with size, so measure again each pass).
  let scale = 1;
  let built = build(ctx, sub, showJa, showEn, k, scale, maxW);
  for (let i = 0; i < 6 && built.height > availH && scale > 0.4; i++) {
    scale *= Math.max(0.4 / scale, Math.min(0.92, availH / built.height));
    built = build(ctx, sub, showJa, showEn, k, scale, maxW);
  }

  let y = area.y + pad + Math.max(0, (availH - built.height) / 2);
  const blocks = enFirst ? [built.en, built.ja] : [built.ja, built.en];
  for (const block of blocks) {
    if (!block) continue;
    block.draw(W / 2, y);
    y += block.height + built.gap;
  }
}

interface Block {
  height: number;
  draw(cx: number, top: number): void;
}

function build(ctx: Ctx, sub: AnimeSubtitle, showJa: boolean, showEn: boolean, k: number, scale: number, maxW: number) {
  const ja = showJa ? buildJa(ctx, sub.ja, JA_SIZE * k * scale, maxW) : null;
  const en = showEn ? buildEn(ctx, sub.en.trim(), EN_SIZE * k * scale, maxW) : null;
  const gap = ja && en ? 22 * k * scale : 0;
  const height = (ja?.height ?? 0) + (en?.height ?? 0) + gap;
  return { ja, en, gap, height };
}

function outlined(ctx: Ctx, text: string, x: number, y: number, fill: string, lineWidth: number) {
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = "rgba(0,0,0,0.92)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function greedyWrap(cells: Cell[], maxW: number, preferCommaAfter: number): JaLine[] {
  const lines: JaLine[] = [];
  let cur: JaLine = { cells: [], width: 0, hasRuby: false };
  const push = () => {
    lines.push(cur);
    cur = { cells: [], width: 0, hasRuby: false };
  };
  for (const c of cells) {
    if (cur.cells.length && cur.width + c.width > maxW && !NO_LINE_START.test(c.text[0])) push();
    cur.cells.push(c);
    cur.width += c.width;
    if (c.ruby) cur.hasRuby = true;
    // A natural pause ("、") close to the target width is a better break than a mid-phrase one.
    if (/[、,]$/.test(c.text) && cur.width >= preferCommaAfter && cur.width <= maxW) push();
  }
  if (cur.cells.length) lines.push(cur);
  return lines;
}

/**
 * Japanese line breaking: find how many lines the text needs, then re-wrap at the narrowest width that still fits in
 * that many lines, so the lines come out balanced instead of leaving one or two characters alone on the last line.
 */
function wrapJa(cells: Cell[], maxW: number): JaLine[] {
  const total = cells.reduce((n, c) => n + c.width, 0);
  if (total <= maxW) return greedyWrap(cells, maxW, Infinity);
  const n = greedyWrap(cells, maxW, Infinity).length;
  let lo = total / n;
  let hi = maxW;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (greedyWrap(cells, mid, Infinity).length <= n) hi = mid;
    else lo = mid;
  }
  const withComma = greedyWrap(cells, hi, hi * 0.6);
  return withComma.length <= n ? withComma : greedyWrap(cells, hi, Infinity);
}

function buildJa(ctx: Ctx, segs: RubySegment[], fs: number, maxW: number): Block {
  const rubyFs = fs * RUBY_RATIO;
  const baseFont = `700 ${fs}px ${JA_FONT}`;
  const rubyFont = `700 ${rubyFs}px ${JA_FONT}`;
  const measure = (font: string, s: string) => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };

  // Plain runs wrap per character (Japanese has no spaces); ruby runs stay whole so a reading is never split.
  const cells: Cell[] = [];
  for (const s of segs) {
    if (s.ruby) {
      const baseW = measure(baseFont, s.text);
      const rubyW = measure(rubyFont, s.ruby);
      cells.push({ text: s.text, ruby: s.ruby, baseW, rubyW, width: Math.max(baseW, rubyW) });
    } else {
      for (const ch of Array.from(s.text)) {
        const w = measure(baseFont, ch);
        cells.push({ text: ch, baseW: w, rubyW: 0, width: w });
      }
    }
  }

  const lines = wrapJa(cells, maxW);

  const rubyH = rubyFs * 1.12;
  const bodyH = fs * 1.14;
  const lineGap = fs * 0.12;
  // Every line reserves the ruby row once any line has furigana, so line spacing stays even.
  const anyRuby = lines.some((l) => l.hasRuby);
  const lineH = (anyRuby ? rubyH : 0) + bodyH;
  const height = lines.length * lineH + Math.max(0, lines.length - 1) * lineGap;

  return {
    height,
    draw(cx, top) {
      ctx.save();
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      lines.forEach((line, i) => {
        const lineTop = top + i * (lineH + lineGap);
        const baseY = lineTop + (anyRuby ? rubyH : 0) + fs * 0.9;
        const rubyY = lineTop + rubyFs * 0.95;
        let x = cx - line.width / 2;
        for (const c of line.cells) {
          if (c.ruby) {
            ctx.font = rubyFont;
            outlined(ctx, c.ruby, x + (c.width - c.rubyW) / 2, rubyY, RUBY_COLOR, rubyFs * 0.26);
          }
          ctx.font = baseFont;
          outlined(ctx, c.text, x + (c.width - c.baseW) / 2, baseY, JA_COLOR, fs * 0.17);
          x += c.width;
        }
      });
      ctx.restore();
    },
  };
}

function buildEn(ctx: Ctx, text: string, fs: number, maxW: number): Block {
  const font = `600 ${fs}px ${EN_FONT}`;
  ctx.font = font;
  const space = ctx.measureText(" ").width;
  const lines: { text: string; width: number }[] = [];
  let cur: string[] = [];
  let curW = 0;
  for (const word of text.split(/\s+/)) {
    const w = ctx.measureText(word).width;
    if (cur.length && curW + space + w > maxW) {
      lines.push({ text: cur.join(" "), width: curW });
      cur = [];
      curW = 0;
    }
    curW += (cur.length ? space : 0) + w;
    cur.push(word);
  }
  if (cur.length) lines.push({ text: cur.join(" "), width: curW });

  const lineH = fs * 1.28;
  return {
    height: lines.length * lineH,
    draw(cx, top) {
      ctx.save();
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      lines.forEach((l, i) => outlined(ctx, l.text, cx, top + i * lineH + fs * 0.98, EN_COLOR, fs * 0.2));
      ctx.restore();
    },
  };
}
