import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const COMPLEX_EXPRESSIONS = [
  String.raw`\int_{0}^{\infty}\frac{x^{m-1}}{(1+x)^{m+n}}\,dx=\frac{\Gamma(m)\Gamma(n)}{\Gamma(m+n)}`,
  String.raw`\nabla\times\mathbf{F}=\begin{vmatrix}\mathbf{i}&\mathbf{j}&\mathbf{k}\\\partial_x&\partial_y&\partial_z\\P&Q&R\end{vmatrix}`,
  String.raw`\frac{\partial}{\partial t}\int_{\Omega(t)}u\,dV=\int_{\Omega(t)}\left(\partial_tu+\nabla\cdot(u\mathbf{v})\right)\,dV`,
  String.raw`\sqrt{1+\frac{x^2}{1+\frac{y^2}{1+z^2}}}=\frac{\sqrt{(1+z^2)(1+x^2)+y^2}}{\sqrt{1+z^2}}`,
  String.raw`\sum_{k=0}^{N}\binom{N}{k}p^k(1-p)^{N-k}=1`,
  String.raw`\left(D^2f(x_k)+\lambda_kD^2g(x_k)\right)\Delta x_k=-\nabla f(x_k)-\lambda_k\nabla g(x_k)`,
];

function createNotationHeavySolution() {
  return annotateMathExplanation({
    title: "Notation-heavy responsiveness probe",
    problem: "Analyze a collection of representative advanced expressions.",
    originalProblem: "Analyze a collection of representative advanced expressions.",
    expression: COMPLEX_EXPRESSIONS[0],
    steps: Array.from({ length: 18 }, (_, index) => ({
      id: `performance-step-${index + 1}`,
      label: `Transform expression ${index + 1}`,
      math: COMPLEX_EXPRESSIONS[index % COMPLEX_EXPRESSIONS.length],
      summary: "Preserve each semantic term while applying the indicated transformation.",
    })),
    finalAnswerLatex: COMPLEX_EXPRESSIONS.at(-1),
  });
}

async function installFixture(page) {
  const solution = createNotationHeavySolution();
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...solution,
      usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
    }),
  }));
  const explainTarget = (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: `Explain ${body.selectedLatex}`,
        explanation: "A focused explanation for the selected semantic target.",
        semanticId: body.semanticId,
        targetId: body.targetId,
      }),
    });
  };
  await page.route("**/api/explain-token", explainTarget);
  await page.route("**/api/explain-pin", explainTarget);
}

