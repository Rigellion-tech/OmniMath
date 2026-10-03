// Offline presentation regression: one Newton step for min x^4+y^4+z^4, x+y+z=1.
export const phase5KktProblem = "Compute one Newton step for the KKT equations of min x^4+y^4+z^4 subject to x+y+z=1, starting at (x,y,z,lambda)=(1,1,1,0). State the constraint residual after the step.";
export const phase5KktConditions = String.raw`\begin{aligned}4x^3+\lambda&=0\\4y^3+\lambda&=0\\4z^3+\lambda&=0\\x+y+z-1&=0\end{aligned}`;
export const phase5KktSystem = String.raw`\begin{bmatrix}12x_k^2&0&0&1\\0&12y_k^2&0&1\\0&0&12z_k^2&1\\1&1&1&0\end{bmatrix}\begin{bmatrix}\Delta x_k\\\Delta y_k\\\Delta z_k\\\Delta\lambda_k\end{bmatrix}=-\begin{bmatrix}4x_k^3+\lambda_k\\4y_k^3+\lambda_k\\4z_k^3+\lambda_k\\x_k+y_k+z_k-1\end{bmatrix}`;
export const phase5KktEvaluatedSystem = String.raw`\begin{bmatrix}12&0&0&1\\0&12&0&1\\0&0&12&1\\1&1&1&0\end{bmatrix}\begin{bmatrix}\Delta x\\\Delta y\\\Delta z\\\Delta\lambda\end{bmatrix}=-\begin{bmatrix}4\\4\\4\\2\end{bmatrix}`;
export const phase5KktCorrection = String.raw`(\Delta x,\Delta y,\Delta z,\Delta\lambda)=(-\tfrac23,-\tfrac23,-\tfrac23,4)`;
export const phase5KktResult = String.raw`(x_1,y_1,z_1,\lambda_1)=(\tfrac13,\tfrac13,\tfrac13,4),\quad r_c=x_1+y_1+z_1-1=0`;
export const phase5KktDuplicatedFinal = String.raw`\begin{aligned}` + [
  String.raw`\mathcal L=x^4+y^4+z^4+\lambda(x+y+z-1)`,
  phase5KktConditions,
  phase5KktSystem,
  phase5KktEvaluatedSystem,
  phase5KktCorrection,
  phase5KktResult,
].join(String.raw`\\\quad `) + String.raw`\end{aligned}`;
export function makePhase5KktFixture({ finalAnswerLatex = phase5KktDuplicatedFinal, includeFinalStep = true } = {}) {
  return {
    title: "Constrained nonlinear KKT Newton step",
    problemLatex: String.raw`\min_{x,y,z}(x^4+y^4+z^4),\quad x+y+z=1`,
    steps: [
      ["lagrangian", "Form the Lagrangian", String.raw`\mathcal L=x^4+y^4+z^4+\lambda(x+y+z-1)`, "Introduce a multiplier for the equality constraint."],
      ["conditions", "KKT conditions", phase5KktConditions, "Set the stationarity equations and constraint to zero."],
      ["newton-system", "Linearize the KKT residual", phase5KktSystem, "The Jacobian gives the Newton system; the fourth row enforces the linearized constraint."],
      ["evaluated-system", "Evaluate at the starting point", phase5KktEvaluatedSystem, "Substitute the initial coordinates and multiplier."],
      ["correction", "Solve for the correction", phase5KktCorrection, "The fourth row gives equal corrections of minus two thirds; each stationarity row gives the multiplier correction four."],
      ["result", "Updated point and constraint residual", phase5KktResult, "This is one Newton step, not a claim of converged stationarity. The equality constraint residual is zero."],
    ].map(([id, heading, latex, reasoning]) => ({ id, heading, latex, reasoning, anchors: [] })).concat(includeFinalStep ? [{ id: "final-answer", heading: "Final Answer", latex: finalAnswerLatex, reasoning: "The updated point and constraint residual are stated above.", anchors: [] }] : []),
    finalAnswerLatex,
    numericCheck: "3*(1/3)-1=0; 12*(-2/3)+4=-4.",
  };
}
export const phase5WideMatrixResult = String.raw`A=\begin{bmatrix}\alpha_{11}+\beta_{11}+\gamma_{11}&\alpha_{12}+\beta_{12}+\gamma_{12}&\alpha_{13}+\beta_{13}+\gamma_{13}&\alpha_{14}+\beta_{14}+\gamma_{14}\\\alpha_{21}+\beta_{21}+\gamma_{21}&\alpha_{22}+\beta_{22}+\gamma_{22}&\alpha_{23}+\beta_{23}+\gamma_{23}&\alpha_{24}+\beta_{24}+\gamma_{24}\end{bmatrix}`;
export function makePhase5WideMatrixFixture() {
  return { title: "Matrix sum", problemLatex: "A=B+C+D", steps: [{ id: "matrix-result", heading: "Final Answer", latex: phase5WideMatrixResult, reasoning: "Add the entries componentwise.", anchors: [] }], finalAnswerLatex: phase5WideMatrixResult, numericCheck: "" };
}
