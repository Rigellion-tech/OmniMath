import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

function readDotEnv() {
  try {
    const raw = fs.readFileSync(".env", "utf8");
    return Object.fromEntries(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
        })
    );
  } catch {
    return {};
  }
}

function canListen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      resolve(error.code !== "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function assertPortAvailable({ name, port }) {
  const available = await canListen(port);
  if (available) return;

  console.error(
    `[dev] Port ${port} is already in use by another ${name} process. ` +
    "Stop the existing dev server before running npm run dev again."
  );
  process.exit(1);
}

const env = { ...readDotEnv(), ...process.env };
const apiPort = Number(env.PORT || 8787);
const vitePort = Number(env.VITE_PORT || 5173);
let shuttingDown = false;
const processes = [];

await assertPortAvailable({ name: "OmniMath API", port: apiPort });
await assertPortAvailable({ name: "Vite", port: vitePort });

for (const { name, args } of [
  { name: "api", args: ["server/index.js"] },
  { name: "vite", args: ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"] },
]) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code) => {
    if (code === 0 || shuttingDown) return;
    shutdown(code || 1);
  });

  processes.push(child);
}

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
