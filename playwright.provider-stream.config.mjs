import { defineConfig } from "@playwright/test";

const WEB_PORT = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_WEB_PORT || 4390);
const API_PORT = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_API_PORT || 4391);
const PROVIDER_PORT = Number(process.env.OMNIMATH_PROVIDER_FIXTURE_PORT || 4392);
const executablePath = process.env.OMNIMATH_E2E_BROWSER_PATH || undefined;

export default defineConfig({
  testDir: "./tests",
  testMatch: "progressiveProviderStreaming.layoutRegression.spec.mjs",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "test-artifacts/provider-stream-playwright-results",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: "node tests/fixtures/runProgressiveProviderStack.mjs",
    url: `http://127.0.0.1:${WEB_PORT}/?mockAuth=1`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      OMNIMATH_PROVIDER_FIXTURE_WEB_PORT: String(WEB_PORT),
      OMNIMATH_PROVIDER_FIXTURE_API_PORT: String(API_PORT),
      OMNIMATH_PROVIDER_FIXTURE_PORT: String(PROVIDER_PORT),
    },
  },
});
