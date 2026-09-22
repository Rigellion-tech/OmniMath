import "./helpers/noExternalNetwork.mjs";

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { it } from "node:test";
import pg from "pg";

const fixtureKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signedSession() {
  const { privateKey, publicKey } = fixtureKeyPair;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "offline-persistence-test" })}.${encode({
    sub: "user_persistence_reconciliation", sid: "sess_persistence_reconciliation",
    iss: "https://offline-test.clerk.accounts.dev", iat: now, nbf: now - 1, exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
  };
}

function request(body, token) {
  return {
    method: "POST",
    url: "/api/explain",
    headers: { "content-type": "application/json", host: "localhost:8787", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    socket: { remoteAddress: "127.0.0.1" },
    body,
  };
}

function responseRecorder() {
  return {
    statusCode: null, body: "", ended: false,
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
}

async function fixture(t) {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const usagePath = join(tmpdir(), `omnimath-persistence-reconciliation-${Date.now()}-${Math.random()}.json`);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    await rm(usagePath, { force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (/^(?:OPENAI_|OMNIMATH_|CLERK_|DATABASE_|POSTGRES_|USAGE_|KV_|UPSTASH_|AI_|VITE_DEBUG_)/u.test(key)) delete process.env[key];
  }
  const session = signedSession();
  Object.assign(process.env, {
    NODE_ENV: "development",
    OPENAI_API_KEY: "offline-persistence-fixture",
    CLERK_JWT_KEY: session.jwtKey,
    DATABASE_URL: "postgres://fixture@127.0.0.1:1/fixture",
    USAGE_LOCAL_STORE_PATH: usagePath,
    USAGE_KV_REST_API_URL: "https://offline-kv.invalid",
    USAGE_KV_REST_API_TOKEN: "offline-persistence-fixture",
    DAILY_AI_LIMIT: "1000", MONTHLY_AI_LIMIT: "1000",
    DAILY_TOKEN_LIMIT: "10000000", MONTHLY_TOKEN_LIMIT: "100000000",
    DAILY_SPEND_LIMIT_USD: "1000", MONTHLY_SPEND_LIMIT_USD: "1000",
  });

  const events = [];
  t.mock.method(console, "info", (...args) => events.push(args));
  t.mock.method(console, "warn", (...args) => events.push(args));
  t.mock.method(console, "error", (...args) => events.push(args));
  const counters = new Map();
  let providerCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (target.startsWith("https://offline-kv.invalid/get/")) {
      return json({ result: counters.get(decodeURIComponent(target.split("/get/")[1])) || 0 });
    }
    if (target === "https://offline-kv.invalid/pipeline") {
      return json(JSON.parse(options.body).map(([verb, key, count]) => {
        if (verb === "INCRBY" || verb === "DECRBY") counters.set(key, (counters.get(key) || 0) + (verb === "INCRBY" ? count : -count));
        return { result: verb === "EXPIRE" ? 1 : counters.get(key) || 0 };
      }));
    }
    if (target !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected offline fixture request: ${target}`);
    providerCalls += 1;
    return json({
      id: "resp_persistence_fixture", status: "completed", model: "offline-fixture",
      usage: { input_tokens: 50, output_tokens: 100, total_tokens: 150 },
      output_text: JSON.stringify({
        title: "Differentiate x squared", problemLatex: "x^2", finalAnswerLatex: "2x", numericCheck: "",
        steps: [
          { id: "power-rule", heading: "Apply the power rule", latex: "\\frac{d}{dx}x^2=2x^{2-1}", reasoning: "Multiply by the exponent and reduce the exponent by one.", anchors: [] },
          { id: "simplify", heading: "Simplify", latex: "2x", reasoning: "Simplify the exponent.", anchors: [] },
        ],
      }),
    });
  };
  const app = await import(`../server/app.js?persist-reconciliation-${Date.now()}-${Math.random()}`);
  const userData = await import(`../server/userData.js?persist-reconciliation-${Date.now()}-${Math.random()}`);
  return { app, userData, session, events, providerCalls: () => providerCalls };
}

function missingAppUsers() {
  return Object.assign(new Error('relation "app_users" does not exist'), { code: "42P01" });
}

it("reproduces typed session payload fallback when the local app_users schema is missing", async (t) => {
  const { userData, session } = await fixture(t);
  t.mock.method(pg.Pool.prototype, "query", async () => { throw missingAppUsers(); });
  const req = request({}, session.token);
  const payload = {
    id: "4eaf5c2a-a398-4e70-aab3-9ee1554d2a1e",
    title: "Solve x + 7 = 9",
    messages: [{ role: "user", text: "Solve x + 7 = 9" }],
    problem: { originalProblem: "x+7=9", steps: [{ id: "step-one" }] },
    steps: [{ id: "step-one", latex: "x=2" }],
    pinnedWindows: [{ id: "pin-one", token: "x" }],
  };

  const created = await userData.createUserSessionForRequest(req, payload);
  assert.equal(created.databaseConfigured, false);
  assert.equal(created.fallback, "missing_local_schema");
  assert.equal(created.session.id, payload.id);
  assert.deepEqual(created.session.messages, payload.messages);
  assert.deepEqual(created.session.problem, payload.problem);
  assert.deepEqual(created.session.steps, payload.steps);
  assert.deepEqual(created.session.pinnedWindows, payload.pinnedWindows);

  const updatedPayload = { ...payload, title: "Updated session", messages: [...payload.messages, { role: "assistant", text: "x=2" }] };
  const updated = await userData.updateUserSessionForRequest(req, payload.id, updatedPayload);
  assert.equal(updated.databaseConfigured, false);
  assert.equal(updated.fallback, "missing_local_schema");
  assert.equal(updated.session.id, payload.id);
  assert.equal(updated.session.title, updatedPayload.title);
  assert.deepEqual(updated.session.messages, updatedPayload.messages);
});

it("keeps a typed provider explanation successful while background persistence reports missing app_users", async (t) => {
  const { app, session, events, providerCalls } = await fixture(t);
  t.mock.method(pg.Pool.prototype, "query", async () => { throw missingAppUsers(); });
  const req = request({ problem: "Explain whether x^7 + y^7 = z^7 has a nonzero integer solution.", debugRequestId: "persist-missing-app-users" }, session.token);
  const res = responseRecorder();

  await app.handleExplainRequest(req, res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(providerCalls(), 1, res.body);
  assert.ok(res.json().steps.length >= 1, "the provider result contains renderable solution steps");
  assert.equal(res.json().runtime?.saveStatus, "pending");

  await nextTurn();
  assert.ok(events.some(([name, details]) => name === "[omnimath:save-warning]" && details.code === "DATABASE_UNAVAILABLE"));
});
