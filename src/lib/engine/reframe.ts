import type { CropKey, CropPath } from "../types";
import type { VisualSignal } from "./signals";

export type { CropKey, CropPath };

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0.5;
};

/**
 * Turn per-frame subject positions into a smooth virtual-camera path:
 * median-filtered, dead-zoned (camera holds still for small movements), eased toward the
 * subject, and hard-switched on scene cuts — mimicking how a human editor reframes.
 */
export function computeCropPath(visual: VisualSignal | null, start: number, end: number, srcW: number, srcH: number): CropPath {
  const cropFrac = Math.min(1, (srcH * 9) / 16 / srcW);
  const lo = cropFrac / 2;
  const hi = 1 - cropFrac / 2;
  if (!visual || !visual.subjectX.length || cropFrac >= 0.999) {
    const ys = (visual?.subjectY ?? []).slice(Math.floor(start * (visual?.fps ?? 2)), Math.ceil(end * (visual?.fps ?? 2))).filter((v): v is number => v !== null);
    return { keys: [{ t: 0, x: 0.5 }], y: ys.length ? median(ys) : 0.45, confidence: 0 };
  }
  const fps = visual.fps;
  const a = Math.max(0, Math.floor(start * fps));
  const b = Math.min(visual.subjectX.length - 1, Math.ceil(end * fps));
  const cutSet = visual.cuts.filter((c) => c > start + 0.2 && c < end - 0.2);

  // Split into shots at cuts.
  const shots: [number, number][] = [];
  let shotStart = a;
  for (const c of cutSet) {
    const idx = Math.round(c * fps);
    if (idx > shotStart) shots.push([shotStart, idx - 1]);
    shotStart = idx;
  }
  shots.push([shotStart, b]);

  const keys: CropKey[] = [];
  let confSum = 0;
  let confN = 0;
  for (const [s, e] of shots) {
    const raw: number[] = [];
    let last: number | null = null;
    for (let i = s; i <= e; i++) {
      const v = visual.subjectX[i];
      const c = visual.subjectConf[i] ?? 0;
      confSum += c;
      confN++;
      if (v !== null && c > 0.08) last = v;
      raw.push(last ?? NaN);
    }
    // Back-fill leading gaps, default to center if nothing found in the shot.
    const firstValid = raw.find((v) => !isNaN(v));
    for (let i = 0; i < raw.length; i++) if (isNaN(raw[i])) raw[i] = i === 0 || isNaN(raw[i - 1]) ? (firstValid ?? 0.5) : raw[i - 1];
    const filtered = raw.map((_, i) => median(raw.slice(Math.max(0, i - 2), i + 3)));
    let cam = median(filtered.slice(0, 4));
    const dead = 0.035;
    for (let i = 0; i < filtered.length; i++) {
      const target = filtered[i];
      const diff = target - cam;
      if (Math.abs(diff) > dead) cam += (diff - Math.sign(diff) * dead) * 0.6;
      const x = Math.max(lo, Math.min(hi, cam));
      const t = Math.max(0, (s + i) / fps - start);
      if (i === 0 && keys.length) keys.push({ t: Math.max(0, t - 0.001), x: keys[keys.length - 1].x });
      keys.push({ t, x });
    }
  }
  // Thin out keyframes to keep the ffmpeg expression compact.
  const maxKeys = 90;
  let out = keys;
  if (keys.length > maxKeys) {
    const step = Math.ceil(keys.length / maxKeys);
    out = keys.filter((k, i) => i % step === 0 || i === keys.length - 1 || (i > 0 && keys[i].t - keys[i - 1].t < 0.01) || (i + 1 < keys.length && keys[i + 1].t - k.t < 0.01));
  }
  const dedup: CropKey[] = [];
  for (const k of out) if (!dedup.length || k.t > dedup[dedup.length - 1].t || k.x !== dedup[dedup.length - 1].x) dedup.push(k);
  return { keys: dedup, y: 0.45, confidence: confN ? confSum / confN : 0 };
}

/** Interpolated normalized crop-window center at clip-relative time t. */
export function cropXAt(path: CropPath, t: number): number {
  const k = path.keys;
  if (!k.length) return 0.5;
  if (t <= k[0].t) return k[0].x;
  for (let i = 0; i < k.length - 1; i++) {
    if (t < k[i + 1].t) {
      const dt = k[i + 1].t - k[i].t;
      return dt <= 0 ? k[i + 1].x : k[i].x + ((k[i + 1].x - k[i].x) * (t - k[i].t)) / dt;
    }
  }
  return k[k.length - 1].x;
}
