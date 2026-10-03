import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const EXPRESSION = "a+b+c=6";

async function openPinnedFixture(page) {
  const solution = annotateMathExplanation({
    title: "Three inspectable terms",
    problem: `Explain ${EXPRESSION}.`,
    originalProblem: `Explain ${EXPRESSION}.`,
    expression: EXPRESSION,
    steps: [{
      id: "pin-stack-step",
      label: "Inspect each term",
      math: EXPRESSION,
      summary: "Each term contributes to the sum.",
    }],
    finalAnswerLatex: EXPRESSION,
  });
  const requests = [];
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...solution, usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 } }),
  }));
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint, body });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Term ${body.selectedLatex}`,
          explanation: `Explanation for ${body.selectedLatex} in the current equation.`,
          semanticId: body.semanticId,
          targetId: body.targetId,
        }),
      });
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, `Explain ${EXPRESSION}.`);
  await expect(page.getByRole("button", { name: /Inspect each term/i })).toBeVisible();
  return requests;
}

async function targetFor(page, symbol) {
  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Inspect each term/i }) });
  const target = step.locator(`[data-inspectable='math-subtoken'][data-token-latex='${symbol}']`).first();
  await expect(target).toBeVisible();
  const semanticId = await target.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  await expect(step.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first()).toHaveAttribute("data-geometry-valid", "true");
  return { target, semanticId };
}

async function pin(page, symbol) {
  const { target, semanticId } = await targetFor(page, symbol);
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const card = page.locator(`.omni-floating-window[data-semantic-id="${semanticId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(`Explanation for ${symbol}`);
  await expect(card).toHaveAttribute("data-spawn-state", "organized");
  return { card, semanticId };
}

async function boxesDoNotOverlap(cards) {
  await expect.poll(async () => {
    const boxes = await Promise.all(cards.map((card) => card.boundingBox()));
    if (boxes.some((box) => !box)) return Number.POSITIVE_INFINITY;
    let maximumOverlap = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        maximumOverlap = Math.max(maximumOverlap, overlapWidth * overlapHeight);
      }
    }
    return maximumOverlap;
  }).toBe(0);
  return Promise.all(cards.map((card) => card.boundingBox()));
}

test("pinned cards use compact controls and stack without losing semantic identities", async ({ page }) => {
  const requests = await openPinnedFixture(page);
  const cards = [];
  const ids = [];
  for (const symbol of ["a", "b", "c"]) {
    const { card, semanticId } = await pin(page, symbol);
    cards.push(card);
    ids.push(semanticId);
    await expect(card).toHaveAttribute("data-placement-mode", "stacked");
  }
  expect(new Set(ids).size).toBe(3);
  await expect(page.locator(".omni-floating-window")).toHaveCount(3);
  const boxes = await boxesDoNotOverlap(cards);
  expect(boxes[0].y).toBeLessThan(boxes[1].y);
  expect(boxes[1].y).toBeLessThan(boxes[2].y);
  await expect(cards[0].locator("select")).toHaveCount(1);
  await expect(cards[0].getByRole("button", { name: "Ask follow-up" })).toBeVisible();
  await expect(cards[0].getByPlaceholder("Ask about this")).toBeVisible();
  await expect(cards[0].locator(".omni-math-block")).toHaveCount(0);
  expect(requests.filter(({ endpoint }) => endpoint === "explain-pin").map(({ body }) => body.semanticId))
    .toEqual(ids);
});

