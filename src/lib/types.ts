export type StageId =
  | "probe"
  | "convert"
  | "audio"
  | "transcribe"
  | "visual"
  | "analyze"
  | "select"
  | "render";

export type StageStatus = "pending" | "active" | "done" | "skipped" | "error";

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  progress: number; // 0..1
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

export type JobStatus = "queued" | "processing" | "ready" | "error";

export interface SourceInfo {
  originalName: string;
  mimeType: string;
  converted: boolean; // true when transcoded in-browser (e.g. AVI -> MP4)
  /** "ffmpeg" when WebCodecs couldn't decode the audio and ffmpeg.wasm is used instead. */
  audioDecoder?: "webcodecs" | "ffmpeg";
  size: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  provider: "cloud" | "browser" | "none";
  language?: string;
  words: Word[];
  segments: TranscriptSegment[];
}

export type MomentType =
  | "funny"
  | "emotional"
  | "unexpected"
  | "plot_twist"
  | "insightful"
  | "high_energy";

export interface Moment {
  start: number;
  end: number;
  type: MomentType;
  score: number; // 0..1
  reason: string;
  source: "ai" | "transcript" | "audio" | "visual";
}

export interface PlotTwist {
  time: number;
  confidence: number; // 0..1
  reason: string;
  source: "ai" | "transcript" | "signal";
}

export type ReframeMode = "track" | "fit";

export interface CropKey {
  t: number; // seconds, relative to clip start
  x: number; // normalized crop-window center (0..1) in source width
}

export interface CropPath {
  keys: CropKey[];
  y: number; // normalized vertical center (used when source is taller than 9:16)
  confidence: number;
}

export interface CaptionStyle {
  preset: string;
  fontFamily: string;
  fontSize: number; // in 1080-wide output pixels
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  background: boolean;
  backgroundColor: string;
  positionY: number; // percent from top (0..100)
  uppercase: boolean;
  wordsPerLine: number;
  highlightActiveWord: boolean;
  popAnimation: boolean;
  enabled: boolean;
}

export interface CaptionLine {
  id: string;
  start: number; // relative to clip start
  end: number;
  text: string;
  words: Word[]; // relative to clip start
}

export interface ScoreBreakdown {
  hook: number;
  emotion: number;
  energy: number;
  pacing: number;
  retention: number;
  twist: number;
}

export type ClipStatus = "queued" | "rendering" | "ready" | "error";

/** Export state lives in memory only; the rendered MP4 is handed straight to the browser download. */
export interface ClipExport {
  status: "idle" | "rendering" | "ready" | "error";
  progress: number;
  error?: string;
}

export interface Clip {
  id: string;
  rank: number;
  start: number;
  end: number;
  duration: number;
  targetDuration: number;
  viralScore: number;
  scores: ScoreBreakdown;
  tags: string[];
  title: string;
  hook: string;
  reason: string;
  hashtags: string[];
  hasPlotTwist: boolean;
  twistAt?: number; // relative to clip start
  /** Human-readable list of the clipping rules this clip satisfied. */
  ruleMatches?: string[];
  status: ClipStatus;
  progress: number;
  error?: string;
  thumbnail?: string; // IndexedDB blob key
  reframeMode: ReframeMode;
  crop: CropPath;
  trackingConfidence: number;
  captions: CaptionLine[];
  style: CaptionStyle;
  export: ClipExport;
}

export type TranscriptionMode = "browser" | "cloud" | "none";

export type FocusType = "funny" | "emotional" | "plot_twist" | "high_energy" | "insightful" | "hook";

/** Creator-defined clipping rules applied before clips are picked. */
export interface ClipRules {
  /** Free-text instructions ("skip the intro, focus on funny moments about money"). */
  instructions: string;
  focus: FocusType[];
  includeKeywords: string[];
  /** "prefer" boosts clips mentioning the keywords, "require" only keeps clips that mention one. */
  keywordMode: "prefer" | "require";
  excludeKeywords: string[];
  requireTwist: boolean;
  /** Seconds — only use the source from this point. */
  startAt: number;
  /** Seconds — only use the source up to this point (null = until the end). */
  endAt: number | null;
  /** Seconds to ignore at the end (outro). */
  skipEnd: number;
  /** 0 = off. */
  minScore: number;
}

export interface JobSettings {
  transcription: TranscriptionMode;
  whisperModel: "tiny" | "base";
  rules?: ClipRules;
  durations: number[];
  maxClipsPerDuration: number;
  captionPreset: string;
  reframeMode: ReframeMode;
  language?: string;
}

export interface Job {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  status: JobStatus;
  progress: number;
  etaSeconds?: number;
  error?: string;
  warnings: string[];
  stages: Stage[];
  settings: JobSettings;
  source?: SourceInfo;
  analysis?: {
    transcriptProvider: Transcript["provider"];
    aiProvider: "cloud" | "browser";
    summary: string;
    wordCount: number;
    plotTwists: PlotTwist[];
    moments: Moment[];
  };
  clips: Clip[];
  /** Browser engine details shown in the UI (e.g. "WebGPU", "WASM"). */
  engine?: string;
}

export interface JobSummary {
  id: string;
  name: string;
  createdAt: number;
  status: JobStatus;
  progress: number;
  etaSeconds?: number;
  duration?: number;
  clipCount: number;
  topScore?: number;
  thumbnail?: string;
}
