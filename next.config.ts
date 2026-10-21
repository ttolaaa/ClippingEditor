import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["openai"],
  // Cross-origin isolation enables SharedArrayBuffer → multi-threaded WASM for in-browser Whisper.
  // "credentialless" still allows CORS model downloads (Hugging Face / jsDelivr).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;