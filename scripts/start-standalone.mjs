// `npm start`: run the production build via Next.js standalone output (same layout as the Docker image).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const sa = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(sa, "server.js"))) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}
fs.cpSync(path.join(root, ".next", "static"), path.join(sa, ".next", "static"), { recursive: true });
fs.cpSync(path.join(root, "public"), path.join(sa, "public"), { recursive: true });

const child = spawn(process.execPath, [path.join(sa, "server.js")], {
  stdio: "inherit",
  env: { PORT: "3000", HOSTNAME: "0.0.0.0", ...process.env, NODE_ENV: "production" },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
