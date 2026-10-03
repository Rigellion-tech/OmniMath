import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const providerPort = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_PORT || 4392);
const apiPort = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_API_PORT || 4391);
const proxyPort = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_PROXY_PORT || 4393);
const vitePort = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_WEB_PORT || 4390);
const providerState = {
  scenario: "success",
  providerRequests: 0,
  emittedStepCount: 0,
  waitingForStep2: false,
  step2Released: false,
  model: null,
  waitingForRecoveryStep1: false,
  recoveryStep1Released: false,
};
let releaseStep2 = null;
let releaseRecoveryStep1 = null;

const step = (id, heading, latex, reasoning) => ({ id, heading, latex, reasoning, anchors: [] });
const solutionSteps = [
  step("provider-step-1", "Subtract 1 from both sides", "x+1-1=2-1", "Subtract 1 from each side of the equation."),
  step("provider-step-2", "Simplify both sides", "x=1", "Combine the constants on both sides."),
  step("provider-step-3", "Check the solution", "1+1=2", "Substitute x=1 into the original equation."),
];

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function sendProviderEvent(res, type, fields = {}) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
}

async function sendTextDelta(res, delta) {
  // Varying chunk lengths makes this fixture exercise arbitrary provider chunk boundaries.
  for (let offset = 0; offset < delta.length;) {
    const length = [1, 7, 3, 19][offset % 4];
    sendProviderEvent(res, "response.output_text.delta", { delta: delta.slice(offset, offset + length) });
    offset += length;
    await delay(1);
  }
}

async function waitForStep2Release() {
  if (providerState.step2Released) return;
  await new Promise((resolve) => { releaseStep2 = resolve; });
}

async function waitForRecoveryStep1Release() {
  if (providerState.recoveryStep1Released) return;
  await new Promise((resolve) => { releaseRecoveryStep1 = resolve; });
}

async function handleProviderRequest(req, res) {
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    sendJson(res, 404, { error: "fixture route not found" });
    return;
  }
  const payload = await readJson(req);
  providerState.providerRequests += 1;
  providerState.model = payload.model || null;
  providerState.requestStream = payload.stream === true;
  if (payload.stream !== true) {
    sendJson(res, 400, { error: { message: "The browser fixture expects a streaming Responses request." } });
    return;
  }

  if (providerState.scenario === "terminal-pre-prefix") {
    sendJson(res, 400, { error: { code: "invalid_request_error", message: "Fixture invalid request." } });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  sendProviderEvent(res, "response.created", { response: { id: `resp-browser-fixture-${providerState.providerRequests}`, model: providerState.model } });

  const metadata = JSON.stringify({ title: "Controlled provider stream", problemLatex: "x+1=2", steps: [] });
  const prefix = metadata.slice(0, metadata.indexOf("[]")) + "[";
  await sendTextDelta(res, prefix);

  if (providerState.scenario === "recover-before-step1" && providerState.providerRequests === 1) {
    await sendTextDelta(res, '{"id":"failed-draft-step","heading":"failed draft","latex":"\\\\frac{1}{');
    providerState.interruptedWithDraft = true;
    sendProviderEvent(res, "response.failed", { response: {
      id: "resp-browser-fixture-1", model: providerState.model, status: "failed",
      error: { code: "server_error" },
      usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 },
    } });
    res.end();
    return;
  }

  if (providerState.scenario === "recover-before-step1" && providerState.providerRequests === 2) {
    providerState.waitingForRecoveryStep1 = true;
    await waitForRecoveryStep1Release();
    providerState.waitingForRecoveryStep1 = false;
  }

  if (providerState.scenario === "interrupted") {
    for (let index = 0; index < 3; index += 1) {
      await sendTextDelta(res, `${JSON.stringify(solutionSteps[index])},`);
      providerState.emittedStepCount = index + 1;
    }
    await sendTextDelta(res, '{"id":"provider-step-4","heading":"unfinished draft","latex":"\\frac{1}{');
    providerState.interruptedWithDraft = true;
    res.end();
    return;
  }

  await sendTextDelta(res, JSON.stringify(solutionSteps[0]));
  await sendTextDelta(res, ",");
  providerState.emittedStepCount = 1;
  providerState.waitingForStep2 = true;
  await waitForStep2Release();
  providerState.waitingForStep2 = false;
  await sendTextDelta(res, `${JSON.stringify(solutionSteps[1])}],"finalAnswerLatex":"x=1","numericCheck":"1+1=2"}`);
  providerState.emittedStepCount = 2;
  sendProviderEvent(res, "response.completed", {
    response: {
      id: `resp-browser-fixture-${providerState.providerRequests}`,
      model: providerState.model,
      status: "completed",
      usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
    },
  });
  res.end("data: [DONE]\n\n");
}

