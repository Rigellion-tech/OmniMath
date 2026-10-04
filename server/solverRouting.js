const PRIOR_MATH_FAILURE = /numerical_final_answer_mismatch|unsupported_|abrupt_special_function|invalid_antiderivative/u;
const PRIOR_SYMBOL_FAILURE = /^unexplained_generated_symbol/u;

function normalizedInput({ problem = "", canonicalLatex = "" } = {}) {
  return `${problem || ""}\n${canonicalLatex || ""}`.trim();
}

function has(text, pattern) {
  return pattern.test(text);
}

function numericMatrixShape(content = "") {
  const rows = content.split(/\\\\/u).map((row) => row.trim()).filter(Boolean);
  if (!rows.length || rows.length > 3) return null;
  const columns = rows.map((row) => row.split(/&/u).map((cell) => cell.trim()));
  if (columns.some((row) => !row.length || row.length > 3 || row.some((cell) => !/^[-+]?\s*(?:\d+(?:\.\d+)?|\d*\s*\/\s*\d+)$/u.test(cell)))) {
    return null;
  }
  const width = columns[0].length;
  if (columns.some((row) => row.length !== width)) return null;
  return { rows: rows.length, columns: width };
}

function findSmallNumericMatrices(text = "") {
  const shapes = [];
  const pattern = /\\begin\{(?:[pbvV]?matrix|array)\}([\s\S]*?)\\end\{(?:[pbvV]?matrix|array)\}/giu;
  for (const match of text.matchAll(pattern)) {
    const shape = numericMatrixShape(match[1]);
    if (shape) shapes.push(shape);
  }
  return shapes;
}

function countMatrixEnvironments(text = "") {
  return [...text.matchAll(/\\begin\{(?:[pbvV]?matrix|array)\}/giu)].length;
}

