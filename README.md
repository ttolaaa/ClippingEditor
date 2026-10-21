# Clipping: AI viral reels from long videos

> **Turn one long video into a stack of ready-to-post TikTok, Instagram Reels, YouTube Shorts and Facebook Reels clips. Everything runs in your browser.**

![Clipping: ranked, captioned 9:16 reels generated from one long video](docs/screenshots/03-clips.png)

## In short

Drop in a podcast, stream, vlog or interview (MP4, MOV or AVI). Clipping then does the following:

- 🎯 **Finds the best moments:** funny, emotional, unexpected and high-energy parts of the video.
- 🔀 **Detects plot twists:** reveals and "wait, what?!" moments, so every clip lands its payoff.
- 🏆 **Ranks clips by viral score (0–100):** the score combines the hook, emotion, energy, pacing, retention and twist.
- ✂️ **Cuts 15s, 30s and 60s reels:** clips start and end on full sentences, not mid-word.
- 💬 **Adds synced, word-by-word captions:** five styles, fully editable.
- 📱 **Reframes to 9:16 vertical:** smart speaker tracking keeps the person in frame.
- ⬇️ **Exports with one click:** a 1080×1920 MP4 with captions burned in.

🔒 **Private by design.** The video is never uploaded. Transcription, analysis, previews and export all run on your own device (WebCodecs, in-browser Whisper and WebAssembly).

---

## How to use

### 1. Drop in your video and pick your settings

Open the app, then drag a video onto the upload box (or click it to browse).

![Upload a video and choose settings](docs/screenshots/01-upload.png)

| Setting | What it does |
| --- | --- |
| **Clip lengths** | Which reel lengths to make: 15s, 30s and/or 60s. |
| **Clips per length** | How many reels to make for each length (1–8). |
| **Caption style** | Starting look for the captions: Bold Pop, Minimal, Boxed, Impact Green or Red Alert. You can change it per clip later. |
| **9:16 reframing** | **Smart speaker tracking** follows the speaker or main subject. **Fit + blur background** keeps the whole frame, which is best for wide shots. |
| **Spoken language** | Helps the speech recognition. |
| **Captions / transcription** | **Accurate** (better captions) or **Fast** (quicker), both in the browser. You can also turn transcription **Off** for videos without speech. |

Click **Generate viral clips**.

### 2. Watch it work

The video is analysed right in your browser. You can see each step, the overall progress, the estimated time remaining, and how many clips are ready.

![Live processing progress with stages and ETA](docs/screenshots/02-processing.png)

> ⏱️ A 90-second video takes about 1–2 minutes. The first run also downloads the speech model once (about 40–80 MB), and after that it's cached. **Keep the tab open while it processes.**

### 3. Browse your reels

When processing finishes, your reels appear ranked by **viral score**:

- **Hover** a card for a live 9:16 preview with captions.
- **Filter** by 15s, 30s or 60s, or by **Plot twists**.
- **Sort** by viral score or by position in the original video.

Scroll down to the **AI analysis** panel. It shows an engagement heatmap of the whole video, where each clip sits on the timeline, and every detected plot twist with a confidence score. Click a twist to jump to it.

![AI analysis: heatmap, clip timeline and detected plot twists](docs/screenshots/04-analysis.png)

### 4. Polish a clip

Click **Edit captions** on any reel to open the editor. Every change shows instantly in the preview and is saved automatically in your browser.

**Captions tab:** fix words, adjust timings, and add or delete caption lines. The current line is highlighted as the video plays.

![Caption editor](docs/screenshots/05-editor.png)

**Style tab:** pick a preset, or customise the font, size, words per line, position, colours and outline. You can also toggle the active-word highlight, the pop animation, uppercase and a background box.

![Caption style editor](docs/screenshots/06-editor-style.png)

**Details tab:** see *why* the clip can go viral (the score breakdown). You can edit the title, hook and hashtags and copy them in one click, or switch between smart tracking and fit-with-blurred-background.

