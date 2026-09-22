import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";

const problemLatex = String.raw`A=\begin{bmatrix}4&1&2\\0&3&1\\0&2&5\end{bmatrix}`;

function solvedMatrixResponse() {
  const problem = String.raw`Find the inverse of ${problemLatex}`;
  return annotateMathExplanation({
    title: "Inverse by cofactors",
    problem,
    originalProblem: problem,
    expression: problem,
    assumptions: [String.raw`\det(A)\ne0`],
    steps: [
      { id: "s1", label: "Compute the determinant", math: String.raw`\det(A)=52`, summary: "The determinant is nonzero." },
      { id: "s2", label: "Build the selected minor", math: String.raw`M_{22}=\begin{bmatrix}4&2\\0&5\end{bmatrix}`, summary: "Delete row 2 and column 2." },
      { id: "s3", label: "Evaluate the cofactor", math: String.raw`C_{22}=(-1)^{2+2}(4\cdot5-2\cdot0)=20`, summary: "Apply the positive cofactor sign." },
      { id: "s4", label: "Form the adjugate", math: String.raw`\operatorname{adj}(A)=\begin{bmatrix}13&-1&-5\\0&20&-4\\0&-8&12\end{bmatrix}`, summary: "Transpose the cofactor matrix." },
      { id: "s5", label: "Form the inverse", math: String.raw`A^{-1}=\frac1{52}\operatorname{adj}(A)`, summary: "Divide by the determinant." },
    ],
    finalAnswerLatex: String.raw`A^{-1}=\frac1{52}\begin{bmatrix}13&-1&-5\\0&20&-4\\0&-8&12\end{bmatrix}`,
  });
}

async function installOfflineRoutes(page) {
  const requests = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort("blockedbyclient");
  });

  // Playwright applies the last matching route first, so this blocks only
  // unrecognized API requests after the explicit fixtures below decline none.
  await page.route(/\/api\/(?!.*\.js)(?:[^/]+)$/, async (route) => {
    requests.push({ endpoint: new URL(route.request().url()).pathname, unexpected: true });
    await route.abort("blockedbyclient");
  });
  await page.route("**/api/explain", async (route) => {
    requests.push({ endpoint: "/api/explain", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...solvedMatrixResponse(),
        usage: { tier: "test", kind: "explanation", used: 17, remaining: 8, limit: 25 },
        saved: false,
        source: "primary composer scope fixture",
      }),
    });
  });
  await page.route("**/api/explain-token", async (route) => {
    const body = route.request().postDataJSON();
    requests.push({ endpoint: "/api/explain-token", body });
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
    requests.push({ endpoint: "/api/explain-pin", body });
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
    requests.push({ endpoint: "/api/explain-followup", body });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        answer: "It comes from the signed cofactor for the same matrix entry.",
        requestId: body.requestId,
        conversationId: body.conversationId,
        targetRevision: body.targetRevision,
      }),
    });
  });

  return requests;
}

async function setMathfieldLatex(mathfield, latex) {
  await mathfield.evaluate((element, nextLatex) => {
    element.setValue(nextLatex, { suppressChangeNotifications: false });
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }, latex);
}

async function hoverAdjugateTwenty(page) {
  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Form the adjugate/i }) });
  await expect(step).toBeVisible();
  const targets = step.locator(".katex-html [data-semantic-selectable='true']");
  await expect.poll(() => targets.count()).toBeGreaterThan(0);
  const index = await targets.evaluateAll((nodes) => nodes.findIndex((node) => node.textContent?.trim() === "20"));
  expect(index).toBeGreaterThanOrEqual(0);
  const target = targets.nth(index);
  const semanticId = await target.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  const tooltip = page.locator(".omni-quick-tooltip");
  await expect(tooltip).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  return { target, tooltip, semanticId, point };
}

async function assertCompactSecondaryInput(window) {
  const input = window.getByPlaceholder("Ask about this");
  await expect(input).toBeVisible();
  await expect(input).toHaveJSProperty("tagName", "INPUT");
  await expect(window.locator("math-field")).toHaveCount(0);
  await expect(window.locator("[data-testid='math-symbol-browser']")).toHaveCount(0);
  await expect(window.getByRole("button", { name: /Solve|Open universal symbol browser|Fraction|Matrix|Cases/i })).toHaveCount(0);
  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox.height).toBeLessThan(48);
}

