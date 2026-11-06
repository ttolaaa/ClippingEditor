/// <reference lib="webworker" />

/** Aggregates transformers.js per-file download progress into one percentage. */
export function downloadTracker(onPercent: (pct: number) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  let last = 0;
  return (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    if (total < 1e6 || Date.now() - last < 400) return;
    last = Date.now();
    onPercent(Math.min(100, Math.round((loaded / total) * 100)));
  };
}

/** Retry flaky model downloads (CDN hiccups, captive Wi-Fi) a couple of times before giving up. */
export async function withRetry<T>(fn: () => Promise<T>, onRetry: (attempt: number) => void, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/network|fetch|load|timeout|aborted|503|502|504|429/i.test(msg) || i === attempts - 1) break;
      onRetry(i + 1);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}
