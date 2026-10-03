import { expect, test } from "@playwright/test";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { serializeSemanticTreeToLatex } from "../src/lib/semanticMathRenderer.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const usage = { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 };

function solutionFor({ latex, stepId, chunkId, label }) {
  return {
    title: "Semantic ownership remediation",
    problem: "Inspect semantic ownership.",
    expression: latex,
    steps: [{
      id: stepId,
      label,
      math: latex,
      summary: "Each visible occurrence keeps its own source identity.",
      chunks: [{ id: chunkId, display: latex, latex, text: latex, role: "equation" }],
    }],
    finalAnswerLatex: latex,
    usage,
  };
}

async function installSolution(page, fixture, requests = []) {
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(solutionFor(fixture)),
  }));
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint, body });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: "Selected occurrence",
          explanation: "This response is grounded to the selected occurrence.",
          semanticId: body.semanticId,
          targetId: body.targetId,
        }),
      });
    });
  }
}

async function paintedOccurrences(step, text) {
  return step.locator(".katex-html").evaluate((root, expectedText) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const occurrences = [];
    let node = walker.nextNode();
    while (node) {
      if ((node.textContent || "").trim() === expectedText) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        range.detach?.();
        if (rect.width > 0 && rect.height > 0) {
          occurrences.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            semanticId: node.parentElement?.getAttribute("data-semantic-id") || null,
            ownerSource: node.parentElement?.getAttribute("data-semantic-owner-source") || null,
          });
        }
      }
      node = walker.nextNode();
    }
    return occurrences.sort((left, right) => left.y - right.y || left.x - right.x);
  }, text);
}

test("mixed scripted bases retain independent source-order ownership and pin grounding", async ({ page }) => {
  const fixture = {
    latex: String.raw`J^2+J^*+J^{-1}`,
    stepId: "mixed-script-step",
    chunkId: "mixed-script-chunk",
    label: "Mixed scripted bases",
  };
  const tree = buildSemanticTree({
    stepId: `${fixture.chunkId}-${fixture.stepId}`,
    displayLatex: fixture.latex,
    enabled: true,
  });
  const expectedBases = tree.flatNodes
    .filter((node) => node.latex === "J" && node.childIds.length === 0)
    .sort((left, right) => left.sourceRange.start - right.sourceRange.start);
  expect(expectedBases.map((node) => node.sourceRange.start)).toEqual([0, 4, 8]);

  const requests = [];
  await installSolution(page, fixture, requests);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect mixed scripted bases.");
  const step = page.locator(".step-card").filter({ hasText: fixture.label });
  const chunk = step.locator(`[data-math-chunk-owner="${fixture.chunkId}"]`);
  await expect(chunk).toHaveAttribute("data-semantic-render-ready", "true", { timeout: 60_000 });

  const painted = await paintedOccurrences(step, "J");
  expect(painted).toHaveLength(3);
  expect(painted.map((item) => item.semanticId)).toEqual(expectedBases.map((node) => node.id));
  expect(painted.map((item) => item.ownerSource)).toEqual([
    "targeted-fallback",
    "targeted-fallback",
    "targeted-fallback",
  ]);

  for (const base of expectedBases) {
    const hitbox = step.locator(`.math-semantic-hitbox[data-semantic-id="${base.id}"]`).first();
    await expect(hitbox).toHaveAttribute("data-source-range", `${base.sourceRange.start}:${base.sourceRange.end}`);
    await expect(hitbox).toHaveAttribute("data-ownership-provenance", "targeted-fallback");
    await expect(hitbox).toHaveAttribute("data-geometry-valid", "true");
  }

  await page.mouse.click(painted[1].x, painted[1].y, { button: "right" });
  await expect.poll(() => requests.filter((request) => request.endpoint === "explain-pin").at(-1)?.body?.semanticId)
    .toBe(expectedBases[1].id);
  const pinRequest = requests.filter((request) => request.endpoint === "explain-pin").at(-1).body;
  expect(pinRequest.targetSourceRange).toEqual(expectedBases[1].sourceRange);
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", expectedBases[1].id);
});

