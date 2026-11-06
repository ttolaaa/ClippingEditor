"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/client";
import { useJob } from "@/lib/browser/store";

const MODES = [
  { href: "/", label: "Viral Clipper", anime: false },
  { href: "/anime", label: "Anime Clipper", anime: true },
];

/** Switches between the two clipper apps that live under this one site. */
export default function ModeSwitch() {
  const pathname = usePathname() ?? "/";
  const jobId = /^\/jobs\/([^/]+)/.exec(pathname)?.[1] ?? "";
  const { job } = useJob(decodeURIComponent(jobId));
  const animeActive = pathname.startsWith("/anime") || job?.settings.kind === "anime";
  return (
    <div className="flex rounded-full border border-black/10 bg-black/[0.03] p-0.5 text-sm font-medium" role="tablist" aria-label="Clipper mode">
      {MODES.map((m) => {
        const active = m.anime === animeActive;
        return (
          <Link
            key={m.href}
            href={m.href}
            role="tab"
            aria-selected={active}
            className={cx("rounded-full px-3.5 py-1 transition", active ? "bg-ink text-white" : "text-black/60 hover:text-black")}
          >
            {m.label}
          </Link>
        );
      })}
    </div>
  );
}