test("an automatically placed lens stays in its canvas and clears the source term", async ({ page }) => {
  await openPinnedFixture(page);
  const { target, semanticId } = await targetFor(page, "c");
  const targetBox = await target.boundingBox();
  const canvas = page.locator("[data-lens-canvas]");
  const canvasBox = await canvas.boundingBox();
  expect(targetBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();

  await page.mouse.click(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { button: "right" }
  );
  const card = page.locator(`.omni-floating-window[data-semantic-id="${semanticId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-placement-mode", "stacked");
  await expect(card).toHaveAttribute("data-spawn-state", "organized");
  await expect(card).toHaveAttribute("data-coordinate-space", "canvas-v1");
  const localBox = await card.boundingBox();
  expect(localBox).not.toBeNull();
  expect(localBox.x).toBeGreaterThanOrEqual(canvasBox.x);
  expect(localBox.x + localBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
  const overlapWidth = Math.max(0, Math.min(localBox.x + localBox.width, targetBox.x + targetBox.width) - Math.max(localBox.x, targetBox.x));
  const overlapHeight = Math.max(0, Math.min(localBox.y + localBox.height, targetBox.y + targetBox.height) - Math.max(localBox.y, targetBox.y));
  expect(overlapWidth * overlapHeight).toBe(0);

  await expect(card).toHaveAttribute("data-spawn-state", "organized");
  const organizedBox = await card.boundingBox();
  expect(organizedBox).not.toBeNull();
  expect(organizedBox.x + organizedBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
});

test("collapsing a stacked card reflows neighbors and preserves explanation and detail", async ({ page }) => {
  await openPinnedFixture(page);
  const cards = [];
  for (const symbol of ["a", "b", "c"]) cards.push((await pin(page, symbol)).card);
  await cards[1].locator("select").selectOption("detailed");
  const before = await cards[2].boundingBox();
  await cards[1].getByRole("button", { name: "Collapse explanation" }).click();
  await expect(cards[1]).toHaveAttribute("data-collapsed", "true");
  await expect(cards[1].getByText("Explanation for b")).toBeHidden();
  await expect.poll(async () => (await cards[2].boundingBox()).y).toBeLessThan(before.y);
  await boxesDoNotOverlap(cards);
  await cards[1].getByRole("button", { name: "Expand explanation" }).click();
  await expect(cards[1]).toContainText("Explanation for b");
  await expect(cards[1].locator("select")).toHaveValue("detailed");
  await boxesDoNotOverlap(cards);
});

test("dragging a card makes it manual while the stack and uncovered math remain interactive", async ({ page }) => {
  const requests = await openPinnedFixture(page);
  const first = (await pin(page, "a")).card;
  const second = (await pin(page, "b")).card;
  const handle = first.locator("[data-pinned-drag-handle]");
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  const start = { x: handleBox.x + 18, y: handleBox.y + handleBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 250, start.y + 250, { steps: 8 });
  await page.mouse.up();
  await expect(first).toHaveAttribute("data-placement-mode", "manual");
  const manualBox = await first.boundingBox();
  await second.getByRole("button", { name: "Collapse explanation" }).click();
  await pin(page, "c");
  await expect.poll(async () => {
    const box = await first.boundingBox();
    return Math.abs(box.x - manualBox.x) + Math.abs(box.y - manualBox.y);
  }).toBeLessThan(2);
  await expect(second).toHaveAttribute("data-placement-mode", "stacked");
  await expect(first.getByRole("button", { name: "Expand explanation" })).toHaveCount(0);

  const { target, semanticId } = await targetFor(page, "c");
  const targetBox = await target.boundingBox();
  await page.mouse.move(2, 2);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  await expect.poll(() => requests.some(({ endpoint, body }) => endpoint === "explain-token" && body.semanticId === semanticId)).toBe(true);
});

test("sidebar and viewport changes retain pinned identities and fresh semantic hover geometry", async ({ page }, testInfo) => {
  await openPinnedFixture(page);
  const ids = [];
  for (const symbol of ["a", "b"]) ids.push((await pin(page, symbol)).semanticId);
  const cards = ids.map((id) => page.locator(`.omni-floating-window[data-semantic-id="${id}"]`));
  const { target, semanticId } = await targetFor(page, "c");
  const workspace = page.locator("[data-math-workspace]");
  let workspaceWidth = await workspace.evaluate((node) => node.getBoundingClientRect().width);
  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });
  const assertFreshHover = async () => {
    await expect(target).toHaveAttribute("data-geometry-valid", "true");
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(2, 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
    await page.mouse.move(2, 2);
    await expect(target).not.toHaveAttribute("data-active-target", "true");
    await expect(page.locator(".omni-quick-tooltip")).toHaveCount(0);
  };
  let reflowRevisionCount = 0;
  for (const [control, state] of [["sidebar-collapse", "collapsed"], ["sidebar-expand", "expanded"]]) {
    await page.getByTestId(control).click();
    await expect(page.getByTestId("session-sidebar")).toHaveAttribute("data-sidebar-state", state);
    await expect.poll(async () => workspace.evaluate((node) => node.getBoundingClientRect().width)).not.toBe(workspaceWidth);
    workspaceWidth = await workspace.evaluate((node) => node.getBoundingClientRect().width);
    for (const card of cards) await expect(card).toBeVisible();
    await boxesDoNotOverlap(cards);
    await assertFreshHover();
    await expect.poll(() => page.evaluate(() => (
      window.__OMNIMATH_HOVER_PERF__?.counters?.geometryReflowRevision || 0
    ))).toBeGreaterThan(reflowRevisionCount);
    reflowRevisionCount = await page.evaluate(() => (
      window.__OMNIMATH_HOVER_PERF__?.counters?.geometryReflowRevision || 0
    ));
  }
  const sidebarReflowMetrics = await page.evaluate(() => ({
    hover: window.__OMNIMATH_HOVER_PERF__?.counters || {},
    resizeObserverCallbacks: (window.__OMNIMATH_PERF__?.measurements || [])
      .filter((entry) => entry.name === "semantic.geometry.resize-observer-callback").length,
  }));
  await testInfo.attach("sidebar-reflow-metrics", {
    body: JSON.stringify(sidebarReflowMetrics, null, 2),
    contentType: "application/json",
  });
  console.log("OMNIMATH_SIDEBAR_REFLOW_METRICS", JSON.stringify(sidebarReflowMetrics));
  expect(sidebarReflowMetrics.hover.geometryReflowRevision || 0).toBeGreaterThanOrEqual(2);
  expect(sidebarReflowMetrics.hover.geometryMeasurement || 0).toBeLessThanOrEqual(1);
  // Two 200 ms sidebar width transitions emit several lightweight observer
  // callbacks. Geometry must translate in place and avoid reconstruction.
  expect(sidebarReflowMetrics.resizeObserverCallbacks).toBeLessThanOrEqual(20);
  await page.setViewportSize({ width: 1050, height: 700 });
  await boxesDoNotOverlap(cards);
  await assertFreshHover();
});

test("session switching restores pinned identity without replaying target-local birth geometry", async ({ page }) => {
  await openPinnedFixture(page);
  const { card, semanticId } = await pin(page, "a");
  await expect(card).toHaveAttribute("data-spawn-state", "organized");

  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.locator(".omni-floating-window")).toHaveCount(0);

  const sidebar = page.getByTestId("session-sidebar");
  await sidebar.getByRole("button", { name: "Three inspectable terms", exact: true }).click();
  const restored = page.locator(`.omni-floating-window[data-semantic-id="${semanticId}"]`);
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute("data-placement-mode", "stacked");
  await expect(restored).toHaveAttribute("data-spawn-state", "organized");
  await expect(restored).toContainText("Explanation for a");
});

test("narrow viewport keeps three pinned cards separate and reachable by scrolling", async ({ page }) => {
  await openPinnedFixture(page);
  const cards = [];
  for (const symbol of ["a", "b", "c"]) cards.push((await pin(page, symbol)).card);
  await page.setViewportSize({ width: 480, height: 700 });
  await expect.poll(async () => {
    const current = await Promise.all(cards.map((card) => card.boundingBox()));
    return current.every((box) => box && box.x >= 0 && box.x + box.width <= 480);
  }).toBe(true);
  const boxes = await boxesDoNotOverlap(cards);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(480);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(700);
  await cards[2].scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const visibleLast = await cards[2].boundingBox();
  expect(visibleLast.y).toBeGreaterThanOrEqual(0);
  expect(visibleLast.y + visibleLast.height).toBeLessThanOrEqual(700);
  await cards[1].getByRole("button", { name: "Ask follow-up" }).click();
  await expect(cards[1].getByPlaceholder("Ask about this")).toBeVisible();
  await cards[1].getByPlaceholder("Ask about this").click();
  await boxesDoNotOverlap(cards);
  await cards[0].getByRole("button", { name: "Collapse explanation" }).click();
  await boxesDoNotOverlap(cards);
  await cards[2].getByRole("button", { name: "Close explanation" }).click();
  await expect(cards[2]).toHaveCount(0);
});
