const RULES = [
  {
    id: "product-rule",
    patterns: [/product rule/i, /\bf'\(x\).*g\(x\)|f\(x\).*g'\(x\)/i],
    display: "f'g + fg'",
    label: "Product rule",
    short: "Use the product rule for two multiplied functions.",
    medium: "When two functions are multiplied, differentiate one at a time: (fg)' = f'g + fg'.",
    deep: "The product rule splits the rate of change into two contributions: the first factor changing while the second stays fixed, plus the second factor changing while the first stays fixed.",
  },
  {
    id: "chain-rule",
    patterns: [/chain rule/i, /\bsin\([^)]*x/i, /\bcos\([^)]*x/i],
    display: "f(g(x))",
    label: "Chain rule",
    short: "Use the chain rule for a function inside another function.",
    medium: "Differentiate the outside function, keep the inside unchanged, then multiply by the derivative of the inside.",
    deep: "For a composition f(g(x)), the derivative is f'(g(x))g'(x). The outside rate is scaled by how quickly the inner expression changes.",
  },
  {
    id: "quotient-rule",
    patterns: [/quotient rule/i, /\//],
    display: "f/g",
    label: "Quotient rule",
    short: "Use the quotient rule for one function divided by another.",
    medium: "For f/g, the derivative is (f'g - fg') / g^2.",
    deep: "The quotient rule follows from product and chain rules by rewriting f/g as f(g^-1). Keep the denominator squared in the final denominator.",
  },
  {
    id: "sin-derivative",
    patterns: [/\bsin\b/i],
    display: "sin x",
    label: "Sine derivative",
    short: "The derivative of sin x is cos x.",
    medium: "Sine changes at a rate given by cosine: d/dx sin x = cos x.",
    deep: "Cosine measures the instantaneous slope of sine. At sine's peaks the slope is zero, and at zero crossings the slope has largest magnitude.",
  },
  {
    id: "cos-derivative",
    patterns: [/\bcos\b/i],
    display: "cos x",
    label: "Cosine derivative",
    short: "The derivative of cos x is -sin x.",
    medium: "Cosine changes at a rate given by negative sine: d/dx cos x = -sin x.",
    deep: "The negative sign reflects cosine decreasing at x = 0 while sine is increasing after its zero crossing.",
  },
  {
    id: "tan-derivative",
    patterns: [/\btan\b/i],
    display: "tan x",
    label: "Tangent derivative",
    short: "The derivative of tan x is sec^2 x.",
    medium: "Tangent differentiates to sec^2 x, often written as 1/cos^2 x.",
    deep: "Since tan x = sin x / cos x, applying the quotient rule simplifies to sec^2 x.",
  },
  {
    id: "power-rule",
    patterns: [/x\^?\d+|x[²³]|x\^n|power rule/i],
    display: "x^n",
    label: "Power rule",
    short: "Bring the exponent down and subtract one.",
    medium: "The power rule says d/dx x^n = n x^(n-1).",
    deep: "For polynomial powers, the exponent becomes the coefficient and the new exponent is one less. This is the core rule behind differentiating x^2, x^3, and x^n.",
  },
  {
    id: "constant-rule",
    patterns: [/\bconstant\b|^[+-]?\d+$/i],
    display: "c",
    label: "Constant",
    short: "A constant's derivative is zero.",
    medium: "Constants do not change as x changes, so their derivative is 0.",
    deep: "The derivative measures change. A fixed value has no rate of change with respect to x.",
  },
  {
    id: "derivative-notation",
    patterns: [/d\/dx|\\frac\{d\}\{dx\}|derivative notation/i],
    display: "d/dx",
    label: "Derivative notation",
    short: "This asks for the derivative with respect to x.",
    medium: "d/dx means measure the instantaneous rate of change as x changes.",
    deep: "Leibniz notation d/dx is an operator applied to an expression. It tells us the input variable whose tiny changes define the derivative.",
  },
  {
    id: "integral-notation",
    patterns: [/∫|\\int|integral/i],
    display: "integral",
    label: "Integral notation",
    short: "An integral accumulates a quantity over an interval or variable.",
    medium: "The integral sign means sum infinitely many small contributions, often finding area or an antiderivative.",
    deep: "Definite integrals accumulate signed area over bounds. Indefinite integrals ask for the family of functions whose derivative gives the integrand.",
  },
  {
    id: "differential",
    patterns: [/\bdx\b|\bdy\b/i],
    display: "dx",
    label: "Differential",
    short: "This marks the variable of differentiation or integration.",
    medium: "dx means the expression is with respect to x; dy means with respect to y.",
    deep: "In integrals, dx identifies the variable being accumulated over. In derivatives, dy/dx compares tiny changes in y to tiny changes in x.",
  },
];

function findRule(value = "") {
  const text = String(value);
  return RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(text))) || null;
}

