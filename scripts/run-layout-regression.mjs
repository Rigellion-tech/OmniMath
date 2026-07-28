import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const playwrightCli = fileURLToPath(new URL("../node_modules/playwright/cli.js", import.meta.url));
const config = fileURLToPath(new URL("../playwright.config.mjs", import.meta.url));

const child = spawn(process.execPath, [playwrightCli, "test", "--config", config], {
  stdio: "inherit",
  env: {
    ...process.env,
    LD_LIBRARY_PATH: [
      ".cache/pw-deps/root/usr/lib/x86_64-linux-gnu",
      process.env.LD_LIBRARY_PATH,
    ].filter(Boolean).join(":"),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || ".cache/ms-playwright",
  },
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});
