export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameGeometry {
  /** Where the untouched source video is drawn. */
  video: Rect;
  /** The empty band below the video reserved for subtitles. */
  text: Rect;
}

/** Minimum share of the canvas height kept free below the video for subtitles. */
const MIN_TEXT_SHARE = 0.24;
/** Bottom share left empty so subtitles stay clear of the Reels/Shorts UI overlay. */
const SAFE_BOTTOM_SHARE = 0.07;

/**
 * Fit the source into the canvas WITHOUT cropping (aspect ratio preserved) and centre it. Landscape sources leave a
 * large letterbox, whose lower half carries the subtitles. Portrait / tall sources have little or no margin, so they are
 * scaled down just enough to free MIN_TEXT_SHARE of the height, and centred in the space above the text band.
 */
export function computeGeometry(srcW: number, srcH: number, W: number, H: number): FrameGeometry {
  const fit = Math.min(W / srcW, H / srcH);
  let vw = srcW * fit;
  let vh = srcH * fit;
  let vy = (H - vh) / 2;
  if (H - (vy + vh) < H * MIN_TEXT_SHARE) {
    const avail = H * (1 - MIN_TEXT_SHARE);
    const s = Math.min(W / srcW, avail / srcH);
    vw = srcW * s;
    vh = srcH * s;
    vy = (avail - vh) / 2;
  }
  const video = { x: Math.round((W - vw) / 2), y: Math.round(vy), w: Math.round(vw), h: Math.round(vh) };
  const textTop = video.y + video.h;
  return { video, text: { x: 0, y: textTop, w: W, h: Math.max(0, H - textTop - H * SAFE_BOTTOM_SHARE) } };
}
