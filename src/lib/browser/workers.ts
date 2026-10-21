"use client";

import type { WorkerRequest } from "./media.worker";

export type WorkerMessage = { type: string; [k: string]: unknown };

/** Run one task on a fresh media worker; resolves with the final message, streaming the rest to onMessage. */
export function runMediaTask(
  req: WorkerRequest,
  finalType: string,
  onMessage?: (m: WorkerMessage) => void,
  signal?: AbortSignal,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./media.worker.ts", import.meta.url), { type: "module" });
    const done = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "error") {
        done();
        reject(new Error(String(m.message)));
      } else if (m.type === finalType) {
        done();
        resolve(m);
      } else onMessage?.(m);
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || "Media worker crashed"));
    };
    worker.postMessage(req);
  });
}

/** Whether the browser's <video> element can play this blob (needed for the live preview player). */
export function canPlayInVideoElement(blob: Blob, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => finish(v.videoWidth > 0);
    v.onerror = () => finish(false);
    v.src = url;
  });
}
