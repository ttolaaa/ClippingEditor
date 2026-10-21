# Clipping: AI viral reels from long videos

Drop in a long video (MP4, MOV or AVI) and get ranked, captioned **9:16 reels** (15s, 30s and 60s) for TikTok, Instagram Reels, YouTube Shorts and Facebook Reels.

**Everything runs in your browser.** Decoding, transcription, moment and plot-twist detection, speaker tracking, previews and the final MP4 export all happen on your device, and the video is never uploaded. The Next.js server only serves the app, plus an *optional* proxy that keeps an OpenAI key secret if you choose to enable cloud AI.

Built with Next.js (App Router), TypeScript, Tailwind CSS, [Mediabunny](https://mediabunny.dev) (WebCodecs), [transformers.js](https://huggingface.co/docs/transformers.js) (Whisper) and ffmpeg.wasm.

## Quick start

```bash
npm install          # also copies ffmpeg.wasm into public/ffmpeg (postinstall)
npm run dev
```

Open http://localhost:3000 in a recent Chrome, Edge, Firefox or Safari, then drop in a video.

The first transcription downloads the Whisper model once (about 40 MB for "fast", about 80 MB for "accurate"). After that, the browser caches it.

## Where things run

| Step | Runs in | Tech |
| --- | --- | --- |
| Storage of projects and source videos | Browser (IndexedDB) | `src/lib/browser/db.ts`, `store.ts` |
| Probe, audio decode, visual tracking, thumbnails | Web Worker | Mediabunny / WebCodecs (`media.worker.ts`) |
| AVI and other unsupported formats | Browser | ffmpeg.wasm → H.264/AAC MP4 (`convert.ts`) |
| Audio WebCodecs can't decode (some builds) | Browser | ffmpeg.wasm fallback (`convert.ts`) |
| Speech-to-text with word timings | Web Worker | Whisper via transformers.js, multi-threaded WASM (`whisper.worker.ts`) |
| Viral moments, plot twists, scoring, crop paths | Browser | `src/lib/engine/*` |
| Live 9:16 preview with captions | Browser (canvas) | `ReelPlayer` + `engine/renderer.ts` |
| 1080×1920 MP4 export with burned-in captions | Web Worker | Mediabunny `Conversion` (H.264 + AAC) |
| *Optional:* GPT titles and moments, Whisper API | Server proxy | `/api/ai/*`, only if `OPENAI_API_KEY` is set |

The preview player and the exporter use the **same canvas renderer**, so what you see while editing is exactly what you download.

## Features

- **Upload settings:** clip lengths, number of clips per length, caption style, reframe mode, language, and transcription mode (in-browser accurate or fast, cloud, or off).
- **Processing dashboard:** 8 stages, overall progress and ETA, and per-stage detail (e.g. "Transcribed 56s of 92s"). If a reload interrupts processing, a Retry button re-runs it from the copy stored in the browser.
- **Clip grid:** ranked by a 0–100 viral score (hook, emotion, energy, pacing, retention, twist), with filters (15s / 30s / 60s / plot twists) and live hover previews.
- **AI analysis panel:** an engagement heatmap, clip ranges on the timeline, and a list of plot twists with confidence scores.
- **Clip editor:** edit caption text and timing; adjust 5 caption presets plus font, size, colours, outline, box, position, words per line, active-word highlight, pop and uppercase; edit the title, hook and hashtags; and switch between smart speaker tracking and fit with a blurred background. Every change is previewed instantly and saved locally.
- **One-click download:** 1080×1920 H.264/AAC MP4, rendered in the browser.

## Optional cloud AI (`.env.local`)

```bash
OPENAI_API_KEY=sk-...        # enables GPT moment analysis + titles/hashtags, and the "Cloud Whisper API" option
OPENAI_MODEL=gpt-4o-mini
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_BASE_URL=             # optional OpenAI-compatible endpoint
```

With a key set, only transcript **text** is sent for GPT analysis. Audio is sent to the server only if you pick "Cloud Whisper API".

## Notes

- The app sends `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy: credentialless` headers (see `next.config.ts`). These enable multi-threaded WASM for Whisper.
- Processing happens in the open tab, so keep it open until it finishes. Projects live in that browser's storage. The home page shows how much space they use.
