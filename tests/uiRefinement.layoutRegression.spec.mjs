import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

test("dark and light themes share semantic hierarchy and persist the selected preference", async ({ page }) => {
  await page.goto("/?mockAuth=1");

  await expect(page.locator("html")).toHaveAttribute("data-omni-theme", "dark");
  const dark = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const value = (name) => styles.getPropertyValue(name).trim();
    return {
      root: value("--bg-root"),
      workspace: value("--bg-workspace"),
      sidebar: value("--bg-sidebar"),
      floating: value("--bg-floating"),
      text: value("--text-primary"),
      colorScheme: styles.colorScheme,
    };
  });
  expect(dark).toEqual({
    root: "#000000",
    workspace: "#090909",
    sidebar: "#0f0f10",
    floating: "#242424",
    text: "#f5f5f5",
    colorScheme: "dark",
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-omni-theme", "light");
  await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-omni-theme", "light");

  const light = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const value = (name) => styles.getPropertyValue(name).trim();
    return {
      root: value("--bg-root"),
      workspace: value("--bg-workspace"),
      sidebar: value("--bg-sidebar"),
      floating: value("--bg-floating"),
      text: value("--text-primary"),
      colorScheme: styles.colorScheme,
    };
  });
  expect(light).toEqual({
    root: "#f1f2f3",
    workspace: "#ffffff",
    sidebar: "#f5f5f4",
    floating: "#ffffff",
    text: "#171717",
    colorScheme: "light",
  });
});

test("native zoom uses compact chrome while keeping solution mathematics readable", async ({ page }) => {
  const solution = annotateMathExplanation({
    title: "Quadratic factorization",
    problem: "Factor x^2-5x+6.",
    expression: "x^2-5x+6",
    steps: [
      { id: "factor", label: "Find the factors", math: "x^2-5x+6=(x-2)(x-3)" },
      { id: "roots", label: "Read the roots", math: "x=2\\quad\\text{or}\\quad x=3" },
    ],
    finalAnswerLatex: "x=2,3",
  });
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...solution, usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 } }),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mockAuth=1");

  const composer = page.getByTestId("primary-math-composer");
  await expect(composer).toHaveAttribute("data-composer-state", "collapsed");
  expect((await composer.boundingBox()).height).toBeLessThanOrEqual(50);

  await submitCurrentComposer(page, "Factor x^2-5x+6.");
  await expect(page.getByRole("button", { name: "Find the factors" })).toBeVisible();
  const density = await page.locator("article[data-step-id='factor']").evaluate((step) => {
    const stepStyle = getComputedStyle(step);
    const number = step.querySelector("button[aria-label^='Select step']");
    const math = step.querySelector(".omni-solution-line");
    return {
      paddingTop: Number.parseFloat(stepStyle.paddingTop),
      paddingInline: Number.parseFloat(stepStyle.paddingLeft),
      numberSize: number?.getBoundingClientRect().width || 0,
      mathFontSize: Number.parseFloat(getComputedStyle(math).fontSize),
      stepBottom: step.getBoundingClientRect().bottom,
    };
  });
  expect(density.paddingTop).toBeLessThanOrEqual(16);
  expect(density.paddingInline).toBeLessThanOrEqual(24);
  expect(density.numberSize).toBeLessThanOrEqual(30);
  expect(density.mathFontSize).toBeGreaterThanOrEqual(22);
  expect(density.mathFontSize).toBeLessThanOrEqual(25);
  expect(density.stepBottom).toBeLessThan(900);
});

test("compact sidebar preserves search, rename, delete, rail reflow, and one solved heading", async ({ page }) => {
  const solution = annotateMathExplanation({
    title: "Stokes' Theorem Problem",
    problem: "Use Stokes' theorem for the upward-oriented paraboloid cap.",
    expression: "\\oint_C \\mathbf{F}\\cdot d\\mathbf{r}",
    steps: [{ id: "stokes", label: "Apply Stokes' theorem", math: "\\oint_C \\mathbf{F}\\cdot d\\mathbf{r}=\\iint_S (\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS" }],
    finalAnswerLatex: "\\iint_S (\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS",
  });
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...solution, usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 } }),
  }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Use Stokes' theorem for the upward-oriented paraboloid cap.");
  await expect(page.getByRole("heading", { name: "Stokes Surface Integral", exact: true })).toHaveCount(1);
  await expect(page.getByText("Problem summary", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Solved problem", { exact: true })).toHaveCount(0);

  const sidebar = page.getByTestId("session-sidebar");
  expect(Math.round((await sidebar.boundingBox()).width)).toBe(250);
  await expect(page.getByPlaceholder("Search sessions")).toHaveCount(0);
  await page.getByRole("button", { name: "Search sessions" }).click();
  await expect(page.getByPlaceholder("Search sessions")).toBeFocused();
  await page.getByPlaceholder("Search sessions").fill("Stokes");
  await expect(sidebar.getByText("Stokes Surface Integral", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close session search" }).click();

  await page.getByRole("button", { name: "Session actions for Stokes Surface Integral" }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("textbox", { name: "Rename Stokes Surface Integral" });
  await rename.fill("Vector Field Boundary");
  await rename.press("Enter");
  await expect(sidebar.getByText("Vector Field Boundary", { exact: true })).toBeVisible();

  const expandedWorkspaceWidth = await page.locator("[data-math-workspace]").evaluate((node) => node.getBoundingClientRect().width);
  await page.getByTestId("sidebar-collapse").click();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
  await expect.poll(async () => Math.round((await sidebar.boundingBox()).width)).toBe(56);
  await expect(sidebar).toBeVisible();
  await expect.poll(() => page.locator("[data-math-workspace]").evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(expandedWorkspaceWidth);
  await page.getByTestId("sidebar-expand").click();
  await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");

  await page.getByRole("button", { name: "Session actions for Vector Field Boundary" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sidebar.getByText("Vector Field Boundary", { exact: true })).toHaveCount(0);
  await expect(sidebar.locator("button[title='New session']")).toBeVisible();
});
