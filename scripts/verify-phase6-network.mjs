import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { makePhase6WorkspaceSolution, PHASE6_PROBLEM, pinPhase6Target } from "../tests/fixtures/phase6Workspace.mjs";
import { submitCurrentComposer } from "../tests/helpers/submitCurrentComposer.mjs";

// Real browser → Vite proxy → backend → deterministic TCP provider. No external API.
const artifactDirectory = "test-artifacts/phase6-resume-network";
await mkdir(artifactDirectory, { recursive: true });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "omnimath-phase6-network-"));
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = async (server) => {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(resolve));
};
const providerRequests = [];
const releases = [];
let completions = 0;
const provider = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw);
  providerRequests.push({ model: payload.model, stream: payload.stream, startedAt: Date.now() });
  const responseId = `phase6-${providerRequests.length}`;
  const frame = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  frame("response.created", { response: { id: responseId, model: payload.model } });
  frame("response.output_text.delta", { delta: "### Example\nFirst provider delta for $a$.\n" });
  await new Promise((resolve) => { releases.push(resolve); });
  frame("response.output_text.delta", { delta: "\n$$a+b+c=6$$\n\nThe target stays bound to its source." });
  frame("response.completed", { response: { id: responseId, model: payload.model, status: "completed", usage: { input_tokens: 20, output_tokens: 25, total_tokens: 45 } } });
  completions += 1;
  res.end();
});
let api;
let vite;
let browser;
try {
  const providerPort = await listen(provider);
  Object.assign(process.env, {
    NODE_ENV: "test", OPENAI_API_KEY: "offline-phase6-network-fixture",
    OPENAI_RESPONSES_URL: `http://127.0.0.1:${providerPort}/v1/responses`,
    OMNIMATH_PINNED_MODEL: "gpt-4.1-mini", CLERK_SECRET_KEY: "", CLERK_JWT_KEY: "",
    USAGE_LOCAL_STORE_PATH: join(temporaryDirectory, "usage.json"),
    DAILY_AI_LIMIT: "1000", MONTHLY_AI_LIMIT: "1000",
    DAILY_TOKEN_LIMIT: "1000000", MONTHLY_TOKEN_LIMIT: "10000000",
  });
  for (const key of ["VERCEL", "DATABASE_URL", "POSTGRES_URL", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[key];
  const { createServer } = await import("../server/index.js");
  api = createServer();
  const apiPort = await listen(api);
  const portProbe = http.createServer();
  const webPort = await listen(portProbe);
  await close(portProbe);
  vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    env: { ...process.env, NODE_ENV: "development", DEV_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_DISABLE_AUTH: "true", VITE_SEMANTIC_MATH_AST: "true", VITE_DEBUG_SESSION_OPERATIONS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteOutput = "";
  vite.stdout.on("data", (data) => { viteOutput += data; });
  vite.stderr.on("data", (data) => { viteOutput += data; });
  const origin = `http://127.0.0.1:${webPort}`;
  const startedAt = Date.now();
  while (true) {
    try { if ((await fetch(origin)).ok) break; } catch { /* start-up only */ }
    if (Date.now() - startedAt > 120_000 || vite.exitCode !== null) throw new Error(`Vite failed to start: ${viteOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const solution = makePhase6WorkspaceSolution();
  await page.route("**/api/explain", (route) => route.fulfill({ json: solution }));
  for (const endpoint of ["explain-token", "explain-pin"]) await page.route(`**/api/${endpoint}`, (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { title: "Controlled target", explanation: "An exact selected term.", semanticId: body.semanticId, targetId: body.targetId } });
  });
  await page.goto(`${origin}/?mockAuth=1`, { timeout: 120_000 });
  await submitCurrentComposer(page, PHASE6_PROBLEM);
  const a = await pinPhase6Target(page, "a");
  const b = await pinPhase6Target(page, "b");
  for (const { card } of [a, b]) {
    const input = card.getByPlaceholder("Ask about this");
    await input.fill("Show an example using this exact term.");
    await input.press("Enter");
    await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "streaming");
    await expect(card.locator(".omni-stream-text h3")).toHaveText("Example");
    await expect(card.locator(".omni-stream-text")).toContainText("First provider delta");
  }
  assert.equal(providerRequests.length, 2);
  assert.equal(completions, 0, "browser visibly rendered both deltas while both real providers remain gated");
  const early = await page.locator("[data-conversation-status='streaming']").evaluateAll((nodes) => nodes.map((node) => ({ conversationId: node.dataset.conversationId, text: node.textContent })));
  assert.equal(new Set(early.map((entry) => entry.conversationId)).size, 2);
  await page.screenshot({ path: `${artifactDirectory}/before-provider-completion.png` });
  releases.forEach((release) => release());
  for (const { card } of [a, b]) {
    await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete");
    await expect(card.locator(".omni-conversation-equation .katex")).toBeVisible();
    await expect(card.locator("[data-message-role='assistant']")).not.toContainText("###");
  }
  await page.screenshot({ path: `${artifactDirectory}/completed.png` });
  const evidence = { topology: "Chromium → real Vite proxy → Node backend → gated local TCP Responses provider", early, completionsBeforeRelease: 0, providerRequests, completions, externalProviderCalls: 0, passed: true };
  await writeFile(`${artifactDirectory}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const stopped = new Promise((resolve) => vite.once("exit", resolve));
    vite.kill("SIGTERM");
    await stopped;
  }
  await close(api);
  await close(provider);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
