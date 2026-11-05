// Self-host the kuromoji dictionary (~18 MB gzipped) used by Anime Clipper to generate furigana on-device.
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("node_modules/@sglkc/kuromoji/dict");
const dest = path.resolve("public/kuromoji-dict");
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) if (f.endsWith(".dat.gz")) fs.copyFileSync(path.join(src, f), path.join(dest, f));
console.log("kuromoji dictionary copied to public/kuromoji-dict");
