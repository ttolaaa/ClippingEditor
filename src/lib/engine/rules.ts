import type { ClipRules, FocusType } from "../types";

export const FOCUS_OPTIONS: { id: FocusType; label: string }[] = [
  { id: "funny", label: "Funny" },
  { id: "emotional", label: "Emotional" },
  { id: "plot_twist", label: "Plot twists" },
  { id: "high_energy", label: "High energy" },
  { id: "insightful", label: "Tips & insights" },
  { id: "hook", label: "Strong hooks" },
];

export const FOCUS_LABEL: Record<FocusType, string> = Object.fromEntries(FOCUS_OPTIONS.map((f) => [f.id, f.label])) as Record<FocusType, string>;

export function defaultRules(): ClipRules {
  return {
    instructions: "",
    focus: [],
    includeKeywords: [],
    keywordMode: "prefer",
    excludeKeywords: [],
    requireTwist: false,
    startAt: 0,
    endAt: null,
    skipEnd: 0,
    minScore: 0,
  };
}

export const RULE_TEMPLATES: { label: string; description: string; rules: Partial<ClipRules> }[] = [
  { label: "Plot twists only", description: "Only clips that land a reveal", rules: { focus: ["plot_twist"], requireTwist: true } },
  { label: "Funny moments", description: "Laughs and jokes first", rules: { focus: ["funny", "high_energy"] } },
  { label: "Emotional story", description: "Heartfelt, story-driven clips", rules: { focus: ["emotional", "plot_twist"] } },
  { label: "Tips & insights", description: "Advice, lessons, how-tos", rules: { focus: ["insightful", "hook"] } },
  { label: "Skip intro & outro", description: "Ignore first 30s and last 30s", rules: { startAt: 30, skipEnd: 30 } },
  { label: "Only top clips", description: "Viral score 70+", rules: { minScore: 70 } },
];

// ---------------------------------------------------------------- natural-language parsing

const FOCUS_WORDS: [RegExp, FocusType][] = [
  [/\b(funny|funniest|humou?r|laugh\w*|jokes?|hilarious|comedy|comedic)\b/, "funny"],
  [/\b(emotional|emotion|sad|heartfelt|touching|heartwarming|cry|cried|crying|tears?|feelings?)\b/, "emotional"],
  [/\b(plot twists?|twists?|reveals?|revelations?|surpris\w*|shocking|unexpected)\b/, "plot_twist"],
  [/\b(high[- ]energy|energetic|hype|exciting|intense|loud|action)\b/, "high_energy"],
  [/\b(tips?|insights?|insightful|advice|lessons?|educational|how[- ]tos?|tutorial|learn\w*)\b/, "insightful"],
  [/\b(hooks?|attention[- ]grabbing|catchy|questions?)\b/, "hook"],
];

const UNIT = String.raw`(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b`;

function toSeconds(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return n * 3600;
  if (u.startsWith("m")) return n * 60;
  return n;
}

