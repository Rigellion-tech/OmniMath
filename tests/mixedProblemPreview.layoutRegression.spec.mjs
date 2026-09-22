import { expect, test } from "@playwright/test";

const MIXED_VARIATIONAL_PROBLEM = "For J[u]=∫_Ω(1/2|∇u|²+α/6|∇u|⁶+β/2 u²−λ/q|u|^q)dx, α,β,λ>0, 2<q<4, u|∂Ω=0: derive the Euler-Lagrange PDE, linearize it at a critical point u*, compute J''[u*](v,v), and give the lowest-eigenvalue/Rayleigh-quotient condition for u* to be a strict local minimum. Show the nonlinear gradient-term linearization explicitly.";

test("canonical-text-only problem preview preserves prose and renders only math spans", async ({ page }) => {
  let solveRequest = null;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname !== "/api/explain") return route.abort();

    solveRequest = route.request().postDataJSON();
    return route.fulfill({
      json: {
        title: "Variational problem",
        canonicalProblem: solveRequest.canonicalProblem,
        originalProblem: solveRequest.problem,
        expression: solveRequest.problem,
        steps: [{
          id: "step-1",
          label: "Fixture result",
          math: "L_*v=0",
          summary: "Deterministic local fixture.",
        }],
        finalAnswerLatex: "L_*v=0",
      },
    });
  });

  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByText("Problem context (optional)").locator("..").getByRole("textbox").fill(MIXED_VARIATIONAL_PROBLEM);
  await page.getByTestId("primary-composer-solve").click();
  await expect.poll(() => solveRequest).not.toBeNull();

  expect(solveRequest.problem).toBe(MIXED_VARIATIONAL_PROBLEM);
  expect(solveRequest.canonicalProblem.canonicalText).toBe(MIXED_VARIATIONAL_PROBLEM);
  expect(solveRequest.canonicalProblem.canonicalLatex).toBe("");

  await page.getByRole("button", { name: "View full problem" }).click();
  const preview = page.getByText("Math preview", { exact: true }).locator("..");
  await expect(preview).toContainText("derive the Euler-Lagrange PDE, linearize it");
  await expect(preview).toContainText("lowest-eigenvalue/Rayleigh-quotient condition");
  await expect(preview.locator(".katex")).not.toHaveCount(0);

  const proseInsideKatex = await preview.locator(".katex").evaluateAll((nodes) => nodes.some((node) => (
    /Euler|Lagrange|lowest|eigenvalue|Rayleigh|quotient|gradient|term/u.test(node.textContent || "")
  )));
  expect(proseInsideKatex).toBe(false);

  const renderedText = await preview.textContent();
  expect(renderedText).toContain("Show the nonlinear gradient-term linearization explicitly.");
  expect(renderedText).not.toContain("derivetheEuler-LagrangePDE");
});
