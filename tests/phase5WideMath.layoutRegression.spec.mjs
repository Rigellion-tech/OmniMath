import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { normalizeProviderSolveCandidate } from "../server/openai.js";
import { finalizeSolveCandidate } from "../server/solveCandidateLifecycle.js";
import { makePhase5KktFixture, makePhase5WideMatrixFixture, phase5KktProblem } from "./fixtures/phase5FinalAnswer.mjs";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

async function showFixture(page, fixture, { duplicatedContentControl = false } = {}) {
  const solution = annotateMathExplanation(finalizeSolveCandidate(normalizeProviderSolveCandidate(fixture, {
    originalProblem: phase5KktProblem,
  }), { requestId: "phase5-layout", candidateId: "phase5-layout-candidate" }));
  if (duplicatedContentControl) {
    // Diagnostic control: same accepted math/renderers, but treat the repeated
    // source block as derivation to measure its cost on the current layout.
    // This is not a recreation of pre-Phase-5 browser CSS or provider behavior.
    solution.finalAnswer = "";
    solution.finalAnswerLatex = "";
    solution.steps.at(-1).label = "Repeated supplied derivation";
    solution.steps.at(-1).title = "Repeated supplied derivation";
  }
  await page.route("**/api/explain", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    ...solution, usage: { tier: "test", kind: "explanation", remaining: 99, limit: 100 },
  }) }));
  await page.route("**/api/explain-token", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    title: "Selected expression", explanation: "Inspect this mathematical result.",
  }) }));
  await page.goto("/?mockAuth=1");
  await page.evaluate(() => {
    window.__OMNIMATH_PERF__?.reset();
    window.__OMNIMATH_HOVER_PERF__?.reset();
  });
  const submittedAt = await page.evaluate(() => performance.now());
  await submitCurrentComposer(page, phase5KktProblem);
  await expect(page.locator(".omni-solution-flow .step-card").first()).toBeVisible();
  return submittedAt;
}

async function observeReadyMath(page, submittedAt) {
  await expect(page.locator(".omni-solution-flow [data-semantic-render-ready='false']")).toHaveCount(0);
  await expect.poll(() => page.locator(".omni-solution-flow [data-inspectable='math-subtoken']").count()).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_GEOMETRY_SCHEDULER__?.pending || 0)).toBe(0);
  return page.evaluate((started) => ({
    sourceTreeNodes: [...document.querySelectorAll(".omni-solution-flow [data-semantic-node-count]")]
      .reduce((sum, node) => sum + Number(node.getAttribute("data-semantic-node-count")), 0),
    annotatedDomOwners: document.querySelectorAll(".omni-solution-flow .katex-html [data-semantic-id]").length,
    repeatedBlockNodes: [...document.querySelectorAll("article[data-step-id='final-answer'] [data-semantic-node-count]")]
      .reduce((sum, node) => sum + Number(node.getAttribute("data-semantic-node-count")), 0),
    geometryCounters: window.__OMNIMATH_HOVER_PERF__?.counters,
    longTasks: window.__OMNIMATH_PERF__?.longTasks,
    submitToReadySampleMs: performance.now() - started,
  }), submittedAt);
}

