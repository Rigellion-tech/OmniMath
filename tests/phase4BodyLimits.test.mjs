import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import "./helpers/noExternalNetwork.mjs";

const MAX_JSON_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + MAX_JSON_BYTES;
const INCIDENT_IMAGE_BYTES = Math.floor(1.36 * 1024 * 1024);
const fixtureKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

function signedSession() {
  const { privateKey, publicKey } = fixtureKeyPair;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "phase4-body-limits" })}.${encode({
    sub: "user_phase4_body_limits",
    sid: "session_phase4_body_limits",
    iss: "https://offline-test.clerk.accounts.dev",
    iat: now,
    nbf: now - 1,
    exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk = "") {
      this.body += chunk;
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
}

function request({ url, body, contentType = "application/json", token = "" }) {
  return {
    method: "POST",
    url,
    headers: {
      host: "localhost:8787",
      "content-type": contentType,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    socket: { remoteAddress: "127.44.0.1" },
    body,
  };
}

function exactJsonObject(byteLength, buildWithPadding) {
  const empty = buildWithPadding("");
  const emptyBytes = Buffer.byteLength(JSON.stringify(empty));
  assert.ok(emptyBytes <= byteLength, "fixture envelope must fit the requested byte length");
  const value = buildWithPadding("a".repeat(byteLength - emptyBytes));
  assert.equal(Buffer.byteLength(JSON.stringify(value)), byteLength);
  return value;
}

function multipartImage(fileBuffer, boundary = "phase4-body-boundary") {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nRead this image\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="incident.png"\r\nContent-Type: image/png\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function invoke(handler, req) {
  const res = responseRecorder();
  await handler(req, res);
  return res;
}

async function bodyFixture(t) {
  const originalEnv = { ...process.env };
  const usagePath = join(tmpdir(), `omnimath-phase4-body-${Date.now()}-${Math.random()}.json`);
  t.after(async () => {
    process.env = originalEnv;
    await rm(usagePath, { force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (/^(?:OPENAI_|OMNIMATH_|CLERK_|DATABASE_|POSTGRES_|USAGE_|KV_|UPSTASH_|AI_)/u.test(key)) {
      delete process.env[key];
    }
  }
  const session = signedSession();
  Object.assign(process.env, {
    NODE_ENV: "test",
    CLERK_JWT_KEY: session.jwtKey,
    USAGE_LOCAL_STORE_PATH: usagePath,
    DAILY_AI_LIMIT: "1000",
    MONTHLY_AI_LIMIT: "1000",
    DAILY_TOKEN_LIMIT: "10000000",
    MONTHLY_TOKEN_LIMIT: "100000000",
    DAILY_SPEND_LIMIT_USD: "1000",
    MONTHLY_SPEND_LIMIT_USD: "1000",
  });
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    fetchCalls += 1;
    throw new Error(`Unexpected network request in body-limit fixture: ${url}`);
  });
  const app = await import(`../server/app.js?phase4-body-limits-${Date.now()}-${Math.random()}`);
  return { app, session, fetchCalls: () => fetchCalls };
}

it("accepts raw JSON at 512 KiB and rejects the next byte on session and OCR solve routes", async (t) => {
  const { app } = await bodyFixture(t);
  const cases = [
    {
      name: "sessions",
      handler: app.handleSessionsRequest,
      url: "/api/sessions",
      exactObject: exactJsonObject(MAX_JSON_BYTES, (padding) => ({
        session: { messages: "invalid-after-body-parse", padding },
      })),
    },
    {
      name: "solve-extracted-problem",
      handler: app.handleSolveExtractedProblemRequest,
      url: "/api/solve-extracted-problem",
      exactObject: exactJsonObject(MAX_JSON_BYTES, (padding) => ({ extraction: [], padding })),
    },
  ];

  for (const testCase of cases) {
    const boundary = await invoke(testCase.handler, request({
      url: testCase.url,
      body: Buffer.from(JSON.stringify(testCase.exactObject)),
    }));
    assert.equal(boundary.statusCode, 400, `${testCase.name} should parse the exact 512 KiB boundary`);
    assert.notEqual(boundary.json().code, "REQUEST_BODY_TOO_LARGE");

    const oversized = await invoke(testCase.handler, request({
      url: testCase.url,
      body: Buffer.alloc(MAX_JSON_BYTES + 1, 0x20),
    }));
    assert.equal(oversized.statusCode, 413, testCase.name);
    assert.equal(oversized.json().code, "REQUEST_BODY_TOO_LARGE", testCase.name);
  }
});

it("applies the same 512 KiB limit to upstream-preparsed JSON objects", async (t) => {
  const { app } = await bodyFixture(t);
  const cases = [
    {
      name: "sessions",
      handler: app.handleSessionsRequest,
      url: "/api/sessions",
      body: exactJsonObject(MAX_JSON_BYTES + 1, (padding) => ({ session: { messages: [], padding } })),
    },
    {
      name: "solve-extracted-problem",
      handler: app.handleSolveExtractedProblemRequest,
      url: "/api/solve-extracted-problem",
      body: exactJsonObject(MAX_JSON_BYTES + 1, (padding) => ({ extraction: {}, padding })),
    },
  ];

  for (const testCase of cases) {
    const res = await invoke(testCase.handler, request({
      url: testCase.url,
      body: testCase.body,
    }));
    assert.equal(res.statusCode, 413, testCase.name);
    assert.equal(res.json().code, "REQUEST_BODY_TOO_LARGE", testCase.name);
  }
});

it("rejects an image multipart envelope above 10.5 MiB before reservation or provider work", async (t) => {
  const { app, session, fetchCalls } = await bodyFixture(t);
  const res = await invoke(app.handleExtractImageProblemRequest, request({
    url: "/api/extract-image-problem",
    contentType: "multipart/form-data; boundary=phase4-oversized",
    token: session.token,
    body: Buffer.alloc(MAX_MULTIPART_BYTES + 1, 0x20),
  }));

  assert.equal(res.statusCode, 413);
  assert.equal(res.json().code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(fetchCalls(), 0, "body rejection must precede usage-store and provider fetches");
});

it("the 1.36 MiB incident image clears app multipart sizing before the next configured boundary", async (t) => {
  const { app, session, fetchCalls } = await bodyFixture(t);
  const png = Buffer.alloc(INCIDENT_IMAGE_BYTES, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  const boundary = "phase4-incident-image";
  const body = multipartImage(png, boundary);
  assert.ok(body.length < MAX_MULTIPART_BYTES);

  const res = await invoke(app.handleExtractImageProblemRequest, request({
    url: "/api/extract-image-problem",
    contentType: `multipart/form-data; boundary=${boundary}`,
    token: session.token,
    body,
  }));

  assert.equal(res.statusCode, 500, res.body);
  assert.equal(res.json().code, "SERVER_CONFIG_ERROR");
  assert.notEqual(res.json().code, "REQUEST_BODY_TOO_LARGE");
  assert.equal(fetchCalls(), 0, "missing provider configuration is the intentional next boundary");
});
