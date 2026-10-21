/**
 * Pure signal feature extraction (runs in a Web Worker). Audio is analysed from 16 kHz mono
 * PCM, video from small RGBA frames sampled at a low frame rate.
 */

export const AUDIO_RATE = 16000;
export const AUDIO_BIN = 0.5;

export interface AudioSignal {
  bin: number;
  rmsDb: number[];
  peakDb: number[];
  variability: number[];
}

export interface VisualSignal {
  fps: number;
  width: number;
  height: number;
  motion: number[];
  cutScore: number[];
  cuts: number[];
  subjectX: (number | null)[];
  subjectY: (number | null)[];
  subjectConf: number[];
  skinFrac: number[];
  brightness: number[];
}

export function analyzeAudio(pcm: Float32Array): AudioSignal {
  const samplesPerBin = Math.round(AUDIO_RATE * AUDIO_BIN);
  const subSize = Math.round(AUDIO_RATE * 0.05);
  const toDb = (ms: number) => 10 * Math.log10(ms + 1e-10);
  const rmsDb: number[] = [];
  const peakDb: number[] = [];
  const variability: number[] = [];
  for (let b = 0; b < pcm.length; b += samplesPerBin) {
    const end = Math.min(pcm.length, b + samplesPerBin);
    let sum = 0;
    const subs: number[] = [];
    for (let s = b; s < end; s += subSize) {
      const se = Math.min(end, s + subSize);
      let ss = 0;
      for (let i = s; i < se; i++) ss += pcm[i] * pcm[i];
      sum += ss;
      subs.push(toDb(ss / Math.max(1, se - s)));
    }
    rmsDb.push(toDb(sum / Math.max(1, end - b)));
    peakDb.push(subs.length ? Math.max(...subs) : -100);
    const mean = subs.reduce((x, y) => x + y, 0) / (subs.length || 1);
    variability.push(Math.sqrt(subs.reduce((x, y) => x + (y - mean) ** 2, 0) / (subs.length || 1)));
  }
  return { bin: AUDIO_BIN, rmsDb, peakDb, variability };
}

/**
 * Incremental visual analyser: motion energy, scene-cut likelihood, and a saliency map combining
 * skin tone (faces / speakers) with motion. The 9:16 window capturing most saliency drives auto-reframing.
 */
export class VisualAnalyzer {
  readonly out: VisualSignal;
  private prevY: Float32Array | null = null;
  private prevHist: Float32Array | null = null;
  private colW: Float32Array;
  private rowW: Float32Array;
  private cropFrac: number;
  private cropCols: number;
  private cropRows: number;

  constructor(
    readonly aw: number,
    readonly ah: number,
    srcW: number,
    srcH: number,
    fps: number,
  ) {
    this.out = { fps, width: aw, height: ah, motion: [], cutScore: [], cuts: [], subjectX: [], subjectY: [], subjectConf: [], skinFrac: [], brightness: [] };
    this.colW = new Float32Array(aw);
    this.rowW = new Float32Array(ah);
    this.cropFrac = Math.min(1, (srcH * 9) / 16 / srcW);
    this.cropCols = Math.max(1, Math.round(this.cropFrac * aw));
    this.cropRows = Math.max(1, Math.round(Math.min(1, (srcW * 16) / 9 / srcH) * ah));
  }