test("dense scripted notation leaves work-budget exhaustion explicit and has no duplicate owners", async ({ page }) => {
  const fixture = {
    latex: `${Array.from({ length: 100 }, () => "J^2").join("+")}=0`,
    stepId: "dense-script-step",
    chunkId: "dense-script-chunk",
    label: "Dense scripted notation",
  };
  const tree = buildSemanticTree({
    stepId: `${fixture.chunkId}-${fixture.stepId}`,
    displayLatex: fixture.latex,
    enabled: true,
  });
  const rendering = serializeSemanticTreeToLatex(tree);
  const diagnosticById = new Map(rendering.nodeDiagnostics.map((item) => [item.semanticId, item]));
  const expectedBases = tree.flatNodes
    .filter((node) => node.latex === "J" && node.childIds.length === 0)
    .sort((left, right) => left.sourceRange.start - right.sourceRange.start);
  const budgetLeafIds = tree.flatNodes
    .filter((node) => node.childIds.length === 0 && diagnosticById.get(node.id)?.reason === "annotation-work-budget")
    .map((node) => node.id);
  expect(budgetLeafIds.length).toBeGreaterThan(100);

  await installSolution(page, fixture);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect dense scripted notation.");
  const step = page.locator(".step-card").filter({ hasText: fixture.label });
  const chunk = step.locator(`[data-math-chunk-owner="${fixture.chunkId}"]`);
  await expect(chunk).toHaveAttribute("data-semantic-render-ready", "true", { timeout: 60_000 });
  await expect.poll(() => step.locator(".katex-html [data-semantic-id]").count(), { timeout: 60_000 })
    .toBeGreaterThan(40);

  const painted = await paintedOccurrences(step, "J");
  expect(painted).toHaveLength(100);
  for (let index = 0; index < expectedBases.length; index += 1) {
    const expected = expectedBases[index];
    const diagnostic = diagnosticById.get(expected.id);
    if (diagnostic?.reason === "annotation-work-budget") {
      expect(painted[index].semanticId, `budget-exhausted J occurrence ${index + 1}`).toBeNull();
      expect(painted[index].ownerSource).toBeNull();
    } else if (diagnostic?.reason === "tex-layout-changed") {
      expect(painted[index].semanticId, `fallback J occurrence ${index + 1}`).toBe(expected.id);
      expect(painted[index].ownerSource).toBe("targeted-fallback");
    }
  }

  const ownership = await step.locator(".katex-html").evaluate((root) => {
    const ids = [...root.querySelectorAll("[data-semantic-id]")]
      .map((element) => element.getAttribute("data-semantic-id"))
      .filter(Boolean);
    const counts = ids.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
    return {
      duplicateIds: [...counts].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count })),
      fallbackOwners: root.querySelectorAll('[data-semantic-owner-source="targeted-fallback"]').length,
    };
  });
  expect(ownership.duplicateIds).toEqual([]);
  expect(ownership.fallbackOwners).toBeGreaterThan(0);

  for (const id of budgetLeafIds) {
    await expect(step.locator(`.katex-html [data-semantic-id="${id}"]`)).toHaveCount(0);
    await expect(step.locator(`.math-semantic-hitbox[data-semantic-id="${id}"]`)).toHaveCount(0);
  }
});

test("pointer entry while the semantic worker is pending stays scheduled and resolves when released", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const workers = [];
    class ControlledWorker {
      constructor(...args) {
        this.nativeWorker = new NativeWorker(...args);
        this.messages = [];
        this.released = false;
        this.nativeWorker.onmessage = (event) => {
          if (this.released) this.onmessage?.(event);
          else this.messages.push(event.data);
        };
        this.nativeWorker.onerror = (event) => this.onerror?.(event);
        this.nativeWorker.onmessageerror = (event) => this.onmessageerror?.(event);
        workers.push(this);
      }
      postMessage(...args) { return this.nativeWorker.postMessage(...args); }
      terminate() { return this.nativeWorker.terminate(); }
      release() {
        this.released = true;
        for (const data of this.messages.splice(0)) this.onmessage?.({ data });
      }
    }
    window.Worker = ControlledWorker;
    window.__OMNIMATH_TEST_WORKERS__ = {
      release: () => workers.forEach((worker) => worker.release()),
      count: () => workers.length,
    };
  });

  const fixture = {
    latex: `${Array.from({ length: 180 }, () => "x_i").join("+")}=0`,
    stepId: "pending-worker-step",
    chunkId: "pending-worker-chunk",
    label: "Pending worker ownership",
  };
  await installSolution(page, fixture);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect pending semantic ownership.");
  const step = page.locator(".step-card").filter({ hasText: fixture.label });
  const chunk = step.locator(`[data-math-chunk-owner="${fixture.chunkId}"]`);
  await expect(chunk).toHaveAttribute("data-semantic-render-ready", "false");
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_TEST_WORKERS__?.count() || 0)).toBeGreaterThan(0);

  const firstX = step.locator(".katex-html .mathnormal").filter({ hasText: "x" }).first();
  const box = await firstX.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(() => {
    window.__OMNIMATH_PERF__?.reset?.();
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
  const pendingSnapshot = await page.evaluate(() => ({
    hover: window.__OMNIMATH_HOVER_PERF__?.counters || {},
    phases: (window.__OMNIMATH_PERF__?.measurements || [])
      .filter((entry) => entry.name === "semantic.geometry.measurement")
      .map((entry) => entry.details?.phase),
  }));
  expect(pendingSnapshot.hover.geometryMeasurement || 0).toBe(0);
  expect(pendingSnapshot.phases).toEqual([]);

  await page.evaluate(() => window.__OMNIMATH_TEST_WORKERS__.release());
  await expect(chunk).toHaveAttribute("data-semantic-render-ready", "true", { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (
    window.__OMNIMATH_HOVER_PERF__?.counters?.pointerResolvedAfterMeasurement || 0
  )), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();

  const settledPhases = await page.evaluate(() => (
    (window.__OMNIMATH_PERF__?.measurements || [])
      .filter((entry) => entry.name === "semantic.geometry.measurement")
      .map((entry) => entry.details?.phase || "")
  ));
  expect(settledPhases.some((phase) => /pointer-boundary|pointer-resolve-retry/.test(phase))).toBe(false);
});
