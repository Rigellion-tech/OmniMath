import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  checkAndReserveUsage,
  releaseTokenReservation,
  settleTokenUsage,
} from "../server/usageLimits.js";
import { captureFailedSolveDiagnostic } from "../server/failedSolveDiagnostics.js";

const identity = {
  key: "unknown-usage-test-user",
  tier: "free",
  subject: "unknown-usage-test-user",
  clerkUserId: "unknown-usage-test-user",
};

describe("solve settlement with unknown provider usage", () => {
  let directory;
  let originalEnv;

  beforeEach(async () => {
    originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      USAGE_LOCAL_STORE_PATH: process.env.USAGE_LOCAL_STORE_PATH,
      USAGE_KV_REST_API_URL: process.env.USAGE_KV_REST_API_URL,
      USAGE_KV_REST_API_TOKEN: process.env.USAGE_KV_REST_API_TOKEN,
      DAILY_TOKEN_LIMIT: process.env.DAILY_TOKEN_LIMIT,
      MONTHLY_TOKEN_LIMIT: process.env.MONTHLY_TOKEN_LIMIT,
      DAILY_SPEND_LIMIT_USD: process.env.DAILY_SPEND_LIMIT_USD,
      MONTHLY_SPEND_LIMIT_USD: process.env.MONTHLY_SPEND_LIMIT_USD,
      OMNIMATH_CAPTURE_FAILED_SOLVES: process.env.OMNIMATH_CAPTURE_FAILED_SOLVES,
    };
    directory = await mkdtemp(join(tmpdir(), "omnimath-unknown-usage-"));
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL;
    delete process.env.USAGE_KV_REST_API_URL;
    delete process.env.USAGE_KV_REST_API_TOKEN;
    process.env.USAGE_LOCAL_STORE_PATH = join(directory, "usage.json");
    process.env.DAILY_TOKEN_LIMIT = "1000000";
    process.env.MONTHLY_TOKEN_LIMIT = "1000000";
    process.env.DAILY_SPEND_LIMIT_USD = "100";
    process.env.MONTHLY_SPEND_LIMIT_USD = "100";
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function reserve(estimatedTokens, estimatedCostMicros) {
    return checkAndReserveUsage({
      identity,
      kind: "solve",
      estimatedTokens,
      estimatedCostMicros,
    });
  }

  it("retains token and spend reservations when a dispatched solve aborts before usage is reported", async () => {
    const { reservation } = await reserve(1200, 4500);
    const providerAttempts = [{
      correlationId: "solve:req-1:attempt-1",
      model: "gpt-test",
      dispatchedAt: "2026-10-01T12:00:00.000Z",
      abortedAt: "2026-10-01T12:00:03.000Z",
      timeoutSource: "request_deadline",
    }];

    const usage = await settleTokenUsage(reservation, 0, 0, {
      providerCalls: 1,
      providerDispatched: true,
      providerAttempts,
      usageStatus: "unknown_due_to_abort",
      settlementReason: "cancelled",
    });

    assert.equal(usage.tokens.daily.used, 1200);
    assert.equal(usage.globalTokens.daily.used, 1200);
    assert.equal(usage.globalSpend.daily.used, 4500);
    assert.equal(usage.settlement.actualTotalTokens, null);
    assert.equal(usage.settlement.actualCostMicros, null);
    assert.equal(usage.settlement.settledTokens, 1200);
    assert.equal(usage.settlement.settledCostMicros, 4500);
    assert.equal(usage.settlement.releasedTokens, 0);
    assert.equal(usage.settlement.releasedCostMicros, 0);
    assert.equal(usage.settlement.costStatus, "unreconciled");
    assert.equal(usage.settlement.providerCalls, 1);
    assert.equal(usage.settlement.providerDispatched, true);
    assert.deepEqual(usage.settlement.providerAttempts, providerAttempts);
    assert.equal(usage.settlement.settlementReason, "cancelled");
  });

  it("raises the conservative hold to known partially observed usage without reporting it as aggregate actual usage", async () => {
    const { reservation } = await reserve(100, 250);

    const usage = await settleTokenUsage(reservation, 175, 400, {
      actualInputTokens: 125,
      actualOutputTokens: 50,
      actualReasoningTokens: 20,
      providerCalls: 1,
      providerDispatched: true,
      usageStatus: "partially_observed",
      settlementReason: "failure-before-provider",
    });

    assert.equal(usage.tokens.daily.used, 175);
    assert.equal(usage.globalSpend.daily.used, 400);
    assert.equal(usage.settlement.actualInputTokens, null);
    assert.equal(usage.settlement.actualOutputTokens, null);
    assert.equal(usage.settlement.actualReasoningTokens, null);
    assert.equal(usage.settlement.actualTotalTokens, null);
    assert.equal(usage.settlement.observedInputTokens, 125);
    assert.equal(usage.settlement.observedOutputTokens, 50);
    assert.equal(usage.settlement.observedReasoningTokens, 20);
    assert.equal(usage.settlement.observedTotalTokens, 175);
    assert.equal(usage.settlement.observedCostMicros, 400);
    assert.equal(usage.settlement.settledTokens, 175);
    assert.equal(usage.settlement.releasedTokens, 0);
    assert.equal(usage.settlement.settlementReason, "failure");
  });

  it("still releases a reservation as zero when failure occurs before provider dispatch", async () => {
    const { reservation } = await reserve(900, 3000);

    const usage = await releaseTokenReservation(reservation, {
      providerCalls: 0,
      settlementReason: "failure-before-provider",
    });

    assert.equal(usage.used, 0);
    assert.equal(usage.tokens.daily.used, 0);
    assert.equal(usage.globalTokens.daily.used, 0);
    assert.equal(usage.globalSpend.daily.used, 0);
    assert.equal(usage.settlement.actualTotalTokens, 0);
    assert.equal(usage.settlement.actualCostMicros, 0);
    assert.equal(usage.settlement.settledTokens, 0);
    assert.equal(usage.settlement.releasedTokens, 900);
    assert.equal(usage.settlement.providerCalls, 0);
    assert.equal(usage.settlement.providerDispatched, false);
    assert.equal(usage.settlement.settlementReason, "failure-before-provider");
  });

  it("records partial usage and dispatched attempt metadata in failed-solve diagnostics", async () => {
    const originalCwd = process.cwd();
    process.env.OMNIMATH_CAPTURE_FAILED_SOLVES = "1";
    process.chdir(directory);
    try {
      const error = Object.assign(new Error("second attempt aborted"), {
        _aiCallCount: 2,
        _aiUsage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
        },
        _omniOpenAiDiagnostics: {
          providerAttempts: [
            {
              correlationId: "req-2:attempt-1",
              model: "gpt-test",
              dispatchAt: "2026-10-01T12:00:00.000Z",
              usageStatus: "observed",
            },
            {
              correlationId: "req-2:attempt-2",
              model: "gpt-test",
              dispatchAt: "2026-10-01T12:00:02.000Z",
              abortAt: "2026-10-01T12:00:05.000Z",
              timeoutSource: "provider_attempt_timeout",
              usageStatus: "unknown_due_to_abort",
            },
          ],
        },
      });

      const path = await captureFailedSolveDiagnostic({
        requestId: "unknown-usage-diagnostic",
        endpoint: "/api/solve-extracted-problem",
        stage: "initial",
        error,
      });
      const artifact = JSON.parse(await readFile(path, "utf8"));
      const settlement = artifact.metadata.usageSettlement;

      assert.equal(settlement.usageStatus, "partially_observed");
      assert.equal(settlement.providerDispatched, true);
      assert.equal(settlement.providerCalls, 2);
      assert.equal(settlement.actualTotalTokens, null);
      assert.equal(settlement.observedTotalTokens, 30);
      assert.equal(settlement.costStatus, "unreconciled");
      assert.equal(settlement.providerAttempts[1].correlationId, "req-2:attempt-2");
      assert.equal(settlement.providerAttempts[1].abortAt, "2026-10-01T12:00:05.000Z");
      assert.equal(settlement.providerAttempts[1].timeoutSource, "provider_attempt_timeout");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
