import { expect, test } from "@playwright/test";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

const finalAnswer = String.raw`\begin{aligned}-\operatorname{div}((1+\alpha|\nabla u|^2)\nabla u)+\beta u-\lambda|u|^{p-2}u&=0 \quad u|_{\partial\Omega}&=0\\u&\in H_0^1(\Omega)\end{aligned}`;

const expressions = [
  ["aligned", finalAnswer],
  ["gathered", String.raw`\begin{gathered}x+y=1\\x-y=0\end{gathered}`],
  ["cases", String.raw`\begin{cases}x+y=1\\x-y=0\end{cases}`],
  ["array", String.raw`\begin{array}{cc}a=b&c+d=e\\f=g&h=i\end{array}`],
  ["matrix", String.raw`M=\begin{bmatrix}a=b&c+d\\e&f=g\end{bmatrix}`],
  ["bare-rows", String.raw`x=1\\u=2`],
  ["spacing", String.raw`x\ y+\frac{1}{2}`],
];

test("related multiline final answers keep complete TeX environments renderable", async ({ page }) => {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "multiline-final-render",
        title: "Multiline systems",
        problem: "Render related equations.",
        expression: "x+y=1",
        steps: expressions.map(([name, latex]) => ({
          id: name,
          label: name === "aligned" ? "Final Answer" : `${name} system`,
          math: latex,
          summary: "Related equations are shown together.",
          chunks: [{ id: `${name}-chunk`, display: latex, latex, text: latex, role: "equation" }],
          lines: [{ id: `${name}-line`, kind: "math", role: name === "aligned" ? "final_answer" : "solution_step", text: "", latex, tokens: [] }],
        })),
        finalAnswerLatex: finalAnswer,
        finalAnswer,
        usage: { kind: "explanation", aggregateKind: "ai", tier: "test", used: 1, remaining: 99, limit: 100 },
        saved: false,
        demoMode: true,
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, "Render related equations.");

  for (const [name] of expressions) {
    const step = page.locator(`article[data-step-id='${name}']`);
    await expect(step.locator(".katex-html").first()).toBeVisible();
    await expect(step.locator("[data-math-render-error='true']")).toHaveCount(0);
    await expect(step.locator(".omni-equation-chain-separator")).toHaveCount(0);
  }
  await expect(page.locator("article[data-step-id='aligned'] [data-math-render-outcome='rendered']")).toHaveCount(1);
});