function analyzeProblem(input = {}) {
  const text = normalizedInput(input);
  const issues = Array.isArray(input.priorIssues) ? input.priorIssues.map(String) : [];
  const smallNumericMatrices = findSmallNumericMatrices(text);
  const matrixEnvironmentCount = countMatrixEnvironments(text);
  const matrixMention = has(text, /\\begin\{(?:[pbvV]?matrix|array)\}|\bmatrix|matrices|determinant|eigenvalue|eigenvector|characteristic polynomial|linear operator|self[- ]adjoint operator/iu);
  const proofTask = has(text, /\bprove|show that|demonstrate|establish|justify|necessary and sufficient\b/iu);
  const derivationTask = has(text, /\bderive|derivation\b/iu);
  const glossaryTask = has(text, /\bdefine|definition of|what is (?:a|an|the)?\s*/iu);
  const substantiveAnalysisTask = proofTask || derivationTask
    || has(text, /\bsolve|analy[sz]e|calculate|compute|evaluate|determine|find|obtain|characteri[sz]e\b/iu);
  const deepOperatorConcept = has(text, /spectral theorem|compact operator|unbounded operator|operator algebra|resolvent|spectrum|Fredholm|semigroup|Hilbert space|Banach space|functional analysis|weak convergence|Sobolev space/iu);
  const eliteOperatorConcept = has(text, /unbounded operator|operator algebra|compact resolvent|infinite[- ]dimensional|weak convergence|Sobolev space|existence and (?:uniqueness|regularity)/iu);
  const basicMatrixOperations = has(text, /\bAB\b|A\s*\^\s*\{?2\}?|A\s*-\s*2B|matrix (?:product|multiplication|arithmetic)|\bdet\s*\(?|determinant|inverse|A\s*\^\s*\{?-1\}?/iu);
  const variational = has(text, /Euler[- ]Lagrange|variational|first variation|second variation|functional derivative|calculus of variations|\\delta\s*[A-Z]|\\frac\{\\delta/iu);
  const variationalTask = variational && has(text, /\bfind|calculate|compute|solve|derive|prove|show|analy[sz]e|determine|minimi[sz]e|maximi[sz]e|obtain\b/iu);
  const secondVariation = has(text, /second variation/iu);
  const constrainedVariational = variational && has(text, /constraint|isoperimetric|admissible class|manifold/iu);
  const pde = has(text, /partial differential equation|\bPDE\b|heat equation|wave equation|Laplace equation|Poisson equation|\\partial|\\nabla\^2/iu);
  const nonlinear = has(text, /nonlinear|Navier[- ]Stokes|Monge[- ]Amp[eè]re|reaction[- ]diffusion|blow[- ]?up|weak solution|regularity|existence and uniqueness|viscosity solution/iu);
  const ode = has(text, /ordinary differential equation|\bODE\b|initial value problem|boundary value problem|(?:^|\s)[a-zA-Z]\s*['′]{1,3}\s*[+=]/u);
  const integral = has(text, /\\int|\bintegral\b/iu);
  const improperIntegral = integral && has(text, /\\infty|improper|infinity/iu);
  const multivariable = has(text, /\\(?:iint|iiint|oint|nabla)|Stokes|Green(?:'s)? theorem|\bcurl\b|Jacobian|surface integral/iu);
  const infiniteSeries = has(text, /infinite series|power series|Fourier series|\\sum[\s\S]{0,80}(?:\\infty|infinity)/iu);
  const finiteSum = has(text, /\\sum_\{?[^}]*\}?\^\{?\d+\}?/iu) && !infiniteSeries;
  const optimization = has(text, /Karush[- ]Kuhn[- ]Tucker|\bKKT\b|Lagrange multiplier|constrained optimi[sz]ation|convex optimi[sz]ation|gradient descent/iu);
  const advancedPhysics = has(text, /Hamiltonian|Lagrangian|Maxwell(?:'s)? equations|Schr[oö]dinger|stress[- ]energy|tensor notation|Einstein summation/iu);
  const straightforwardQuadratic = has(text, /\bquadratic\b|(?:^|\s)[a-zA-Z]\s*\^\s*2\s*[+-]/iu)
    && has(text, /solve|roots|factor|quadratic formula/iu);
  const simpleLinear = has(text, /(?:solve|find)\s+(?:for\s+)?[a-zA-Z]|=/iu)
    && has(text, /\b\d*\s*[a-zA-Z]\s*[+-]\s*\d+\s*=\s*[-+]?\d+\b/iu)
    && !has(text, /system|matrix|integral|derivative|differential|proof|prove/iu);
  const elementaryArithmetic = has(text, /\b(?:calculate|compute|evaluate|simplify|substitute)\b/iu)
    && (finiteSum || has(text, /(?:\d+|\\frac\{[^{}]+\}\{[^{}]+\})\s*(?:[+*/^]|-(?!>))\s*(?:\d+|\\left|\\frac)/u))
    && !has(text, /\blimit|convergence|derivative|differentiat|proof|prove|operator|functional|PDE|variational|nonlinear|integral\b|\\int/iu);
  const elementaryProbability = has(text, /\bcoin|dice|cards?|binomial\b/iu)
    && !has(text, /prove|asymptotic|stochastic process|martingale|measure[- ]theoretic/iu);

  return {
    features: {
      priorMathematicalValidationFailure: issues.some((issue) => PRIOR_MATH_FAILURE.test(issue)),
      priorSymbolValidationFailure: issues.some((issue) => PRIOR_SYMBOL_FAILURE.test(issue)),
      matrixMention,
      matrixEnvironmentCount,
      smallNumericMatrixCount: smallNumericMatrices.length,
      basicMatrixOperations,
      proofTask,
      derivationTask,
      glossaryTask,
      substantiveAnalysisTask,
      deepOperatorConcept,
      eliteOperatorConcept,
      variational,
      variationalTask,
      secondVariation,
      constrainedVariational,
      pde,
      nonlinear,
      ode,
      integral,
      improperIntegral,
      multivariable,
      infiniteSeries,
      finiteSum,
      optimization,
      advancedPhysics,
      straightforwardQuadratic,
      simpleLinear,
      elementaryArithmetic,
      elementaryProbability,
    },
  };
}

function classifyAnalysis({ features }) {
  if (features.priorSymbolValidationFailure) return { tier: "advanced", reason: "prior_symbol_validation_failure" };
  if (features.priorMathematicalValidationFailure) return { tier: "advanced", reason: "prior_mathematical_validation_failure" };
  if (features.variational && features.variationalTask) {
    const deepSignals = [features.nonlinear, features.deepOperatorConcept, features.secondVariation, features.constrainedVariational]
      .filter(Boolean).length;
    if (deepSignals >= 2 || (features.nonlinear && features.proofTask)) return { tier: "elite", reason: "deep_variational_calculus" };
    return { tier: "advanced", reason: "variational_calculus" };
  }
  if (features.pde) {
    if (features.nonlinear && (features.proofTask || features.deepOperatorConcept)) return { tier: "elite", reason: "nonlinear_pde_analysis" };
    if (features.nonlinear || features.proofTask) return { tier: "advanced", reason: "advanced_partial_differential_equation" };
    return { tier: "standard", reason: "routine_partial_differential_equation" };
  }
  if (features.matrixMention) {
    if (features.glossaryTask && !features.proofTask && !features.derivationTask) {
      return { tier: "standard", reason: "concept_definition" };
    }
    if (features.eliteOperatorConcept && features.proofTask) return { tier: "elite", reason: "deep_operator_analysis" };
    if ((features.deepOperatorConcept && features.substantiveAnalysisTask) || features.proofTask) {
      return { tier: "advanced", reason: "advanced_matrix_or_operator_proof" };
    }
    if (features.matrixEnvironmentCount > 0
      && features.smallNumericMatrixCount === features.matrixEnvironmentCount
      && features.basicMatrixOperations) return { tier: "simple", reason: "small_numeric_matrix_computation" };
    return { tier: "standard", reason: "matrix_or_linear_operator" };
  }
  if (features.glossaryTask && !features.elementaryProbability) return { tier: "standard", reason: "concept_definition" };
  if (features.deepOperatorConcept && features.substantiveAnalysisTask) {
    return { tier: features.eliteOperatorConcept && features.proofTask ? "elite" : "advanced", reason: features.eliteOperatorConcept && features.proofTask ? "deep_functional_analysis" : "functional_analysis" };
  }
  if (features.advancedPhysics && features.substantiveAnalysisTask) {
    return { tier: features.proofTask ? "elite" : "advanced", reason: "advanced_physics_math" };
  }
  if (features.optimization) return { tier: features.proofTask ? "advanced" : "standard", reason: "optimization" };
  if (features.multivariable) return { tier: features.proofTask ? "advanced" : "standard", reason: "vector_or_multivariable_calculus" };
  if (features.ode) return { tier: features.proofTask || features.nonlinear ? "advanced" : "standard", reason: "differential_equation" };
  if (features.infiniteSeries) return { tier: features.proofTask ? "advanced" : "standard", reason: "infinite_series" };
  if (features.finiteSum && features.elementaryArithmetic) return { tier: "simple", reason: "finite_sum_computation" };
  if (features.improperIntegral) return { tier: "standard", reason: "improper_integral_standard_first" };
  if (features.integral) return { tier: "standard", reason: "one_dimensional_integral" };
  if (features.straightforwardQuadratic) return { tier: "simple", reason: "straightforward_quadratic" };
  if (features.simpleLinear) return { tier: "simple", reason: "elementary_linear_equation" };
  if (features.elementaryProbability) return { tier: "simple", reason: "elementary_probability" };
  if (features.elementaryArithmetic) return { tier: "simple", reason: "elementary_computation" };
  return { tier: "standard", reason: "default_standard" };
}

export function inspectProblemDifficulty(input = {}) {
  const analysis = analyzeProblem(input);
  return { ...classifyAnalysis(analysis), features: analysis.features };
}

export function classifyProblemComplexity(input = {}) {
  const { tier, reason } = inspectProblemDifficulty(input);
  return { tier, reason };
}

export function chooseSolverRoleForProblem(input = {}) {
  const classification = classifyProblemComplexity(input);
  const role = classification.reason === "prior_symbol_validation_failure"
    ? "repair"
    : classification.tier === "simple" || classification.tier === "standard"
      ? "solver"
      : "hardSolve";
  return { role, ...classification, reason: classification.reason };
}
