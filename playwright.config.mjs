import { defineConfig } from "@playwright/test";

const PORT = 4175;
const executablePath = process.env.OMNIMATH_E2E_BROWSER_PATH || undefined;

export default defineConfig({
  testDir: "./tests",
  testMatch: /layoutRegression\.spec\.mjs/,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: "test-artifacts/playwright-results",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 1100 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: `npm run dev:client -- --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/?mockAuth=1`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_DISABLE_AUTH: "true",
      VITE_SEMANTIC_MATH_AST: "true",
      VITE_DEBUG_MATH_HOVER: process.env.VITE_DEBUG_MATH_HOVER || "0",
      DEV_API_TARGET: "http://127.0.0.1:65535",
    },
  },
});
