import { expect, test } from "@playwright/test";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";
import katex from "katex";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { serializeSemanticTreeToLatex } from "../src/lib/semanticMathRenderer.js";

const CASES = [
  {
    key: "variational-boundary-integral",
    label: "Variational boundary integral ownership",
    latex: String.raw`J'[u](v)=\int_{\Omega}\left[-\nabla\cdot\left((1+\alpha|\nabla u|^2)\nabla u\right)+\beta u-\lambda|u|^{p-2}u\right]v\,dx+\int_{\partial\Omega}(1+\alpha|\nabla u|^2)\frac{\partial u}{\partial n}v\,dS`,
    match: (node) => node.latex === "S" && node.sourceRange.start > 190,
  },
  {
    key: "variational-additive-boundary",
    label: "Variational additive boundary ownership",
    latex: String.raw`J'[u](v)=\int_{\Omega}\left[-\nabla\cdot\left((1+\alpha|\nabla u|^2)\nabla u\right)+\beta u-\lambda|u|^{p-2}u\right]v\,dx+\int_{\partial\Omega}(1+\alpha|\nabla u|^2)\frac{\partial u}{\partial n}v\,dS`,
    match: (node) => node.latex === "+" && node.sourceRange.start === 145,
  },
  {
    key: "variational-second-integral",
    label: "Variational second integral ownership",
    latex: String.raw`\int_{\Omega}(1+\alpha|\nabla u|^2)\nabla u\cdot\nabla v\,dx+\int_{\Omega}(\beta u-\lambda|u|^{p-2}u)v\,dx=0`,
    match: (node) => node.latex === String.raw`\lambda` && node.sourceRange.start > 60,
  },
  {
    key: "variational-final-zero",
    label: "Variational equation suffix ownership",
    latex: String.raw`\int_{\Omega}(1+\alpha|\nabla u|^2)\nabla u\cdot\nabla v\,dx+\int_{\Omega}(\beta u-\lambda|u|^{p-2}u)v\,dx=0`,
    match: (node) => node.latex === "0" && node.sourceRange.start > 100,
  },
  { key: "indexed-root", label: "Indexed radical ownership", latex: String.raw`\sqrt[n+1]{x^2+y^2}`, match: (node) => node.latex === "n" && node.role === "variable" },
  { key: "binomial", label: "Binomial ownership", latex: String.raw`\binom{n}{k}`, match: (node) => node.latex === "n" && node.role === "argument" },
  { key: "overbrace", label: "Overbrace ownership", latex: String.raw`\overbrace{a+b+c}^{n\text{ terms}}`, match: (node) => node.latex === "b" && node.role === "variable" },
  { key: "norm", label: "Norm ownership", latex: String.raw`\left\lVert x+y \right\rVert`, match: (node) => node.latex === "x" && node.role === "variable" },
  {
    key: "substack",
    label: "Substack limit ownership",
    latex: String.raw`\lim_{\substack{x\to0\\\,x>0}}f(x)`,
    transportLatex: String.raw`\lim_{\substack{x\to0\\\ x>0}} f(x)`,
    match: (node) => node.latex === "f" && node.role === "functionName",
  },
  {
    key: "matrix",
    label: "Matrix ownership",
    latex: String.raw`\begin{pmatrix}\frac{a_1}{b^2}&x^{y_z}\\\ \sqrt{q}&r\end{pmatrix}`,
    transportLatex: String.raw`\begin{pmatrix}\frac{a_1}{b^2}&x^{y_z}\\\ \sqrt{q}&r\end{pmatrix}`,
    match: (node) => node.latex === "q" && node.role === "radicand",
  },
  {
    key: "cases",
    label: "Cases ownership",
    latex: String.raw`\begin{cases}x^2&x>0\\\,-x&x\le0\end{cases}`,
    transportLatex: String.raw`\begin{cases}x^2&x>0\\\ -x&x\le0\end{cases}`,
    match: (node) => node.latex === "2" && node.role === "exponent",
  },
  {
    key: "aligned",
    label: "Aligned ownership",
    latex: String.raw`\begin{aligned}a&=b+c\\\,d&=e-f\end{aligned}`,
    transportLatex: String.raw`\begin{aligned}a&=b+c\\\ d&=e-f\end{aligned}`,
    match: (node) => node.latex === "b" && node.role === "variable",
  },
].map((fixture) => {
  const stepId = `tex-${fixture.key}-step`;
  const chunkId = `tex-${fixture.key}-chunk`;
  const sourceLatex = fixture.transportLatex || fixture.latex;
  const tree = buildSemanticTree({
    stepId: `${chunkId}-${stepId}`,
    displayLatex: sourceLatex,
    enabled: true,
  });
  const serialized = serializeSemanticTreeToLatex(tree);
  const target = tree.flatNodes.find(fixture.match);
  if (!target || !serialized.annotatedNodeIds.includes(target.id)) {
    throw new Error(`Browser ownership fixture ${fixture.key} has no safe target.`);
  }
  return {
    ...fixture,
    sourceLatex,
    stepId,
    chunkId,
    tree,
    serialized,
    target,
    plainHtml: katex.renderToString(sourceLatex, { throwOnError: true, strict: "ignore" }),
  };
});

