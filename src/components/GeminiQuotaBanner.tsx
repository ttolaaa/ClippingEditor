"use client";

import { useCallback, useEffect, useState } from "react";
import { aiHeaders } from "@/lib/browser/pipeline";

interface QuotaInfo {
  model: string;
  provider?: "gemini" | "groq";
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  resetsAt: number;
}

const FLAG = "clipping.geminiWasExhausted";

function fmtWhen(ms: number) {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function fmtIn(ms: number) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`;
}

/**
 * Gemini daily-limit notice: how many requests are left today, a clear "used up — available again at …" message with a
 * countdown, and a notification (in the app, and on the desktop if allowed) when Gemini is available again.
 */
export default function GeminiQuotaBanner() {
  const [quota, setQuota] = useState<QuotaInfo[] | null>(null);
  const [back, setBack] = useState(false);
  const [, tick] = useState(0);
  const [canNotify, setCanNotify] = useState<NotificationPermission | "unsupported">("unsupported");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/config", { headers: aiHeaders(), cache: "no-store" });
      const c = (await r.json()) as { geminiQuota?: QuotaInfo[] | null };
      const q = c.geminiQuota ?? null;
      setQuota(q);
      if (!q?.length) return;
      // "Back again" is about Gemini (the most accurate provider).
      const gem = q.filter((x) => x.provider !== "groq");
      const allOut = gem.length > 0 && gem.every((x) => x.exhausted);
      let was = false;
      try {
        was = localStorage.getItem(FLAG) === "1";
        if (allOut) localStorage.setItem(FLAG, "1");
      } catch {
        // storage blocked
      }
      if (!allOut && was) {
        setBack(true);
        try {
          localStorage.removeItem(FLAG);
        } catch {
          // storage blocked
        }
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Gemini is available again", { body: "The daily limit has reset. You can make subtitles with Cloud AI again." });
        }
      }
    } catch {
      // server unreachable: keep the last state
    }
  }, []);

  useEffect(() => {
    setCanNotify(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    refresh();
    const poll = setInterval(refresh, 60_000);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  // Check right when the quota is due back, not up to a minute later.
  useEffect(() => {
    const next = quota?.filter((q) => q.exhausted).map((q) => q.resetsAt);
    if (!next?.length) return;
    const wait = Math.min(...next) - Date.now() + 5_000;
    if (wait <= 0 || wait > 24 * 3600_000) return;
    const t = setTimeout(refresh, wait);
    return () => clearTimeout(t);
  }, [quota, refresh]);

  if (!quota?.length) return null;
  const gem = quota.filter((q) => q.provider !== "groq");
  const groq = quota.filter((q) => q.provider === "groq");
  const gemUsable = gem.filter((q) => !q.exhausted);
  const geminiOut = gem.length > 0 && !gemUsable.length;
  const groqOk = groq.length > 0 && groq.every((q) => !q.exhausted);
  const groqLeft = groqOk ? Math.min(...groq.map((q) => q.remaining)) : 0;
  const allOut = (gem.length === 0 || geminiOut) && !groqOk;
  const main = gem[0] ?? groq[0];
  const left = gemUsable.reduce((a, q) => a + q.remaining, 0);
  const nextBack = Math.min(...(gem.length ? gem : groq).map((q) => q.resetsAt));

  if (back && !allOut) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-2.5 text-sm">
        <span>✅</span>
        <span className="flex-1">
          <b>Gemini is available again.</b> The daily limit has reset — Cloud AI subtitles work again. Use <b>Redo subtitles</b> on a project to
          improve it.
        </span>
        <button type="button" onClick={() => setBack(false)} className="text-xs text-black/50 hover:text-black">
          Dismiss
        </button>
      </div>
    );
  }

  if (allOut) {
    const groqBack = groq.length ? Math.min(...groq.map((q) => q.resetsAt)) : Infinity;
    const backAt = Math.min(nextBack, groqBack);
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-400 bg-amber-50 px-4 py-2.5 text-sm text-amber-950">
        <span>⏳</span>
        <span className="flex-1">
          <b>{groq.length ? "The cloud AI daily limits are used up" : "Gemini's daily limit is used up"}.</b> Cloud AI is available again{" "}
          <b>{fmtWhen(backAt)}</b> (in {fmtIn(backAt)}). Until then, new subtitles use the on-device model — or wait and make them with Cloud AI
          then.
        </span>
        {canNotify === "default" && (
          <button
            type="button"
            onClick={async () => setCanNotify(await Notification.requestPermission())}
            className="rounded-full border border-amber-500 px-3 py-1 text-xs font-medium hover:bg-amber-100"
          >
            🔔 Notify me when it&apos;s back
          </button>
        )}
        {canNotify === "granted" && <span className="text-xs text-amber-800">🔔 You&apos;ll get a notification</span>}
      </div>
    );
  }

  if (geminiOut && groqOk) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-300 bg-sky-50 px-4 py-2 text-xs text-sky-950">
        <span>☁️</span>
        <span className="flex-1">
          <b>Gemini&apos;s daily limit is used up</b> (back {fmtWhen(nextBack)}, in {fmtIn(nextBack)}). <b>Groq</b> is making the subtitles until then
          (about {groqLeft} requests left today) — slightly less accurate than Gemini.
        </span>
        {canNotify === "default" && (
          <button
            type="button"
            onClick={async () => setCanNotify(await Notification.requestPermission())}
            className="rounded-full border border-sky-400 px-3 py-1 font-medium hover:bg-sky-100"
          >
            🔔 Notify me when Gemini is back
          </button>
        )}
      </div>
    );
  }

  const low = left <= 5;
  return (
    <div
      className={
        low
          ? "mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900"
          : "mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-black/[0.02] px-4 py-2 text-xs text-black/55"
      }
      title="Counted by this app; providers don't report the remaining quota. Free tiers: Gemini about 20 requests a day per model, Groq about 2,000 (speech) and 1,000 (text)."
    >
      {gem.length ? (
        <>
          <span>☁️ Gemini today: about <b>{left}</b> request{left === 1 ? "" : "s"} left</span>
          {main.exhausted && <span>· main model used up, using the backup model</span>}
          <span>· resets {fmtWhen(gemUsable[0]?.resetsAt ?? main.resetsAt)}</span>
          {groqOk && <span>· then Groq (about {groqLeft} left)</span>}
          {low && !groqOk && <span>· running low — a full film needs about 15–20</span>}
        </>
      ) : (
        <span>☁️ Groq today: about <b>{groqLeft}</b> requests left</span>
      )}
    </div>
  );
}
