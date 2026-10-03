import { expect, test } from "@playwright/test";
import { syntheticSolveEvents } from "./fixtures/progressiveSolve.mjs";

async function begin(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?mockAuth=1&progressiveFixture=1", { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => Boolean(window.__OMNIMATH_PROGRESSIVE_FIXTURE__))).toBe(true);
  const identity = await page.evaluate(() => window.__OMNIMATH_PROGRESSIVE_FIXTURE__.start());
  expect(identity.accepted).toBe(true);
  return identity;
}

async function dispatch(page, event) {
  const result = await page.evaluate((nextEvent) => window.__OMNIMATH_PROGRESSIVE_FIXTURE__.dispatch(nextEvent), event);
  expect(result.accepted, `${event.type} at sequence ${event.sequence} should be accepted`).toBe(true);
  return result;
}

function eventsFor(identity, stepCount = 12, options = {}) {
  return syntheticSolveEvents(identity, { stepCount, ...options });
}

function stepEvents(events, index) {
  const stepId = `progressive-step-${index}`;
  return events.filter((event) => event.stepId === stepId);
}

async function deliverStep(page, events, index) {
  for (const event of stepEvents(events, index)) await dispatch(page, event);
  await expect(page.getByRole("button", { name: `Solve step ${index}` })).toBeVisible();
}

async function firstSemanticTarget(page) {
  const target = page.locator(".step-card", { has: page.getByRole("button", { name: "Solve step 1" }) })
    .locator("[data-inspectable='math-subtoken']").first();
  await expect(target).toBeVisible();
  const semanticId = await target.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  const hitbox = page.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first();
  await expect(hitbox).toHaveAttribute("data-geometry-valid", "true");
  return { target, semanticId, hitbox };
}

async function deliverMetadataAndStepOne(page, identity, events) {
  await dispatch(page, events.find((event) => event.type === "solution_metadata"));
  await observeStepGeometry(page, "progressive-step-1");
  await deliverStep(page, events, 1);
  return identity;
}

async function observeStepGeometry(page, stepId) {
  await page.evaluate((targetStepId) => {
    const browser = /** @type {any} */ (window);
    browser.__progressiveHoverObservations ||= [];
    const inspect = () => {
      const step = document.querySelector(`[data-step-id="${targetStepId}"]`);
      const hitbox = step?.querySelector(".math-semantic-hitbox[data-geometry-valid='true']");
      if (!hitbox) return false;
      if (browser.__progressiveHoverObservations.some((item) => item.stepId === targetStepId)) return true;
      const entry = browser.__OMNIMATH_PROGRESSIVE_PRESENTATION__?.steps.find((item) => item.stepId === targetStepId);
      if (!entry || typeof entry.receivedAt !== "number") return false;
      browser.__progressiveHoverObservations.push({
        stepId: targetStepId,
        receivedAt: entry.receivedAt,
        hoverableAt: performance.now(),
        eventToHoverableObservedMs: performance.now() - entry.receivedAt,
        semanticId: hitbox.getAttribute("data-token-id"),
      });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (inspect()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-geometry-valid"],
    });
    if (inspect()) observer.disconnect();
  }, stepId);
}

