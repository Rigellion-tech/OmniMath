// Optional, explicitly invoked live-provider smoke check. Never part of npm test.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { chromium } from "@playwright/test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* local process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not start.`);
}

const apiPort = await freePort();
const webPort = await freePort();
const apiEnv = {
  ...process.env,
  NODE_ENV: "development",
  PORT: String(apiPort),
  OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true",
  OPENAI_RESPONSES_URL: "",
};
const api = spawn(process.execPath, ["server/index.js"], { env: apiEnv, stdio: "inherit" });
let web;
let browser;
try {
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`, "Local API");
  web = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEV_API_TARGET: `http://127.0.0.1:${apiPort}`,
      VITE_DISABLE_AUTH: "true",
      VITE_SEMANTIC_MATH_AST: "true",
      VITE_PROGRESSIVE_SOLVE: "true",
    },
    stdio: "inherit",
  });
  await waitFor(`http://127.0.0.1:${webPort}/?mockAuth=1`, "Vite client");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.OMNIMATH_E2E_BROWSER_PATH ? { executablePath: process.env.OMNIMATH_E2E_BROWSER_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    window.__OMNIMATH_LIVE_STREAM__ = { events: [], firstStepVisibleAt: null, startedAt: null };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      if (!String(args[0]?.url || args[0] || "").includes("/api/explain")
        || !(response.headers.get("content-type") || "").includes("text/event-stream")) return response;
      const reader = response.clone().body.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        let pending = "";
        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value || new Uint8Array(), { stream: !done });
          let match;
          while ((match = /\r?\n\r?\n/u.exec(pending))) {
            const frame = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/u).find((line) => line.startsWith("data:"))?.slice(5).trim();
            if (data) {
              try {
                const event = JSON.parse(data);
                window.__OMNIMATH_LIVE_STREAM__.events.push({ type: event.type, stepIndex: event.stepIndex,
                  sequence: event.sequence, model: event.model || null, receivedAt: performance.now() });
              } catch { /* observer only; the application remains authoritative */ }
            }
          }
          if (done) break;
        }
      })();
      return response;
    };
    new MutationObserver(() => {
      const observed = window.__OMNIMATH_LIVE_STREAM__;
      if (observed.firstStepVisibleAt === null && document.querySelector(".step-card [data-inspectable='math-subtoken']")) {
        observed.firstStepVisibleAt = performance.now();
      }
    }).observe(document, { subtree: true, childList: true });
  });
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, async (route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        title: "Smoke-test target explanation",
        explanation: `A controlled explanation for ${body.selectedLatex || "the hovered target"}.`,
        semanticId: body.semanticId,
        targetId: body.targetId,
      }) });
    });
  }
  await page.goto(`http://127.0.0.1:${webPort}/?mockAuth=1`);
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…")
    .fill("Find the extrema of f(x,y)=x^2+xy+y^2 subject to x+y=1 using Lagrange multipliers.");
  await page.evaluate(() => { window.__OMNIMATH_LIVE_STREAM__.startedAt = performance.now(); });
  await page.getByTestId("primary-composer-solve").click();
  const firstTarget = page.locator(".step-card [data-inspectable='math-subtoken']").first();
  await firstTarget.waitFor({ state: "visible", timeout: 90_000 });
  const semanticId = await firstTarget.getAttribute("data-semantic-id");
  if (!semanticId) throw new Error("Live Step 1 has no semantic identity.");
  await page.waitForFunction((id) => document.querySelector(`.step-card .math-semantic-hitbox[data-token-id="${id}"][data-geometry-valid="true"]`),
    semanticId, { timeout: 15_000 });
  await firstTarget.hover({ force: true });
  await page.locator(`.omni-quick-tooltip[data-semantic-id="${semanticId}"]`).waitFor({ state: "visible", timeout: 10_000 });
  const hoverSnapshot = await page.evaluate(() => ({
    ...window.__OMNIMATH_LIVE_STREAM__,
    hoveredAt: performance.now(),
  }));
  await page.waitForFunction(() => window.__OMNIMATH_LIVE_STREAM__.events.some((event) => event.type === "solve_completed"), null, { timeout: 90_000 });
  const finalSnapshot = await page.evaluate(() => ({
    ...window.__OMNIMATH_LIVE_STREAM__,
    completedAt: performance.now(),
    visibleSteps: document.querySelectorAll(".step-card").length,
  }));
  const earlyHover = !hoverSnapshot.events.some((event) => event.type === "solve_completed");
  const authoritativeStepReceipt = finalSnapshot.events.find((event) => event.type === "step_completed");
  const completion = finalSnapshot.events.find((event) => event.type === "solve_completed");
  const semanticIdAfterCompletion = await firstTarget.getAttribute("data-semantic-id");
  console.log(JSON.stringify({
    selectedModel: completion?.model || "see server attribution",
    firstStepVisibleMs: Math.round(finalSnapshot.firstStepVisibleAt - finalSnapshot.startedAt),
    validatedEventToVisibleMs: authoritativeStepReceipt
      ? Math.round(finalSnapshot.firstStepVisibleAt - authoritativeStepReceipt.receivedAt) : null,
    hoverMs: Math.round(hoverSnapshot.hoveredAt - finalSnapshot.startedAt),
    completeMs: Math.round(finalSnapshot.completedAt - finalSnapshot.startedAt),
    earlyHover,
    semanticId,
    semanticIdStable: semanticIdAfterCompletion === semanticId,
    visibleSteps: finalSnapshot.visibleSteps,
    events: finalSnapshot.events,
  }, null, 2));
  if (!earlyHover) throw new Error("Live provider completed before the first step could be hovered.");
  if (semanticIdAfterCompletion !== semanticId) throw new Error("Early semantic identity changed after later steps.");
  if (finalSnapshot.visibleSteps < 2) throw new Error("Later live-provider steps did not appear.");
} finally {
  await browser?.close();
  web?.kill();
  api.kill();
}
