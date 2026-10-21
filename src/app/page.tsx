import UploadPanel from "@/components/UploadPanel";
import ProjectList from "@/components/ProjectList";

const FEATURES = [
  { title: "Viral moment AI", body: "Audio energy, speech, emotion and scene analysis find the funniest, most emotional and unexpected moments.", accent: "bg-accent" },
  { title: "Plot-twist detection", body: "Reveals, reversals and calm-then-spike reactions are flagged so every reel lands its payoff.", accent: "bg-danger" },
  { title: "9:16 speaker tracking", body: "A virtual camera follows faces and motion, holds steady on small moves and cuts with the edit.", accent: "bg-ink" },
  { title: "Synced captions", body: "Word-level captions with active-word highlight, editable text and five customizable styles.", accent: "bg-success" },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-7xl px-5 pb-24">
      <section className="grid gap-10 pt-14 pb-10 lg:grid-cols-[1fr_1.15fr] lg:items-start lg:pt-20">
        <div className="lg:sticky lg:top-24">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-black/10 px-3 py-1 text-xs font-medium text-black/60">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> TikTok · Reels · Shorts · Facebook
          </p>
          <h1 className="text-5xl font-black leading-[1.02] tracking-tight sm:text-6xl">
            One long video.
            <br />
            <span className="text-accent">Dozens</span> of viral reels.
          </h1>
          <p className="mt-5 max-w-md text-lg text-black/60">
            Upload a podcast, stream or vlog. AI finds the hooks, plot twists and high-retention moments, then delivers captioned 9:16 clips
            ranked by viral score.
          </p>
          <div className="mt-8 grid max-w-md grid-cols-3 gap-px overflow-hidden rounded-xl border border-black/10 bg-black/10 text-center">
            {[
              ["15 · 30 · 60s", "clip lengths"],
              ["1080×1920", "vertical export"],
              ["0–100", "viral score"],
            ].map(([v, l]) => (
              <div key={l} className="bg-white px-3 py-4">
                <p className="font-bold">{v}</p>
                <p className="text-xs text-black/50">{l}</p>
              </div>
            ))}
          </div>
        </div>
        <UploadPanel />
      </section>

      <section className="grid gap-px overflow-hidden rounded-2xl border border-black/10 bg-black/10 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-white p-6">
            <span className={`mb-4 block h-1 w-8 rounded-full ${f.accent}`} />
            <h3 className="font-semibold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-black/55">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-14">
        <h2 className="mb-4 text-xl font-bold tracking-tight">Your projects</h2>
        <ProjectList />
      </section>
    </div>
  );
}
