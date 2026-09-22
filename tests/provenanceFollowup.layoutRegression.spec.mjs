import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

function matrixResponse() {
  const problem = String.raw`Find the inverse of A=\begin{bmatrix}4&1&2\\0&3&1\\0&2&5\end{bmatrix}`;
  return annotateMathExplanation({
    title: "Inverse by cofactors",
    problem,
    originalProblem: problem,
    expression: problem,
    assumptions: [String.raw`\det(A)\ne0`],
    steps: [
      { id: "s1", label: "Compute the determinant", math: String.raw`\det(A)=52`, summary: "The determinant is nonzero." },
      { id: "s2", label: "Build the selected minor", math: String.raw`M_{22}=\begin{bmatrix}4&2\\0&5\end{bmatrix}`, summary: "Delete row 2 and column 2." },
      { id: "s3", label: "Evaluate the cofactor", math: String.raw`C_{22}=(-1)^{2+2}(4\cdot5-2\cdot0)=20`, summary: "Apply the positive cofactor sign to the minor determinant." },
      { id: "s4", label: "Form the adjugate", math: String.raw`\operatorname{adj}(A)=\begin{bmatrix}13&-1&-5\\0&20&-4\\0&-8&12\end{bmatrix}`, summary: "Transpose the cofactor matrix." },
      { id: "s5", label: "Form the inverse", math: String.raw`A^{-1}=\frac1{52}\operatorname{adj}(A)`, summary: "Divide the adjugate by the determinant." },
    ],
    finalAnswerLatex: String.raw`A^{-1}=\frac1{52}\begin{bmatrix}13&-1&-5\\0&20&-4\\0&-8&12\end{bmatrix}`,
  });
}

async function installMatrixRoutes(page, followupHandler) {
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...matrixResponse(),
      usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
      saved: false,
      source: "provenance playwright fixture",
    }),
  }));
  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Selected occurrence",
        explanation: "This is the exact selected occurrence in the adjugate.",
        semanticId: body.semanticId,
        targetId: body.targetId,
      }),
    });
  });
  await page.route("**/api/explain-pin", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Adjugate entry",
        explanation: "20 is the selected adjugate entry, obtained from its signed cofactor.",
        semanticId: body.semanticId,
        targetId: body.targetId,
      }),
    });
  });
  await page.route("**/api/explain-followup", followupHandler);
}

async function contextClickSemanticPointer(page, x, y) {
  await page.evaluate(({ x: clientX, y: clientY }) => {
    const contains = (rect) => clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
    const host = [...document.querySelectorAll(".math-semantic-hitbox[data-token-id]")]
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && contains(rect))
      .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height)[0]
      ?.node?.closest("[data-inspectable='math-token']");
    host?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
    }));
  }, { x, y });
}

async function solveAndPinAdjugateTwenty(page) {
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Find the inverse by cofactors.");
  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Form the adjugate/i }) });
  await expect(step).toBeVisible();
  const targets = step.locator(".katex-html [data-semantic-selectable='true']");
  await expect.poll(() => targets.count()).toBeGreaterThan(0);
  const targetIndex = await targets.evaluateAll((nodes) => nodes.findIndex((node) => node.textContent?.trim() === "20"));
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  const target = targets.nth(targetIndex);
  const semanticId = await target.getAttribute("data-semantic-id");
  await expect(step.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first()).toBeAttached();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await contextClickSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
  const window = page.locator(".omni-floating-window");
  await expect(window).toHaveAttribute("data-semantic-id", semanticId);
  await expect(window).toContainText("obtained from its signed cofactor");
  return { window, semanticId };
}

test("matrix follow-ups retain exact occurrence, derivation evidence, and multi-turn ownership", async ({ page }) => {
  const requests = [];
  await installMatrixRoutes(page, async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        answer: requests.length === 1
          ? String.raw`Delete row 2 and column 2, then compute $4\cdot5-2\cdot0=20$; the cofactor sign is positive.`
          : "The sign is positive because $(-1)^{2+2}=1$.",
        requestId: body.requestId,
        conversationId: body.conversationId,
        targetRevision: body.targetRevision,
      }),
    });
  });
  const { window, semanticId } = await solveAndPinAdjugateTwenty(page);
  const input = window.getByPlaceholder("Ask about this");

  await input.fill("how did you find 20?");
  await input.press("Enter");
  await expect(window).toContainText("Delete row 2 and column 2");
  expect(requests[0].provenanceSnapshot.target.semanticId).toBe(semanticId);
  expect(requests[0].provenanceSnapshot.origin.stepId).toBe("s4");
  expect(requests[0].provenanceSnapshot.evidence.steps.map((step) => step.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  expect(requests[0].pinnedExplanation).toContain("obtained from its signed cofactor");

  await input.fill("why is the sign positive?");
  await input.press("Enter");
  await expect(window).toContainText("because");
  expect(requests[1].conversationId).toBe(requests[0].conversationId);
  expect(requests[1].targetRevision).toBe(requests[0].targetRevision);
  expect(requests[1].history.map((message) => message.role)).toEqual(["user", "assistant"]);
});

test("follow-up provider failure restores the exact question for deterministic retry", async ({ page }) => {
  let attempts = 0;
  await installMatrixRoutes(page, async (route) => {
    attempts += 1;
    const body = route.request().postDataJSON();
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "AI_SERVICE_UNAVAILABLE", message: "synthetic timeout" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        answer: "Retry succeeded for the same cofactor occurrence.",
        requestId: body.requestId,
        conversationId: body.conversationId,
        targetRevision: body.targetRevision,
      }),
    });
  });
  const { window } = await solveAndPinAdjugateTwenty(page);
  const input = window.getByPlaceholder("Ask about this");

  await input.fill("show the exact calculation");
  await input.press("Enter");
  await expect(window).toContainText("timed out or connection dropped");
  await expect(input).toHaveValue("show the exact calculation");
  await input.press("Enter");
  await expect(window).toContainText("Retry succeeded");
  expect(attempts).toBe(2);
});
