"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/client";

const MODES = [
  { href: "/", label: "Viral Clipper", match: (p: string) => !p.startsWith("/anime") },
  { href: "/anime", label: "Anime Clipper", match: (p: string) => p.startsWith("/anime") },
];

/** Switches between the two clipper apps that live under this one site. */
export default function ModeSwitch() {
  const pathname = usePathname() ?? "/";
  return (
    <div className="flex rounded-full border border-black/10 bg-black/[0.03] p-0.5 text-sm font-medium" role="tablist" aria-label="Clipper mode">
      {MODES.map((m) => {
        const active = m.match(pathname);
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