/** Parse "mm:ss", "h:mm:ss" or plain seconds. */
export function parseClock(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(t);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

export function formatClock(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function splitList(text: string): string[] {
  return text
    .split(/,|;|\/|\band\b|\bor\b|&/i)
    .map((s) =>
      s
        .replace(/["'“”‘’]/g, "")
        .replace(/^\s*(no|not|avoid|without|never|exclude)\s+/i, "")
        .replace(/\b(any|the|a|an|some|of|my|our|your|his|her|their|stuff|things?|topics?|parts?|bits?|moments?|clips?|words?|language|content|mentions?|please)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((s) => s.length >= 2 && s.length <= 40);
}

/**
 * Turn free-text clipping instructions into structured rules (on-device, no AI service needed).
 * Unrecognised text is still kept as `instructions` and sent to GPT when cloud AI is enabled.
 */
export function parseInstructions(raw: string): Partial<ClipRules> {
  const out: Partial<ClipRules> = {};
  const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return out;
  const sentences = text.split(/[.!\n]+/).map((s) => s.trim()).filter(Boolean);

  // Time windows
  const negating = (s: string) => /\b(skip|skipping|ignore|cut|without|no|exclude|drop|remove)\b/.test(s);
  const first = new RegExp(String.raw`\b(?:skip|ignore|cut|exclude|drop|without)\s+(?:the\s+)?(?:first|opening|intro(?:duction)?(?:\s+of)?)\s*(\d+(?:\.\d+)?)\s*${UNIT}`).exec(text);
  if (first) out.startAt = toSeconds(Number(first[1]), first[2]);
  else if (sentences.some((s) => negating(s) && /\b(intro|introduction|opening)\b/.test(s))) out.startAt = 30;
  const last = new RegExp(String.raw`\b(?:skip|ignore|cut|exclude|drop|without)\s+(?:the\s+)?(?:last|final|closing)\s*(\d+(?:\.\d+)?)\s*${UNIT}`).exec(text);
  if (last) out.skipEnd = toSeconds(Number(last[1]), last[2]);
  else if (sentences.some((s) => negating(s) && /\b(outro|ending|credits|end screen)\b/.test(s))) out.skipEnd = 30;
  const range = /\b(?:only\s+)?(?:from|between)\s+(\d{1,2}(?::\d{1,2}){1,2}|\d+)\s*(?:-|–|to|and|until)\s*(\d{1,2}(?::\d{1,2}){1,2}|\d+)/.exec(text);
  if (range) {
    const a = parseClock(range[1]);
    const b = parseClock(range[2]);
    if (a !== null && b !== null && b > a) {
      out.startAt = a;
      out.endAt = b;
    }
  }
  const after = /\b(?:after|starting at|start at|from)\s+(\d{1,2}(?::\d{1,2}){1,2})\b/.exec(text);
  if (after && out.endAt === undefined) out.startAt = parseClock(after[1]) ?? out.startAt;
  const before = /\b(?:before|until|up to|stop at)\s+(\d{1,2}(?::\d{1,2}){1,2})\b/.exec(text);
  if (before && out.endAt === undefined) out.endAt = parseClock(before[1]);

  // Exclusions: "avoid swearing", "no politics", "don't include ads"
  const exclude: string[] = [];
  for (const s of sentences) {
    const m = /\b(?:avoid|exclude|excluding|without|skip(?:ping)?|never|no|don'?t (?:use|include|show|want)|do not (?:use|include|show|want)|not about)\s+(?:any\s+|the\s+)?(.+)$/.exec(s);
    if (!m) continue;
    const target = m[1];
    if (/^(the\s+)?(first|last|intro|outro|ending|opening|final|closing)\b/.test(target)) continue;
    exclude.push(...splitList(target.split(/\b(?:focus|only|but|and focus|prefer)\b/)[0]));
  }

  // Inclusions: "about money", "mentioning crypto", "featuring the cat"
  const include: string[] = [];
  let requireKw = false;
  for (const s of sentences) {
    const m = /\b(?:about|mention(?:s|ing)?|talking about|featuring|regarding|related to|on the topic of|that (?:mention|include)s?|with the (?:word|words|keyword|keywords))\s+(.+)$/.exec(s);
    if (!m) continue;
    if (/\b(must|only|required?|always)\b/.test(s)) requireKw = true;
    const target = m[1].split(/\b(?:but|avoid|without|except|no)\b/)[0];
    include.push(...splitList(target).filter((k) => !FOCUS_WORDS.some(([re]) => re.test(k))));
  }

  // Focus moments (ignore anything after a negation: "emotional story, without sad music")
  const focus = new Set<FocusType>();
  for (const s of sentences) {
    const positive = s.split(/\b(?:avoid|no|not|without|don'?t|never|exclude|except)\b/)[0];
    for (const [re, f] of FOCUS_WORDS) if (re.test(positive)) focus.add(f);
  }

  if (/\b(only|must have|must include|require[ds]?|always)\b[^.]*\b(plot twists?|twists?|reveals?)\b/.test(text)) out.requireTwist = true;
  const score = /\b(?:score|viral score)\s*(?:of\s*)?(?:above|over|at least|>=?|minimum(?: of)?)\s*(\d{1,2})\b|\bminimum (?:viral )?score\s*(?:of\s*)?(\d{1,2})\b/.exec(text);
  if (score) out.minScore = Math.min(95, Number(score[1] ?? score[2]));

  const clean = (list: string[]) => [...new Set(list.map((k) => k.trim()).filter(Boolean))];
  if (exclude.length) out.excludeKeywords = clean(exclude);
  if (include.length) {
    out.includeKeywords = clean(include).filter((k) => !(out.excludeKeywords ?? []).includes(k));
    if (requireKw) out.keywordMode = "require";
  }
  if (focus.size) out.focus = [...focus];
  return out;
}

/** Structured fields + whatever was understood from the free text. */
export function effectiveRules(rules: ClipRules): ClipRules {
  const p = parseInstructions(rules.instructions);
  const uniq = (a: string[]) => [...new Set(a.map((s) => s.toLowerCase().trim()).filter(Boolean))];
  return {
    ...rules,
    focus: [...new Set([...rules.focus, ...(p.focus ?? [])])],
    includeKeywords: uniq([...rules.includeKeywords, ...(p.includeKeywords ?? [])]),
    keywordMode: rules.keywordMode === "require" || p.keywordMode === "require" ? "require" : "prefer",
    excludeKeywords: uniq([...rules.excludeKeywords, ...(p.excludeKeywords ?? [])]),
    requireTwist: rules.requireTwist || !!p.requireTwist,
    startAt: Math.max(rules.startAt || 0, p.startAt ?? 0),
    endAt: [rules.endAt, p.endAt ?? null].filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b)[0] ?? null,
    skipEnd: Math.max(rules.skipEnd || 0, p.skipEnd ?? 0),
    minScore: Math.max(rules.minScore || 0, p.minScore ?? 0),
  };
}

export function hasRules(r: ClipRules | undefined): boolean {
  if (!r) return false;
  const e = effectiveRules(r);
  return !!(
    e.instructions.trim() ||
    e.focus.length ||
    e.includeKeywords.length ||
    e.excludeKeywords.length ||
    e.requireTwist ||
    e.startAt > 0 ||
    e.endAt !== null ||
    e.skipEnd > 0 ||
    e.minScore > 0
  );
}

/** Short chips describing the rules, e.g. ["Focus: Funny", "Must mention: money", "From 2:00"]. */
export function describeRules(r: Partial<ClipRules>): string[] {
  const out: string[] = [];
  if (r.focus?.length) out.push(`Focus: ${r.focus.map((f) => FOCUS_LABEL[f]).join(", ")}`);
  if (r.includeKeywords?.length) out.push(`${r.keywordMode === "require" ? "Must mention" : "Prefer"}: ${r.includeKeywords.join(", ")}`);
  if (r.excludeKeywords?.length) out.push(`Avoid: ${r.excludeKeywords.join(", ")}`);
  if (r.requireTwist) out.push("Plot twist required");
  if (r.startAt) out.push(`From ${formatClock(r.startAt)}`);
  if (r.endAt) out.push(`Until ${formatClock(r.endAt)}`);
  if (r.skipEnd) out.push(`Skip last ${formatClock(r.skipEnd)}`);
  if (r.minScore) out.push(`Viral score ≥ ${r.minScore}`);
  return out;
}

export function keywordRegex(keyword: string): RegExp {
  const esc = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Match whole words, allowing simple plurals/suffixes ("dog" matches "dogs").
  return new RegExp(`\\b${esc}(s|es|ed|ing)?\\b`, "i");
}