test("accepted steps show a compact continuation state and complete in place", async ({ page }, testInfo) => {
  const identity = await begin(page);
  const events = eventsFor(identity, 2);
  await dispatch(page, events.find((event) => event.type === "solution_metadata"));
  await expect(page.locator(".omni-progressive-status")).toHaveCount(0);

  await observeStepGeometry(page, "progressive-step-1");
  await deliverStep(page, events, 1);
  const status = page.locator(".omni-progressive-status");
  await expect(status).toHaveText(/Solving next step/);
  await expect(page.locator(".omni-progressive-step")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__progressiveHoverObservations?.some((item) => item.stepId === "progressive-step-1"))).toBe(true);
  const { target, semanticId } = await firstSemanticTarget(page);
  await target.hover({ force: true });
  await expect(target).toHaveAttribute("data-active-target", "true");

  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
  });

  await observeStepGeometry(page, "progressive-step-2");
  await deliverStep(page, events, 2);
  await expect(status).toHaveText(/Solving next step/);
  await expect(page.locator(".omni-progressive-step")).toHaveCount(2);
  await expect(target).toHaveAttribute("data-semantic-id", semanticId);
  await expect(target).toHaveAttribute("data-active-target", "true");
  await expect(page.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first()).toHaveAttribute("data-geometry-valid", "true");
  const secondTarget = page.locator(".step-card", { has: page.getByRole("button", { name: "Solve step 2" }) })
    .locator("[data-inspectable='math-subtoken']").first();
  const secondSemanticId = await secondTarget.getAttribute("data-semantic-id");
  expect(secondSemanticId).toBeTruthy();
  await expect(page.locator(`.math-semantic-hitbox[data-token-id="${secondSemanticId}"]`).first()).toHaveAttribute("data-geometry-valid", "true");
  await expect.poll(() => page.evaluate(() => window.__progressiveHoverObservations?.filter((item) => ["progressive-step-1", "progressive-step-2"].includes(item.stepId)).length || 0)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_PROGRESSIVE_PRESENTATION__?.steps.filter((entry) =>
    ["progressive-step-1", "progressive-step-2"].includes(entry.stepId)
      && typeof entry.eventToHoverableMs === "number").length || 0)).toBe(2);
  const presentation = await page.evaluate(() => window.__OMNIMATH_PROGRESSIVE_PRESENTATION__?.steps || []);
  const geometryObservations = await page.evaluate(() => window.__progressiveHoverObservations || []);
  const hoverPerf = await page.evaluate(() => window.__OMNIMATH_HOVER_PERF__?.events || []);
  const oldGeometry = hoverPerf.filter((entry) => entry.event === "geometryMeasurement" && entry.stepId === "progressive-step-1").length;
  const newGeometry = hoverPerf.filter((entry) => entry.event === "geometryMeasurement" && entry.stepId === "progressive-step-2").length;
  const timing = presentation.filter((entry) => ["progressive-step-1", "progressive-step-2"].includes(entry.stepId));
  await testInfo.attach("progressive-presentation-timing", {
    body: JSON.stringify({ steps: timing, geometryObservations, oldStepGeometryMeasurements: oldGeometry, newStepGeometryMeasurements: newGeometry }, null, 2),
    contentType: "application/json",
  });
  console.log("PROGRESSIVE_PRESENTATION_TIMING", JSON.stringify({ steps: timing, geometryObservations, oldStepGeometryMeasurements: oldGeometry, newStepGeometryMeasurements: newGeometry }));
  expect(timing).toHaveLength(2);
  for (const entry of timing) {
    expect(entry.eventToVisibleMs).toEqual(expect.any(Number));
    expect(entry.eventToHoverableMs).toEqual(expect.any(Number));
    expect(entry.eventToHoverableMs).toBeGreaterThanOrEqual(0);
  }
  expect(geometryObservations).toHaveLength(2);
  for (const observation of geometryObservations) expect(observation.eventToHoverableObservedMs).toEqual(expect.any(Number));
  expect(oldGeometry).toBe(0);
  expect(newGeometry).toBeGreaterThan(0);

  for (const event of events.filter((candidate) => ["final_answer", "solve_completed"].includes(candidate.type))) {
    await dispatch(page, event);
  }
  await expect(page.getByText("Explanation ready")).toBeVisible();
  await expect(status).toHaveCount(0);
  await expect(target).toHaveAttribute("data-semantic-id", semanticId);
  await expect(page.locator(".omni-progressive-step")).toHaveCount(2);
});

test("near-bottom users follow new steps; upward scroll pauses follow and exposes Jump to latest", async ({ page }, testInfo) => {
  const identity = await begin(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  const events = eventsFor(identity, 12);
  await deliverMetadataAndStepOne(page, identity, events);
  for (let index = 2; index <= 6; index += 1) await deliverStep(page, events, index);

  await page.evaluate(() => {
    window.__progressiveScrollEvents = 0;
    window.addEventListener("scroll", () => { window.__progressiveScrollEvents += 1; }, { passive: true });
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  });
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollHeight - window.scrollY - window.innerHeight
  ))).toBeLessThanOrEqual(120);
  await expect.poll(() => page.evaluate(() => window.__progressiveScrollEvents || 0)).toBeGreaterThan(0);
  const heightBeforeFollow = await page.evaluate(() => document.documentElement.scrollHeight);
  await deliverStep(page, events, 7);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(heightBeforeFollow);
  await expect.poll(() => page.evaluate(() => {
    const latest = document.querySelector(".omni-solution-flow [data-step-id]:last-child");
    return latest ? latest.getBoundingClientRect().bottom <= window.innerHeight : false;
  })).toBe(true);
  await expect(page.locator(".omni-jump-to-latest")).toHaveCount(0);

  // A tiny upward correction can occur when dock clearance changes. It must not
  // be mistaken for deliberate user scrolling and pause the next append.
  await deliverStep(page, events, 8);
  await page.waitForTimeout(500);
  const repeatedFollowEvidence = await page.evaluate(() => {
    const latest = document.querySelector(".omni-solution-flow [data-step-id]:last-child");
    const hovered = document.querySelector("[data-pinned-lens]:hover, .omni-solution-flow [data-step-id]:hover");
    return {
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      distanceFromBottom: document.documentElement.scrollHeight - window.scrollY - window.innerHeight,
      latestBottom: latest?.getBoundingClientRect().bottom ?? null,
      latestStepId: latest?.getAttribute("data-step-id") ?? null,
      hoveredStepId: hovered?.getAttribute("data-step-id") ?? null,
      jumpVisible: Boolean(document.querySelector(".omni-jump-to-latest")),
      followDiagnostics: (window.__OMNIMATH_PERF__?.measurements || []).filter((entry) =>
        entry.name?.startsWith("progressive.follow")),
    };
  });
  await testInfo.attach("progressive-repeated-follow", {
    body: JSON.stringify(repeatedFollowEvidence, null, 2),
    contentType: "application/json",
  });
  console.log("PROGRESSIVE_REPEATED_FOLLOW", JSON.stringify(repeatedFollowEvidence));
  await expect.poll(() => page.evaluate(() => {
    const latest = document.querySelector(".omni-solution-flow [data-step-id]:last-child");
    return latest ? latest.getBoundingClientRect().bottom <= window.innerHeight : false;
  })).toBe(true);
  await expect(page.locator(".omni-jump-to-latest")).toHaveCount(0);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(4);
  await deliverStep(page, events, 9);
  await expect(page.locator(".omni-jump-to-latest")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(4);

  await page.locator(".omni-jump-to-latest").click();
  await expect.poll(() => page.evaluate(() => {
    const latest = document.querySelector(".omni-solution-flow [data-step-id]:last-child");
    return latest ? latest.getBoundingClientRect().bottom <= window.innerHeight : false;
  })).toBe(true);
  await expect(page.locator(".omni-jump-to-latest")).toHaveCount(0);
});

