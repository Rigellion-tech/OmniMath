import { expect, test } from "@playwright/test";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const SOLUTION = {
  id: "hover-lifecycle-problem",
  title: "Hover lifecycle fixture",
  problem: "Solve x+1=2.",
  expression: "x+1=2",
  steps: [{
    id: "hover-lifecycle-step",
    label: "Subtract one",
    math: "x=1",
    summary: "Subtract one from both sides.",
    chunks: [{
      id: "hover-lifecycle-chunk",
      display: "x=1",
      latex: "x=1",
      text: "x=1",
      role: "equation",
      short: "Solved equation",
      medium: "The variable is isolated.",
      deep: "Subtracting one preserves equality.",
    }],
  }],
  finalAnswerLatex: "x=1",
  usage: { kind: "explanation", tier: "test", used: 1, remaining: 99, limit: 100 },
};

async function installHoverFixture(page, {
  delayMs = 0,
  responseSemanticId = null,
  explanation = "Delayed provider success reached the active hover owner.",
} = {}) {
  const requests = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{}",
  }));
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(SOLUTION),
  }));
  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Variable x",
        explanation,
        semanticId: responseSemanticId || body.semanticId,
        targetId: responseSemanticId || body.targetId,
        responseTextLength: 56,
      }),
    }).catch(() => {});
  });
  await page.route("**/api/explain-pin", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ title: "Pinned x", explanation: "Pinned explanation." }),
  }));
  return requests;
}

for (const movement of ["ancestor-transform", "preceding-layout"]) {
  test(`hover resolves the visible owner after ${movement} moves the math root`, async ({ page }) => {
    const requests = await installHoverFixture(page);
    await page.goto("/?mockAuth=1");
    await submitCurrentComposer(page, "Solve x+1=2.");
    await expect(page.getByText(/Explanation ready/i)).toBeVisible();
    const hitbox = page.locator(".math-semantic-hitbox[data-token-latex='x']").first();
    await expect(hitbox).toHaveAttribute("data-geometry-valid", "true");
    const semanticId = await hitbox.getAttribute("data-semantic-id");
    const board = page.locator(".solution-board");
    await board.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await page.setViewportSize({ width: 1439, height: 1100 });
    const before = await hitbox.boundingBox();
    if (movement === "ancestor-transform") {
      await board.evaluate((element) => {
        element.style.animation = "none";
        element.style.transform = "translateY(80px)";
      });
    } else {
      await board.evaluate((element) => {
        const spacer = document.createElement("div");
        spacer.style.height = "80px";
        element.before(spacer);
      });
    }
    const after = await hitbox.boundingBox();
    expect(after.y - before.y).toBeGreaterThan(60);
    const pointer = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
    const visibleOwnersContainPointer = await page.evaluate(({ x, y, id }) => {
      const inside = (rect) => Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      return {
        hitbox: inside(document.querySelector(`.math-semantic-hitbox[data-semantic-id="${CSS.escape(id)}"]`)?.getBoundingClientRect()),
        owner: inside(document.querySelector(`.katex-html [data-semantic-id="${CSS.escape(id)}"]`)?.getBoundingClientRect()),
      };
    }, { ...pointer, id: semanticId });
    expect(visibleOwnersContainPointer).toEqual({ hitbox: true, owner: true });
    await page.mouse.move(pointer.x, pointer.y);
    await expect.poll(() => requests.some((request) => request.semanticId === semanticId)).toBe(true);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  });
}
