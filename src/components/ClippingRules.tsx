"use client";

import { useEffect, useMemo, useState } from "react";
import type { ClipRules, FocusType } from "@/lib/types";
import { FOCUS_OPTIONS, RULE_TEMPLATES, defaultRules, describeRules, effectiveRules, formatClock, hasRules, parseClock, parseInstructions } from "@/lib/engine/rules";
import { cx } from "@/lib/client";

const EXAMPLES = [
  "Skip the first 2 minutes, focus on funny moments about money. Avoid swearing.",
  "Only plot twists. Skip the intro and outro.",
  "Clips must mention crypto or bitcoin. No sponsor reads.",
  "Only from 10:00 to 25:00, give me tips and advice.",
];

/** "Clipping rules" section of the upload panel: tell the AI how to clip before generating. */
export default function ClippingRules({ value, onChange }: { value: ClipRules; onChange: (r: ClipRules) => void }) {
  const [open, setOpen] = useState(true);
  const [includeText, setIncludeText] = useState(value.includeKeywords.join(", "));
  const [excludeText, setExcludeText] = useState(value.excludeKeywords.join(", "));
  const [times, setTimes] = useState({ start: formatClock(value.startAt || null), end: formatClock(value.endAt), skip: formatClock(value.skipEnd || null) });

  // Keep local text fields in sync when a template/reset replaces the rules.
  useEffect(() => {
    setIncludeText(value.includeKeywords.join(", "));
    setExcludeText(value.excludeKeywords.join(", "));
    setTimes({ start: formatClock(value.startAt || null), end: formatClock(value.endAt), skip: formatClock(value.skipEnd || null) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.includeKeywords.join("|"), value.excludeKeywords.join("|"), value.startAt, value.endAt, value.skipEnd]);

  const set = (patch: Partial<ClipRules>) => onChange({ ...value, ...patch });
  const understood = useMemo(() => {
    const p = parseInstructions(value.instructions);
    return describeRules({ ...p, keywordMode: p.keywordMode ?? "prefer" });
  }, [value.instructions]);
  const summary = useMemo(() => describeRules(effectiveRules(value)), [value]);
  const active = hasRules(value);

  const toggleFocus = (f: FocusType) => set({ focus: value.focus.includes(f) ? value.focus.filter((x) => x !== f) : [...value.focus, f] });
  const keywords = (t: string) => [...new Set(t.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const commitTime = (field: "start" | "end" | "skip") => {
    const v = parseClock(times[field]);
    if (field === "start") set({ startAt: v ?? 0 });
    else if (field === "end") set({ endAt: v && v > 0 ? v : null });
    else set({ skipEnd: v ?? 0 });
  };

  return (
    <div className="border-t border-black/10">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-6 py-4 text-left hover:bg-black/[0.02]">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-white">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
            <circle cx="15" cy="6" r="2" />
            <circle cx="9" cy="12" r="2" />
            <circle cx="17" cy="18" r="2" />
          </svg>
        </span>
        <span className="flex-1">
          <span className="block font-semibold">
            Clipping rules <span className="font-normal text-black/40">· optional</span>
          </span>
          <span className="block text-xs text-black/50">Tell the AI what to look for, what to avoid and which part of the video to use.</span>
        </span>
        {active && <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent-dark">{summary.length || 1} active</span>}
        <svg viewBox="0 0 24 24" className={cx("h-4 w-4 text-black/40 transition", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="space-y-5 px-6 pb-6">
          {/* Templates */}
          <div>
            <Label>Quick templates</Label>
            <div className="flex flex-wrap gap-2">
              {RULE_TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  title={t.description}
                  onClick={() => onChange({ ...value, ...t.rules, focus: [...new Set([...value.focus, ...(t.rules.focus ?? [])])] })}
                  className="rounded-full border border-dashed border-black/25 px-3 py-1.5 text-sm text-black/70 transition hover:border-accent hover:text-accent-dark"
                >
                  + {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Free text */}
          <div>
            <Label>Describe how to clip (in your own words)</Label>
            <textarea
              value={value.instructions}
              onChange={(e) => set({ instructions: e.target.value.slice(0, 1000) })}
              rows={3}
              placeholder={`e.g. “${EXAMPLES[0]}”`}
              className="w-full resize-y rounded-xl border border-black/15 px-3 py-2.5 text-sm outline-none placeholder:text-black/35 focus:border-black"
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              {value.instructions.trim() ? (
                understood.length ? (
                  <>
                    <span className="font-medium text-success">✓ Understood:</span>
                    {understood.map((u) => (
                      <span key={u} className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-success">
                        {u}
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="text-black/45">No specific rule detected yet — try words like “funny”, “about …”, “avoid …”, “skip the first 2 minutes”.</span>
                )
              ) : (
                <>
                  <span className="text-black/40">Try:</span>
                  {EXAMPLES.slice(1).map((ex) => (
                    <button key={ex} type="button" onClick={() => set({ instructions: ex })} className="rounded-full bg-black/5 px-2 py-0.5 text-black/60 hover:bg-black/10">
                      {ex}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {/* Focus */}
            <div className="md:col-span-2">
              <Label>Focus on moments that are…</Label>
              <div className="flex flex-wrap gap-2">
                {FOCUS_OPTIONS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => toggleFocus(f.id)}
                    className={cx(
                      "rounded-full border px-3 py-1.5 text-sm font-medium transition",
                      value.focus.includes(f.id) ? "border-accent bg-accent text-white" : "border-black/15 text-black/70 hover:border-black/40",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Keywords */}
            <div>
              <Label>Must talk about (keywords)</Label>
              <input
                value={includeText}
                onChange={(e) => setIncludeText(e.target.value)}
                onBlur={() => set({ includeKeywords: keywords(includeText) })}
                placeholder="money, crypto, my dog"
                className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm outline-none placeholder:text-black/35 focus:border-black"
              />
              <div className="mt-2 flex gap-1 text-xs">
                {(["prefer", "require"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => set({ keywordMode: m, includeKeywords: keywords(includeText) })}
                    className={cx("rounded-full px-2.5 py-1 font-medium", value.keywordMode === m ? "bg-ink text-white" : "bg-black/5 text-black/60 hover:bg-black/10")}
                  >
                    {m === "prefer" ? "Prefer these" : "Only clips with these"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label>Avoid (keywords)</Label>
              <input
                value={excludeText}
                onChange={(e) => setExcludeText(e.target.value)}
                onBlur={() => set({ excludeKeywords: keywords(excludeText) })}
                placeholder="sponsor, politics, swear words"
                className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm outline-none placeholder:text-black/35 focus:border-danger"
              />
              <p className="mt-2 text-xs text-black/45">Clips that mention any of these are skipped.</p>
            </div>

            {/* Time range */}
            <div>
              <Label>Use only this part of the video</Label>
              <div className="flex items-center gap-2 text-sm">
                <TimeField label="From" value={times.start} placeholder="0:00" onChange={(v) => setTimes((t) => ({ ...t, start: v }))} onCommit={() => commitTime("start")} />
                <TimeField label="To" value={times.end} placeholder="end" onChange={(v) => setTimes((t) => ({ ...t, end: v }))} onCommit={() => commitTime("end")} />
                <TimeField label="Skip last" value={times.skip} placeholder="0:00" onChange={(v) => setTimes((t) => ({ ...t, skip: v }))} onCommit={() => commitTime("skip")} />
              </div>
              <p className="mt-2 text-xs text-black/45">Use mm:ss — great for skipping intros, sponsor reads and outros.</p>
            </div>

            {/* Quality */}
            <div>
              <Label>Quality bar</Label>
              <button
                type="button"
                onClick={() => set({ requireTwist: !value.requireTwist })}
                className="mb-3 flex w-full items-center justify-between rounded-lg border border-black/10 px-3 py-2 text-sm hover:border-black/30"
              >
                Only clips with a plot twist
                <span className={cx("relative h-5 w-9 rounded-full transition", value.requireTwist ? "bg-danger" : "bg-black/15")}>
                  <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", value.requireTwist ? "left-[1.1rem]" : "left-0.5")} />
                </span>
              </button>
              <label className="block text-xs text-black/55">
                <span className="flex justify-between">
                  Minimum viral score
                  <span className="font-semibold text-ink">{value.minScore ? value.minScore : "Off"}</span>
                </span>
                <input type="range" min={0} max={90} step={5} value={value.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} className="mt-2 w-full" />
              </label>
            </div>
          </div>

          {/* Summary */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-black/[0.03] px-4 py-3 text-xs">
            <span className="font-semibold text-black/60">Rules applied:</span>
            {summary.length ? (
              summary.map((s) => (
                <span key={s} className="rounded-full bg-white px-2.5 py-1 font-medium text-ink ring-1 ring-black/10">
                  {s}
                </span>
              ))
            ) : (
              <span className="text-black/45">{value.instructions.trim() ? "Your instructions (used by cloud AI if enabled)" : "None — the AI picks the most viral moments."}</span>
            )}
            {active && (
              <button type="button" onClick={() => onChange(defaultRules())} className="ml-auto font-medium text-black/50 hover:text-danger">
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/45">{children}</p>;
}

function TimeField({ label, value, placeholder, onChange, onCommit }: { label: string; value: string; placeholder: string; onChange: (v: string) => void; onCommit: () => void }) {
  return (
    <label className="flex-1 text-[11px] text-black/45">
      {label}
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="mt-1 w-full rounded-lg border border-black/15 px-2 py-1.5 font-mono text-sm text-ink outline-none placeholder:text-black/30 focus:border-black"
      />
    </label>
  );
}
