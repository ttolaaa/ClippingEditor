export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "clip"
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function scoreColor(score: number): { text: string; bg: string; ring: string; label: string } {
  if (score >= 80) return { text: "text-success", bg: "bg-success", ring: "#16a34a", label: "Viral potential" };
  if (score >= 60) return { text: "text-accent", bg: "bg-accent", ring: "#ff6a00", label: "Strong" };
  return { text: "text-danger", bg: "bg-danger", ring: "#e5371f", label: "Needs work" };
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
