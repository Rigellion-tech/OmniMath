import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { it } from "node:test";
import pg from "pg";
import { buildExtractionSubmissionPayload } from "../src/api/mathClient.js";

// Clerk caches verification keys by kid; use one generated key for this fixture.
const fixtureKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signedSession() {
  const { privateKey, publicKey } = fixtureKeyPair;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "offline-test" })}.${encode({
    sub: "user_incident_regression", sid: "sess_incident_regression",
    iss: "https://offline-test.clerk.accounts.dev", iat: now, nbf: now - 1, exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
  };
}

function request(body, token) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/api/solve-extracted-problem";
  req.headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  req.body = body;
  return req;
}

function recorder() {
  return {
    statusCode: null, body: "", ended: false,
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
}

async function fixture(t) {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  for (const key of Object.keys(process.env)) {
    if (/^(?:OPENAI_|OMNIMATH_|CLERK_|DATABASE_|POSTGRES_|USAGE_|KV_|UPSTASH_|AI_)/u.test(key)) delete process.env[key];
  }
  const session = signedSession();
  Object.assign(process.env, {
    NODE_ENV: "production", VERCEL: "1", OPENAI_API_KEY: "offline-test-fixture",
    CLERK_JWT_KEY: session.jwtKey, DATABASE_URL: "postgres://fixture@127.0.0.1:1/fixture",
    USAGE_KV_REST_API_URL: "https://offline-kv.invalid", USAGE_KV_REST_API_TOKEN: "offline-test-fixture",
  });
  const events = [];
  t.mock.method(console, "info", (...args) => events.push(args));
  t.mock.method(console, "warn", (...args) => events.push(args));
  t.mock.method(console, "error", (...args) => events.push(args));
  let providerCalls = 0;
  const counters = new Map();
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (target.startsWith("https://offline-kv.invalid/get/")) return json({ result: counters.get(decodeURIComponent(target.split("/get/")[1])) || 0 });
    if (target === "https://offline-kv.invalid/pipeline") return json(JSON.parse(options.body).map(([verb, key, count]) => {
      if (verb === "INCRBY" || verb === "DECRBY") counters.set(key, (counters.get(key) || 0) + (verb === "INCRBY" ? count : -count));
      return { result: verb === "EXPIRE" ? 1 : counters.get(key) || 0 };
    }));
    if (!target.startsWith("https://api.openai.com/")) throw new Error(`Unexpected offline fixture request: ${target}`);
    providerCalls += 1;
    return json({
      id: "resp_incident_fixture", status: "completed", model: "offline-fixture",
      usage: { input_tokens: 50, output_tokens: 100, total_tokens: 150 },
      output_text: JSON.stringify({
        title: "Solve the equation", problemLatex: "x+7=9", finalAnswerLatex: "x=2", numericCheck: "",
        steps: [{ id: "subtract", heading: "Subtract seven", latex: "x=9-7", reasoning: "Subtract seven from both sides.", anchors: [] },
          { id: "answer", heading: "Final answer", latex: "x=2", reasoning: "Simplify the right side.", anchors: [] }],
      }),
    });
  });
  const app = await import(`../server/app.js?incident-boundary-${Math.random()}`);
  return { app, session, events, providerCalls: () => providerCalls };
}

it("production image solve preserves a real IncomingMessage's auth through provider, save and response", async (t) => {
  const { app, session, events, providerCalls } = await fixture(t);
  const userIds = [];
  t.mock.method(pg.Pool.prototype, "query", async (sql, params) => {
    if (/insert into app_users/iu.test(sql)) { userIds.push(params[0]); return { rows: [{ id: "offline-user-row" }] }; }
    if (/insert into user_explanations/iu.test(sql)) return { rows: [{ id: "offline-save-row" }] };
    throw new Error("Unexpected SQL in incident regression");
  });
  const req = request({ problem: "x+7=9", extraction: {}, debugRequestId: "incident-auth-real" }, session.token);
  assert.equal(({ ...req }).headers, undefined, "the old adapter demonstrably drops real Node headers");
  const res = recorder();
  await app.handleSolveExtractedProblemRequest(req, res);
  await nextTurn();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(providerCalls(), 1);
  assert.equal(res.json().steps.length, 2);
  assert.deepEqual(userIds, ["user_incident_regression"]);
  assert.ok(events.some(([name, value]) => name === "[omnimath:clerk-auth]" && value.status === "verified"));
  assert.equal(events.some(([name]) => name === "[omnimath:dev-auth-fallback]"), false);
  req.destroy();
});

