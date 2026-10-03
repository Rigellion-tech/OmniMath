import { expect, test } from "@playwright/test";
import { annotateMathExplanation } from "../server/mathAnnotator.js";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const expressions = [
  ["simple", "x+2=5"],
  ["rows", String.raw`\begin{aligned}x^2+2x+1&=(x+1)^2\\\frac{d}{dx}(x+1)^2&=2(x+1)\\x&=-1\end{aligned}`],
  ["matrix", String.raw`A=\begin{bmatrix}1&2&3\\4&5&6\\7&8&9\end{bmatrix}`],
  ["integral", String.raw`\int_0^1\int_0^x\frac{\sqrt{1+y^2}}{1+x^2}\,dy\,dx`],
  ["system", String.raw`\begin{aligned}-\nabla\cdot(a\nabla u)+\beta u&=f\\u|_{\partial\Omega}&=0\\u&\in H_0^1(\Omega)\end{aligned}`],
  ["long", `${Array.from({ length: 28 }, (_, i) => `a_{${i}}x^{${i + 1}}`).join("+")}=0`],
];

async function fixture(page, { stress = false, theme = "dark" } = {}) {
  const entries = stress
    ? Array.from({ length: 42 }, (_, i) => [
        `stress-${i}`,
        `x_{${i}}^2+y_{${i}}^2=z_{${i}}^2`,
      ])
    : expressions;
  const solution = annotateMathExplanation({
    title: "UI hardening fixture", problem: "Inspect the mathematical work.", expression: "x+2=5",
    steps: entries.map(([id, math]) => ({ id, label: `Inspect ${id}`, math, summary: "Preserve the supplied expression." })),
    finalAnswerLatex: entries.at(-1)[1],
  });
  const suppliedRoles = { rows: "simplification", matrix: "substitution", system: "final_answer" };
  for (const step of solution.steps) {
    if (suppliedRoles[step.id] && step.lines?.[0]) step.lines[0].role = suppliedRoles[step.id];
  }
  await page.addInitScript((theme) => localStorage.setItem("omnimath.settings.v1", JSON.stringify({ appearance: { theme } })), theme);
  await page.route("**/api/explain", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    ...solution, usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
  }) }));
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, (route) => {
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        title: `Explain ${body.selectedLatex}`,
        explanation: "Focused fixture explanation.",
        semanticId: body.semanticId,
        targetId: body.targetId,
      }) });
    });
  }
  await page.goto("/?mockAuth=1");
}

for (const theme of ["dark", "light"]) {
  test(`${theme}: large Advanced source has readable text, selection and focus`, async ({ page }) => {
    await fixture(page, { theme });
    await page.getByTestId("primary-composer-activate").click();
    await page.getByRole("tab", { name: "Advanced LaTeX" }).click();
    const editor = page.getByTestId("primary-raw-latex");
    const source = expressions.map(([, tex]) => tex).join("\n").repeat(15);
    await editor.fill(source);
    await expect(editor).toHaveValue(source);
    await expect(editor).toBeFocused();
    const contrast = await editor.evaluate((node) => {
      const luminance = (color) => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((c) => {
          const s = c / 255;
          return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
      const style = getComputedStyle(node);
      const selected = getComputedStyle(node, "::selection");
      return { text: ratio(style.color, style.backgroundColor), selection: ratio(selected.color, selected.backgroundColor), caret: style.caretColor, color: style.color, outline: style.outlineStyle };
    });
    expect(contrast.text).toBeGreaterThanOrEqual(4.5);
    expect(contrast.selection).toBeGreaterThanOrEqual(4.5);
    expect(contrast.caret).toBe(contrast.color);
    expect(contrast.outline).not.toBe("none");
  });
}

test("semantic role color remains stable while hover and pin use distinct non-color emphasis", async ({ page }) => {
  await fixture(page);
  await submitCurrentComposer(page, "Inspect the mathematical work.");
  const step = page.locator("article[data-step-id='simple']");
  const variableOwners = step.locator(".katex-html [data-semantic-kind='leaf'][data-semantic-role='variable']");
  await expect(variableOwners.first()).toBeVisible();
  const normalColors = await variableOwners.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
  expect(new Set(normalColors).size).toBe(1);

  const target = step.locator("[data-inspectable='math-subtoken']").first();
  const semanticId = await target.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  await target.hover({ force: true });
  await expect(target).toHaveAttribute("data-active-target", "true");
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  const hoverStyle = await target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(hoverStyle.outlineStyle).toBe("solid");
  expect(parseFloat(hoverStyle.outlineWidth)).toBeGreaterThan(0);
  expect(await variableOwners.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color))).toEqual(normalColors);

  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const pinned = page.locator(`.omni-pinned-card[data-semantic-id='${semanticId}']`);
  await expect(pinned).toBeVisible();
  await expect(pinned).toHaveAttribute("data-placement-mode", "stacked");
  await expect(target).toHaveAttribute("data-pinned-target", "true");
  const pinStyle = await target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { borderStyle: style.borderBottomStyle, borderWidth: style.borderBottomWidth };
  });
  expect(pinStyle.borderStyle).toBe("solid");
  expect(parseFloat(pinStyle.borderWidth)).toBeGreaterThan(0);
});

