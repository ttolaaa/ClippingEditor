"use client";

import type { FFmpeg } from "@ffmpeg/ffmpeg";

/**
 * ffmpeg.wasm fallbacks (self-hosted under /ffmpeg, see scripts/copy-ffmpeg-core.mjs), used only when the
 * browser's native WebCodecs can't handle a file:
 *  - convertToMp4: containers/codecs the browser can't demux or decode (e.g. AVI)
 *  - decodeAudioPcm: audio codecs WebCodecs can't decode in this browser
 */

let instance: Promise<FFmpeg> | null = null;
let busy: Promise<unknown> = Promise.resolve();

async function load(): Promise<FFmpeg> {
  instance ??= (async () => {
    const base = `${location.origin}/ffmpeg`;
    const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${base}/lib/index.js`)) as { FFmpeg: new () => FFmpeg };
    const ff = new mod.FFmpeg();
    await ff.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL: `${base}/ffmpeg-core.wasm` });
    return ff;
  })().catch((e) => {
    instance = null;
    throw e;
  });
  return instance;
}

/** Serialize jobs on the single ffmpeg instance. */
function exclusive<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T> {
  const run = busy.then(async () => fn(await load()));
  busy = run.catch(() => undefined);
  return run;
}

async function withInput<T>(ff: FFmpeg, file: Blob, name: string, fn: (path: string) => Promise<T>): Promise<T> {
  const safe = (name.replace(/[^\w.\-]+/g, "_") || "input").slice(-80);
  const dir = `/in${Math.random().toString(36).slice(2, 8)}`;
  await ff.createDir(dir);
  await ff.mount("WORKERFS" as never, { files: [new File([file], safe)] }, dir);
  try {
    return await fn(`${dir}/${safe}`);
  } finally {
    await ff.unmount(dir).catch(() => undefined);
    await ff.deleteDir(dir).catch(() => undefined);
  }
}

export function convertToMp4(file: Blob, name: string, onProgress: (f: number) => void): Promise<Blob> {
  return exclusive(async (ff) => {
    const listener = ({ progress }: { progress: number }) => progress > 0 && progress <= 1 && onProgress(progress);
    ff.on("progress", listener);
    try {
      return await withInput(ff, file, name, async (input) => {
        const code = await ff.exec([
          "-i", input,
          "-vf", "scale='min(1920,iw)':-2",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k",
          "-movflags", "+faststart",
          "/out.mp4",
        ]);
        if (code !== 0) throw new Error(`ffmpeg.wasm exited with code ${code}`);
        const data = (await ff.readFile("/out.mp4")) as Uint8Array;
        await ff.deleteFile("/out.mp4");
        return new Blob([data as BlobPart], { type: "video/mp4" });
      });
    } finally {
      ff.off("progress", listener);
    }
  });
}

/** Decode (a range of) the audio track to planar Float32 PCM. */
export function decodeAudioPcm(
  file: Blob,
  opts: { rate: number; channels: number; start?: number; duration?: number },
): Promise<Float32Array[]> {
  return exclusive((ff) =>
    withInput(ff, file, "source.mp4", async (input) => {
      const args = [
        ...(opts.start ? ["-ss", opts.start.toFixed(3)] : []),
        "-i", input,
        ...(opts.duration ? ["-t", opts.duration.toFixed(3)] : []),
        "-vn", "-ac", String(opts.channels), "-ar", String(opts.rate), "-f", "f32le", "/audio.raw",
      ];
      const code = await ff.exec(args);
      if (code !== 0) throw new Error(`ffmpeg.wasm audio decode failed (${code})`);
      const raw = (await ff.readFile("/audio.raw")) as Uint8Array;
      await ff.deleteFile("/audio.raw");
      const inter = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
      const frames = Math.floor(inter.length / opts.channels);
      const planes = Array.from({ length: opts.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < opts.channels; c++) planes[c][i] = inter[i * opts.channels + c];
      return planes;
    }),
  );
}
