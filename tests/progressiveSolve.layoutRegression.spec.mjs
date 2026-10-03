import { expect, test } from "@playwright/test";
import { syntheticSolveEvents } from "./fixtures/progressiveSolve.mjs";

async function begin(page) {
  await page.goto("/?mockAuth=1&progressiveFixture=1");
  await expect.poll(() => page.evaluate(() => Boolean(window.__OMNIMATH_PROGRESSIVE_FIXTURE__))).toBe(true);
  const identity = await page.evaluate(() => window.__OMNIMATH_PROGRESSIVE_FIXTURE__.start());
  expect(identity.accepted).toBe(true);
  return identity;
}

async function dispatch(page, event) {
  return page.evaluate((nextEvent) => window.__OMNIMATH_PROGRESSIVE_FIXTURE__.dispatch(nextEvent), event);
}

function firstTarget(page) {
  return page.locator(".step-card", { has: page.getByRole("button", { name: "Solve step 1" }) })
    .locator("[data-inspectable='math-subtoken']").first();
}

test("synthetic completed steps enter the ordinary semantic renderer without invalidating earlier steps", async ({ page }, testInfo) => {
  const identity = await begin(page);
  const events = syntheticSolveEvents(identity, { stepCount: 5 });
  for (const event of events.slice(0, 3)) expect((await dispatch(page, event)).accepted).toBe(true);
  await expect(page.getByRole("button", { name: "Solve step 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Solve step 2" })).toHaveCount(0);
  const target = firstTarget(page);
  await expect(target).toBeVisible();
  const semanticId = await target.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  await expect(page.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first()).toHaveAttribute("data-geometry-valid", "true");
  await target.hover({ force: true });
  await expect(target).toHaveAttribute("data-active-target", "true");
  await page.mouse.move(4, 4);
  await expect(target).not.toHaveAttribute("data-active-target", "true");

  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });
  for (const event of events.slice(3, 5)) expect((await dispatch(page, event)).accepted).toBe(true);
  await expect(page.getByRole("button", { name: "Solve step 2" })).toBeVisible();
  await expect(target).toHaveAttribute("data-semantic-id", semanticId);
  const counters = await page.evaluate(() => ({
    hover: window.__OMNIMATH_HOVER_PERF__?.events || [],
    longTasks: window.__OMNIMATH_PERF__?.longTasks || [],
  }));
  const oldStepRenders = counters.hover.filter((entry) => entry.event === "mathChunkRender" && entry.stepId === "progressive-step-1").length;
  const newStepRenders = counters.hover.filter((entry) => entry.event === "mathChunkRender" && entry.stepId === "progressive-step-2").length;
  const oldStepGeometry = counters.hover.filter((entry) => entry.event === "geometryMeasurement" && entry.stepId === "progressive-step-1").length;
  const newStepGeometry = counters.hover.filter((entry) => entry.event === "geometryMeasurement" && entry.stepId === "progressive-step-2").length;
  const pointerReads = counters.hover.filter((entry) => entry.event === "pointerResolve").length;
  await testInfo.attach("incremental-render-metrics", {
    body: JSON.stringify({ oldStepRenders, newStepRenders, oldStepGeometry, newStepGeometry, pointerReads, longTaskCount: counters.longTasks.length }, null, 2),
    contentType: "application/json",
  });
  console.log("PROGRESSIVE_INSERT_METRICS", JSON.stringify({ oldStepRenders, newStepRenders, oldStepGeometry, newStepGeometry, pointerReads, longTaskCount: counters.longTasks.length }));
  expect(newStepRenders).toBeGreaterThan(0);
  expect(oldStepRenders).toBeLessThanOrEqual(2);
  await target.hover({ force: true });
  await expect(target).toHaveAttribute("data-active-target", "true");
  await page.mouse.move(4, 4);
  await expect(target).not.toHaveAttribute("data-active-target", "true");

  for (const event of events.slice(5)) expect((await dispatch(page, event)).accepted).toBe(true);
  await expect(page.getByRole("button", { name: "Solve step 5" })).toBeVisible();
  await expect(page.getByText("Explanation ready")).toBeVisible();
  const actual = await page.evaluate(() => {
    const fixture = window.__OMNIMATH_PROGRESSIVE_FIXTURE__;
    const state = fixture.snapshot();
    const session = fixture.sessions().find((item) => item.id === state.sessionId);
    return {
      status: state.status,
      steps: session.problem.steps.map(({ id, math, summary }) => ({ id, math, summary })),
      finalAnswerLatex: session.problem.finalAnswerLatex,
    };
  });
  const canonicalSteps = events.filter((event) => event.type === "step_completed")
    .map(({ step }) => ({ id: step.id, math: step.math, summary: step.summary }));
  expect(actual).toEqual({ status: "complete", steps: canonicalSteps, finalAnswerLatex: "x=2\\text{ or }x=3" });
});

test("failure after three steps preserves hoverable completed work and excludes the draft", async ({ page }) => {
  const identity = await begin(page);
  const events = syntheticSolveEvents(identity, { failAfter: 3 });
  for (const event of events) expect((await dispatch(page, event)).accepted).toBe(true);
  await expect(page.getByRole("button", { name: "Solve step 3" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Solve step 4" })).toHaveCount(0);
  await expect(page.getByText("Generation stopped")).toBeVisible();
  const target = firstTarget(page);
  await target.hover({ force: true });
  await expect(target).toHaveAttribute("data-active-target", "true");
  const persistedShape = await page.evaluate(() => {
    const fixture = window.__OMNIMATH_PROGRESSIVE_FIXTURE__;
    const state = fixture.snapshot();
    const session = fixture.sessions().find((item) => item.id === state.sessionId);
    return JSON.stringify(session.problem);
  });
  expect(persistedShape).not.toContain("activeStepDraft");
  expect(persistedShape).not.toContain("progressive-step-4");
});

test("session switching keeps late completed steps on their originating session", async ({ page }) => {
  const identity = await begin(page);
  const events = syntheticSolveEvents(identity);
  for (const event of events.slice(0, 3)) expect((await dispatch(page, event)).accepted).toBe(true);
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("button", { name: "Solve step 1" })).toHaveCount(0);
  for (const event of events.slice(3, 5)) expect((await dispatch(page, event)).accepted).toBe(true);
  const state = await page.evaluate((originSessionId) => {
    const sessions = window.__OMNIMATH_PROGRESSIVE_FIXTURE__.sessions();
    return {
      originSteps: sessions.find((session) => session.id === originSessionId)?.problem?.steps?.length,
      otherStepCounts: sessions.filter((session) => session.id !== originSessionId).map((session) => session.problem?.steps?.length || 0),
    };
  }, identity.sessionId);
  expect(state.originSteps).toBe(2);
  expect(state.otherStepCounts).toEqual([0]);
  await expect(page.getByRole("button", { name: "Solve step 2" })).toHaveCount(0);
});
