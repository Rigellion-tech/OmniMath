import { expect, test } from "@playwright/test";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";
import { generatedDecoratedNotationCorpus } from "./fixtures/semanticRenderingCorpus.mjs";

const FIXTURES = [
  ["Variational Euler-Lagrange PDE", String.raw`-\nabla\cdot((1+\alpha|\nabla u_*|^4)\nabla u_*)+\beta u_*-\lambda|u_*|^{q-2}u_*=0`],
  ["Variational coefficient tensor", String.raw`B_*=(1+\alpha|\nabla u_*|^4)I+4\alpha|\nabla u_*|^2\nabla u_*\otimes\nabla u_*`],
  ["Variational linearized operator", String.raw`L_*v=-\nabla\cdot(B_*\nabla v)+[\beta-\lambda(q-1)|u_*|^{q-2}]v`],
  ["Variational second variation", String.raw`J''[u_*](v,v)`],
  ["Variational Rayleigh quotient", String.raw`\inf_{0\ne v\in H_0^1(\Omega)}\frac{J''[u_*](v,v)}{\int_\Omega v^2\,dx}`],
  ["Decorated lowest eigenvalue", String.raw`\lambda_1(L_*)=\inf_{v\in X,\,v\ne0}\frac{J''[u_*](v,v)}{\lVert v\rVert^2}`],
  ["Composed scripted primes", String.raw`u_*''+\psi_*'''+A_i^{-1}+T_\mu^{*}`],
  ["Composed accents", String.raw`\hat{u}_i+\bar{\psi}^{*}+\tilde{\phi}_k+\dot{u}_i+\ddot{u}_*`],
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

const GENERATED_BATCH_SIZE = 14;
const GENERATED_BATCHES = Array.from(
  { length: Math.ceil(generatedDecoratedNotationCorpus.length / GENERATED_BATCH_SIZE) },
  (_, batchIndex) => {
    const members = generatedDecoratedNotationCorpus.slice(
      batchIndex * GENERATED_BATCH_SIZE,
      (batchIndex + 1) * GENERATED_BATCH_SIZE,
    );
    let cursor = 0;
    const occurrences = members.map((member, memberIndex) => {
      const occurrence = { ...member, start: cursor, end: cursor + member.latex.length };
      cursor = occurrence.end + (memberIndex < members.length - 1 ? 1 : 0);
      return occurrence;
    });
    return {
      id: `generated-decoration-batch-${batchIndex + 1}`,
      chunkId: `generated-decoration-chunk-${batchIndex + 1}`,
      latex: members.map((member) => member.latex).join("+"),
      occurrences,
    };
  },
);

async function waitForAuthoritativeSemanticGeometry(page, chunk) {
  await page.evaluate(() => window.__OMNIMATH_SCROLL_COORDINATOR__?.flush?.());
  await expect.poll(() => chunk.evaluate((chunkElement) => {
    const scheduler = window.__OMNIMATH_GEOMETRY_SCHEDULER__;
    const ownerIds = new Set(
      [...chunkElement.querySelectorAll(".katex-html [data-semantic-id][data-semantic-selectable='true']")]
        .map((owner) => owner.getAttribute("data-semantic-id"))
        .filter(Boolean),
    );
    const measuredIds = new Set(
      [...chunkElement.querySelectorAll(".math-semantic-hitbox[data-semantic-id][data-rect-source^='semantic-dom'][data-geometry-valid='true']")]
        .map((hitbox) => hitbox.getAttribute("data-semantic-id"))
        .filter(Boolean),
    );
    const missingOwnerIds = [...ownerIds].filter((id) => !measuredIds.has(id));
    return {
      fontsLoaded: !document.fonts || document.fonts.status === "loaded",
      schedulerIdle: !scheduler?.pending && !scheduler?.backgroundPending,
      ownerCount: ownerIds.size,
      missingOwnerIds,
    };
  }), { timeout: 60_000 }).toEqual({
    fontsLoaded: true,
    schedulerIdle: true,
    ownerCount: expect.any(Number),
    missingOwnerIds: [],
  });
}

function generatedApiResponse() {
  return {
    title: "Generated decorated-notation semantic coverage",
    problem: "Verify compositional semantic hover coverage.",
    expression: GENERATED_BATCHES[0].latex,
    steps: GENERATED_BATCHES.map((batch, index) => ({
      id: batch.id,
      label: `Generated decoration batch ${index + 1}`,
      math: batch.latex,
      summary: "Supported atom and decorator classes must compose automatically.",
      chunks: [{
        id: batch.chunkId,
        display: batch.latex,
        latex: batch.latex,
        text: batch.latex,
        role: "equation",
      }],
    })),
    finalAnswerLatex: GENERATED_BATCHES.at(-1).latex,
    usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
  };
}

test("every visible variational atom reaches semantic DOM geometry and hover dispatch", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
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
  await page.evaluate(() => document.fonts?.ready);

  const report = [];
  for (const fixture of FIXTURES) {
    const step = page.locator(`.step-card[data-step-id="${fixture.stepId}"]`);
    await expect(step).toBeVisible();
    const chunk = step.locator(`[data-token-id="${fixture.chunkId}"]`).first();
    await expect(chunk).toBeVisible();
    await chunk.scrollIntoViewIfNeeded();
    await expect(chunk.locator("[data-semantic-render-fallback='true']")).toHaveCount(0);
    await expect(chunk).toHaveAttribute("data-semantic-render-ready", "true", { timeout: 60_000 });
    await expect.poll(() => chunk.locator(".math-semantic-hitbox[data-rect-source^='semantic-dom'][data-geometry-valid='true']").count(), {
      timeout: 60_000,
    }).toBeGreaterThan(0);

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
      const htmlRoot = chunkElement.querySelector(".katex-html");
      const visiblePrimitives = [];
      const paintedRectForElement = (element) => {
        if (element?.ownerSVGElement && typeof element.getBBox === "function" && typeof element.getScreenCTM === "function") {
          const box = element.getBBox();
          const matrix = element.getScreenCTM();
          if (matrix) {
            const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
              .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
            const padding = 0.5;
            return {
              left: Math.min(...points.map((point) => point.x)) - padding,
              right: Math.max(...points.map((point) => point.x)) + padding,
              top: Math.min(...points.map((point) => point.y)) - padding,
              bottom: Math.max(...points.map((point) => point.y)) + padding,
              get width() { return this.right - this.left; },
              get height() { return this.bottom - this.top; },
            };
          }
        }
        return element.getBoundingClientRect();
      };
      const residualOwnedRects = (owner, sourceRect) => {
        const ownerId = owner?.getAttribute("data-semantic-id");
        const subtract = (source, blocker) => {
          if (source.right <= blocker.left || source.left >= blocker.right || source.bottom <= blocker.top || source.top >= blocker.bottom) return [source];
          const overlap = { left: Math.max(source.left, blocker.left), right: Math.min(source.right, blocker.right), top: Math.max(source.top, blocker.top), bottom: Math.min(source.bottom, blocker.bottom) };
          return [
            { left: source.left, right: source.right, top: source.top, bottom: overlap.top },
            { left: source.left, right: source.right, top: overlap.bottom, bottom: source.bottom },
            { left: source.left, right: overlap.left, top: overlap.top, bottom: overlap.bottom },
            { left: overlap.right, right: source.right, top: overlap.top, bottom: overlap.bottom },
          ].map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }))
            .filter((rect) => rect.width >= 0.75 && rect.height >= 0.75);
        };
        const blockers = [...(owner?.querySelectorAll("[data-semantic-id]") || [])]
          .filter((descendant) => descendant.getAttribute("data-semantic-id") !== ownerId)
          .map((descendant) => descendant.getBoundingClientRect());
        return blockers.reduce((rects, blocker) => rects.flatMap((rect) => subtract(rect, blocker)), [sourceRect]);
      };
      const residualAccentRects = (element) => residualOwnedRects(
        element.closest("[data-semantic-id]"),
        paintedRectForElement(element),
      );
      const walker = document.createTreeWalker(htmlRoot, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        if ((textNode.textContent || "").trim()) {
          const owner = textNode.parentElement?.closest?.("[data-semantic-id]");
          const range = document.createRange();
          range.selectNodeContents(textNode);
          for (const sourceRect of range.getClientRects()) {
            const ownerRects = owner ? residualOwnedRects(owner, sourceRect) : [sourceRect];
            for (const rect of ownerRects) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            visiblePrimitives.push({
              id: `text-${visiblePrimitives.length + 1}`,
              text: textNode.textContent,
              ownerSemanticId: owner?.getAttribute("data-semantic-id") || null,
              expectedSemanticId: owner?.getAttribute("data-semantic-id") || null,
              rects: [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }],
            });
            }
          }
        }
        textNode = walker.nextNode();
      }
      for (const primitive of htmlRoot.querySelectorAll(".frac-line, .sqrt-line, .sqrt-sign svg, .accent-body svg path, .accent-body svg line, .accent-body svg rect, .accent-body svg circle, .accent-body svg ellipse, .accent-body svg polyline, .accent-body svg polygon, .accent-body svg use")) {
        const owner = primitive.closest("[data-semantic-id]");
        const primitiveRects = primitive.closest(".accent-body") ? residualAccentRects(primitive) : [paintedRectForElement(primitive)];
        for (const rect of primitiveRects) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          visiblePrimitives.push({
            id: `shape-${visiblePrimitives.length + 1}`,
            text: primitive.textContent || primitive.className?.baseVal || primitive.className || "shape",
            ownerSemanticId: owner?.getAttribute("data-semantic-id") || null,
            expectedSemanticId: owner?.getAttribute("data-semantic-id") || null,
            rects: [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }],
          });
        }
      }
      return auditSemanticCoverage({
        tree,
        serialization,
        domRoot: htmlRoot,
        measuredTargets: measured,
        geometryAcceptedTargets: measured,
        reachableTargets: measured,
        visiblePrimitives,
      });
    }, fixture);

    report.push({ fixture: fixture.label, sourceLatex: fixture.latex, atoms: audit.sourceAtoms, nodeFailures: audit.silentMissingNodes });
    expect(audit.sourceAtoms.length, fixture.label).toBeGreaterThan(0);
    expect(audit.sourceAtoms.filter((atom) => atom.firstFailingLayer !== 0), fixture.label).toEqual([]);
    expect(audit.silentMissingNodes, fixture.label).toEqual([]);
    expect(audit.orphanVisiblePrimitives, `${fixture.label}: orphan rendered ink`).toEqual([]);

    const ownerAt = (start, end, role = null) => audit.visiblePrimitives.filter((primitive) => (
      primitive.semanticSourceRange?.start === start
      && primitive.semanticSourceRange?.end === end
      && (!role || primitive.semanticRole === role)
    ));
    if (fixture.label === "Decorated lowest eigenvalue") {
      expect(ownerAt(0, 9, "decorated").length, "lambda base must belong to the decorated callable head").toBeGreaterThan(0);
      expect(ownerAt(8, 9, "subscript").length, "lambda index must retain its child occurrence").toBeGreaterThan(0);
      expect(ownerAt(10, 13, "argument").length, "L and star must retain the exact L_* occurrence").toBeGreaterThan(0);
      const jStart = fixture.latex.indexOf("J''");
      expect(ownerAt(jStart, jStart + 3).length, "J and its primes must retain the exact J'' occurrence").toBeGreaterThan(0);
    }
    if (fixture.label === "Composed scripted primes") {
      expect(ownerAt(0, 1, "base").length, "the base must retain its smallest meaningful occurrence").toBeGreaterThan(0);
      expect(ownerAt(0, 5, "decorated").length, "the star and prime run must belong to the safe u_*'' envelope").toBeGreaterThanOrEqual(2);
    }

    // Every actual painted fragment is sampled against the production pointer
    // resolver. This catches a parent wrapper that has an ID but omits its base,
    // prime, script, or accent geometry.
    for (const primitive of audit.visiblePrimitives) {
      const rect = primitive.rects[0];
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const selectedId = await page.evaluate(({ id, point }) => (
        window.__OMNIMATH_INSPECT_SEMANTIC__?.(id, point)?.find((item) => item.semanticId === id)?.pointerSelection?.selectedId || null
      ), { id: primitive.semanticId, point });
      expect(selectedId, `${fixture.label}: ${primitive.primitiveId} selected ${selectedId} instead of ${primitive.semanticId}`).toBe(primitive.semanticId);
    }

    // Transport is asserted for intended source occurrences. Some rendered
    // primitives (for example a fraction rule) are owned by a passive parent
    // aggregate whose painted descendants must resolve to smaller children;
    // requiring every such aggregate to dispatch would reward parent stealing.
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

    if (fixture.label === "Decorated lowest eigenvalue") {
      const lambdaPrimitive = audit.visiblePrimitives.find((primitive) => primitive.semanticRole === "decorated" && primitive.semanticSourceRange?.start === 0);
      expect(lambdaPrimitive).toBeTruthy();
      await page.mouse.move(4, 4);
      await expect(page.locator(".omni-quick-tooltip")).toBeHidden();
      const reprobe = async () => {
        const live = await chunk.evaluate((chunkElement, semanticId) => {
          const owner = chunkElement.querySelector(`[data-semantic-id="${CSS.escape(semanticId)}"]`);
          const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node && !(node.textContent || "").includes("λ")) node = walker.nextNode();
          if (!node) return null;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          return { point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
        }, lambdaPrimitive.semanticId);
        await page.mouse.move(live.point.x, live.point.y);
        await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", lambdaPrimitive.semanticId);
        await expect.poll(() => page.evaluate(({ id, point }) => (
          window.__OMNIMATH_INSPECT_SEMANTIC__?.(id, point)?.find((item) => item.semanticId === id)?.pointerSelection?.selectedId || null
        ), { id: lambdaPrimitive.semanticId, point: live.point })).toBe(lambdaPrimitive.semanticId);
      };

      await chunk.evaluate((element) => { element.style.transform = "translateX(23px)"; });
      await chunk.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      await reprobe();

      await chunk.evaluate((element) => {
        const shell = element.querySelector(".math-render-shell-block") || element;
        shell.style.width = "180px";
        shell.style.overflowX = "auto";
        shell.scrollLeft = Math.max(0, shell.scrollWidth - shell.clientWidth);
        shell.dispatchEvent(new Event("scroll"));
        window.__OMNIMATH_SCROLL_COORDINATOR__?.flush?.();
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await reprobe();
    }
  }

  await testInfo.attach("variational-semantic-coverage-report", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
});