test("hovered and selected earlier steps pause follow; pin identity survives later insertions", async ({ page }) => {
  const identity = await begin(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  const events = eventsFor(identity, 10);
  await deliverMetadataAndStepOne(page, identity, events);
  for (let index = 2; index <= 6; index += 1) await deliverStep(page, events, index);
  const { target, semanticId } = await firstSemanticTarget(page);
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  const bottomY = await page.evaluate(() => window.scrollY);
  expect(bottomY).toBeGreaterThan(0);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(bottomY);
  await target.hover({ force: true });
  await expect(target).toHaveAttribute("data-active-target", "true");
  const readingY = await page.evaluate(() => window.scrollY);
  await deliverStep(page, events, 7);
  await expect(target).toHaveAttribute("data-active-target", "true");
  await expect(target).toHaveAttribute("data-semantic-id", semanticId);
  await expect(page.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first()).toHaveAttribute("data-geometry-valid", "true");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(readingY);

  await page.mouse.move(4, 4);
  await expect(target).not.toHaveAttribute("data-active-target", "true");
  await page.locator(".omni-jump-to-latest").click();
  await expect.poll(() => page.evaluate(() => {
    const latest = document.querySelector(".omni-solution-flow [data-step-id]:last-child");
    return latest ? latest.getBoundingClientRect().bottom <= window.innerHeight : false;
  })).toBe(true);
  await page.getByRole("button", { name: "Solve step 1" }).evaluate((button) => button.click());
  // Selecting an earlier card can change its own expanded geometry and invoke
  // browser scroll anchoring. Measure after that transition so this assertion
  // isolates whether the later progressive insertion resumes follow.
  await page.waitForTimeout(300);
  const beforeSelectionAppend = await page.evaluate(() => window.scrollY);
  await deliverStep(page, events, 8);
  await expect.poll(() => page.evaluate((expectedY) => Math.abs(window.scrollY - expectedY), beforeSelectionAppend)).toBeLessThanOrEqual(2);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(beforeSelectionAppend);
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const pinned = page.locator("[data-pinned-lens]").first();
  await expect(pinned).toBeVisible();
  const pinnedId = await pinned.getAttribute("data-pinned-lens");
  expect(pinnedId).toBeTruthy();
  await expect(pinned).toHaveAttribute("data-spawn-state", "organized");
  const pinBox = await pinned.boundingBox();
  expect(pinBox).not.toBeNull();

  await page.locator(".omni-jump-to-latest").click();
  await expect.poll(() => page.evaluate(() => {
    const latest = document.querySelector(".omni-solution-flow [data-step-id]:last-child");
    return latest ? latest.getBoundingClientRect().bottom <= window.innerHeight : false;
  })).toBe(true);
  await pinned.scrollIntoViewIfNeeded();
  const pinnedBox = await pinned.boundingBox();
  expect(pinnedBox).not.toBeNull();
  await page.mouse.click(pinnedBox.x + pinnedBox.width / 2, pinnedBox.y + pinnedBox.height / 2);
  const pinPositionBeforeInsertion = await pinned.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
  });
  const beforePinAppend = await page.evaluate(() => window.scrollY);
  await deliverStep(page, events, 9);
  await expect.poll(() => page.evaluate((expectedY) => Math.abs(window.scrollY - expectedY), beforePinAppend)).toBeLessThanOrEqual(3);
  await expect(page.locator("[data-pinned-lens]")).toHaveCount(1);
  await expect(pinned).toHaveAttribute("data-pinned-lens", pinnedId);
  const pinPositionAfter = await pinned.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + window.scrollX, y: rect.top + window.scrollY };
  });
  expect(Number.isFinite(pinPositionAfter.x) && Number.isFinite(pinPositionAfter.y)).toBe(true);
  expect(Math.abs(pinPositionAfter.x - pinPositionBeforeInsertion.x)).toBeLessThan(1);
  expect(Math.abs(pinPositionAfter.y - pinPositionBeforeInsertion.y)).toBeLessThan(1);
  await expect(target).toHaveAttribute("data-semantic-id", semanticId);
  await expect(target).not.toHaveAttribute("data-active-target", "true");
});

