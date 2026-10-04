import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  checkAndReserveUsage,
  resolveSpendLimitsUsd,
} from "../server/usageLimits.js";

describe("development spend limits", () => {
  it("uses development ceilings only in explicit local modes", () => {
    const limits = resolveSpendLimitsUsd({
      NODE_ENV: "development",
      DAILY_SPEND_LIMIT_USD: "2",
      MONTHLY_SPEND_LIMIT_USD: "50",
      OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD: "20",
      OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD: "500",
    });

    assert.deepEqual(limits, { daily: 20, monthly: 500 });
    assert.deepEqual(resolveSpendLimitsUsd({
      NODE_ENV: "test",
      DAILY_SPEND_LIMIT_USD: "2",
      MONTHLY_SPEND_LIMIT_USD: "50",
      OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD: "12",
      OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD: "120",
    }), { daily: 12, monthly: 120 });
  });

  it("ignores development ceilings in production and hosted runtimes", () => {
    const configured = {
      DAILY_SPEND_LIMIT_USD: "3",
      MONTHLY_SPEND_LIMIT_USD: "60",
      OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD: "30",
      OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD: "600",
    };

    assert.deepEqual(resolveSpendLimitsUsd({ ...configured, NODE_ENV: "production" }), {
      daily: 3,
      monthly: 60,
    });
    assert.deepEqual(resolveSpendLimitsUsd({ ...configured, NODE_ENV: "development", VERCEL: "1" }), {
      daily: 3,
      monthly: 60,
    });
    assert.deepEqual(resolveSpendLimitsUsd({ ...configured, NODE_ENV: "test", VERCEL_ENV: "preview" }), {
      daily: 3,
      monthly: 60,
    });
  });

  it("ignores development ceilings when NODE_ENV is unset or unrecognized", () => {
    const configured = {
      DAILY_SPEND_LIMIT_USD: "4",
      MONTHLY_SPEND_LIMIT_USD: "80",
      OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD: "40",
      OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD: "800",
    };

    assert.deepEqual(resolveSpendLimitsUsd(configured), { daily: 4, monthly: 80 });
    assert.deepEqual(resolveSpendLimitsUsd({ ...configured, NODE_ENV: "staging" }), {
      daily: 4,
      monthly: 80,
    });
  });

  it("falls back to production ceilings for invalid development values", () => {
    const base = {
      NODE_ENV: "development",
      DAILY_SPEND_LIMIT_USD: "5",
      MONTHLY_SPEND_LIMIT_USD: "100",
    };

    for (const value of ["", "0", "-1", "not-a-number", "Infinity"]) {
      assert.deepEqual(resolveSpendLimitsUsd({
        ...base,
        OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD: value,
        OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD: value,
      }), { daily: 5, monthly: 100 });
    }
  });

  describe("reservation enforcement", () => {
    let directory;
    let originalEnv;

    beforeEach(async () => {
      originalEnv = Object.fromEntries([
        "NODE_ENV",
        "VERCEL",
        "VERCEL_ENV",
        "USAGE_LOCAL_STORE_PATH",
        "USAGE_KV_REST_API_URL",
        "USAGE_KV_REST_API_TOKEN",
        "DAILY_AI_LIMIT",
        "MONTHLY_AI_LIMIT",
        "DAILY_TOKEN_LIMIT",
        "MONTHLY_TOKEN_LIMIT",
        "DAILY_SPEND_LIMIT_USD",
        "MONTHLY_SPEND_LIMIT_USD",
        "OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD",
        "OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD",
      ].map((name) => [name, process.env[name]]));
      directory = await mkdtemp(join(tmpdir(), "omnimath-dev-spend-"));
      process.env.NODE_ENV = "test";
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      delete process.env.USAGE_KV_REST_API_URL;
      delete process.env.USAGE_KV_REST_API_TOKEN;
      process.env.USAGE_LOCAL_STORE_PATH = join(directory, "usage.json");
      process.env.DAILY_AI_LIMIT = "100";
      process.env.MONTHLY_AI_LIMIT = "100";
      process.env.DAILY_TOKEN_LIMIT = "1000000";
      process.env.MONTHLY_TOKEN_LIMIT = "1000000";
      process.env.DAILY_SPEND_LIMIT_USD = "10";
      process.env.MONTHLY_SPEND_LIMIT_USD = "100";
      process.env.OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD = "0.001";
      process.env.OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD = "1";
    });

    afterEach(async () => {
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    });

    it("enforces the local ceiling while preserving ordinary reservations", async () => {
      const identity = {
        key: "dev-spend-user",
        tier: "free",
        subject: "dev-spend-user",
        clerkUserId: "dev-spend-user",
      };
      const first = await checkAndReserveUsage({
        identity,
        kind: "explanation",
        estimatedTokens: 10,
        estimatedCostMicros: 600,
      });

      assert.equal(first.usage.globalSpend.daily.limitUsd, 0.001);
      assert.equal(first.usage.globalSpend.daily.used, 600);
      await assert.rejects(
        checkAndReserveUsage({
          identity,
          kind: "explanation",
          estimatedTokens: 10,
          estimatedCostMicros: 401,
        }),
        (error) => {
          assert.equal(error.code, "SPEND_LIMIT_EXCEEDED");
          assert.equal(error.usage.globalSpend.daily.limitUsd, 0.001);
          return true;
        },
      );
    });
  });
});