const providerServer = http.createServer(async (req, res) => {
  if (req.url === "/__fixture/state" && req.method === "GET") {
    sendJson(res, 200, providerState);
    return;
  }
  if (req.url === "/__fixture/scenario" && req.method === "POST") {
    const body = await readJson(req);
    Object.assign(providerState, {
      scenario: ["interrupted", "recover-before-step1", "terminal-pre-prefix"].includes(body.scenario)
        ? body.scenario : "success",
      providerRequests: 0,
      emittedStepCount: 0,
      waitingForStep2: false,
      step2Released: false,
      interruptedWithDraft: false,
      model: null,
      requestStream: false,
      waitingForRecoveryStep1: false,
      recoveryStep1Released: false,
    });
    releaseStep2 = null;
    releaseRecoveryStep1 = null;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.url === "/__fixture/release-step2" && req.method === "POST") {
    providerState.step2Released = true;
    releaseStep2?.();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.url === "/__fixture/release-recovery-step1" && req.method === "POST") {
    providerState.recoveryStep1Released = true;
    releaseRecoveryStep1?.();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.url === "/v1/responses" && req.method === "POST") {
    try { await handleProviderRequest(req, res); }
    catch (error) {
      console.error("[provider-fixture] request failed", error?.message || String(error));
      if (!res.headersSent) sendJson(res, 500, { error: "fixture provider failed" });
      else res.destroy(error);
    }
    return;
  }
  sendJson(res, 404, { error: "fixture route not found" });
});

process.env.PORT = String(apiPort);
process.env.OPENAI_API_KEY = "deterministic-browser-fixture";
process.env.OPENAI_RESPONSES_URL = `http://127.0.0.1:${providerPort}/v1/responses`;
process.env.OMNIMATH_PROGRESSIVE_SOLVE_ENABLED = "true";
process.env.OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS = "60000";
process.env.OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS = "60000";
process.env.NODE_ENV = "test";
const usageFixtureDir = await mkdtemp(join(tmpdir(), "omnimath-provider-browser-"));
process.env.USAGE_LOCAL_STORE_PATH = join(usageFixtureDir, "usage.json");

providerServer.listen(providerPort, "127.0.0.1");
await once(providerServer, "listening");
const { createServer } = await import("../../server/index.js");
const apiServer = createServer();
apiServer.listen(apiPort, "127.0.0.1");
await once(apiServer, "listening");

// Exercise the browser through a separate Node forwarding hop, as it would through
// a deployment proxy. Pipe bytes as they arrive and preserve the API response headers.
const forwardingProxy = http.createServer((req, res) => {
  const headers = { ...req.headers };
  // Connection and the headers it nominates are hop-by-hop. Forwarding
  // `connection: close` through Vite made Node close the API socket while the
  // next request was already being sent on that socket.
  delete headers.connection;
  delete headers["proxy-connection"];
  delete headers["keep-alive"];
  delete headers["upgrade"];
  delete headers["proxy-authenticate"];
  delete headers["proxy-authorization"];
  delete headers["te"];
  delete headers["transfer-encoding"];
  let upstreamResponseEnded = false;
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: apiPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.once("end", () => { upstreamResponseEnded = true; });
    upstreamResponse.pipe(res);
  });
  req.pipe(upstream);
  upstream.on("error", (error) => {
    console.error("[provider-fixture:proxy-upstream-error]", error.code, error.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Forwarding proxy error: ${error.message}`);
  });
  res.on("close", () => {
    if (!upstreamResponseEnded) upstream.destroy();
  });
});
forwardingProxy.listen(proxyPort, "127.0.0.1");
await once(forwardingProxy, "listening");

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
  env: {
    ...process.env,
    PORT: String(apiPort),
    DEV_API_TARGET: `http://127.0.0.1:${proxyPort}`,
    VITE_DISABLE_AUTH: "true",
    VITE_SEMANTIC_MATH_AST: "true",
    VITE_PROGRESSIVE_SOLVE: "true",
    VITE_DEBUG_SESSION_OPERATIONS: "true",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || ".cache/ms-playwright",
  },
  stdio: "inherit",
  windowsHide: true,
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (!vite.killed) vite.kill();
  apiServer.close();
  forwardingProxy.close();
  providerServer.close();
  void rm(usageFixtureDir, { recursive: true, force: true });
  process.exitCode = code;
}
vite.once("exit", (code) => { if (!stopping) shutdown(code || 1); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
await once(vite, "spawn");
await new Promise((resolve, reject) => {
  const startedAt = Date.now();
  const check = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${vitePort}/?mockAuth=1`);
      if (response.ok) { resolve(); return; }
    } catch { /* Vite is starting. */ }
    if (Date.now() - startedAt > 90_000) { reject(new Error("Vite fixture server did not start.")); return; }
    setTimeout(check, 100);
  };
  check();
});
console.log(`[provider-fixture] mock provider :${providerPort}, API :${apiPort}, forwarding proxy :${proxyPort}, Vite :${vitePort}`);
await new Promise(() => {});