![Clip details: score breakdown, post copy and reframing](docs/screenshots/07-editor-details.png)

### 5. Download and post

Click **Download 1080×1920 MP4**, either in the editor or on a clip card. The reel is rendered in your browser and saved to your Downloads folder, ready to upload to TikTok, Reels, Shorts or Facebook.

### Tips

- Videos where **people talk** (podcasts, interviews, storytimes, vlogs) give the best results, because the AI reads the speech for hooks and twists.
- For wide or group shots where tracking can't lock on, switch the clip to **Fit + blurred background**.
- Your projects stay in *this* browser on *this* device. The home page shows how much storage they use. Delete old projects to free up space.

---

## Build & run

### Requirements

- **Node.js 20.9+** (tested on Node 24)
- A recent **Chrome, Edge, Firefox or Safari** (it needs WebCodecs)

### Development

```bash
git clone https://github.com/ttolaaa/ClippingEditor.git
cd ClippingEditor
npm install        # also copies ffmpeg.wasm into public/ffmpeg (postinstall)
npm run dev        # http://localhost:3000
```

### Production

```bash
npm run build
npm start          # serves the optimized app on http://localhost:3000
```

Type-check with `npm run lint`.

> Deploying: any Node host that runs `next start` works. Keep the `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers from `next.config.ts`, because they enable multi-threaded WebAssembly for faster transcription.

### Optional: cloud AI (`.env.local`)

No keys are needed. To add GPT-written titles and hashtags, extra moment analysis, and a "Cloud Whisper API" transcription option, copy `.env.example` to `.env.local` and set:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_BASE_URL=             # optional OpenAI-compatible endpoint
```

The key stays on the server, and the browser goes through the `/api/ai/*` proxy. GPT receives only the transcript **text**. Audio is sent to the server only if you pick "Cloud Whisper API".

---

## How it works

| Step | Runs in | Tech |
| --- | --- | --- |
| Project and video storage | Browser (IndexedDB) | `src/lib/browser/db.ts`, `store.ts` |
| Probe, audio decode, visual tracking, thumbnails | Web Worker | [Mediabunny](https://mediabunny.dev) / WebCodecs (`media.worker.ts`) |
| AVI and other unsupported formats | Browser | ffmpeg.wasm → H.264/AAC MP4 (`convert.ts`) |
| Audio WebCodecs can't decode (some browsers) | Browser | ffmpeg.wasm fallback (`convert.ts`) |
| Speech-to-text with word timings | Web Worker | Whisper via [transformers.js](https://huggingface.co/docs/transformers.js), multi-threaded WASM (`whisper.worker.ts`) |
| Viral moments, plot twists, scoring, crop paths | Browser | `src/lib/engine/*` |
| Live 9:16 preview with captions | Browser (canvas) | `ReelPlayer` + `engine/renderer.ts` |
| 1080×1920 MP4 export with burned-in captions | Web Worker | Mediabunny `Conversion` (H.264 + AAC) |
| *Optional:* GPT titles and moments, Whisper API | Server proxy | `/api/ai/*`, only if `OPENAI_API_KEY` is set |

The preview player and the exporter share **one canvas renderer**, so what you see in the editor is exactly what you download.

```
src/
├─ app/                 Next.js pages + optional AI proxy routes (/api/ai/*, /api/config)
├─ components/          UI: upload, processing dashboard, clip grid, editor, ReelPlayer
└─ lib/
   ├─ browser/          IndexedDB store, pipeline orchestration, Web Workers, ffmpeg.wasm fallback
   ├─ engine/           Pure analysis: signals, moments & plot twists, scoring, reframing, renderer
   └─ server/           OpenAI helpers for the optional proxy
```

Built with Next.js, TypeScript, Tailwind CSS, Mediabunny, transformers.js and ffmpeg.wasm.
