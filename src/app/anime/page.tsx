import type { Metadata } from "next";
import AnimeHome from "@/components/AnimeHome";

export const metadata: Metadata = {
  title: "Anime Clipper — viral clips with furigana + English subtitles",
  description: "Find the most viral moments in an anime episode and export 9:16 Reels with Japanese furigana and English subtitles, in your browser.",
};

export default function AnimePage() {
  return <AnimeHome />;
}