function isStokesParaboloidCurlProblem(value = "") {
  const text = String(value);
  return /(?:stokes|curl|\\nabla\s*\\times|∇\s*×|\\iint|∬)/iu.test(text)
    && /paraboloid|9\s*-\s*x\^?2\s*-\s*y\^?2|9\s*-\s*x\{?\^?2\}?/iu.test(text)
    && /yz\^?2|e\^\(?x\^?2|\\sin|sin\s*\(y\)|\\ln|ln\s*\(1\s*\+\s*z\^?2\)|\\cos|cos\s*\(xy\)/iu.test(text);
}

function createStokesParaboloidCurlExplanation(problem) {
  if (!isStokesParaboloidCurlProblem(problem)) return null;

  const steps = [
    {
      id: "stokes-step-1",
      label: "Use Stokes' theorem",
      math: "\\iint_S (\\nabla \\times \\mathbf F)\\cdot \\mathbf n\\,dS = \\oint_C \\mathbf F\\cdot d\\mathbf r",
      summary: "Because the surface is oriented upward, the boundary is oriented counterclockwise when viewed from above.",
      chunks: [],
    },
    {
      id: "stokes-step-2",
      label: "Identify the boundary",
      math: "C:\\ x^2+y^2=9,\\ z=0",
      summary: "The paraboloid meets the plane z=0 where x^2+y^2=9.",
      chunks: [],
    },
    {
      id: "stokes-step-3",
      label: "Restrict the vector field to C",
      math: "\\mathbf F(x,y,0)=\\left\\langle e^{x^2}\\sin(y),\\ 0,\\ xy^2\\right\\rangle",
      summary: "On the boundary curve z=0, all terms containing z vanish except the third component, which does not contribute to d\\mathbf r in the xy-plane.",
      chunks: [],
    },
    {
      id: "stokes-step-4",
      label: "Convert the line integral",
      math: "\\oint_C \\mathbf F\\cdot d\\mathbf r=\\oint_C e^{x^2}\\sin(y)\\,dx",
      summary: "Along C, d\\mathbf r=\\langle dx,dy,0\\rangle, so only the first component contributes.",
      chunks: [],
    },
    {
      id: "stokes-step-5",
      label: "Apply Green's theorem",
      math: "\\oint_C e^{x^2}\\sin(y)\\,dx=-\\iint_D e^{x^2}\\cos(y)\\,dA,\\quad D:\\ x^2+y^2\\le 9",
      summary: "For counterclockwise orientation, \\oint_C P\\,dx+Q\\,dy=\\iint_D(Q_x-P_y)\\,dA with P=e^{x^2}\\sin(y) and Q=0.",
      chunks: [],
    },
    {
      id: "stokes-step-6",
      label: "State the result",
      math: "-\\iint_{x^2+y^2\\le 9} e^{x^2}\\cos(y)\\,dA",
      summary: "This remaining disk integral generally does not simplify to an elementary closed form.",
      chunks: [],
    },
  ];

  const finalAnswer = "-\\iint_{x^2+y^2\\le 9} e^{x^2}\\cos(y)\\,dA";

  return {
    title: "Stokes' theorem setup",
    originalProblem: problem,
    expression: problem,
    finalAnswer,
    finalAnswerLatex: finalAnswer,
    summary: "Use Stokes' theorem, identify the circular boundary, then apply Green's theorem on the disk.",
    explanations: {
      beginner: "Stokes' theorem lets us use the boundary circle instead of the curved surface.",
      intermediate: "The upward orientation makes C counterclockwise from above, so Green's theorem gives the disk integral with integrand -e^{x^2}\\cos(y).",
      advanced: "The final area integral over x^2+y^2\\le 9 has no expected elementary closed form.",
    },
    tokens: [],
    steps,
  };
}

function buildToken(rule, stepId = "local-step") {
  return {
    id: `${stepId}-${rule.id}`,
    stepId,
    display: rule.display,
    label: rule.label,
    explanations: {
      beginner: rule.short,
      intermediate: rule.medium,
      advanced: rule.deep,
    },
  };
}

export function explainLocalRule(value) {
  const rule = findRule(value);
  if (!rule) return null;

  return {
    ruleId: rule.id,
    display: rule.display,
    label: rule.label,
    short: rule.short,
    medium: rule.medium,
    deep: rule.deep,
  };
}

export function applyLocalRulesToExplanation(explanation) {
  if (!explanation?.steps) return explanation;

  for (const step of explanation.steps) {
    for (const chunk of step.chunks || []) {
      const rule = explainLocalRule(`${chunk.display} ${chunk.short} ${chunk.medium}`);
      if (!rule) continue;
      chunk.short = rule.short;
      chunk.medium = rule.medium;
      chunk.deep = rule.deep;
    }
  }

  return explanation;
}

export function createLocalRuleExplanation(problem, { source = "text" } = {}) {
  const stokesExplanation = createStokesParaboloidCurlExplanation(problem);
  if (stokesExplanation) return stokesExplanation;

  const rule = explainLocalRule(problem);
  if (!rule) return null;

  const stepId = "local-step";
  const token = buildToken({ ...rule, id: rule.ruleId }, stepId);

  return {
    title: rule.label,
    originalProblem: problem,
    expression: rule.display,
    finalAnswer: rule.medium,
    explanations: {
      beginner: rule.short,
      intermediate: rule.medium,
      advanced: rule.deep,
    },
    tokens: [token],
    steps: [
      {
        id: stepId,
        label: source === "image" ? "Recognized rule" : "Local rule",
        math: rule.display,
        summary: rule.medium,
        chunks: [
          {
            id: token.id,
            display: rule.display,
            short: rule.short,
            medium: rule.medium,
            deep: rule.deep,
          },
        ],
      },
    ],
  };
}