test("keyboard interaction with an earlier step pauses follow during later insertion", async ({ page }) => {
  const identity = await begin(page);
  const events = eventsFor(identity, 8);
  await deliverMetadataAndStepOne(page, identity, events);
  for (let index = 2; index <= 6; index += 1) await deliverStep(page, events, index);

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.scrollY - window.innerHeight)).toBeLessThanOrEqual(120);
  const stepControl = page.getByRole("button", { name: "Select step 1" });
  await stepControl.evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await expect(stepControl).toBeFocused();
  const reasoning = page.getByRole("button", { name: "Reasoning" }).first();
  await expect(reasoning).toBeVisible();
  await expect(reasoning).toHaveAttribute("aria-expanded", "true");
  await reasoning.evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press(" ");
  await expect(reasoning).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(300);
  const beforeKeyboard = await page.evaluate(() => window.scrollY);

  await deliverStep(page, events, 7);
  await expect.poll(() => page.evaluate((expectedY) => Math.abs(window.scrollY - expectedY), beforeKeyboard)).toBeLessThanOrEqual(2);
});

test("partial failure keeps accepted steps usable without a continuation state", async ({ page }) => {
  const failedIdentity = await begin(page);
  const failedEvents = eventsFor(failedIdentity, 5, { failAfter: 3 });
  for (const event of failedEvents) await dispatch(page, event);
  await expect(page.getByRole("button", { name: "Solve step 3" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Solve step 4" })).toHaveCount(0);
  await expect(page.getByText("Generation stopped before finishing")).toBeVisible();
  await expect(page.locator(".omni-progressive-status")).toHaveCount(1);
  await expect(page.locator(".omni-progressive-status")).not.toContainText("Solving next step");
  const failedTarget = await firstSemanticTarget(page);
  await failedTarget.target.hover({ force: true });
  await expect(failedTarget.target).toHaveAttribute("data-active-target", "true");
});

test("cancellation keeps accepted steps usable without a continuation state", async ({ page }) => {
  const cancelledIdentity = await begin(page);
  const cancelledEvents = eventsFor(cancelledIdentity, 4);
  await deliverMetadataAndStepOne(page, cancelledIdentity, cancelledEvents);
  const state = await page.evaluate(() => window.__OMNIMATH_PROGRESSIVE_FIXTURE__.snapshot());
  await dispatch(page, {
    requestId: state.requestId,
    attemptId: state.attemptId,
    sessionId: state.sessionId,
    conversationId: state.conversationId,
    sequence: state.lastSequence + 1,
    type: "solve_cancelled",
  });
  await expect(page.getByText("Generation cancelled. 1 completed step remains available.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Solve step 1" })).toBeVisible();
  await expect(page.locator(".omni-progressive-status")).not.toContainText("Solving next step");
  const cancelledTarget = await firstSemanticTarget(page);
  await cancelledTarget.target.hover({ force: true });
  await expect(cancelledTarget.target).toHaveAttribute("data-active-target", "true");
});

test("reduced motion removes arrival and pulse animations while preserving insertion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const identity = await begin(page);
  const events = eventsFor(identity, 2);
  await deliverMetadataAndStepOne(page, identity, events);
  const firstCard = page.locator(".omni-progressive-step").first();
  await expect(firstCard).toBeVisible();
  await expect.poll(() => firstCard.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await expect.poll(() => page.locator(".omni-progressive-status-dot").evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await deliverStep(page, events, 2);
  await expect(page.locator(".omni-progressive-step")).toHaveCount(2);
});