async function assertLocalOverflow(page) {
  const overflow = await page.locator(".omni-solution-flow").evaluate((flow) => {
    const extent = (element) => element.scrollWidth - element.clientWidth;
    return {
      page: extent(document.documentElement),
      flow: extent(flow),
      cards: [...flow.querySelectorAll(".step-card")].map(extent),
      text: [...flow.querySelectorAll("p")].map(extent),
      local: [...flow.querySelectorAll(".omni-expression-scroll")].filter((node) => extent(node) > 20).map((node) => ({
        extent: extent(node),
        ancestorScroller: [...(function* () { for (let parent = node.parentElement; parent && parent !== flow; parent = parent.parentElement) yield parent; })()]
          .some((parent) => /auto|scroll/.test(getComputedStyle(parent).overflowX) && extent(parent) > 1),
      })),
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(2);
  expect(overflow.flow).toBeLessThanOrEqual(2);
  expect(overflow.cards.every((value) => value <= 2)).toBe(true);
  expect(overflow.text.every((value) => value <= 2)).toBe(true);
  expect(overflow.local.length).toBeGreaterThan(0);
  expect(overflow.local.every((value) => !value.ancestorScroller)).toBe(true);
}

test("KKT presentation removes duplicated final derivation and keeps Newton system overflow local", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const started = Date.now();
  await showFixture(page, makePhase5KktFixture());
  await expect(page.locator(".final-answer-step .mtable")).toHaveCount(0);
  await expect(page.locator(".omni-solution-flow article[data-step-id='newton-system'] .mtable").first()).toBeVisible();
  await assertLocalOverflow(page);
  await expect(page.locator(".omni-solution-flow [data-math-render-error='true']")).toHaveCount(0);
  const metrics = await page.evaluate(() => ({
    semanticNodes: document.querySelectorAll(".omni-solution-flow .katex-html [data-semantic-id]").length,
    finalAnswerSemanticNodes: document.querySelectorAll(".final-answer-step .katex-html [data-semantic-id]").length,
    geometry: window.__OMNIMATH_GEOMETRY_SCHEDULER__,
    longTasks: window.__OMNIMATH_PERF__?.longTasks,
  }));
  await testInfo.attach("phase5-kkt-observation", { body: JSON.stringify({ interactiveObservationMs: Date.now() - started, ...metrics }, null, 2), contentType: "application/json" });
});

test("KKT duplicate-content control records browser rendering and geometry observations", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 375, height: 900 });
  const controlStart = await showFixture(page, makePhase5KktFixture(), { duplicatedContentControl: true });
  const control = await observeReadyMath(page, controlStart);
  await page.unroute("**/api/explain");
  const projectedStart = await showFixture(page, makePhase5KktFixture());
  const projected = await observeReadyMath(page, projectedStart);
  expect(control.repeatedBlockNodes).toBeGreaterThan(0);
  expect(projected.repeatedBlockNodes).toBe(0);
  expect(projected.sourceTreeNodes).toBeLessThan(control.sourceTreeNodes);
  await assertLocalOverflow(page);
  const observation = { method: "One sequential duplicated-content control and projected fixture on current layout; cold/warm cache and process contention differ. Timings/long tasks are observations, not a general speedup benchmark.", control, projected };
  await writeFile("test-artifacts/phase5-browser-observation.json", `${JSON.stringify(observation, null, 2)}\n`);
  console.log("PHASE5_BROWSER_OBSERVATION", JSON.stringify(observation));
});

test("wide matrix final result remains intact with stable semantic owners after expression scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await showFixture(page, makePhase5WideMatrixFixture());
  const final = page.locator(".final-answer-step").last();
  await expect(final.locator(".mtable").first()).toBeVisible();
  await assertLocalOverflow(page);
  const scroller = final.locator(".omni-expression-scroll").first();
  await expect(scroller).toHaveAttribute("tabindex", "0");
  await expect(scroller).toHaveAttribute("aria-label", /Mathematical expression/);
  const hitboxes = final.locator("[data-inspectable='math-subtoken']");
  await expect.poll(() => hitboxes.count()).toBeGreaterThan(0);
  const ids = await hitboxes.evaluateAll((nodes) => nodes.map((node) => node.dataset.semanticId));
  await scroller.evaluate((node) => { node.scrollLeft = node.scrollWidth - node.clientWidth; node.dispatchEvent(new Event("scroll")); });
  const target = hitboxes.last();
  await expect.poll(async () => target.evaluate((node) => {
    const root = node.closest("[data-math-chunk-owner]");
    const id = node.dataset.semanticId;
    const owner = [...root.querySelectorAll(".katex-html [data-semantic-id]")].find((element) => element.dataset.semanticId === id);
    if (!owner) return Infinity;
    const a = node.getBoundingClientRect();
    const b = owner.getBoundingClientRect();
    return Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2);
  })).toBeLessThan(8);
  expect(await hitboxes.evaluateAll((nodes) => nodes.map((node) => node.dataset.semanticId))).toEqual(ids);
  await target.hover({ force: true });
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", ids.at(-1));
});
