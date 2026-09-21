import { expect, test } from "@playwright/test";
import { semanticRenderingCorpus } from "./fixtures/semanticRenderingCorpus.mjs";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

test("adversarial annotations preserve browser glyph and primitive geometry in both math styles", async ({ page }) => {
  await page.goto("/?mockAuth=1");
  const failures = await page.evaluate(async (fixtures) => {
    const [{ default: katex }, { buildSemanticTree }, { serializeSemanticTreeToLatex, createSemanticKatexTrust }] = await Promise.all([
      import("/node_modules/katex/dist/katex.mjs"),
      import("/src/lib/mathSemanticTree.js"),
      import("/src/lib/semanticMathRenderer.js"),
    ]);
    await document.fonts.ready;
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;font-size:20px;white-space:nowrap;visibility:hidden";
    document.body.append(host);
    const results = [];
    const geometry = (element) => {
      const root = element.querySelector(".katex-html");
      const origin = root.getBoundingClientRect();
      const boxes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let index = 0; index < node.textContent.length; index += 1) {
          const text = node.textContent[index];
          if (text === "\u200b") continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          boxes.push({ text, x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height });
        }
      }
      for (const primitive of root.querySelectorAll(".frac-line,.hide-tail")) {
        const rect = primitive.getBoundingClientRect();
        boxes.push({ text: primitive.className, x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height });
      }
      return { width: origin.width, height: origin.height, boxes };
    };
    for (const { name, latex } of fixtures) {
      const rendered = serializeSemanticTreeToLatex(buildSemanticTree({ stepId: name, displayLatex: latex, enabled: true }));
      for (const displayMode of [false, true]) {
        const plain = document.createElement("div");
        const annotated = document.createElement("div");
        host.replaceChildren(plain, annotated);
        katex.render(latex, plain, { throwOnError: true, strict: "ignore", displayMode });
        katex.render(rendered.latex, annotated, { throwOnError: true, strict: "ignore", displayMode, trust: createSemanticKatexTrust() });
        // KaTeX fonts are requested only after the first math is mounted. Wait
        // here so both trees are measured with the same loaded font and shaping.
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const before = geometry(plain);
        const after = geometry(annotated);
        const maxDelta = Math.max(Math.abs(before.width - after.width), Math.abs(before.height - after.height),
          ...before.boxes.flatMap((box, index) => ["x", "y", "width", "height"].map((key) => Math.abs(box[key] - (after.boxes[index]?.[key] ?? Infinity)))));
        if (before.boxes.map((box) => box.text).join("") !== after.boxes.map((box) => box.text).join("") || maxDelta > 0.75) {
          results.push({ name, displayMode, maxDelta, before, after });
        }
      }
    }
    host.remove();
    return results;
  }, semanticRenderingCorpus);
  expect(failures).toEqual([]);
});

