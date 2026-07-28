import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

const stokesProblem = "Let S be the portion of the paraboloid z = 9 - x^2 - y^2 lying above z = 0, oriented upward. Its boundary curve is C. Evaluate ∬_S (∇ × F) · n dS where F(x,y,z)=<yz^2 + e^(x^2) sin(y), x^3 z + ln(1+z^2), xy^2 + z cos(xy)>.";

function createJsonResponseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createExpiredJwt() {
  return [
    base64urlJson({ alg: "none", typ: "JWT" }),
    base64urlJson({ sub: "user_expired_save", exp: Math.floor(Date.now() / 1000) - 60 }),
    "signature",
  ].join(".");
}

describe("save auth expiry", () => {
  it("keeps solve-extracted-problem steps when best-effort save sees an expired token", async () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      POSTGRES_URL: process.env.POSTGRES_URL,
      USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
    };

    const storeDir = join(tmpdir(), `omnimath-save-expiry-${Date.now()}-${Math.random()}`);
    await mkdir(storeDir, { recursive: true });

    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;
    delete process.env.POSTGRES_URL;
    process.env.DATABASE_URL = "postgres://omnimath:omnimath@127.0.0.1:1/omnimath";
    process.env.USAGE_LOCAL_STORE_PATH = join(storeDir, "usage.json");

    try {
      const { handleSolveExtractedProblemRequest } = await import(`../server/app.js?save-expiry-${Date.now()}`);
      const req = {
        method: "POST",
        url: "/api/solve-extracted-problem",
        headers: {
          authorization: `Bearer ${createExpiredJwt()}`,
          "content-type": "application/json",
          host: "localhost:8787",
        },
        body: {
          problem: stokesProblem,
          problemText: stokesProblem,
          extraction: { imageHash: "expired-save-test" },
          solveDecision: "direct",
        },
      };
      const res = createJsonResponseRecorder();

      await handleSolveExtractedProblemRequest(req, res);

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.steps));
      assert.ok(body.steps.length > 0);
      assert.equal(body.runtime.saveWarning, "auth_expired");
    } finally {
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });
});
