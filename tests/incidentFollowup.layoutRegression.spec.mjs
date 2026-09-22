import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const FOLLOWUP_QUESTION = "how did you find 20?";
const FOLLOWUP_ANSWER = "Delete row 2 and column 2, then compute $4\\cdot5-2\\cdot0=20$; the cofactor sign is positive.";

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

async function installSignedMockAuthBoundary(page) {
  let patchCount = 0;
  await page.route("**/src/lib/auth.jsx*", async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const expected = [
      "getToken: async () => null,",
      "        isLoaded: true,",
      "        isSignedIn: true,",
      "        isMock: true,",
    ].join("\n");
    const replacement = [
      'getToken: async () => "e2e-session-token",',
      "        isLoaded: true,",
      "        isSignedIn: true,",
      "        isMock: false,",
    ].join("\n");
    const occurrences = original.split(expected).length - 1;
    expect(occurrences, "the Vite-transformed mock auth provider must match the test patch exactly").toBe(1);
    const patched = original.replace(expected, replacement);
    expect(patched).not.toBe(original);
    patchCount += 1;
    await route.fulfill({ response, body: patched });
  });
  return () => expect(patchCount, "the signed mock auth boundary should be installed").toBeGreaterThan(0);
}

async function installMathRoutes(page) {
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...matrixResponse(),
      usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
      saved: false,
      source: "incident persistence fixture",
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
  await page.route("**/api/explain-followup", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        answer: FOLLOWUP_ANSWER,
        requestId: body.requestId,
        conversationId: body.conversationId,
        targetRevision: body.targetRevision,
      }),
    });
  });
  await page.route("**/api/usage", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ usage: { ai: { used: 0, remaining: 999, limit: 999 } } }),
  }));
}

function savedSessionResponse(payload) {
  const now = new Date().toISOString();
  return {
    session: {
      createdAt: payload.createdAt || now,
      updatedAt: now,
      ...payload,
    },
  };
}

function payloadHasAssistantAnswer(payload) {
  return payload?.pinnedWindows?.some((item) => item.chatHistory?.some(
    (message) => message.role === "assistant" && message.text === FOLLOWUP_ANSWER,
  ));
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
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await contextClickSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
  const floatingWindow = page.locator(".omni-floating-window");
  await expect(floatingWindow).toContainText("obtained from its signed cofactor");
  return floatingWindow;
}

async function submitFollowup(page, floatingWindow) {
  const input = floatingWindow.getByPlaceholder("Ask about this");
  await input.fill(FOLLOWUP_QUESTION);
  await input.press("Enter");
  await expect(floatingWindow).toContainText("Delete row 2 and column 2");
  const assistantMessage = floatingWindow.locator("[data-followup-request-id]", {
    hasText: "Delete row 2 and column 2",
  });
  await expect(assistantMessage).toBeVisible();
  const requestId = await assistantMessage.getAttribute("data-followup-request-id");
  expect(requestId).toBeTruthy();
  await expect.poll(async () => page.evaluate((expectedRequestId) => {
    const events = window.__OMNIMATH_FOLLOWUP_REQUEST_EVENTS__ || [];
    return events
      .filter((event) => event.requestId === expectedRequestId)
      .map((event) => event.state);
  }, requestId)).toEqual(expect.arrayContaining([
    "request_started",
    "api_parsed",
    "committed_to_ui",
    "rendered",
    "local_window_update_requested",
  ]));
  const terminalOrder = await page.evaluate((expectedRequestId) => {
    const states = (window.__OMNIMATH_FOLLOWUP_REQUEST_EVENTS__ || [])
      .filter((event) => event.requestId === expectedRequestId)
      .map((event) => event.state);
    return ["api_parsed", "committed_to_ui", "rendered"].map((state) => states.indexOf(state));
  }, requestId);
  expect(terminalOrder[0]).toBeLessThan(terminalOrder[1]);
  expect(terminalOrder[1]).toBeLessThan(terminalOrder[2]);
  return { input, requestId };
}