it("production image solve with missing auth fails closed before any provider call", async (t) => {
  const { app, events, providerCalls } = await fixture(t);
  const req = request({ problem: "x+7=9", extraction: {} });
  const res = recorder();
  await app.handleSolveExtractedProblemRequest(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "AUTH_REQUIRED");
  assert.equal(providerCalls(), 0);
  assert.equal(events.some(([name]) => name === "[omnimath:dev-auth-fallback]"), false);
  req.destroy();
});

it("provider success reaches HTTP before the actual DB save settles, and a later reset cannot revoke it", async (t) => {
  const { app, session, events, providerCalls } = await fixture(t);
  let rejectSave;
  t.mock.method(pg.Pool.prototype, "query", () => new Promise((_, reject) => { rejectSave = reject; }));
  const req = request({ problem: "x+7=9", extraction: { imageHash: "db-reset-fixture" }, debugRequestId: "incident-db-reset" }, session.token);
  const res = recorder();
  const handling = app.handleSolveExtractedProblemRequest(req, res);
  // The deadline is an assertion, not the simulated failure. The unresolved PG
  // query is the exact awaited boundary that used to delay HTTP success.
  let timer;
  const result = await Promise.race([
    handling.then(() => "responded"),
    new Promise((resolve) => { timer = setTimeout(() => resolve("blocked-on-db"), 3000); }),
  ]);
  clearTimeout(timer);
  assert.equal(typeof rejectSave, "function", JSON.stringify({
    requirement: "must exercise the actual save query, not a cache hit",
    status: res.statusCode, source: res.ended ? res.json().runtime?.source : null,
    code: res.ended ? res.json().code : null, providerCalls: providerCalls(),
  }));
  rejectSave(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  await handling;
  await nextTurn();
  assert.equal(result, "responded");
  assert.equal(providerCalls(), 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().steps.length, 2);
  assert.equal(res.json().runtime.saveStatus, "pending");
  assert.ok(events.some(([name, details]) => name === "[omnimath:save-warning]" && details.code === "DATABASE_UNAVAILABLE"));
  req.destroy();
});

it("the extraction-submit contract preserves canonical review issues and metrics over conflicting top-level summaries", async (t) => {
  const { app, session, providerCalls } = await fixture(t);
  const review = {
    confidence: 64, tier: "medium", critical: false,
    issues: [{ type: "ocr_text_cleanup_review", severity: "medium" }, { type: "text_latex_mismatch", severity: "medium" }],
    metrics: { ocrConfidence: 95, modelConfidence: 100, textSuperscripts: 2, latexSuperscripts: 3,
      textSubscripts: 0, latexSubscripts: 1, differenceRatio: 0.649,
      textCleanup: { substantial: true, changedCharacters: 61, changeRatio: 0.513 } },
  };
  const payload = buildExtractionSubmissionPayload({
    extraction: { extractedProblemText: "x+7=9", extractedProblemLatex: "x+7=9", confidenceTier: "high", issues: [], extractionValidation: review },
    displayText: "x+7=9", rawText: "x+7=9", solveDecision: "direct", source: "ocr-direct",
  });
  assert.deepEqual(payload.extraction.extractionValidation, review);
  const req = request(JSON.parse(JSON.stringify(payload)), session.token);
  const res = recorder();
  await app.handleSolveExtractedProblemRequest(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "OCR_REVIEW_REQUIRED");
  assert.equal(providerCalls(), 0);
  req.destroy();
});
