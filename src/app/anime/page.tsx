import type { Metadata } from "next";
import AnimeClipper from "@/components/AnimeClipper";

export const metadata: Metadata = {
  title: "Anime Clipper — Japanese furigana + English subtitles",
  description: "Clip anime into 9:16 Reels with Japanese furigana and English subtitles, rendered in your browser.",
};

export default function AnimePage() {
  return <AnimeClipper />;
}