test.describe("primary composer scope, header, and responsive palette", () => {
  test("primary expansion cannot take over hover or pinned follow-up ownership", async ({ page }) => {
    const requests = await installOfflineRoutes(page);
    await page.goto("/?mockAuth=1");

    const composer = page.getByTestId("primary-math-composer");
    const mathfield = page.getByTestId("primary-math-field");
    await expect(composer).toHaveAttribute("data-composer-state", "collapsed");
    await page.getByTestId("primary-composer-activate").click();
    await expect(composer).toHaveAttribute("data-composer-state", "expanded");
    await setMathfieldLatex(mathfield, problemLatex);
    await page.getByTestId("primary-composer-solve").click();

    await expect(composer).toHaveAttribute("data-composer-state", "collapsed");
    await expect(page.getByText("Inverse by cofactors")).toBeVisible();
    await expect(page.getByText(/17\/25 used today/i)).toHaveCount(0);

    const { target, tooltip, semanticId, point } = await hoverAdjugateTwenty(page);
    await expect(tooltip.locator("math-field")).toHaveCount(0);
    await expect(tooltip.locator("[data-testid='math-symbol-browser']")).toHaveCount(0);
    await expect(tooltip.getByRole("button", { name: /Solve|Open universal symbol browser/i })).toHaveCount(0);

    await page.mouse.click(point.x, point.y, { button: "right" });
    const pinned = page.locator(".omni-floating-window");
    await expect(pinned).toHaveAttribute("data-semantic-id", semanticId);
    await expect(pinned).toContainText("obtained from its signed cofactor");
    await assertCompactSecondaryInput(pinned);

    const followup = pinned.getByPlaceholder("Ask about this");
    await followup.fill("Where did this entry come from?");
    await followup.press("Enter");
    await expect(pinned).toContainText("same matrix entry");
    const followupRequest = requests.find((request) => request.endpoint === "/api/explain-followup");
    expect(followupRequest.body.provenanceSnapshot.target.semanticId).toBe(semanticId);

    await page.getByRole("button", { name: "Edit submitted problem" }).click();
    await expect(composer).toHaveAttribute("data-composer-state", "expanded");
    await assertCompactSecondaryInput(pinned);
    await expect(pinned).toHaveAttribute("data-semantic-id", semanticId);
    await expect(target).toHaveAttribute("data-semantic-id", semanticId);
    expect(requests.filter((request) => request.unexpected)).toEqual([]);
  });

  test("compact header keeps export accessible without presenting usage", async ({ page }) => {
    await installOfflineRoutes(page);
    await page.goto("/?mockAuth=1");
    const header = page.locator("header");
    const box = await header.boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeLessThan(190);
    await expect(page.getByText(/used today|remaining today|token usage/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Session actions" }).click();
    const menu = page.getByRole("menu", { name: "Session actions" });
    await expect(menu).toBeVisible();
    const download = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: "Save as Markdown" }).click();
    await expect((await download).suggestedFilename()).toMatch(/\.md$/);
  });

  test("mobile symbol browser remains viewport-bound and scrolls internally", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await installOfflineRoutes(page);
    await page.goto("/?mockAuth=1");
    await page.getByTestId("primary-composer-activate").click();
    await page.getByRole("button", { name: "Open universal symbol browser" }).click();

    const browser = page.getByTestId("math-symbol-browser");
    await expect(browser).toBeVisible();
    const bounds = await browser.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);

    const grid = browser.getByRole("grid", { name: "Mathematical symbols" });
    await expect.poll(() => grid.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await browser.getByRole("textbox", { name: "Search mathematical symbols" }).fill("surface integral");
    const result = browser.getByRole("gridcell", { name: /surface integral/i }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(browser).toHaveCount(0);

    await page.getByRole("button", { name: "Open universal symbol browser" }).click();
    await browser.getByRole("button", { name: /^recent$/i }).click();
    await expect(browser.getByRole("gridcell", { name: /surface integral/i })).toHaveCount(1);
  });

  test("desktop expansion is measured and palette navigation crosses category boundaries", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await installOfflineRoutes(page);
    await page.goto("/?mockAuth=1");
    const composer = page.getByTestId("primary-math-composer");
    const collapsed = await composer.boundingBox();
    expect(collapsed).not.toBeNull();
    await page.getByTestId("primary-composer-activate").click();
    await expect(composer).toHaveAttribute("data-composer-state", "expanded");
    await expect.poll(async () => (await composer.boundingBox())?.height || 0).toBeGreaterThan(300);
    const expanded = await composer.boundingBox();
    expect(expanded.height).toBeGreaterThanOrEqual(350);
    expect(expanded.height).toBeLessThanOrEqual(450);
    expect(expanded.height).toBeGreaterThan(collapsed.height + 250);
    const layout = await page.evaluate(() => {
      const composer = document.querySelector("[data-testid='primary-math-composer']");
      return {
        transition: getComputedStyle(composer).transitionDuration,
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(layout.transition).toMatch(/(?:0\.[1-9]\d*|[1-9]\d*(?:\.\d+)?)s/);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);

    await page.getByRole("button", { name: "Open universal symbol browser" }).click();
    const browser = page.getByTestId("math-symbol-browser");
    await browser.locator('[aria-label="Symbol categories"]').getByRole("button", { name: /^arithmetic$/i }).click();
    await browser.locator('[aria-label="Symbol subcategories"]').getByRole("button", { name: /^binary operators$/i }).click();
    const grid = browser.getByRole("grid", { name: "Mathematical symbols" });
    const columns = await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length);
    expect(columns).toBeGreaterThan(1);
    expect(await grid.getByRole("gridcell").count()).toBeGreaterThan(columns);
    await grid.getByRole("gridcell").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(grid.getByRole("gridcell").nth(columns)).toBeFocused();

    await browser.getByRole("textbox", { name: "Search mathematical symbols" }).fill("Hessian");
    await expect(browser.getByRole("gridcell", { name: /Hessian/i }).first()).toBeVisible();
  });

  test("raw custom source and prose survive successful solve and session switching", async ({ page }) => {
    const requests = await installOfflineRoutes(page);
    await page.goto("/?mockAuth=1");
    const composer = page.getByTestId("primary-math-composer");
    const prose = "Evaluate the flux with the stated boundary condition.";
    const customLatex = String.raw`\operatorname{CustomFlux}_{\alpha}(x)=\int_{\partial\Omega}\mathbf{F}\cdot d\mathbf{S}`;
    await page.getByTestId("primary-composer-activate").click();
    await composer.getByPlaceholder(/Describe assumptions, boundary conditions/i).fill(prose);
    await composer.getByRole("tab", { name: "Advanced LaTeX" }).click();
    await composer.getByTestId("primary-raw-latex").fill(customLatex);
    await page.getByTestId("primary-composer-solve").click();
    await expect(composer).toHaveAttribute("data-composer-state", "collapsed");

    const solve = requests.find((request) => request.endpoint === "/api/explain");
    expect(solve?.body?.canonicalProblem?.canonicalText).toBe(`${prose}\n\n${customLatex}`);
    expect(solve?.body?.canonicalProblem?.canonicalLatex).toBe(customLatex);
    expect(solve?.body?.canonicalProblem?.source).toBe("typed");
    const originalSession = page.locator(".omni-sidebar button", { hasText: "Inverse by cofactors" }).first();
    await expect(originalSession).toBeVisible();
    await page.getByRole("button", { name: "New session" }).click();
    await expect(page.getByTestId("primary-composer-activate")).toBeVisible();
    await originalSession.click();
    await expect(composer).toHaveAttribute("data-composer-state", "collapsed");
    await expect(page.getByTestId("primary-composer-compact-problem")).toContainText(prose);
    await page.getByRole("button", { name: "Edit submitted problem" }).click();
    await expect(composer).toHaveAttribute("data-composer-state", "expanded");
    await expect(composer.getByRole("tab", { name: "Advanced LaTeX" })).toHaveAttribute("aria-selected", "true");
    await expect(composer.getByPlaceholder(/Describe assumptions, boundary conditions/i)).toHaveValue(prose);
    await expect(composer.getByTestId("primary-raw-latex")).toHaveValue(customLatex);
    expect(requests.filter((request) => request.unexpected)).toEqual([]);
  });
});