test("native hover and pin preserve repeated identities after scrolling, resize and a glyph layout mutation", async ({ page }) => {
  const requests = [];
  const latex = Array.from({ length: 10 }, () => String.raw`\frac{x+x}{x}+\sqrt{x+1}`).join("+");
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      title: "Adversarial ownership", problem: "Inspect repeated math.", expression: latex,
      steps: [{ id: "native-step", label: "Repeated scrolling expression", math: latex,
        summary: "Repeated source occurrences retain independent identities.",
        chunks: [{ id: "native-chunk", latex, display: latex, text: latex, role: "equation" }] }],
      finalAnswerLatex: latex,
      usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
    }),
  }));
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, (route) => {
      const body = route.request().postDataJSON();
      requests.push({ endpoint, body });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        title: "Selected occurrence", explanation: "This is the selected source occurrence.",
        semanticId: body.semanticId, targetId: body.targetId,
      }) });
    });
  }
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect repeated math.");
  const step = page.locator(".step-card").first();
  await expect(step).toBeVisible();
  const ids = await step.locator(".katex-html [data-semantic-selectable='true']").evaluateAll((owners) => owners
    .filter((owner) => owner.textContent === "x").map((owner) => owner.getAttribute("data-semantic-id")));
  expect(ids.length).toBeGreaterThanOrEqual(30);
  expect(new Set(ids).size).toBe(ids.length);
  const inspect = (id, pointer = null) => page.evaluate(({ id, pointer }) => {
    const result = window.__OMNIMATH_INSPECT_SEMANTIC__(id, pointer)[0];
    if (!result) return null;
    const { ownerElements, ...serializable } = result;
    return serializable;
  }, { id, pointer });
  const moveTo = async (id) => {
    await page.mouse.move(5, 5);
    const owner = step.locator(`.katex-html [data-semantic-id="${id}"]`).first();
    await owner.scrollIntoViewIfNeeded();
    await expect.poll(async () => (await inspect(id))?.geometry?.snapshotValid).toBe(true);
    const point = await owner.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", id);
    await expect.poll(async () => (await inspect(id, point))?.pointerSelection?.selectedId).toBe(id);
    const diagnostic = await inspect(id, point);
    expect(diagnostic.sourceSlice).toBe("x");
    expect(diagnostic.annotatedLatex).toContain(id);
    expect(diagnostic.owners.length).toBeGreaterThan(0);
    return point;
  };
  for (const id of [ids[0], ids[1], ids.at(-1), ids[0]]) await moveTo(id);
  const queuedScrollProbe = await step.evaluate((stepElement, denominatorId) => {
    const scrollContainer = stepElement.querySelector(".math-render-shell-block");
    const owner = stepElement.querySelector(`.katex-html [data-semantic-id="${CSS.escape(denominatorId)}"]`);
    if (!scrollContainer || !owner) return null;
    const inspect = (pointer = null) => window.__OMNIMATH_INSPECT_SEMANTIC__(denominatorId, pointer)[0];

    // Establish a far-right cached snapshot, then return left and deliver the
    // pointer in this same task. The browser cannot deliver its queued native
    // scroll event between the scrollLeft assignment and this mousemove.
    scrollContainer.scrollLeft = scrollContainer.scrollWidth - scrollContainer.clientWidth;
    scrollContainer.dispatchEvent(new Event("scroll"));
    window.__OMNIMATH_SCROLL_COORDINATOR__?.flush?.();
    const translatedRight = inspect();
    scrollContainer.scrollLeft = 0;

    const text = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.selectNodeContents(text);
    const liveRect = range.getBoundingClientRect();
    const point = { x: liveRect.left + liveRect.width / 2, y: liveRect.top + liveRect.height / 2 };
    const staleLeft = inspect()?.geometry?.paintedRects?.[0]?.left;
    owner.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      clientX: point.x,
      clientY: point.y,
    }));
    const refreshed = inspect(point);
    return {
      selectedId: window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__?.selected?.id || null,
      pointerSelectedId: refreshed?.pointerSelection?.selectedId || null,
      rightTranslationRevision: translatedRight?.geometry?.translationRevision || 0,
      refreshedTranslationRevision: refreshed?.geometry?.translationRevision || 0,
      staleDistance: Math.abs((staleLeft ?? liveRect.left) - liveRect.left),
      refreshedDistance: Math.abs((refreshed?.geometry?.paintedRects?.[0]?.left ?? liveRect.left) - liveRect.left),
    };
  }, ids[0]);
  expect(queuedScrollProbe).not.toBeNull();
  expect(queuedScrollProbe.staleDistance).toBeGreaterThan(100);
  expect(
    queuedScrollProbe.refreshedTranslationRevision,
    `queued scroll probe: ${JSON.stringify(queuedScrollProbe)}`,
  ).toBeGreaterThan(queuedScrollProbe.rightTranslationRevision);
  expect(queuedScrollProbe.refreshedDistance).toBeLessThanOrEqual(1);
  expect(queuedScrollProbe.selectedId).toBe(ids[0]);
  expect(queuedScrollProbe.pointerSelectedId).toBe(ids[0]);
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", ids[0]);
  await page.setViewportSize({ width: 1100, height: 850 });
  await moveTo(ids.at(-1));
  await moveTo(ids[0]);
  const before = await inspect(ids[0]);
  await step.locator(`.katex-html [data-semantic-id="${ids[0]}"]`).first().evaluate((owner) => {
    const glyph = owner.querySelector(".mathnormal");
    glyph.style.display = "inline-block";
    glyph.style.transform = "translateX(7px)";
  });
  await expect.poll(async () => (await inspect(ids[0]))?.geometry?.revision).toBeGreaterThan(before.geometry.revision);
  const point = await moveTo(ids[0]);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect.poll(() => requests.filter((request) => request.endpoint === "explain-pin").at(-1)?.body?.semanticId).toBe(ids[0]);
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", ids[0]);
});