  /** Feed one RGBA frame (aw × ah). */
  push(rgba: Uint8ClampedArray) {
    const { aw, ah, colW, rowW, cropCols, cropRows, cropFrac } = this;
    const n = aw * ah;
    const Y = new Float32Array(n);
    const hist = new Float32Array(48);
    colW.fill(0);
    rowW.fill(0);
    let skin = 0;
    let motionSum = 0;
    let bright = 0;
    const prevY = this.prevY;
    for (let y = 0; y < ah; y++) {
      const rowBias = y < ah * 0.7 ? 1 : 0.5;
      for (let x = 0; x < aw; x++) {
        const i = y * aw + x;
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        Y[i] = lum;
        bright += lum;
        hist[r >> 4]++;
        hist[16 + (g >> 4)]++;
        hist[32 + (b >> 4)]++;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        let w = 0;
        if (lum > 45 && cr >= 133 && cr <= 175 && cb >= 77 && cb <= 127) {
          skin++;
          w += 3 * rowBias;
        }
        if (prevY) {
          const d = Math.abs(lum - prevY[i]);
          motionSum += d;
          if (d > 18) w += rowBias;
        }
        colW[x] += w;
        rowW[y] += w;
      }
    }
    let cut = 0;
    if (this.prevHist) {
      let diff = 0;
      for (let k = 0; k < 48; k++) diff += Math.abs(hist[k] - this.prevHist[k]);
      cut = Math.min(1, diff / (3 * n * 2));
    }
    const motion = prevY ? Math.min(1, motionSum / n / 64) : 0;

    let total = 0;
    for (let x = 0; x < aw; x++) total += colW[x];
    let best: number | null = null;
    let conf = 0;
    if (total > n * 0.004) {
      let sum = 0;
      for (let x = 0; x < cropCols; x++) sum += colW[x];
      let bestSum = sum;
      let bestStart = 0;
      for (let x = cropCols; x < aw; x++) {
        sum += colW[x] - colW[x - cropCols];
        if (sum > bestSum) {
          bestSum = sum;
          bestStart = x - cropCols + 1;
        }
      }
      // Center on the saliency centroid inside the winning window so the subject is framed centrally.
      let cw = 0;
      let cx = 0;
      for (let x = bestStart; x < bestStart + cropCols; x++) {
        cw += colW[x];
        cx += colW[x] * (x + 0.5);
      }
      best = cw > 0 ? cx / cw / aw : (bestStart + cropCols / 2) / aw;
      conf = Math.max(0, Math.min(1, (bestSum / total - cropFrac) / Math.max(0.05, 1 - cropFrac)));
      if (cropFrac >= 0.999) conf = Math.min(1, total / (n * 0.05));
    }
    let bestY: number | null = null;
    if (total > n * 0.004 && cropRows < ah) {
      let sum = 0;
      for (let y = 0; y < cropRows; y++) sum += rowW[y];
      let bestSum = sum;
      let bestStart = 0;
      for (let y = cropRows; y < ah; y++) {
        sum += rowW[y] - rowW[y - cropRows];
        if (sum > bestSum) {
          bestSum = sum;
          bestStart = y - cropRows + 1;
        }
      }
      bestY = (bestStart + cropRows / 2) / ah;
    }
    const o = this.out;
    o.motion.push(motion);
    o.cutScore.push(cut);
    o.subjectX.push(best);
    o.subjectY.push(bestY);
    o.subjectConf.push(conf);
    o.skinFrac.push(skin / n);
    o.brightness.push(bright / n / 255);
    this.prevY = Y;
    this.prevHist = hist;
  }

  finish(): VisualSignal {
    const score = this.out.cutScore;
    const fps = this.out.fps;
    const cuts: number[] = [];
    for (let i = 1; i < score.length; i++) {
      const window = score.slice(Math.max(1, i - 8), i).concat(score.slice(i + 1, i + 8)).sort((a, b) => a - b);
      const median = window.length ? window[Math.floor(window.length / 2)] : 0;
      if (score[i] > 0.35 && score[i] > median * 2.5 + 0.08) {
        const t = i / fps;
        if (!cuts.length || t - cuts[cuts.length - 1] > 0.9) cuts.push(t);
      }
    }
    this.out.cuts = cuts;
    return this.out;
  }
}

/** Mix planar channels to mono and resample to 16 kHz with a box low-pass + linear interpolation. */
export class Resampler16k {
  private ratio: number;
  private pos = 0; // fractional read position in the input stream (input samples)
  private tail: number[] = [];
  private chunks: Float32Array[] = [];
  length = 0;

  constructor(private inRate: number) {
    this.ratio = inRate / AUDIO_RATE;
  }

  push(mono: Float32Array) {
    const win = Math.max(1, Math.round(this.ratio));
    const buf = this.tail.length ? Float32Array.from([...this.tail, ...mono]) : mono;
    const base = this.pos;
    const out: number[] = [];
    let p = base;
    while (p + win + 1 < buf.length) {
      const i = Math.floor(p);
      let s = 0;
      for (let k = 0; k < win; k++) s += buf[i + k];
      out.push(s / win);
      p += this.ratio;
    }
    const consumed = Math.floor(p);
    this.tail = Array.from(buf.subarray(consumed));
    this.pos = p - consumed;
    if (out.length) {
      const f = Float32Array.from(out);
      this.chunks.push(f);
      this.length += f.length;
    }
  }

  result(): Float32Array {
    const out = new Float32Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  get rate() {
    return this.inRate;
  }
}
