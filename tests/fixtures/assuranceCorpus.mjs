// Hand-authored reference claims. Expected evidence describes this bounded
// checker, not the mathematical truth of unsupported advanced problems.
const expected = Object.freeze({
  inputPass: { status: "supported_checks_passed", applicability: "applicable",
    evidence: "deterministic_input_linked_final_pass", recoveryBehavior: "none" },
  contradiction: { status: "contradiction_detected", applicability: "applicable",
    evidence: "deterministic_contradiction", recoveryBehavior: "one_shared_route_if_available" },
  internalContradiction: { status: "contradiction_detected", applicability: "applicable",
    evidence: "deterministic_internal_contradiction", recoveryBehavior: "one_shared_route_if_available" },
  unsupported: { status: "inconclusive", applicability: "unsupported",
    evidence: "inconclusive_or_unsupported", recoveryBehavior: "none" },
});
const item = (name, problem, step, final, expectation) => ({
  name, problem, candidate: {
    title: name, steps: [{ id: "s1", math: step, summary: "Candidate reasoning." }],
    finalAnswerLatex: final,
  },
  expected: expectation,
});

export const assuranceCorpus = [
  item("correct scalar algebra", "x^2=4", "x^2=4", "x=2", expected.inputPass),
  item("wrong scalar algebra", "x^2=4", "x^2=4", "x=3", expected.contradiction),
  item("correct derivative", "F(x)=x^3", "F'(x)=3*x^2", "F'(x)=3*x^2", expected.inputPass),
  item("wrong derivative", "F(x)=x^3", "F'(x)=2*x^2", "F'(x)=2*x^2", expected.contradiction),
  item("correct definite integral", String.raw`\int_0^1 x\,dx`, "1/2", "1/2", expected.inputPass),
  item("wrong numeric final answer", String.raw`\int_0^1 x\,dx`, "1/2", "3/4", expected.contradiction),
  item("equivalent symbolic forms", "F(x)=x^3", "F'(x)=x^2+x^2+x^2", "F'(x)=3*x^2", expected.inputPass),
  item("multiple valid branches", "x^2=4", "x^2=4", "x=-2", expected.inputPass),
  item("matrix solution", "Solve Ax=b for x", "Ax=b", String.raw`x=A^{-1}b`, expected.unsupported),
  item("vector calculus identity", String.raw`\nabla\cdot(\nabla\times F)=0`, String.raw`\nabla\times F`, "0", expected.unsupported),
  item("Euler-Lagrange", "Find the Euler-Lagrange equation", String.raw`\delta S=0`, String.raw`\frac{d}{dt}\frac{\partial L}{\partial \dot q}=\frac{\partial L}{\partial q}`, expected.unsupported),
  item("nonlinear PDE weak form", "Solve nonlinear PDE in weak form", String.raw`\int_\Omega \nabla u\cdot\nabla v=\int_\Omega fv`, String.raw`u\in H_0^1(\Omega)`, expected.unsupported),
  item("unsupported notation", "Evaluate a polylogarithm", String.raw`\operatorname{Li}_2(x)`, String.raw`\operatorname{Li}_2(1)`, expected.unsupported),
  item("symbolic integral", String.raw`\int \sin(x^2)\,dx`, String.raw`\int \sin(x^2)\,dx`, String.raw`F(x)`, expected.unsupported),
  item("eigenvalue problem", String.raw`Av=\lambda v`, String.raw`\det(A-\lambda I)=0`, String.raw`\lambda\in\sigma(A)`, expected.unsupported),
  item("constrained optimization", String.raw`\min f(x)\text{ subject to }g(x)=0`, String.raw`\nabla f=\lambda\nabla g`, String.raw`x=x^*`, expected.unsupported),
  item("Newton linearization", String.raw`F(u)=0`, String.raw`J(u_k)\delta u=-F(u_k)`, String.raw`u_{k+1}=u_k+\delta u`, expected.unsupported),
  item("complex-valued expression", String.raw`z^2=-1`, String.raw`z=i`, String.raw`z=\pm i`, expected.unsupported),
  item("piecewise domain restriction", "Solve x^2=4 for positive x", String.raw`x>0`, String.raw`x=2\text{ if }x>0`, expected.unsupported),
  item("internal contradictory constants", "Explain a scalar calculation", "2=3", "4", expected.internalContradiction),
  item("incomplete reasoning", "x^2=4", "x^2=4", "x", expected.unsupported),
];
