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

async function openFixture(page, requests) {
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Solve x+1=2.");
  await expect(page.getByText(/Explanation ready/i)).toBeVisible();
  const target = page.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await expect(target).toBeVisible();
  const semanticId = await target.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  const hitbox = page.locator(`.math-semantic-hitbox[data-semantic-id="${semanticId}"]`).first();
  await expect(hitbox).toHaveAttribute("data-geometry-valid", "true");

  let previousBox = null;
  await expect.poll(async () => {
    const box = await hitbox.boundingBox();
    const stable = box && previousBox
      && Math.abs(box.x - previousBox.x) < 0.5
      && Math.abs(box.y - previousBox.y) < 0.5
      && Math.abs(box.width - previousBox.width) < 0.5
      && Math.abs(box.height - previousBox.height) < 0.5;
    previousBox = box;
    return Boolean(stable);
  }, { timeout: 5_000 }).toBe(true);

  // Re-read the hitbox each time: card layout can move after the first
  // measurement, and moving away restores mouse-enter on the next attempt.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.move(4, 4);
    const box = await hitbox.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    try {
      await expect.poll(() => requests.some((request) => request.semanticId === semanticId), { timeout: 1_200 }).toBe(true);
      return { target, hitbox };
    } catch (error) {
      if (attempt === 2) {
        const diagnosis = await page.evaluate(({ x, y, semanticId: id }) => {
          const snapshot = window.__OMNIMATH_LAST_GEOMETRY_SNAPSHOT__ || null;
          const root = document.querySelector(`[data-inspectable="math-token"]`);
          const currentRoot = root?.getBoundingClientRect();
          const snapshotRoot = snapshot?.rootRect;
          const origin = snapshot?.coordinateSpaceOrigin;
          const snapshotTarget = snapshot?.acceptedTargets?.find((item) => item.semanticId === id);
          return {
          pointer: { x, y },
          elementAtPointer: document.elementFromPoint(x, y)?.outerHTML?.slice(0, 300) || null,
          hitboxRect: (() => {
            const el = document.querySelector(`.math-semantic-hitbox[data-semantic-id="${CSS.escape(id)}"]`);
            const rect = el?.getBoundingClientRect();
            return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
          })(),
          ownerRects: [...document.querySelectorAll(`.katex-html [data-semantic-id="${CSS.escape(id)}"]`)].map((el) => {
            const rect = el.getBoundingClientRect();
            return { text: el.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
          snapshotRoot,
          currentRootRect: currentRoot ? { x: currentRoot.x, y: currentRoot.y, width: currentRoot.width, height: currentRoot.height } : null,
          snapshotTarget,
          pointerLocalAtSnapshot: snapshotRoot ? {
            x: (x - snapshotRoot.left) / (origin?.scaleX || 1) + (origin?.scrollLeft || 0),
            y: (y - snapshotRoot.top) / (origin?.scaleY || 1) + (origin?.scrollTop || 0),
          } : null,
          pointerLocalAtCurrentRoot: currentRoot ? {
            x: (x - currentRoot.left) / (currentRoot.width / (origin?.width || currentRoot.width)) + (root?.scrollLeft || 0),
            y: (y - currentRoot.top) / (currentRoot.height / (origin?.height || currentRoot.height)) + (root?.scrollTop || 0),
          } : null,
          snapshotScrollState: snapshot?.scrollState || null,
          currentScroll: { rootLeft: root?.scrollLeft || 0, rootTop: root?.scrollTop || 0, windowX: window.scrollX, windowY: window.scrollY },
          snapshotRevision: snapshot?.revision || null,
          hoverRootRect: window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.geometryRootRect || null,
          hoverSelected: window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.selected || null,
          hoverCandidateCount: window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.candidateRectCount || 0,
          hoverState: window.__OMNIMATH_HOVER_STATE__ || null,
          lifecycle: (window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || []).slice(-10),
        }; }, { x: box.x + box.width / 2, y: box.y + box.height / 2, semanticId });
        throw new Error(`${error.message}\n${JSON.stringify({ semanticId, requests, diagnosis }, null, 2)}`);
      }
    }
  }
  throw new Error(`No hover request dispatched for semantic target ${semanticId}`);
}

test("a delayed successful hover response reaches the still-valid tooltip owner", async ({ page }) => {
  const requests = await installHoverFixture(page, { delayMs: 900 });
  const { target } = await openFixture(page, requests);
  const semanticId = await target.getAttribute("data-semantic-id");
  const tooltip = page.locator(".omni-quick-tooltip");

  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  await expect(tooltip).toContainText("Delayed provider success reached the active hover owner.", { timeout: 10_000 });
  await expect(tooltip).toHaveAttribute("data-lazy-phase", "ready");
  expect(requests.length).toBeGreaterThanOrEqual(1);

  await expect.poll(async () => page.evaluate(() => {
    const events = window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || [];
    const rendered = events.find((event) => event.state === "rendered" && event.scope === "owner");
    return Boolean(rendered && events.some((event) => (
      event.state === "committed_to_ui"
      && event.ownerId === rendered.ownerId
      && event.transportRequestId === rendered.transportRequestId
    )));
  }), { timeout: 2_000 }).toBe(true);
  const lifecycle = await page.evaluate(() => {
    const events = window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || [];
    const rendered = events.find((event) => event.state === "rendered" && event.scope === "owner");
    return {
      rendered,
      committed: events.find((event) => (
        event.state === "committed_to_ui"
        && event.ownerId === rendered.ownerId
        && event.transportRequestId === rendered.transportRequestId
      )) || null,
      transportStates: events
        .filter((event) => event.scope === "transport" && event.transportRequestId === rendered.transportRequestId)
        .map((event) => event.state),
    };
  });
  expect(requests.map((request) => request.debugRequestId)).toContain(lifecycle.rendered.transportRequestId);
  expect(lifecycle.rendered.renderedTextLength).toBeGreaterThan(0);
  expect(lifecycle.committed).not.toBeNull();
  expect(lifecycle.transportStates).toEqual(["request_started", "api_parsed", "cached"]);
});

test("a parsed empty hover response receives an explicit render-input terminal outcome", async ({ page }) => {
  const requests = await installHoverFixture(page, { explanation: "   " });
  await openFixture(page, requests);
  const tooltip = page.locator(".omni-quick-tooltip");

  await expect(tooltip).toHaveAttribute("data-lazy-phase", "ready", { timeout: 10_000 });
  await expect.poll(async () => page.evaluate(() => (
    (window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || []).some((event) => (
      event.scope === "owner"
      && event.state === "render_input_empty"
      && event.terminal === true
    ))
  ))).toBe(true);

  const lifecycle = await page.evaluate(() => {
    const events = window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || [];
    const empty = events.find((event) => event.scope === "owner" && event.state === "render_input_empty");
    return {
      empty,
      transportStates: events
        .filter((event) => event.scope === "transport" && event.transportRequestId === empty.transportRequestId)
        .map((event) => event.state),
    };
  });
  expect(requests.map((request) => request.debugRequestId)).toContain(lifecycle.empty.transportRequestId);
  expect(lifecycle.empty.explanationLength).toBe(3);
  expect(lifecycle.transportStates).toEqual(["request_started", "api_parsed", "cached"]);
});

test("a hidden owner and its later successful transport both receive explicit terminal outcomes", async ({ page }) => {
  const requests = await installHoverFixture(page, { delayMs: 1_800 });
  await openFixture(page, requests);
  const tooltip = page.locator(".omni-quick-tooltip");

  await expect.poll(() => requests.length).toBe(1);
  const originalTransportId = requests[0].debugRequestId;
  await page.mouse.move(4, 4);
  await expect(tooltip).toBeHidden();

  await expect.poll(async () => page.evaluate(() => {
    const events = window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || [];
    return events.some((event) => event.scope === "transport" && event.state === "cached");
  }), { timeout: 10_000 }).toBe(true);
  expect(requests).toHaveLength(1);

  const lifecycle = await page.evaluate(() => window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || []);
  const transportStarts = lifecycle.filter((event) => event.scope === "transport" && event.state === "request_started");
  const ownerStarts = lifecycle.filter((event) => event.scope === "owner" && event.state === "request_started");
  const hidden = lifecycle.find((event) => event.scope === "owner" && event.state === "hidden_before_completion");
  const cached = lifecycle.find((event) => event.scope === "transport" && event.state === "cached");

  expect(transportStarts).toHaveLength(1);
  expect(transportStarts[0].transportRequestId).toBe(originalTransportId);
  expect(new Set(ownerStarts.map((event) => event.ownerId)).size).toBe(ownerStarts.length);
  expect(ownerStarts.length).toBeGreaterThanOrEqual(1);
  expect(ownerStarts.every((event) => event.transportRequestId === null)).toBe(true);
  expect(hidden?.terminal).toBe(true);
  expect(hidden?.transportRequestId).toBe(originalTransportId);
  expect(cached?.terminal).toBe(true);
  expect(cached?.transportRequestId).toBe(originalTransportId);
});

test("a mismatched response identity is explicitly discarded as stale", async ({ page }) => {
  const requests = await installHoverFixture(page, { responseSemanticId: "different-semantic-owner" });
  await openFixture(page, requests);
  const tooltip = page.locator(".omni-quick-tooltip");

  await expect(tooltip).toHaveAttribute("data-lazy-phase", "stale", { timeout: 1_700 });
  await expect(tooltip).not.toContainText("Delayed provider success reached the active hover owner.");
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.every((request) => request.semanticId === requests[0].semanticId)).toBe(true);

  await expect.poll(async () => page.evaluate(() => (
    (window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || []).find((event) => (
      event.scope === "owner"
      && event.state === "stale_discarded"
      && event.reason === "target-mismatch"
    )) || null
  ))).not.toBeNull();
  const stale = await page.evaluate(() => (
    (window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || []).find((event) => (
      event.scope === "owner"
      && event.state === "stale_discarded"
      && event.reason === "target-mismatch"
    )) || null
  ));
  expect(stale.terminal).toBe(true);
  expect(stale.transportRequestId).toBe(requests[0].debugRequestId);
  expect(stale.responseSemanticId).toBe("different-semantic-owner");
});

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
