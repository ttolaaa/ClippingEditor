// Self-host ffmpeg.wasm (used only to convert AVI and other formats browsers can't decode natively).
// Served as plain static files so its internal module worker loads without bundler involvement.
import fs from "node:fs";
import path from "node:path";

const dest = path.resolve("public/ffmpeg");
fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
const core = path.resolve("node_modules/@ffmpeg/core/dist/esm");
for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) fs.copyFileSync(path.join(core, f), path.join(dest, f));
const lib = path.resolve("node_modules/@ffmpeg/ffmpeg/dist/esm");
for (const f of fs.readdirSync(lib)) if (f.endsWith(".js")) fs.copyFileSync(path.join(lib, f), path.join(dest, "lib", f));
console.log("ffmpeg.wasm copied to public/ffmpeg");