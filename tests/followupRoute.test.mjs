import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const appUrl = pathToFileURL(join(repoRoot, "server", "app.js")).href;

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

describe("explain follow-up route", () => {
  it("answers pinned follow-up from request context when auth, DB, and OpenAI are unavailable locally", async () => {
    const originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      OPENAI_SOLVER_MODEL: process.env.OPENAI_SOLVER_MODEL,
      DATABASE_URL: process.env.DATABASE_URL,
      POSTGRES_URL: process.env.POSTGRES_URL,
      CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
      CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
      USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
      DAILY_AI_LIMIT: process.env.DAILY_AI_LIMIT,
      MONTHLY_AI_LIMIT: process.env.MONTHLY_AI_LIMIT,
      DAILY_TOKEN_LIMIT: process.env.DAILY_TOKEN_LIMIT,
      MONTHLY_TOKEN_LIMIT: process.env.MONTHLY_TOKEN_LIMIT,
    };
    const originalCwd = process.cwd();
    const cwd = join(tmpdir(), `omnimath-followup-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(cwd, { recursive: true });

    process.chdir(cwd);
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_SOLVER_MODEL;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_JWT_KEY;
    process.env.USAGE_LOCAL_STORE_PATH = join(cwd, ".data", "usage.json");
    process.env.DAILY_AI_LIMIT = "1000";
    process.env.MONTHLY_AI_LIMIT = "1000";
    process.env.DAILY_TOKEN_LIMIT = "1000000";
    process.env.MONTHLY_TOKEN_LIMIT = "10000000";

    try {
      const { handleExplainFollowupRequest } = await import(`${appUrl}?followup-route-${Date.now()}-${Math.random()}`);
      const req = {
        method: "POST",
        url: "/api/explain-followup",
        headers: {
          "content-type": "application/json",
          host: "localhost:8787",
        },
        body: {
          problem: "Evaluate the pinned step.",
          solution: { problem: "Evaluate the pinned step.", steps: [] },
          stepId: "step-1",
          stepTitle: "Pinned expression",
          currentStep: { math: "3\\cos\\theta" },
          selectedText: "3\\cos\\theta",
          selectedTokens: [{ latex: "3", display: "3" }],
          pinnedExplanation: "3 is the coefficient multiplying cosine.",
          question: "where did you get the 3 from?",
          history: [],
        },
      };
      const res = createJsonResponseRecorder();

      await handleExplainFollowupRequest(req, res);

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.fallback, true);
      assert.match(body.answer, /3/);
      assert.match(body.answer, /pinned expression|current step|coefficient/i);
    } finally {
      process.chdir(originalCwd);
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
