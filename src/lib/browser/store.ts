"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Clip, Job, JobSummary } from "../types";
import { BLOBS, DATA, JOBS, idbAll, idbDelete, idbDeletePrefix, idbGet, idbPut } from "./db";

/**
 * Client-side job store: the source of truth is in memory (so the UI re-renders on every progress tick),
 * persisted to IndexedDB with a short debounce.
 */

type Listener = () => void;

const jobs = new Map<string, Job>();
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let loaded: Promise<void> | null = null;
let version = 0;
/** Jobs being processed by this tab right now (anything else marked "processing" was interrupted). */
export const activeJobs = new Set<string>();

let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce change notifications (progress events can arrive hundreds of times per second). */
function emit() {
  version++;
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const l of listeners) l();
  }, 16);
}

export function loadJobs(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    const all = await idbAll<Job>(JOBS);
    for (const job of all) {
      if ((job.status === "processing" || job.status === "queued") && !activeJobs.has(job.id)) {
        job.status = "error";
        job.error = "Processing was interrupted (the tab was closed or reloaded). Click “Retry” to process again — the video is still saved in your browser.";
        job.etaSeconds = undefined;
        for (const s of job.stages) if (s.status === "active") s.status = "error";
      }
      for (const c of job.clips) c.export = { status: "idle", progress: 0 };
      jobs.set(job.id, job);
    }
    emit();
  })();
  return loaded;
}

function persist(id: string, immediate = false) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  const write = () => {
    timers.delete(id);
    const job = jobs.get(id);
    if (!job) return;
    // Export progress is transient and not stored.
    const copy: Job = { ...job, clips: job.clips.map((c) => ({ ...c, export: { status: "idle", progress: 0 } })) };
    idbPut(JOBS, copy).catch((e) => console.error("Failed to save project", e));
  };
  if (immediate) write();
  else timers.set(id, setTimeout(write, 400));
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function putJob(job: Job, immediate = true) {
  job.updatedAt = Date.now();
  jobs.set(job.id, job);
  persist(job.id, immediate);
  emit();
}

/** Immutable-style update so React sees new object identities. */
export function updateJob(id: string, fn: (job: Job) => void, immediate = false): Job | undefined {
  const cur = jobs.get(id);
  if (!cur) return undefined;
  const next: Job = structuredClone(cur);
  fn(next);
  next.updatedAt = Date.now();
  jobs.set(id, next);
  persist(id, immediate);
  emit();
  return next;
}

export function updateClip(jobId: string, clipId: string, fn: (clip: Clip) => void, immediate = false) {
  return updateJob(
    jobId,
    (j) => {
      const c = j.clips.find((x) => x.id === clipId);
      if (c) fn(c);
    },
    immediate,
  );
}

export async function deleteJob(id: string) {
  jobs.delete(id);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  emit();
  await idbDelete(JOBS, id);
  await idbDeletePrefix(BLOBS, `${id}:`);
  await idbDeletePrefix(DATA, `${id}:`);
}

export function summarize(job: Job): JobSummary {
  const top = [...job.clips].sort((a, b) => b.viralScore - a.viralScore)[0];
  return {
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    status: job.status,
    progress: job.progress,
    etaSeconds: job.etaSeconds,
    duration: job.source?.duration,
    clipCount: job.clips.length,
    topScore: top?.viralScore,
    thumbnail: top?.thumbnail,
  };
}

// ---------------------------------------------------------------- blobs & data

export const blobKey = (jobId: string, name: string) => `${jobId}:${name}`;

export function putBlob(jobId: string, name: string, blob: Blob) {
  return idbPut(BLOBS, blob, blobKey(jobId, name));
}

export function getBlob(jobId: string, name: string) {
  return idbGet<Blob>(BLOBS, blobKey(jobId, name));
}

export function putData(jobId: string, name: string, data: unknown) {
  return idbPut(DATA, data, blobKey(jobId, name));
}

export function getData<T>(jobId: string, name: string) {
  return idbGet<T>(DATA, blobKey(jobId, name));
}

// ---------------------------------------------------------------- React hooks

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function useStoreVersion() {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

export function useJobs(): Job[] | null {
  const [ready, setReady] = useState(false);
  useStoreVersion();
  useEffect(() => {
    loadJobs().then(() => setReady(true));
  }, []);
  return ready ? listJobs() : null;
}

export function useJob(id: string): { job: Job | undefined; loading: boolean } {
  const [ready, setReady] = useState(false);
  useStoreVersion();
  useEffect(() => {
    loadJobs().then(() => setReady(true));
  }, []);
  return { job: jobs.get(id), loading: !ready };
}

const urlCache = new Map<string, string>();

/** Object URL for a blob stored in IndexedDB (cached for the session; bump `rev` when the blob is replaced). */
export function useBlobUrl(jobId: string, name: string | undefined, rev = 0): string | undefined {
  const key = name ? `${blobKey(jobId, name)}#${rev}` : "";
  const [url, setUrl] = useState<string | undefined>(() => (key ? urlCache.get(key) : undefined));
  useEffect(() => {
    if (!key || !name) {
      setUrl(undefined);
      return;
    }
    const cached = urlCache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    getBlob(jobId, name).then((b) => {
      if (!b || !alive) return;
      const u = URL.createObjectURL(b);
      urlCache.set(key, u);
      setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [jobId, key, name]);
  return url;
}
