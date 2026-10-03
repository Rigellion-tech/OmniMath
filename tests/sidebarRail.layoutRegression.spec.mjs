import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const PROBLEM = "Factor x^2-5x+6.";

async function openSolvedWorkspace(page) {
  const solution = annotateMathExplanation({
    title: "Quadratic factorization",
    problem: PROBLEM,
    originalProblem: PROBLEM,
    expression: "x^2-5x+6",
    steps: [{
      id: "rail-factor",
      label: "Find the factors",
      math: "x^2-5x+6=(x-2)(x-3)",
      summary: "Find two numbers with product six and sum negative five.",
    }],
    finalAnswerLatex: "(x-2)(x-3)",
  });
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...solution,
      usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
    }),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, PROBLEM);
  await expect(page.getByRole("button", { name: "Find the factors" })).toBeVisible();
}

test("collapsed sidebar is a functional, accessible icon rail", async ({ page }) => {
  await openSolvedWorkspace(page);
  const sidebar = page.getByTestId("session-sidebar");
  const workspace = page.locator("[data-math-workspace]");
  const expandedWidth = await workspace.evaluate((node) => node.getBoundingClientRect().width);

  await page.getByTestId("sidebar-collapse").click();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
  await expect.poll(async () => Math.round((await sidebar.boundingBox()).width)).toBe(56);
  await expect.poll(() => workspace.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(expandedWidth);

  const top = page.getByTestId("collapsed-sidebar-actions");
  const bottom = page.getByTestId("collapsed-sidebar-navigation");
  const controls = [
    sidebar.getByRole("button", { name: "Expand sidebar" }),
    top.getByRole("button", { name: "New session" }),
    top.getByRole("button", { name: "Search" }),
    bottom.getByRole("link", { name: "History" }),
    bottom.getByRole("link", { name: "Profile" }),
    bottom.getByRole("button", { name: "Settings" }),
    bottom.getByRole("link", { name: "Account" }),
    bottom.getByRole("button", { name: "Sign out" }),
  ];
  for (const control of controls) {
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("title", /\S+/);
    const box = await control.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(32);
  }
  await expect(sidebar.getByText("Quadratic factorization", { exact: true })).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "New session" })).toHaveCount(1);
  await expect(sidebar.getByRole("button", { name: "Settings" })).toHaveCount(1);

  const search = top.getByRole("button", { name: "Search" });
  await search.hover();
  await expect.poll(() => search.evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("1");
  expect(await search.evaluate((node) => getComputedStyle(node, "::after").content)).toContain("Search");
  await search.click();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
  await expect(page.getByPlaceholder("Search sessions")).toBeFocused();
  await expect(sidebar.getByText("Quadratic factorization", { exact: true })).toBeVisible();

  await page.getByTestId("sidebar-collapse").click();
  await bottom.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();

  await top.getByRole("button", { name: "New session" }).click();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
  await page.getByTestId("sidebar-expand").click();
  await expect(sidebar.getByText("Quadratic factorization", { exact: true })).toBeVisible();
  await expect.poll(() => sidebar.locator(".omni-scrollbar button").count()).toBeGreaterThanOrEqual(2);

  await page.getByTestId("sidebar-collapse").click();
  await bottom.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
  await bottom.getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.goBack();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
  await bottom.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("rail stays centered and reachable across desktop widths and zoom levels", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?mockAuth=1");
  await page.getByTestId("sidebar-collapse").click();
  const sidebar = page.getByTestId("session-sidebar");
  const railControls = sidebar.locator(".omni-rail-control:visible");

  for (const zoom of [0.75, 1, 1.25]) {
    await page.evaluate((value) => { document.documentElement.style.zoom = String(value); }, zoom);
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
    await expect(railControls.first()).toBeVisible();
    const geometry = await page.evaluate(() => {
      const rail = document.querySelector("[data-testid='session-sidebar']");
      const buttons = [...rail.querySelectorAll(".omni-rail-control")]
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { center: rect.left + rect.width / 2, bottom: rect.bottom };
        });
      const railRect = rail.getBoundingClientRect();
      return {
        railCenter: railRect.left + railRect.width / 2,
        controls: buttons,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    for (const control of geometry.controls) {
      expect(Math.abs(control.center - geometry.railCenter)).toBeLessThanOrEqual(1);
      expect(control.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    }
  }

  await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  for (const width of [1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
    await expect(sidebar.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  }

  const workspace = page.locator("[data-math-workspace]");
  let previousWidth = await workspace.evaluate((node) => node.getBoundingClientRect().width);
  for (let index = 0; index < 3; index += 1) {
    await page.getByTestId("sidebar-expand").click();
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    await expect.poll(() => workspace.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(previousWidth);
    previousWidth = await workspace.evaluate((node) => node.getBoundingClientRect().width);
    await page.getByTestId("sidebar-collapse").click();
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
    await expect.poll(() => workspace.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(previousWidth);
    previousWidth = await workspace.evaluate((node) => node.getBoundingClientRect().width);
  }
});
