/**
 * General solution acceptance corpus.
 *
 * The examples are deliberately domain diverse.  They test representation
 * shape at the acceptance boundary; they do not assert that the verifier has
 * proved the mathematics.
 */
const cases = [
  ["algebra", "x^2-5x+6=0", "x\\in\\{2,3\\}", "x_1=2,\\quad x_2=3"],
  ["calculus", "\\frac{d}{dx}\\sin x=\\cos x", "\\int_0^1 x\\,dx=\\frac12", "\\int_0^1x\\,dx=\\frac12,\\quad [x^2/2]_0^1=\\frac12"],
  ["multivariable-calculus", "\\nabla f=(2x,2y)", "f(x,y)=x^2+y^2", "f(x,y)=x^2+y^2,\\quad \\nabla f=(2x,2y)"],
  ["linear-algebra", "A\\mathbf v=\\lambda\\mathbf v", "(\\lambda,\\mathbf v)=(2,(1,1))", "\\lambda=2,\\quad\\mathbf v=(1,1)"],
  ["odes", "y''+y=0", "y(t)=C_1\\cos t+C_2\\sin t", "y(t)=C_1\\cos t+C_2\\sin t,\\quad y'(t)=-C_1\\sin t+C_2\\cos t"],
  ["pdes", "u_t=\\kappa u_{xx}", "u(0,t)=u(L,t)=0", "u_t=\\kappa u_{xx},\\quad u(0,t)=u(L,t)=0"],
  ["probability-statistics", "X\\sim\\mathcal N(\\mu,\\sigma^2)", "P(X>0)=1-\\Phi\\left(\\frac{-\\mu}{\\sigma}\\right),\\quad \\sigma>0", "P(X>0)=\\Phi(\\mu/\\sigma),\\quad\\sigma>0"],
  ["optimization", "\\min_x f(x)\\quad\\text{s.t.}\\quad g(x)\\le0", "\\nabla f(x^*)+\\lambda\\nabla g(x^*)=0,\\quad \\lambda g(x^*)=0", "\\nabla f(x^*)+\\lambda\\nabla g(x^*)=0,\\quad\\lambda g(x^*)=0"],
  ["numerical-methods", "x_{n+1}=x_n-\\frac{f(x_n)}{f'(x_n)}", "x_3=1.41421356\\ldots", "x_3=1.41421356,\\quad |x_3-\\sqrt2|<10^{-7}"],
  ["vector-calculus", "\\nabla\\times\\mathbf F=\\mathbf 0", "\\oint_C\\mathbf F\\cdot d\\mathbf r=0", "\\nabla\\times\\mathbf F=\\mathbf0,\\quad\\oint_C\\mathbf F\\cdot d\\mathbf r=0"],
  ["complex-analysis", "f(z)=\\frac1z", "\\mathop{\\rm Res}_{z=0}f=1", "\\mathop{\\rm Res}_{z=0}f=1,\\quad\\oint_C f(z)\\,dz=2\\pi i"],
  ["mathematical-physics", "\\nabla\\cdot\\mathbf E=\\frac{\\rho}{\\varepsilon_0}", "\\nabla\\times\\mathbf E=-\\frac{\\partial\\mathbf B}{\\partial t}", "\\nabla\\cdot\\mathbf E=\\frac{\\rho}{\\varepsilon_0},\\quad\\nabla\\times\\mathbf E=-\\frac{\\partial\\mathbf B}{\\partial t}"],
  ["thermodynamics", "dU=T\\,dS-P\\,dV", "H=U+PV,\\quad dH=T\\,dS+V\\,dP", "H=U+PV,\\quad dH=T\\,dS+V\\,dP"],
  ["matrices-tensors", "M=\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}", "\\det M=-2,\\quad \\operatorname{tr}M=5", "\\det M=-2,\\quad\\operatorname{tr}M=5"],
  ["systems", "\\begin{cases}x+y=3\\\\x-y=1\\end{cases}", "(x,y)=(2,1)", "x=2,\\quad y=1"],
  ["piecewise", "f(x)=\\begin{cases}x^2,&x\\ge0\\\\-x,&x<0\\end{cases}", "f(-1)=1,\\quad f(2)=4", "f(-1)=1,\\quad f(2)=4"],
];

function step(latex, index, heading = "Derive") {
  return {
    id: `corpus-${index + 1}`,
    heading,
    latex,
    reasoning: "Apply the stated definition and simplify the result.",
    anchors: [],
  };
}

export function makeFastResponse({ problemLatex, finalAnswerLatex, steps = [problemLatex, finalAnswerLatex], title = "Corpus solve" }) {
  return {
    title,
    problemLatex,
    steps: steps.map((latex, index) => step(latex, index, index === steps.length - 1 ? "Final Answer" : "Derive")),
    finalAnswerLatex,
    numericCheck: "",
  };
}

export const solutionAcceptanceCorpus = cases.map(([domain, problemLatex, finalAnswerLatex, related], index) => {
  const unchanged = makeFastResponse({ problemLatex, finalAnswerLatex });
  const normalized = makeFastResponse({
    problemLatex: `$$${problemLatex}$$`,
    finalAnswerLatex: `\\(${finalAnswerLatex}\\)`,
    steps: [`\\[${problemLatex}\\]`, `$$${finalAnswerLatex}$$`],
  });
  const warned = makeFastResponse({
    problemLatex,
    finalAnswerLatex: `\\begin{aligned}${related}\\end{aligned}`,
    steps: [problemLatex, `\\begin{aligned}${related}\\end{aligned}`],
  });
  const rejected = makeFastResponse({ problemLatex, finalAnswerLatex });
  const negativeKind = ["broken-braces", "trailing-backslash", "unmatched-environment", "empty-step", "duplicate-step-id"][index % 5];
  if (negativeKind === "broken-braces") rejected.finalAnswerLatex = "\\frac{1}{2";
  if (negativeKind === "trailing-backslash") rejected.finalAnswerLatex = "x=1\\";
  if (negativeKind === "unmatched-environment") rejected.finalAnswerLatex = "\\begin{aligned}x=1";
  if (negativeKind === "empty-step") rejected.steps[1].latex = "";
  if (negativeKind === "duplicate-step-id") rejected.steps[1].id = rejected.steps[0].id;
  // Keep the negative shape varied while guaranteeing a genuinely fatal
  // renderability defect even if one lexical detector is made recoverable.
  if (!rejected.finalAnswerLatex.includes("\\frac{1}{")
    && negativeKind !== "trailing-backslash"
    && negativeKind !== "unmatched-environment") rejected.steps[1].latex = "\\frac{1}{";
  rejected.steps[0].latex = negativeKind === "empty-step" ? "" : rejected.steps[0].latex;
  if (negativeKind === "trailing-backslash" || negativeKind === "unmatched-environment") rejected.steps[1].latex = "";
  if (negativeKind === "broken-braces") rejected.steps[1].latex = "";
  return { domain, unchanged, normalized, warned, rejected, negativeKind };
});

export const corpusDomains = solutionAcceptanceCorpus.map(({ domain }) => domain);