test("generated supported decorators preserve production source-to-ink and ink-to-source ownership", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(generatedApiResponse()),
  }));
  await page.route("**/api/explain-token", (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: body.selectedLatex || "Generated semantic atom",
        explanation: "Deterministic generated-notation hover response.",
        semanticId: body.semanticId,
        targetId: body.targetId,
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Verify generated decorated notation.");
  await expect(page.locator(".step-card")).toHaveCount(GENERATED_BATCHES.length);
  await page.evaluate(() => document.fonts?.ready);

  const reports = [];
  for (const batch of GENERATED_BATCHES) {
    const step = page.locator(`.step-card[data-step-id="${batch.id}"]`);
    const chunk = step.locator(`[data-token-id="${batch.chunkId}"]`).first();
    await chunk.scrollIntoViewIfNeeded();
    await expect(chunk).toBeVisible();
    await expect(chunk.locator(".katex-html")).toBeVisible();
    await expect(chunk).toHaveAttribute("data-semantic-render-ready", "true", { timeout: 60_000 });
    await waitForAuthoritativeSemanticGeometry(page, chunk);

    const report = await chunk.evaluate(async (chunkElement, currentBatch) => {
      const [{ buildSemanticTree }, { serializeSemanticTreeToLatex }, { auditSemanticCoverage }] = await Promise.all([
        import("/src/lib/mathSemanticTree.js"),
        import("/src/lib/semanticMathRenderer.js"),
        import("/src/lib/semanticCoverageAudit.js"),
      ]);
      const tree = buildSemanticTree({
        stepId: `${currentBatch.chunkId}-${currentBatch.id}`,
        displayLatex: currentBatch.latex,
        enabled: true,
      });
      const serialization = serializeSemanticTreeToLatex(tree);
      const htmlRoot = chunkElement.querySelector(".katex-html");
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
      const visiblePrimitives = [];
      const paintedRectForElement = (element) => {
        if (element?.ownerSVGElement && typeof element.getBBox === "function" && typeof element.getScreenCTM === "function") {
          const box = element.getBBox();
          const matrix = element.getScreenCTM();
          if (matrix) {
            const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
              .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
            const padding = 0.5;
            return {
              left: Math.min(...points.map((point) => point.x)) - padding,
              right: Math.max(...points.map((point) => point.x)) + padding,
              top: Math.min(...points.map((point) => point.y)) - padding,
              bottom: Math.max(...points.map((point) => point.y)) + padding,
              get width() { return this.right - this.left; },
              get height() { return this.bottom - this.top; },
            };
          }
        }
        return element.getBoundingClientRect();
      };
      const residualOwnedRects = (owner, sourceRect) => {
        const ownerId = owner?.getAttribute("data-semantic-id");
        const subtract = (source, blocker) => {
          if (source.right <= blocker.left || source.left >= blocker.right || source.bottom <= blocker.top || source.top >= blocker.bottom) return [source];
          const overlap = { left: Math.max(source.left, blocker.left), right: Math.min(source.right, blocker.right), top: Math.max(source.top, blocker.top), bottom: Math.min(source.bottom, blocker.bottom) };
          return [
            { left: source.left, right: source.right, top: source.top, bottom: overlap.top },
            { left: source.left, right: source.right, top: overlap.bottom, bottom: source.bottom },
            { left: source.left, right: overlap.left, top: overlap.top, bottom: overlap.bottom },
            { left: overlap.right, right: source.right, top: overlap.top, bottom: overlap.bottom },
          ].map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }))
            .filter((rect) => rect.width >= 0.75 && rect.height >= 0.75);
        };
        const blockers = [...(owner?.querySelectorAll("[data-semantic-id]") || [])]
          .filter((descendant) => descendant.getAttribute("data-semantic-id") !== ownerId)
          .map((descendant) => descendant.getBoundingClientRect());
        return blockers.reduce((rects, blocker) => rects.flatMap((rect) => subtract(rect, blocker)), [sourceRect]);
      };
      const residualAccentRects = (element) => residualOwnedRects(
        element.closest("[data-semantic-id]"),
        paintedRectForElement(element),
      );
      const addPrimitive = (element, text, rect) => {
        if (rect.width <= 0 || rect.height <= 0) return;
        const owner = element?.closest?.("[data-semantic-id]");
        const ownerSemanticId = owner?.getAttribute("data-semantic-id") || null;
        visiblePrimitives.push({
          id: `generated-primitive-${visiblePrimitives.length + 1}`,
          text,
          ownerSemanticId,
          expectedSemanticId: ownerSemanticId,
          rects: [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }],
        });
      };
      const walker = document.createTreeWalker(htmlRoot, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        if ((textNode.textContent || "").trim()) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          const owner = textNode.parentElement?.closest?.("[data-semantic-id]");
          for (const sourceRect of range.getClientRects()) {
            const ownerRects = owner ? residualOwnedRects(owner, sourceRect) : [sourceRect];
            for (const rect of ownerRects) addPrimitive(textNode.parentElement, textNode.textContent, rect);
          }
        }
        textNode = walker.nextNode();
      }
      for (const shape of htmlRoot.querySelectorAll(".frac-line, .sqrt-line, .sqrt-sign svg, .accent-body svg path, .accent-body svg line, .accent-body svg rect, .accent-body svg circle, .accent-body svg ellipse, .accent-body svg polyline, .accent-body svg polygon, .accent-body svg use")) {
        const shapeRects = shape.closest(".accent-body") ? residualAccentRects(shape) : [paintedRectForElement(shape)];
        for (const rect of shapeRects) addPrimitive(shape, shape.className?.baseVal || shape.className || "shape", rect);
      }

      const audit = auditSemanticCoverage({
        tree,
        serialization,
        domRoot: htmlRoot,
        measuredTargets: measured,
        geometryAcceptedTargets: measured,
        reachableTargets: measured,
        visiblePrimitives,
      });
      const exactMissing = currentBatch.occurrences.filter((occurrence) => !tree.flatNodes.some((node) => (
        node.sourceRange?.start === occurrence.start
        && node.sourceRange?.end === occurrence.end
        && tree.displayLatex.slice(node.sourceRange.start, node.sourceRange.end) === occurrence.latex
      )));
      const primitivePointerFailures = audit.visiblePrimitives.flatMap((primitive) => {
        const rect = primitive.rects[0];
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const diagnostic = window.__OMNIMATH_INSPECT_SEMANTIC__?.(primitive.semanticId, point)
          ?.find((item) => item.semanticId === primitive.semanticId);
        const selectedId = diagnostic?.pointerSelection?.selectedId || null;
        const selectedDiagnostic = selectedId
          ? window.__OMNIMATH_INSPECT_SEMANTIC__?.(selectedId, point)?.find((item) => item.semanticId === selectedId)
          : null;
        return selectedId === primitive.semanticId ? [] : [{
          primitiveId: primitive.primitiveId,
          text: primitive.text,
          expectedSemanticId: primitive.semanticId,
          selectedId,
          point,
          expectedGeometry: diagnostic?.geometry || null,
          selectedGeometry: selectedDiagnostic?.geometry || null,
          pointerCandidates: diagnostic?.pointerSelection?.candidates || [],
        }];
      });
      const orphanGeometryDiagnostics = audit.orphanVisiblePrimitives.map((primitive) => ({
        semanticId: primitive.semanticId,
        primitiveRects: primitive.rects,
        measuredRects: measured.find((target) => target.id === primitive.semanticId)?.rects || [],
        ownerRects: [...htmlRoot.querySelectorAll("[data-semantic-id]")]
          .filter((owner) => owner.getAttribute("data-semantic-id") === primitive.semanticId)
          .map((owner) => {
            const rect = owner.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              selectable: owner.getAttribute("data-semantic-selectable"),
              role: owner.getAttribute("data-semantic-role"),
              parentId: owner.parentElement?.closest?.("[data-semantic-id]")?.getAttribute("data-semantic-id") || null,
            };
          }),
        hitboxRects: [...chunkElement.querySelectorAll(".math-semantic-hitbox[data-semantic-id]")]
          .filter((hitbox) => hitbox.getAttribute("data-semantic-id") === primitive.semanticId)
          .map((hitbox) => {
            const rect = hitbox.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              source: hitbox.getAttribute("data-rect-source"),
              revision: hitbox.getAttribute("data-measurement-revision"),
            };
          }),
        inspection: (() => {
          const item = window.__OMNIMATH_INSPECT_SEMANTIC__?.(primitive.semanticId)?.[0];
          if (!item) return null;
          return {
            annotationStatus: item.annotation?.annotationStatus || null,
            annotationReason: item.annotation?.reason || null,
            geometryAccepted: item.geometry?.accepted ?? null,
            geometryFilteringReasons: item.geometry?.filteringReasons || [],
            rectSource: item.geometry?.rectSource || null,
          };
        })(),
      }));
      return {
        complete: audit.complete,
        sourceFailures: audit.sourceAtoms.filter((atom) => atom.firstFailingLayer !== 0),
        nodeFailures: audit.silentMissingNodes,
        orphanPrimitives: audit.orphanVisiblePrimitives,
        orphanGeometryDiagnostics,
        primitivePointerFailures,
        exactMissing,
        memberCount: currentBatch.occurrences.length,
        primitiveCount: audit.visiblePrimitives.length,
      };
    }, batch);

    expect(report.exactMissing, `${batch.id}: generated member lacks an exact semantic source node`).toEqual([]);
    expect(report.sourceFailures, `${batch.id}: source-to-ink failure`).toEqual([]);
    expect(report.nodeFailures, `${batch.id}: semantic node pipeline failure`).toEqual([]);
    expect(report.orphanPrimitives, `${batch.id}: ink-to-source failure ${JSON.stringify(report.orphanGeometryDiagnostics)}`).toEqual([]);
    expect(report.primitivePointerFailures, `${batch.id}: production pointer resolver chose the wrong owner`).toEqual([]);
    expect(report.complete, batch.id).toBe(true);
    expect(report.memberCount).toBe(batch.occurrences.length);
    expect(report.primitiveCount, `${batch.id}: no visible primitives audited`).toBeGreaterThan(0);
    reports.push({ batchId: batch.id, ...report });
  }

  expect(reports.reduce((total, report) => total + report.memberCount, 0)).toBe(generatedDecoratedNotationCorpus.length);
  await testInfo.attach("generated-decorated-notation-coverage", {
    body: Buffer.from(JSON.stringify({ caseCount: generatedDecoratedNotationCorpus.length, reports }, null, 2)),
    contentType: "application/json",
  });
});
