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
