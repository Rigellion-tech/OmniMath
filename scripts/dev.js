import { spawn } from "node:child_process";

const processes = [
  { name: "api", args: ["server/index.js"] },
  { name: "vite", args: ["node_modules/vite/bin/vite.js"] },
].map(({ name, args }) => {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code) => {
    if (code === 0 || shuttingDown) return;
    shutdown(code || 1);
  });

  return child;
});

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
