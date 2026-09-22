import { expect, test } from "@playwright/test";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const FIXTURES = [
  ["Variational Euler-Lagrange PDE", String.raw`-\nabla\cdot((1+\alpha|\nabla u_*|^4)\nabla u_*)+\beta u_*-\lambda|u_*|^{q-2}u_*=0`],
  ["Variational coefficient tensor", String.raw`B_*=(1+\alpha|\nabla u_*|^4)I+4\alpha|\nabla u_*|^2\nabla u_*\otimes\nabla u_*`],
  ["Variational linearized operator", String.raw`L_*v=-\nabla\cdot(B_*\nabla v)+[\beta-\lambda(q-1)|u_*|^{q-2}]v`],
  ["Variational second variation", String.raw`J''[u_*](v,v)`],
  ["Variational Rayleigh quotient", String.raw`\inf_{0\ne v\in H_0^1(\Omega)}\frac{J''[u_*](v,v)}{\int_\Omega v^2\,dx}`],
].map(([label, latex], index) => ({ label, latex, stepId: `variational-step-${index + 1}`, chunkId: `variational-chunk-${index + 1}` }));

function apiResponse() {
  return {
    title: "Variational semantic coverage",
    problem: "Inspect deterministic variational semantic coverage.",
    expression: FIXTURES[0].latex,
    steps: FIXTURES.map((fixture) => ({
      id: fixture.stepId,
      label: fixture.label,
      math: fixture.latex,
      summary: "Every visible atom must retain an exact or compact semantic owner.",
      chunks: [{
        id: fixture.chunkId,
        display: fixture.latex,
        latex: fixture.latex,
        text: fixture.latex,
        role: "equation",
      }],
    })),
    finalAnswerLatex: FIXTURES.at(-1).latex,
    usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
  };
}

test("every visible variational atom reaches semantic DOM geometry and hover dispatch", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const requests = [];
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(apiResponse()),
  }));
  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: body.selectedLatex || "Semantic atom",
        explanation: `Semantic owner ${body.semanticId} reached hover dispatch.`,
        semanticId: body.semanticId,
        targetId: body.targetId,
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Inspect deterministic variational semantic coverage.");
  await expect(page.locator(".step-card")).toHaveCount(FIXTURES.length);

  const report = [];
  for (const fixture of FIXTURES) {
    const step = page.locator(`.step-card[data-step-id="${fixture.stepId}"]`);
    await expect(step).toBeVisible();
    const chunk = step.locator(`[data-token-id="${fixture.chunkId}"]`).first();
    await expect(chunk).toBeVisible();
    await chunk.scrollIntoViewIfNeeded();
    await expect(chunk.locator("[data-semantic-render-fallback='true']")).toHaveCount(0);

    const audit = await chunk.evaluate(async (chunkElement, current) => {
      const [{ buildSemanticTree }, { serializeSemanticTreeToLatex }, { auditSemanticCoverage }] = await Promise.all([
        import("/src/lib/mathSemanticTree.js"),
        import("/src/lib/semanticMathRenderer.js"),
        import("/src/lib/semanticCoverageAudit.js"),
      ]);
      const tree = buildSemanticTree({
        stepId: `${current.chunkId}-${current.stepId}`,
        displayLatex: current.latex,
        enabled: true,
      });
      const serialization = serializeSemanticTreeToLatex(tree);
      const byId = new Map();
      for (const hitbox of chunkElement.querySelectorAll(".math-semantic-hitbox[data-semantic-id][data-geometry-valid='true']")) {
        const id = hitbox.getAttribute("data-semantic-id");
        const rect = hitbox.getBoundingClientRect();
        if (!id || rect.width <= 0 || rect.height <= 0) continue;
        const target = byId.get(id) || { id, semanticId: id, rects: [] };
        target.rects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
        byId.set(id, target);
      }
      const measured = [...byId.values()];
      return auditSemanticCoverage({
        tree,
        serialization,
        domRoot: chunkElement.querySelector(".katex-html"),
        measuredTargets: measured,
        geometryAcceptedTargets: measured,
        reachableTargets: measured,
      });
    }, fixture);

    report.push({ fixture: fixture.label, sourceLatex: fixture.latex, atoms: audit.sourceAtoms, nodeFailures: audit.silentMissingNodes });
    expect(audit.sourceAtoms.length, fixture.label).toBeGreaterThan(0);
    expect(audit.sourceAtoms.filter((atom) => atom.firstFailingLayer !== 0), fixture.label).toEqual([]);
    expect(audit.silentMissingNodes, fixture.label).toEqual([]);

    const semanticIds = [...new Set(audit.sourceAtoms.map((atom) => atom.semanticId).filter(Boolean))];
    for (const semanticId of semanticIds) {
      if (requests.some((request) => request.semanticId === semanticId)) continue;
      const boxes = chunk.locator(`.math-semantic-hitbox[data-semantic-id="${semanticId}"][data-geometry-valid='true']`);
      const ownerRects = await chunk.locator(`.katex-html [data-semantic-id="${semanticId}"]`).evaluateAll((owners) => owners.flatMap((owner) => {
        const rects = [];
        const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();
        while (textNode) {
          if ((textNode.textContent || "").trim()) {
            const range = document.createRange();
            range.selectNodeContents(textNode);
            rects.push(...Array.from(range.getClientRects()).map((rect) => ({
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            })).filter((rect) => rect.width > 0 && rect.height > 0));
          }
          textNode = walker.nextNode();
        }
        return rects;
      }));
      const hitboxRects = [];
      const count = await boxes.count();
      for (let boxIndex = 0; boxIndex < count; boxIndex += 1) {
        const box = await boxes.nth(boxIndex).boundingBox();
        if (box) hitboxRects.push(box);
      }
      let dispatched = false;
      for (const box of [...ownerRects, ...hitboxRects]) {
        if (dispatched) break;
        const probes = [
          [0.5, 0.5], [0.2, 0.5], [0.8, 0.5],
        ];
        for (const [xRatio, yRatio] of probes) {
          await page.mouse.move(box.x + box.width * xRatio, box.y + box.height * yRatio);
          try {
            await expect.poll(
              () => requests.some((request) => request.semanticId === semanticId),
              { timeout: 350, intervals: [50, 100] },
            ).toBe(true);
            dispatched = true;
            break;
          } catch {
            // Probe another painted fragment of the same compact owner.
          }
        }
      }
      const failureDiagnostic = dispatched ? null : await page.evaluate(({ id, rects }) => {
        const points = rects.map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
        return {
          points,
          inspections: points.flatMap((point) => window.__OMNIMATH_INSPECT_SEMANTIC__?.(id, point) || []),
          lastHoverDiagnostic: window.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ || null,
          hoverState: window.__OMNIMATH_HOVER_STATE__ || null,
          hoverEvents: (window.__OMNIMATH_HOVER_EVENTS__ || []).slice(-40),
          requestEvents: (window.__OMNIMATH_HOVER_REQUEST_EVENTS__ || []).slice(-40),
          elements: points.map((point) => document.elementsFromPoint(point.x, point.y).slice(0, 5).map((element) => ({
            className: element.className?.baseVal || element.className || "",
            semanticId: element.getAttribute?.("data-semantic-id"),
            tokenId: element.getAttribute?.("data-token-id"),
          }))),
        };
      }, { id: semanticId, rects: [...ownerRects, ...hitboxRects] });
      expect(dispatched, `${fixture.label}: ${semanticId} has geometry but no hover dispatch: ${JSON.stringify(failureDiagnostic)}`).toBe(true);
    }
  }

  await testInfo.attach("variational-semantic-coverage-report", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
});