async function installDragFixture(page) {
  const solution = annotateMathExplanation({
    title: "Pinned drag performance",
    problem: "Explain a+b=3.",
    originalProblem: "Explain a+b=3.",
    expression: "a+b=3",
    steps: [{ id: "drag-step", label: "Inspect the terms", math: "a+b=3" }],
    finalAnswerLatex: "a+b=3",
  });
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...solution, usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 } }),
  }));
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, (route) => {
      const body = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Explain ${body.selectedLatex}`,
          explanation: `Explanation for ${body.selectedLatex}.`,
          semanticId: body.semanticId,
          targetId: body.targetId,
        }),
      });
    });
  }
}

async function beginEventLoopProbe(page) {
  await page.evaluate(() => {
    window.__OMNIMATH_EVENT_LOOP_PROBE__ = {
      startedAt: performance.now(),
      lastAt: performance.now(),
      maxDelayMs: 0,
      delayedTicks: 0,
      ticks: 0,
    };
    window.__OMNIMATH_EVENT_LOOP_PROBE__.timer = window.setInterval(() => {
      const probe = window.__OMNIMATH_EVENT_LOOP_PROBE__;
      const now = performance.now();
      const delay = Math.max(0, now - probe.lastAt - 16);
      probe.lastAt = now;
      probe.maxDelayMs = Math.max(probe.maxDelayMs, delay);
      probe.delayedTicks += delay >= 50 ? 1 : 0;
      probe.ticks += 1;
    }, 16);
  });
}

async function readPerformanceSnapshot(page) {
  return page.evaluate(() => {
    const app = window.__OMNIMATH_PERF__ || {};
    const hover = window.__OMNIMATH_HOVER_PERF__ || {};
    const probe = window.__OMNIMATH_EVENT_LOOP_PROBE__ || {};
    if (probe.timer) clearInterval(probe.timer);
    const geometryDurations = (app.measurements || [])
      .filter((entry) => entry.name === "semantic.geometry.measurement")
      .map((entry) => entry.durationMs);
    const measuredTotals = Object.entries((app.measurements || []).reduce((totals, entry) => {
      if (!Number.isFinite(entry.durationMs)) return totals;
      const current = totals[entry.name] || { count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += entry.durationMs;
      current.maxMs = Math.max(current.maxMs, entry.durationMs);
      totals[entry.name] = current;
      return totals;
    }, {})).sort((left, right) => right[1].totalMs - left[1].totalMs).slice(0, 12);
    const reactCommits = (app.measurements || [])
      .filter((entry) => entry.name === "react.commit")
      .map((entry) => entry.details)
      .sort((left, right) => right.actualDuration - left.actualDuration)
      .slice(0, 8);
    const mathChunkRenderGroups = (app.measurements || [])
      .filter((entry) => entry.name === "react.render.math-chunk")
      .reduce((groups, entry) => {
        const key = entry.details?.overlayTargetCount > 0 ? "withOverlay" : "withoutOverlay";
        groups[key].count += 1;
        groups[key].totalMs += entry.durationMs;
        groups[key].maxMs = Math.max(groups[key].maxMs, entry.durationMs);
        return groups;
      }, {
        withOverlay: { count: 0, totalMs: 0, maxMs: 0 },
        withoutOverlay: { count: 0, totalMs: 0, maxMs: 0 },
      });
    return {
      appCounters: app.counters || {},
      hoverCounters: hover.counters || {},
      longTasks: (app.longTasks || []).map((entry) => entry.durationMs),
      slowMeasurements: (app.slow || []).map((entry) => ({ name: entry.name, durationMs: entry.durationMs })),
      measuredTotals,
      reactCommits,
      mathChunkRenderGroups,
      geometryScheduler: window.__OMNIMATH_GEOMETRY_SCHEDULER__ || null,
      geometryTotalMs: geometryDurations.reduce((sum, duration) => sum + duration, 0),
      geometryMaxMs: Math.max(0, ...geometryDurations),
      eventLoop: {
        maxDelayMs: probe.maxDelayMs || 0,
        delayedTicks: probe.delayedTicks || 0,
        ticks: probe.ticks || 0,
      },
      mathChunkCount: document.querySelectorAll("[data-math-chunk-owner]").length,
    };
  });
}

test("notation-heavy solution remains interactive while semantic geometry settles", async ({ page }, testInfo) => {
  await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mockAuth=1");
  await page.evaluate(() => {
    window.__OMNIMATH_PERF__?.reset?.();
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
  });
  await beginEventLoopProbe(page);
  const solveStartedAt = Date.now();
  await submitCurrentComposer(page, "Analyze representative advanced expressions.");
  await expect(page.getByRole("button", { name: "Transform expression 18" })).toBeVisible();
  const visibleAtMs = Date.now() - solveStartedAt;

  const firstTarget = page.locator("[data-inspectable='math-subtoken']").first();
  await expect(firstTarget).toBeVisible();
  const interactionStartedAt = Date.now();
  await firstTarget.hover({ force: true });
  await expect(firstTarget).toHaveAttribute("data-active-target", "true");
  await page.mouse.move(4, 4);
  await expect(firstTarget).not.toHaveAttribute("data-active-target", "true");
  const activateComposer = page.getByTestId("primary-composer-activate");
  if (await activateComposer.count()) {
    await activateComposer.click();
  } else {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
  }
  const proseInput = page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…");
  await proseInput.click();
  await expect(proseInput).toBeFocused();
  const interactionMs = Date.now() - interactionStartedAt;
  await page.waitForTimeout(1200);

  const snapshot = await readPerformanceSnapshot(page);
  await testInfo.attach("responsiveness-metrics", {
    body: JSON.stringify({ visibleAtMs, interactionMs, ...snapshot }, null, 2),
    contentType: "application/json",
  });
  console.log("OMNIMATH_RESPONSIVENESS_METRICS", JSON.stringify({ visibleAtMs, interactionMs, ...snapshot }));

  expect(snapshot.mathChunkCount).toBeGreaterThanOrEqual(18);
  expect(snapshot.eventLoop.ticks).toBeGreaterThan(0);
  expect(snapshot.hoverCounters.geometryMeasurement || 0).toBeLessThanOrEqual(snapshot.mathChunkCount * 3);
  expect(snapshot.appCounters["katex.renderToString.render-path"] || 0).toBe(0);
  expect(Math.max(0, ...snapshot.longTasks)).toBeLessThan(1200);
  expect(snapshot.eventLoop.maxDelayMs).toBeLessThan(1500);
});

test("pinned dragging stays local until pointer-up", async ({ page }) => {
  await installDragFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Explain a+b=3.");
  const target = page.locator("[data-inspectable='math-subtoken'][data-token-latex='a']").first();
  await expect(target).toBeVisible();
  const targetBox = await target.boundingBox();
  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { button: "right" });
  const card = page.locator(".omni-floating-window").first();
  await expect(card).toHaveAttribute("data-spawn-state", "organized");
  const handle = card.locator("[data-pinned-drag-handle]");
  const handleBox = await handle.boundingBox();
  const start = { x: handleBox.x + 18, y: handleBox.y + handleBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(card).toHaveAttribute("data-placement-mode", "manual");
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });

  await page.mouse.move(start.x - 300, start.y + 260, { steps: 24 });
  const duringDrag = await page.evaluate(() => ({
    hover: window.__OMNIMATH_HOVER_PERF__?.counters || {},
    app: window.__OMNIMATH_PERF__?.counters || {},
  }));
  const movedBox = await card.boundingBox();
  expect(Math.abs(movedBox.x - (handleBox.x - 300))).toBeLessThan(30);
  expect(duringDrag.hover.mathChunkRender || 0).toBe(0);
  expect(duringDrag.hover.geometryMeasurement || 0).toBe(0);
  expect(duringDrag.app["session.pinned-windows.stringify-current"] || 0).toBe(0);
  expect(duringDrag.app["session.pinned-windows.stringify-next"] || 0).toBe(0);

  await page.mouse.up();
  await expect(card).toHaveAttribute("data-placement-mode", "manual");
  const committedBox = await card.boundingBox();
  expect(Math.abs(committedBox.x - movedBox.x) + Math.abs(committedBox.y - movedBox.y)).toBeLessThan(3);
});
