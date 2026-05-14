// Demo data for multiple math problems

export const demoProblem = {
    title: "Differentiate",
    expression: "d/dx (x² sin x)",
    steps: [
      {
        id: "step-0",
        label: "Problem",
        chunks: [
          { id: "s0-ddx", display: "d/dx", short: "Derivative operator", medium: "This symbol means we're taking the derivative with respect to x — finding the rate of change.", deep: "The derivative operator d/dx asks: how does the output change as x changes by an infinitely small amount? It's the foundation of differential calculus, formalized by Leibniz." },
          { id: "s0-open", display: "(", short: "Grouping", medium: "Parentheses group the entire expression that we need to differentiate.", deep: "The parentheses indicate that d/dx applies to everything inside — the full product x² · sin x, not just one term." },
          { id: "s0-x2", display: "x²", short: "Power function", medium: "x squared — a polynomial term. Its derivative is 2x by the power rule.", deep: "x² is our first function in the product. We'll call it f(x) = x². Its derivative f'(x) = 2x comes from the power rule: d/dx(xⁿ) = nxⁿ⁻¹." },
          { id: "s0-sinx", display: "sin x", short: "Trig function", medium: "The sine function. Its derivative is cos x.", deep: "sin x is our second function in the product. We'll call it g(x) = sin x. Its derivative g'(x) = cos x." },
          { id: "s0-close", display: ")", short: "Grouping", medium: "Closes the expression being differentiated.", deep: "End of the grouped expression. Since we have a product of two functions inside, we'll need the product rule." },
        ],
      },
      {
        id: "step-1",
        label: "Apply Product Rule",
        chunks: [
          { id: "s1-eq", display: "=", short: "Equals", medium: "Rewriting the derivative using the product rule.", deep: "This equals sign bridges the original expression and its expanded form via the product rule: d/dx[f·g] = f'·g + f·g'." },
          { id: "s1-fprime", display: "f'(x)", short: "Derivative of first", medium: "f'(x) is the derivative of x², which is 2x.", deep: "Using the power rule d/dx(xⁿ) = nxⁿ⁻¹, we get f'(x) = 2x. The exponent comes down as a coefficient and decreases by 1." },
          { id: "s1-dot1", display: "·", short: "Multiplication", medium: "Multiply the derivative of the first by the second (unchanged).", deep: "The first term of the product rule: f'(x) · g(x). We differentiate f and leave g alone." },
          { id: "s1-gx", display: "g(x)", short: "Second unchanged", medium: "g(x) = sin x stays as-is in this term.", deep: "The product rule's first term keeps g(x) = sin x unchanged. This represents f changing while g is constant." },
          { id: "s1-plus", display: "+", short: "Addition", medium: "The product rule adds two terms together.", deep: "The product rule sums two contributions: (1) how the product changes when f changes, and (2) when g changes." },
          { id: "s1-fx", display: "f(x)", short: "First unchanged", medium: "f(x) = x² stays as-is in this term.", deep: "In the second term, f(x) = x² remains unchanged. This captures how the product changes when g changes." },
          { id: "s1-dot2", display: "·", short: "Multiplication", medium: "Multiply the first (unchanged) by the derivative of the second.", deep: "The second term: f(x) · g'(x). We leave f alone and differentiate g." },
          { id: "s1-gprime", display: "g'(x)", short: "Derivative of second", medium: "g'(x) is the derivative of sin x, which is cos x.", deep: "The derivative of sin x is cos x. From the limit definition: lim(h→0) [sin(x+h) − sin(x)]/h = cos x." },
        ],
      },
      {
        id: "step-2",
        label: "Substitute",
        chunks: [
          { id: "s2-eq", display: "=", short: "Equals", medium: "Substituting the actual functions and derivatives.", deep: "We replace abstract f, g, f', g' with: f(x)=x², g(x)=sin x, f'(x)=2x, g'(x)=cos x." },
          { id: "s2-2x", display: "2x", short: "f'(x) = 2x", medium: "The derivative of x² is 2x, from the power rule.", deep: "By the power rule, d/dx(x²) = 2x²⁻¹ = 2x. The exponent 2 becomes the coefficient, new exponent is 1." },
          { id: "s2-dot1", display: "·", short: "Times", medium: "Multiplying f'(x) by g(x).", deep: "Completing the first term: f'(x) · g(x) = 2x · sin x." },
          { id: "s2-sinx", display: "sin x", short: "g(x) = sin x", medium: "The original sine, kept unchanged.", deep: "sin x unchanged because in the first term we only differentiate f(x)=x²." },
          { id: "s2-plus", display: "+", short: "Plus", medium: "Adding the two product rule terms.", deep: "Sum of both contributions: from f changing (2x · sin x) plus from g changing (x² · cos x)." },
          { id: "s2-x2", display: "x²", short: "f(x) = x²", medium: "The original x², kept unchanged.", deep: "x² unchanged because in the second term we only differentiate g(x)=sin x." },
          { id: "s2-dot2", display: "·", short: "Times", medium: "Multiplying f(x) by g'(x).", deep: "Completing the second term: f(x) · g'(x) = x² · cos x." },
          { id: "s2-cosx", display: "cos x", short: "g'(x) = cos x", medium: "The derivative of sin x is cos x.", deep: "cos x is the derivative of sin x. When sine peaks (π/2), its rate of change is 0 (cosine is 0). When sine crosses zero, it changes fastest (cosine is ±1)." },
        ],
      },
      {
        id: "step-3",
        label: "Final Answer",
        chunks: [
          { id: "s3-eq", display: "=", short: "Result", medium: "The final simplified form of the derivative.", deep: "The derivative of x² sin x is 2x sin x + x² cos x. No further simplification possible since the terms are unlike." },
          { id: "s3-2xsinx", display: "2x sin x", short: "First term", medium: "From differentiating x² (→ 2x) and keeping sin x unchanged.", deep: "This term shows how the product changes due to x² changing. As x grows, the oscillation amplitude increases linearly." },
          { id: "s3-plus", display: "+", short: "Sum of terms", medium: "Both terms contribute to the total rate of change.", deep: "Total derivative = polynomial part changing (2x sin x) + trigonometric part changing (x² cos x)." },
          { id: "s3-x2cosx", display: "x² cos x", short: "Second term", medium: "From keeping x² unchanged and differentiating sin x (→ cos x).", deep: "This term grows quadratically for large |x|. The cos x shifts phase by π/2 relative to the first term." },
        ],
      },
    ],
  };
  
  export const chainRuleProblem = {
    title: "Chain Rule",
    expression: "d/dx sin(x³)",
    steps: [
      {
        id: "cr-0",
        label: "Identify Composition",
        chunks: [
          { id: "cr0-outer", display: "sin(", short: "Outer function", medium: "The outer function is sin( ), applied to x³.", deep: "In a composition f(g(x)), sin is our outer function f. The chain rule will differentiate this and multiply by the inner derivative." },
          { id: "cr0-inner", display: "x³", short: "Inner function", medium: "The inner function is x³, sitting inside sin.", deep: "x³ is g(x) in the composition. Its derivative g'(x) = 3x² by the power rule. This will multiply the outer derivative." },
          { id: "cr0-close", display: ")", short: "End of composition", medium: "Closes the composed expression.", deep: "Together sin(x³) = f(g(x)) where f = sin, g = x³. Chain rule: [f(g(x))]' = f'(g(x)) · g'(x)." },
        ],
      },
      {
        id: "cr-1",
        label: "Apply Chain Rule",
        chunks: [
          { id: "cr1-eq", display: "=", short: "Equals", medium: "Applying the chain rule formula.", deep: "Chain rule: d/dx[f(g(x))] = f'(g(x)) · g'(x). Differentiate outer, keep inner unchanged, multiply by inner's derivative." },
          { id: "cr1-cos", display: "cos(x³)", short: "Outer derivative", medium: "Derivative of sin is cos — evaluated at the inner function x³.", deep: "f'(x) = cos(x), so f'(g(x)) = cos(x³). The inner function x³ stays unchanged inside cos — we haven't differentiated it yet." },
          { id: "cr1-times", display: "·", short: "Times", medium: "Multiply by the derivative of the inner function.", deep: "The chain rule multiplies the outer derivative by the inner derivative g'(x). This accounts for the rate of change of the composition." },
          { id: "cr1-3x2", display: "3x²", short: "Inner derivative", medium: "Derivative of x³ is 3x² by the power rule.", deep: "g'(x) = d/dx(x³) = 3x²⁻¹ = 3x² by the power rule. This is the chain factor — it scales the outer derivative." },
        ],
      },
      {
        id: "cr-2",
        label: "Final Answer",
        chunks: [
          { id: "cr2-eq", display: "=", short: "Result", medium: "The complete derivative.", deep: "Final answer: d/dx[sin(x³)] = 3x² cos(x³). The chain rule multiplied the outer derivative cos(x³) by the inner derivative 3x²." },
          { id: "cr2-3x2", display: "3x²", short: "Inner derivative factor", medium: "The derivative of x³, acting as the chain factor.", deep: "3x² scales the result. When x is large, the function oscillates faster — this factor captures that acceleration in rate of change." },
          { id: "cr2-cos", display: "cos(x³)", short: "Outer derivative", medium: "Derivative of sin, evaluated at the inner function.", deep: "cos(x³) is the outer part. The argument remains x³ (unchanged) — only the outer function changed from sin to cos." },
        ],
      },
    ],
  };
  
  export const integralProblem = {
    title: "Integration",
    expression: "∫ x eˣ dx",
    steps: [
      {
        id: "int-0",
        label: "Integration by Parts",
        chunks: [
          { id: "i0-formula", display: "∫ u dv", short: "IBP setup", medium: "Integration by parts: ∫u dv = uv − ∫v du.", deep: "Integration by parts reverses the product rule. Formula: ∫u dv = uv − ∫v du. We choose u and dv strategically using LIATE: Logarithm, Inverse trig, Algebraic, Trig, Exponential." },
          { id: "i0-eq", display: "=", short: "Equals", medium: "Setting up the formula.", deep: "The equals sign starts the IBP transformation." },
          { id: "i0-uv", display: "uv", short: "Product term", medium: "The product of u and v, evaluated.", deep: "After choosing u and dv, we compute v by integrating dv, then form the product uv." },
          { id: "i0-minus", display: "−", short: "Minus", medium: "Subtract the remaining integral.", deep: "IBP trades one integral for (usually) a simpler one. The minus sign means we subtract ∫v du." },
          { id: "i0-vdu", display: "∫ v du", short: "Remaining integral", medium: "The new (simpler) integral to evaluate.", deep: "If we chose u and dv wisely, ∫v du is easier than the original. Here it will reduce to ∫eˣ dx." },
        ],
      },
      {
        id: "int-1",
        label: "Choose u and dv",
        chunks: [
          { id: "i1-u", display: "u = x", short: "u choice", medium: "Let u = x. Its derivative du = dx.", deep: "We pick u = x because it's algebraic (A in LIATE) and differentiating it simplifies it to 1. This is the key to making the remaining integral easier." },
          { id: "i1-comma", display: ",", short: "Separator", medium: "Separating the two assignments.", deep: "We're making two assignments simultaneously: one for u (to differentiate) and one for dv (to integrate)." },
          { id: "i1-dv", display: "dv = eˣ dx", short: "dv choice", medium: "Let dv = eˣ dx. Then v = eˣ.", deep: "eˣ is chosen as dv because it's exponential (E in LIATE) and integrating it is trivial — eˣ integrates to itself, v = eˣ." },
        ],
      },
      {
        id: "int-2",
        label: "Substitute & Solve",
        chunks: [
          { id: "i2-eq", display: "=", short: "Substituting", medium: "Plugging u, v, du into the IBP formula.", deep: "With u=x, v=eˣ, du=dx: ∫x eˣ dx = x·eˣ − ∫eˣ·dx = xeˣ − eˣ + C." },
          { id: "i2-xex", display: "x eˣ", short: "uv term", medium: "The product uv = x · eˣ.", deep: "This is the uv part of IBP. We evaluated u=x and v=eˣ at the same argument. Straightforward multiplication." },
          { id: "i2-minus", display: "−", short: "Minus", medium: "Subtracting the remaining integral.", deep: "From the IBP formula: uv − ∫v du = xeˣ − ∫eˣ dx." },
          { id: "i2-ex", display: "eˣ", short: "∫eˣ dx = eˣ", medium: "The integral of eˣ is simply eˣ.", deep: "eˣ is the only function that is its own derivative (and integral). ∫eˣ dx = eˣ + C. This is what made eˣ the perfect choice for dv." },
          { id: "i2-plus", display: "+", short: "Plus constant", medium: "Adding the constant of integration.", deep: "Every indefinite integral has an arbitrary constant C, representing all antiderivatives that differ by a constant." },
          { id: "i2-C", display: "C", short: "Constant of integration", medium: "The arbitrary constant — needed for all indefinite integrals.", deep: "C represents a family of functions. d/dx(xeˣ − eˣ + C) = xeˣ for any value of C. Initial conditions determine the specific value." },
        ],
      },
    ],
  };