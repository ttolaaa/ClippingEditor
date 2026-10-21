import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipping — AI viral reels from long videos",
  description: "Upload a long video and get viral-ready 9:16 reels with captions, plot-twist detection and viral scores.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-ink">
        <header className="sticky top-0 z-30 border-b border-black/10 bg-white/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-black text-white">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="7" y="2" width="10" height="20" rx="2" />
                  <path d="M11 9l3 3-3 3" stroke="#ff6a00" />
                </svg>
              </span>
              Clipping<span className="text-accent">.</span>
            </Link>
            <nav className="flex items-center gap-5 text-sm text-black/60">
              <Link href="/" className="hover:text-black">
                Projects
              </Link>
              <Link href="/#upload" className="rounded-full bg-black px-4 py-1.5 font-medium text-white hover:bg-accent">
                New project
              </Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
