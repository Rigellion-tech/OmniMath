import assert from "node:assert/strict";
import { test } from "node:test";
import { progressiveProviderEnabled } from "../server/progressiveCanaryConfig.js";

test("progressive canary requires an explicit server switch", () => {
  assert.equal(progressiveProviderEnabled({ NODE_ENV: "development" }), false);
  assert.equal(progressiveProviderEnabled({ NODE_ENV: "development", OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true" }), true);
  assert.equal(progressiveProviderEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview", OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true" }), true);
});

test("production needs a second explicit canary switch", () => {
  const deployment = { NODE_ENV: "production", VERCEL_ENV: "production", OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true" };
  assert.equal(progressiveProviderEnabled(deployment), false);
  assert.equal(progressiveProviderEnabled({ ...deployment, OMNIMATH_PROGRESSIVE_PRODUCTION_CANARY_ENABLED: "true" }), true);
  assert.equal(progressiveProviderEnabled({ NODE_ENV: "production", OMNIMATH_PROGRESSIVE_SOLVE_ENABLED: "true" }), false);
});