function apiResponse() {
  return {
    title: "TeX grammar ownership",
    problem: "Inspect TeX grammar ownership.",
    expression: CASES[0].latex,
    steps: CASES.map((fixture) => ({
      id: fixture.stepId,
      label: fixture.label,
      math: fixture.latex,
      summary: "The visible target should keep deterministic semantic ownership.",
      chunks: [{
        id: fixture.chunkId,
        display: fixture.sourceLatex,
        latex: fixture.sourceLatex,
        text: fixture.sourceLatex,
        role: "equation",
        // A supplied part exercises the existing-part annotation path while
        // the parser assigns ranged ownership to the complete source.
        parts: [{
          id: `${fixture.chunkId}-transport-sentinel`,
          display: "x",
          latex: "x",
          text: "x",
          role: "variable",
        }],
      }],
    })),
    finalAnswerLatex: CASES[0].latex,
    usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
  };
}

async function visibleTextRect(owner) {
  return owner.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects = [];
    let textNode = walker.nextNode();
    while (textNode) {
      if ((textNode.textContent || "").trim()) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
      }
      textNode = walker.nextNode();
    }
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

test("grammar-sensitive TeX preserves render layout and end-to-end semantic ownership", async ({ page }) => {
  const requests = [];
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(apiResponse()) });
  });
  for (const endpoint of ["**/api/explain-token", "**/api/explain-pin"]) {
    await page.route(endpoint, async (route) => {
      const body = route.request().postDataJSON();
      const mode = endpoint.includes("pin") ? "pin" : "hover";
      requests.push({ mode, body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `${mode} ${body.semanticId}`,
          explanation: `${body.selectedLatex} belongs to ${body.semanticId}.`,
          semanticId: body.semanticId,
          targetId: body.targetId,
        }),
      });
    });
  }

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect TeX grammar ownership.");
  await expect(page.locator(".step-card")).toHaveCount(CASES.length);

  const browserPlanner = await page.evaluate(async (fixtures) => {
    const [{ buildSemanticTree: build }, { serializeSemanticTreeToLatex: serialize }] = await Promise.all([
      import("/src/lib/mathSemanticTree.js"),
      import("/src/lib/semanticMathRenderer.js"),
    ]);
    return fixtures.map((fixture) => {
      const tree = build({ stepId: `${fixture.chunkId}-${fixture.stepId}`, displayLatex: fixture.sourceLatex, enabled: true });
      const rendered = serialize(tree);
      return {
        key: fixture.key,
        annotatedNodeCount: rendered.annotatedNodeCount,
        completeAnnotationValid: rendered.annotationPlan?.completeAnnotationValid,
      };
    });
  }, CASES.map(({ key, stepId, chunkId, sourceLatex }) => ({ key, stepId, chunkId, sourceLatex })));
  expect(browserPlanner).toEqual(CASES.map((fixture) => ({
    key: fixture.key,
    annotatedNodeCount: fixture.serialized.annotatedNodeCount,
    completeAnnotationValid: fixture.serialized.annotationPlan.completeAnnotationValid,
  })));

  for (const fixture of CASES) {
    const step = page.locator(".step-card").filter({ hasText: fixture.label });
    await expect(step).toBeVisible();
    await expect(step.locator("[data-semantic-render-fallback='true']")).toHaveCount(0);
    await expect(step.locator(`[data-token-id="${fixture.chunkId}"]`)).toHaveAttribute("data-token-latex", fixture.sourceLatex);

    const visualDifference = await step.locator(".katex-html").first().evaluate((semanticHtml, plainHtml) => {
      const reference = document.createElement("span");
      const shell = semanticHtml.closest("[data-math-shell]") || semanticHtml.parentElement;
      reference.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
      reference.style.fontSize = getComputedStyle(shell).fontSize;
      reference.innerHTML = plainHtml;
      shell.append(reference);
      const semanticRect = semanticHtml.getBoundingClientRect();
      const plainRect = reference.querySelector(".katex-html").getBoundingClientRect();
      const result = {
        width: Math.abs(semanticRect.width - plainRect.width),
        height: Math.abs(semanticRect.height - plainRect.height),
        semanticWidth: semanticRect.width,
        plainWidth: plainRect.width,
        semanticFontSize: getComputedStyle(semanticHtml.closest("[data-math-shell]") || semanticHtml.parentElement).fontSize,
        referenceFontSize: getComputedStyle(reference).fontSize,
      };
      reference.remove();
      return result;
    }, fixture.plainHtml);
    expect(visualDifference.width, `${fixture.key} width changed: ${JSON.stringify(visualDifference)}`).toBeLessThan(0.75);
    expect(visualDifference.height, `${fixture.key} height changed: ${JSON.stringify(visualDifference)}`).toBeLessThan(0.75);

    const owner = step.locator(`.katex-html [data-semantic-id="${fixture.target.id}"]`).first();
    const hitbox = step.locator(`.math-semantic-hitbox[data-semantic-id="${fixture.target.id}"]`).first();
    await expect(owner).toBeVisible();
    await expect(hitbox).toBeVisible();
    await expect(hitbox).toHaveAttribute("data-geometry-valid", "true");
    await owner.scrollIntoViewIfNeeded();
    const box = await visibleTextRect(owner);
    expect(box, `${fixture.key} has no visible glyph rectangle`).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await expect(hitbox).toHaveAttribute("data-active-target", "true");
    const tooltip = page.locator(".omni-quick-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", fixture.target.id);
    await expect.poll(() => requests.filter((request) => request.mode === "hover").at(-1)?.body?.semanticId).toBe(fixture.target.id);
    const hoverBody = requests.filter((request) => request.mode === "hover").at(-1).body;
    expect(hoverBody.selectedNode?.id).toBe(fixture.target.id);
    expect(hoverBody.selectedLatex).toBe(fixture.target.latex);
    expect(hoverBody.targetRole).toBe(fixture.target.role);
    expect(hoverBody.targetSourceRange).toEqual(fixture.target.sourceRange);
    // Tooltip prose may render identifier hyphens through KaTeX as minus
    // glyphs, so the semantic data attribute is the authoritative identity.
    await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", fixture.target.id);
  }

  const pinned = CASES[0];
  const pinnedStep = page.locator(".step-card").filter({ hasText: pinned.label });
  const pinnedOwner = pinnedStep.locator(`.katex-html [data-semantic-id="${pinned.target.id}"]`).first();
  await pinnedOwner.scrollIntoViewIfNeeded();
  const pinBox = await visibleTextRect(pinnedOwner);
  await page.mouse.click(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2, { button: "right" });
  await expect.poll(() => requests.filter((request) => request.mode === "pin").at(-1)?.body?.semanticId).toBe(pinned.target.id);
  await expect(page.locator(".omni-floating-window")).toHaveAttribute("data-semantic-id", pinned.target.id);

  for (const fixture of CASES.filter((item) => !item.serialized.annotationPlan.completeAnnotationValid)) {
    expect(fixture.serialized.annotationPlan.unsupportedNodeIds.length).toBeGreaterThan(0);
    expect(fixture.serialized.annotatedNodeCount).toBeGreaterThan(0);
  }
});