for (const failure of [
  { method: "POST", code: "ECONNRESET" },
  { method: "PUT", code: "ECONNABORTED" },
]) {
  test(`a successful follow-up remains visible when its real session ${failure.method} returns ${failure.code}`, async ({ page }) => {
    const assertAuthPatched = await installSignedMockAuthBoundary(page);
    await installMathRoutes(page);
    let createdSessionSaved = false;
    let failedChatSaveMethod = "";
    let failedChatRequestId = "";
    await page.route("**/api/sessions**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
        return;
      }
      const payload = request.postDataJSON()?.session || {};
      if (payloadHasAssistantAnswer(payload)) {
        failedChatSaveMethod = request.method();
        failedChatRequestId = payload.pinnedWindows
          .flatMap((item) => item.chatHistory || [])
          .find((message) => message.role === "assistant" && message.text === FOLLOWUP_ANSWER)
          ?.requestId || "";
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: failure.code, message: `read ${failure.code}` }),
        });
        return;
      }
      if (failure.method === "POST") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: failure.code, message: `read ${failure.code}` }),
        });
        return;
      }
      createdSessionSaved = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedSessionResponse(payload)) });
    });

    const floatingWindow = await solveAndPinAdjugateTwenty(page);
    if (failure.method === "PUT") await expect.poll(() => createdSessionSaved).toBe(true);
    const { input, requestId } = await submitFollowup(page, floatingWindow);
    await expect.poll(() => failedChatSaveMethod).toBe(failure.method);
    expect(failedChatRequestId).toBe(requestId);
    await expect(page.getByText(`read ${failure.code}`)).toBeVisible();
    await expect(floatingWindow).toContainText("Delete row 2 and column 2");
    await expect(input).toBeEnabled();
    assertAuthPatched();
  });
}

test("a successful follow-up remains visible when the delayed session list connection resets", async ({ page }) => {
  const assertAuthPatched = await installSignedMockAuthBoundary(page);
  await installMathRoutes(page);
  let delayedListRoute;
  const delayedListStarted = new Promise((resolve) => {
    page.route("**/api/sessions**", async (route) => {
      const request = route.request();
      if (request.method() === "GET" && !delayedListRoute) {
        delayedListRoute = route;
        resolve();
        return;
      }
      const payload = request.postDataJSON()?.session || {};
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedSessionResponse(payload)) });
    });
  });

  const floatingWindow = await solveAndPinAdjugateTwenty(page);
  await delayedListStarted;
  const { input } = await submitFollowup(page, floatingWindow);
  await delayedListRoute.abort("connectionreset");
  await expect(page.getByText(/Failed to fetch/i)).toBeVisible();
  await expect(floatingWindow).toContainText("Delete row 2 and column 2");
  await expect(input).toBeEnabled();
  assertAuthPatched();
});

test("a stale successful session save cannot overwrite a newer visible follow-up", async ({ page }) => {
  const assertAuthPatched = await installSignedMockAuthBoundary(page);
  await installMathRoutes(page);
  let heldSave;
  let heldPayload;
  const heldSaveStarted = new Promise((resolve) => {
    page.route("**/api/sessions**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
        return;
      }
      if (!heldSave) {
        heldSave = route;
        heldPayload = request.postDataJSON()?.session || {};
        resolve();
        return;
      }
      const payload = request.postDataJSON()?.session || {};
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedSessionResponse(payload)) });
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Find the inverse by cofactors.");
  await expect(page.getByRole("button", { name: /Form the adjugate/i })).toBeVisible();
  await heldSaveStarted;
  expect(payloadHasAssistantAnswer(heldPayload)).toBeFalsy();

  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Form the adjugate/i }) });
  const targets = step.locator(".katex-html [data-semantic-selectable='true']");
  const targetIndex = await targets.evaluateAll((nodes) => nodes.findIndex((node) => node.textContent?.trim() === "20"));
  const box = await targets.nth(targetIndex).boundingBox();
  expect(box).not.toBeNull();
  await contextClickSemanticPointer(page, box.x + box.width / 2, box.y + box.height / 2);
  const floatingWindow = page.locator(".omni-floating-window");
  await expect(floatingWindow).toContainText("obtained from its signed cofactor");
  const { input } = await submitFollowup(page, floatingWindow);

  await heldSave.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(savedSessionResponse(heldPayload)),
  });
  await expect(floatingWindow).toContainText("Delete row 2 and column 2");
  await expect(input).toBeEnabled();
  assertAuthPatched();
});
