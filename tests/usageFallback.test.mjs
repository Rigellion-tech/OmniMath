import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

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

function usageKey({ date, month, metric, identityKey, period }) {
  const periodKey = period === "daily" ? date : month;
  return `usage:${period}:${periodKey}:${metric}:${identityKey}`;
}

async function seedUsageStore(path, identityKey, requestCount, limit) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const data = {
    [usageKey({ date, month, metric: "requests", identityKey, period: "daily" })]: { count: requestCount },
    [usageKey({ date, month, metric: "requests", identityKey, period: "monthly" })]: { count: requestCount },
    [usageKey({ date, month, metric: "tokens", identityKey, period: "daily" })]: { count: 0 },
    [usageKey({ date, month, metric: "tokens", identityKey, period: "monthly" })]: { count: 0 },
    [usageKey({ date, month, metric: "tokens", identityKey: "global", period: "daily" })]: { count: 0 },
    [usageKey({ date, month, metric: "tokens", identityKey: "global", period: "monthly" })]: { count: 0 },
    [usageKey({ date, month, metric: "costMicros", identityKey: "global", period: "daily" })]: { count: 0 },
    [usageKey({ date, month, metric: "costMicros", identityKey: "global", period: "monthly" })]: { count: 0 },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), "utf8");
  return { limit };
}

describe("local usage fallback", () => {
  it("returns empty local sessions instead of failing when dev DB user schema is unavailable", async () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      DATABASE_URL: process.env.DATABASE_URL,
      POSTGRES_URL: process.env.POSTGRES_URL,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
    };

    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    process.env.DATABASE_URL = "postgres://omnimath:omnimath@127.0.0.1:1/omnimath";
    delete process.env.POSTGRES_URL;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;

    try {
      const { handleSessionsRequest } = await import(`../server/app.js?sessions-fallback-${Date.now()}`);
      const req = {
        method: "GET",
        url: "/api/sessions",
        headers: {
          host: "localhost:8787",
        },
      };
      const res = createJsonResponseRecorder();

      await handleSessionsRequest(req, res);

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.sessions, []);
      assert.equal(body.databaseConfigured, false);
      assert.equal(body.fallback, "missing_local_schema");
    } finally {
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it("does not block local-rule /api/explain when local dev AI request quota is exhausted", async () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
      DAILY_AI_LIMIT: process.env.DAILY_AI_LIMIT,
      MONTHLY_AI_LIMIT: process.env.MONTHLY_AI_LIMIT,
      USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
      DATABASE_URL: process.env.DATABASE_URL,
      POSTGRES_URL: process.env.POSTGRES_URL,
    };

    const storePath = join(tmpdir(), `omnimath-usage-${Date.now()}-${Math.random()}.json`);
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.env.DAILY_AI_LIMIT = "1";
    process.env.MONTHLY_AI_LIMIT = "1";
    process.env.USAGE_LOCAL_STORE_PATH = storePath;

    await seedUsageStore(storePath, "local-dev-explain", 1, 1);

    try {
      const { handleExplainRequest } = await import(`../server/app.js?usage-fallback-${Date.now()}`);
      const req = {
        method: "POST",
        url: "/api/explain",
        headers: {
          "content-type": "application/json",
          host: "localhost:8787",
        },
        body: {
          problem: "Use the quotient rule for f/g.",
          history: [],
        },
      };
      const res = createJsonResponseRecorder();

      await handleExplainRequest(req, res);

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.steps));
      assert.ok(body.steps.length > 0);
      assert.equal(body.runtime.source, "local rule");
      assert.equal(body.usage.used, 1);
      assert.equal(body.usage.limit, 1);
      assert.equal(body.usage.remaining, 0);
    } finally {
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it("returns accurate used and limit values when daily quota is truly reached", async () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      DAILY_AI_LIMIT: process.env.DAILY_AI_LIMIT,
      MONTHLY_AI_LIMIT: process.env.MONTHLY_AI_LIMIT,
      USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
    };

    const storePath = join(tmpdir(), `omnimath-usage-limit-${Date.now()}-${Math.random()}.json`);
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    process.env.DAILY_AI_LIMIT = "1";
    process.env.MONTHLY_AI_LIMIT = "1";
    process.env.USAGE_LOCAL_STORE_PATH = storePath;
    await seedUsageStore(storePath, "usage-limit-user", 1, 1);

    try {
      const { checkAndReserveUsage } = await import(`../server/usageLimits.js?usage-limit-${Date.now()}`);
      await assert.rejects(
        () => checkAndReserveUsage({
          identity: {
            key: "usage-limit-user",
            tier: "free",
            subject: "test",
            clerkUserId: "usage-limit-user",
          },
          kind: "explanation",
          estimatedTokens: 0,
          estimatedCostMicros: 0,
        }),
        (error) => {
          assert.equal(error.statusCode, 429);
          assert.equal(error.usage.used, 1);
          assert.equal(error.usage.limit, 1);
          assert.equal(error.usage.remaining, 0);
          return true;
        }
      );
    } finally {
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });
});