for (const [width, zoom] of [[1920, .75], [1440, 1], [1152, 1.25]]) {
  test(`math remains reachable at width ${width}, CSS zoom ${zoom}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, zoom);
    await submitCurrentComposer(page, "Inspect the mathematical work.");
    await expect(page.getByRole("button", { name: "Inspect system" })).toBeVisible();
    await expect(page.locator("article[data-step-id='rows']").getByText("Simplification", { exact: true })).toBeVisible();
    await expect(page.locator("article[data-step-id='matrix']").getByText("Substitution", { exact: true })).toBeVisible();
    await expect(page.locator("article[data-step-id='system']").getByText("Final result", { exact: true })).toBeVisible();
    for (const [id] of expressions) {
      const step = page.locator(`article[data-step-id='${id}']`);
      await expect(step.locator(".katex-html").first()).toBeVisible();
      await expect(step.locator("[data-math-render-error='true']")).toHaveCount(0);
      const overflow = await step.evaluate((node) => [...node.querySelectorAll(".math-render-shell-block")].map((el) => ({
        vertical: el.scrollHeight - el.clientHeight,
        scrolls: el.scrollWidth > el.clientWidth + 1,
        scrollingAncestor: Boolean(el.parentElement?.closest(".math-render-shell-block")),
      })));
      expect(overflow.filter((value) => value.vertical > 4), `${id} should grow vertically: ${JSON.stringify(overflow)}`).toEqual([]);
      expect(overflow.filter((value) => value.scrolls && value.scrollingAncestor), `${id} should have at most one horizontal scroller`).toEqual([]);
    }
    const rows = page.locator("article[data-step-id='rows'] .katex-html .mtable").first();
    await expect(rows).toBeVisible();
    const rowExtent = await rows.evaluate((node) => {
      const rects = [...node.querySelectorAll(".mord, .mrel")].map((part) => part.getBoundingClientRect()).filter((rect) => rect.width && rect.height);
      return Math.max(...rects.map((rect) => rect.bottom)) - Math.min(...rects.map((rect) => rect.top));
    });
    expect(rowExtent).toBeGreaterThan(70 * zoom);
    if (width / zoom >= 1024) {
      await page.getByTestId("sidebar-collapse").click();
      await expect(page.getByTestId("sidebar-expand")).toBeVisible();
      await expect(page.getByTestId("session-sidebar").getByRole("button", { name: "New session" })).toBeVisible();
      await page.getByTestId("sidebar-expand").click();
    }
  });
}

test("300+ semantic nodes settle and retain a responsive, stable hover owner", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await fixture(page, { stress: true });
  await submitCurrentComposer(page, "Inspect the mathematical work.");
  const step = page.locator("article[data-step-id='stress-0']");
  await expect(step.locator("[data-inspectable='math-subtoken']").first()).toBeVisible({ timeout: 60_000 });
  const owners = page.locator(".katex-html [data-semantic-id]");
  await expect.poll(() => owners.count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(300);
  const hoverAnchor = step.locator("[data-inspectable='math-subtoken'][data-token-latex='+']").first();
  await expect(hoverAnchor).toHaveAttribute("data-rect-source", /semantic-dom/);
  await hoverAnchor.scrollIntoViewIfNeeded();
  const identity = await hoverAnchor.getAttribute("data-semantic-id");
  const targetBox = await hoverAnchor.boundingBox();
  expect(targetBox).not.toBeNull();
  const started = Date.now();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  await expect(hoverAnchor).toHaveAttribute("data-active-target", "true");
  const activationMs = Date.now() - started;
  const clearStarted = Date.now();
  await page.mouse.move(4, 4);
  await expect(hoverAnchor).not.toHaveAttribute("data-active-target", "true");
  const clearMs = Date.now() - clearStarted;
  expect(activationMs).toBeLessThan(2000);
  expect(clearMs).toBeLessThan(2000);
  await expect(step.locator(`[data-inspectable][data-semantic-id='${identity}']`)).toHaveCount(1);
  const metrics = await page.evaluate(() => ({
    longTasks: window.__OMNIMATH_PERF__?.longTasks,
    worker: window.__OMNIMATH_PERF__?.measurements.filter((m) => m.name === "semantic-render.worker"),
    geometry: window.__OMNIMATH_GEOMETRY_SCHEDULER__,
  }));
  await testInfo.attach("stress-metrics", { body: JSON.stringify({ activationMs, clearMs, ...metrics }, null, 2), contentType: "application/json" });
  expect(metrics.worker.length).toBeGreaterThan(0);
});
