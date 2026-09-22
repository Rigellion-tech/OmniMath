const humanizeId = (id) => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
const editorTemplate = (insertion) => {
  let first = true;
  return insertion.replaceAll("□", () => {
    if (first) { first = false; return "#@"; }
    return "#?";
  });
};
const entry = (id, category, display, insertion = display, name = id, aliases = [], extra = {}) => {
  const type = extra.type || "symbol";
  const subcategory = extra.subcategory || category;
  const editorInsertion = extra.editorInsertion || (type === "structure" ? editorTemplate(insertion) : insertion);
  const displayLatex = extra.displayLatex || (type === "structure" ? insertion.replaceAll("□", "{\\square}") : insertion);
  return Object.freeze({
    id, category, subcategory, display, displayLatex, insertion,
    editorInsertion, name, aliases: [...new Set([humanizeId(id), ...(id === "perp" ? ["perpendicular", "orthogonal"] : []), ...aliases])], type,
    insertOptions: Object.freeze(extra.insertOptions || {
      insertionMode: "replaceSelection",
      selectionMode: type === "structure" ? "placeholder" : "after",
    }),
  });
};

const greekLower = [
  ["alpha", "\\alpha"], ["beta", "\\beta"], ["gamma", "\\gamma"], ["delta", "\\delta"], ["epsilon", "\\epsilon"], ["varepsilon", "\\varepsilon"], ["zeta", "\\zeta"], ["eta", "\\eta"], ["theta", "\\theta"], ["vartheta", "\\vartheta"], ["iota", "\\iota"], ["kappa", "\\kappa"], ["varkappa", "\\varkappa"], ["lambda", "\\lambda"], ["mu", "\\mu"], ["nu", "\\nu"], ["xi", "\\xi"], ["omicron", "o"], ["pi", "\\pi"], ["varpi", "\\varpi"], ["rho", "\\rho"], ["varrho", "\\varrho"], ["sigma", "\\sigma"], ["varsigma", "\\varsigma"], ["tau", "\\tau"], ["upsilon", "\\upsilon"], ["phi", "\\phi"], ["varphi", "\\varphi"], ["chi", "\\chi"], ["psi", "\\psi"], ["omega", "\\omega"],
];
const greekUpper = [["Gamma", "\\Gamma"], ["Delta", "\\Delta"], ["Theta", "\\Theta"], ["Lambda", "\\Lambda"], ["Xi", "\\Xi"], ["Pi", "\\Pi"], ["Sigma", "\\Sigma"], ["Upsilon", "\\Upsilon"], ["Phi", "\\Phi"], ["Psi", "\\Psi"], ["Omega", "\\Omega"]];

const groups = {
  arithmetic: [["+", "+"], ["minus", "-", "−"], ["pm", "\\pm", "±"], ["mp", "\\mp", "∓"], ["times", "\\times", "×"], ["divide", "\\div", "÷"], ["cdot", "\\cdot", "·"], ["equals", "="], ["neq", "\\ne", "≠"], ["approx", "\\approx", "≈", "approximately equal"], ["simeq", "\\simeq", "≃"], ["cong", "\\cong", "≅"], ["equiv", "\\equiv", "≡"], ["propto", "\\propto", "∝"], ["percent", "\\%", "%"], ["factorial", "!"], ["infty", "\\infty", "∞"]],
  relations: [["lt", "<"], ["gt", ">"], ["le", "\\le", "≤"], ["ge", "\\ge", "≥"], ["ll", "\\ll", "≪"], ["gg", "\\gg", "≫"], ["sim", "\\sim", "∼"], ["asymp", "\\asymp", "≍"], ["prec", "\\prec"], ["succ", "\\succ"], ["parallel", "\\parallel", "∥"], ["perp", "\\perp", "⊥"], ["triangleq", "\\triangleq"]],
  calculus: [["int", "\\int"], ["iint", "\\iint"], ["iiint", "\\iiint"], ["oint", "\\oint", "\\oint", "contour integral"], ["oiint", "\\oiint", "\\oiint", "surface integral"], ["sum", "\\sum"], ["prod", "\\prod"], ["coprod", "\\coprod"], ["lim", "\\lim_{x\\to a}"], ["partial", "\\partial"], ["nabla", "\\nabla"], ["differential", "\\,d"], ["gradient", "\\nabla f"], ["divergence", "\\nabla\\cdot\\mathbf{F}"], ["curl", "\\nabla\\times\\mathbf{F}"], ["laplacian", "\\nabla^2"]],
  sets: [["in", "\\in", "∈"], ["notin", "\\notin", "∉"], ["ni", "\\ni", "∋"], ["subset", "\\subset", "⊂"], ["subseteq", "\\subseteq", "⊆"], ["nsubset", "\\not\\subset", "⊄"], ["supset", "\\supset", "⊃"], ["supseteq", "\\supseteq", "⊇"], ["cup", "\\cup", "∪"], ["cap", "\\cap", "∩"], ["emptyset", "\\varnothing", "∅"], ["setminus", "\\setminus"], ["complement", "^c"], ["powerset", "\\mathcal{P}(A)"], ["cardinality", "|A|"]],
  logic: [["not", "\\neg", "¬"], ["and", "\\land", "∧"], ["or", "\\lor", "∨"], ["xor", "\\oplus", "⊕"], ["implies", "\\Rightarrow", "⇒"], ["impliedby", "\\Leftarrow", "⇐"], ["iff", "\\Leftrightarrow", "⇔"], ["forall", "\\forall", "∀"], ["exists", "\\exists", "∃"], ["notexists", "\\nexists", "∄"], ["therefore", "\\therefore", "∴"], ["because", "\\because", "∵"], ["models", "\\models"]],
  linearAlgebra: [["transpose", "^{\\mathsf T}"], ["inverse", "^{-1}"], ["adjoint", "^*"], ["trace", "\\operatorname{tr}"], ["rank", "\\operatorname{rank}"], ["nullity", "\\operatorname{null}"], ["det", "\\det"], ["norm", "\\lVert x\\rVert"], ["inner", "\\langle u,v\\rangle"], ["outer", "u\\otimes v"], ["kronecker", "\\otimes"], ["eigenvalue", "\\lambda"], ["identity", "I"], ["zeroMatrix", "0_{m\\times n}"], ["matrix", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "matrix"]],
  probability: [["expectation", "\\mathbb{E}[X]"], ["variance", "\\operatorname{Var}(X)"], ["covariance", "\\operatorname{Cov}(X,Y)"], ["correlation", "\\operatorname{Corr}(X,Y)"], ["probability", "\\mathbb{P}(A)"], ["conditional", "\\mathbb{P}(A\\mid B)"], ["independent", "A\\perp\\!\\perp B"], ["likelihood", "\\mathcal{L}(\\theta)"], ["estimator", "\\hat{\\theta}"], ["distribution", "X\\sim\\mathcal{N}(\\mu,\\sigma^2)"], ["almostSurely", "\\text{a.s.}"]],
  optimization: [["argmin", "\\arg\\min_x"], ["argmax", "\\arg\\max_x"], ["min", "\\min"], ["max", "\\max"], ["inf", "\\inf"], ["sup", "\\sup"], ["gradientVector", "\\nabla f"], ["hessian", "\\nabla^2 f"], ["jacobian", "J_f"], ["lagrangian", "\\mathcal{L}(x,\\lambda)"], ["constraint", "g(x)\\le 0"], ["kkt", "\\lambda\\ge0"], ["residual", "r_k"], ["approximation", "\\approx"]],
  physics: [["hbar", "\\hbar", "ℏ"], ["hatOperator", "\\hat{H}"], ["commutator", "[A,B]"], ["anticommutator", "\\{A,B\\}"], ["bra", "\\langle \\psi|"], ["ket", "|\\psi\\rangle"], ["braket", "\\langle \\phi|\\psi\\rangle"], ["expectationValue", "\\langle A\\rangle"], ["lagrangianPhysics", "\\mathcal{L}"], ["fourVector", "A^\\mu"], ["deltaKronecker", "\\delta_{ij}"], ["leviCivita", "\\varepsilon_{ijk}"], ["unitVector", "\\hat{\\mathbf{r}}"]],
  geometry: [["angle", "\\angle ABC", "angle"], ["degree", "^{\\circ}", "°"], ["congruent", "\\cong", "≅"], ["similar", "\\sim"], ["perpendicular", "\\perp", "⊥"], ["parallelGeometry", "\\parallel", "∥"], ["arc", "\\widehat{AB}"], ["triangle", "\\triangle ABC"]],
  arrows: [["to", "\\to", "→"], ["mapsto", "\\mapsto", "↦"], ["rightarrow", "\\rightarrow", "⟶"], ["leftarrow", "\\leftarrow", "←"], ["leftrightarrow", "\\leftrightarrow", "↔"], ["longrightarrow", "\\longrightarrow", "⟶"], ["uparrow", "\\uparrow", "↑"], ["downarrow", "\\downarrow", "↓"], ["converges", "\\longrightarrow"], ["hookrightarrow", "\\hookrightarrow", "↪"], ["twoheadrightarrow", "\\twoheadrightarrow", "↠"]],
  delimiters: [["parentheses", "\\left( x \\right)"], ["brackets", "\\left[ x \\right]"], ["braces", "\\left\\{ x \\right\\}"], ["angles", "\\langle x\\rangle"], ["absolute", "|x|"], ["normDelim", "\\lVert x\\rVert"], ["floor", "\\lfloor x\\rfloor"], ["ceiling", "\\lceil x\\rceil"]],
  accents: [["hat", "\\hat{x}"], ["bar", "\\bar{x}"], ["overline", "\\overline{x}"], ["underline", "\\underline{x}"], ["tilde", "\\tilde{x}"], ["dot", "\\dot{x}"], ["doubleDot", "\\ddot{x}"], ["vectorArrow", "\\vec{x}"], ["widehat", "\\widehat{AB}"], ["overrightarrow", "\\overrightarrow{AB}"]],
};

/** @type {Array<[string, string, string, string[]]>} */
const structureSpecs = [
  ["fraction", "\\frac{□}{□}", "fraction", ["frac", "quotient"]], ["sqrt", "\\sqrt{□}", "square root", ["root"]], ["nthRoot", "\\sqrt[□]{□}", "nth root", ["radical"]], ["power", "□^{□}", "power", ["superscript", "exponent"]], ["subscript", "□_{□}", "subscript", ["index"]], ["subsup", "□_{□}^{□}", "subscript and superscript", ["combined index"]], ["derivative", "\\frac{d}{d□}□", "derivative", ["differentiate"]], ["partialDerivative", "\\frac{\\partial}{\\partial □}□", "partial derivative", ["partial"]], ["definiteIntegral", "\\int_{□}^{□} □\\,d□", "definite integral", ["integral bounds"]], ["indefiniteIntegral", "\\int □\\,d□", "indefinite integral", ["antiderivative"]], ["multipleIntegral", "\\iint_{□} □\\,dA", "multiple integral", ["double integral", "surface integral"]], ["sumStructure", "\\sum_{□}^{□} □", "sum", ["summation"]], ["productStructure", "\\prod_{□}^{□} □", "product", ["product notation"]], ["limit", "\\lim_{□\\to□} □", "limit", ["limiting"]], ["binomial", "\\binom{□}{□}", "binomial coefficient", ["choose", "combination"]], ["determinant", "\\begin{vmatrix}□&□\\\\□&□\\end{vmatrix}", "determinant", ["det"]], ["matrixStructure", "\\begin{pmatrix}□&□\\\\□&□\\end{pmatrix}", "matrix", ["array"]], ["cases", "\\begin{cases}□ & \\text{if } □\\\\□ & \\text{if } □\\end{cases}", "piecewise cases", ["piecewise"]], ["system", "\\begin{cases}□\\\\□\\end{cases}", "system of equations", ["equations"]], ["aligned", "\\begin{aligned}□&=□\\\\□&=□\\end{aligned}", "aligned equations", ["align"]], ["braStructure", "\\langle □|", "bra", ["quantum"]], ["ketStructure", "|□\\rangle", "ket", ["quantum"]], ["braketStructure", "\\langle □|□\\rangle", "bra ket", ["inner product"]], ["tensor", "T^{□}_{□}", "tensor index", ["indices", "einstein"]], ["contraction", "T^{□}_{□}T^{□}_{□}", "tensor contraction", ["index contraction"]],
  ["higherDerivative", "\\frac{d^{□}□}{d□^{□}}", "higher derivative", ["nth derivative"]], ["mixedPartialDerivative", "\\frac{\\partial^{□}□}{\\partial □\\partial □}", "mixed partial derivative", ["mixed derivative"]],
  ["tripleIntegralStructure", "\\iiint_{□} □\\,dV", "triple integral", ["volume integral"]], ["lineIntegral", "\\int_{□} □\\cdot d\\mathbf{r}", "line integral", ["path integral"]], ["contourIntegralStructure", "\\oint_{□} □\\,d□", "contour integral", ["closed line integral"]], ["surfaceIntegralStructure", "\\oiint_{□} □\\cdot d\\mathbf{S}", "surface integral", ["closed surface integral", "flux integral"]],
  ["evaluation", "\\left.□\\right|_{□}^{□}", "evaluate at bounds", ["evaluation bar"]], ["setBuilder", "\\left\\{□\\mid □\\right\\}", "set builder", ["set comprehension", "such that"]], ["innerProductStructure", "\\langle □,□\\rangle", "inner product", ["scalar product"]], ["matrix3x3", "\\begin{pmatrix}□&□&□\\\\□&□&□\\\\□&□&□\\end{pmatrix}", "3 by 3 matrix", ["matrix", "array"]],
  ["expectationStructure", "\\mathbb{E}[□]", "expectation", ["expected value", "mean"]], ["conditionalExpectationStructure", "\\mathbb{E}[□\\mid □]", "conditional expectation", ["expected value given"]], ["varianceStructure", "\\operatorname{Var}(□)", "variance", ["Var"]],
  ["argminStructure", "\\operatorname*{arg\\,min}_{□}□", "argument minimum", ["argmin", "minimizer"]], ["argmaxStructure", "\\operatorname*{arg\\,max}_{□}□", "argument maximum", ["argmax", "maximizer"]], ["constrainedOptimization", "\\begin{aligned}\\min_{□}\;&□\\\\\\text{s.t.}\;&□\\le0\\end{aligned}", "constrained optimization", ["subject to", "optimization problem"]],
  ["jacobianStructure", "J_{□}=\\left[\\frac{\\partial □}{\\partial □}\\right]", "Jacobian matrix", ["Jacobian"]], ["hessianStructure", "H_{□}=\\left[\\frac{\\partial^2 □}{\\partial □\\partial □}\\right]", "Hessian matrix", ["second derivative matrix"]],
  ["fourierTransformStructure", "\\mathcal{F}\\{□\\}(□)", "Fourier transform", ["frequency transform"]], ["laplaceTransformStructure", "\\mathcal{L}\\{□\\}(□)", "Laplace transform", ["s domain transform"]],
  ["outerProductStructure", "|□\\rangle\\langle□|", "quantum outer product", ["ket bra"]], ["commutatorStructure", "[□,□]", "commutator", ["operator commutator"]], ["covariantDerivativeStructure", "\\nabla_{□}T^{□}_{□}", "covariant derivative", ["tensor derivative"]],
];
const structures = structureSpecs.map((item) => entry(item[0], "structures", item[1], item[1], item[2], item[3], { type: "structure" }));

// This inventory is intentionally organized by mathematical meaning rather than by
// LaTeX package. It fills ordinary graduate-STEM families that the original palette
// did not cover, while leaving specialist notation to the raw-LaTeX escape hatch.
/** @type {Array<[string, string, string, string, string, string[]]>} */
const advancedSpecs = [
  ["arithmetic", "binary operators", "ast", "\\ast", "asterisk product", ["asterisk"]], ["arithmetic", "binary operators", "star", "\\star", "star product", []], ["arithmetic", "binary operators", "circ", "\\circ", "composition", ["function composition"]], ["arithmetic", "binary operators", "bullet", "\\bullet", "bullet product", []], ["arithmetic", "binary operators", "diamond", "\\diamond", "diamond operator", []],
  ["arithmetic", "circled operators", "ominus", "\\ominus", "circled minus", []], ["arithmetic", "circled operators", "oslash", "\\oslash", "circled slash", ["quotient"]], ["arithmetic", "circled operators", "odot", "\\odot", "circled dot", []], ["arithmetic", "boxed operators", "boxplus", "\\boxplus", "box plus", []], ["arithmetic", "boxed operators", "boxminus", "\\boxminus", "box minus", []], ["arithmetic", "boxed operators", "boxtimes", "\\boxtimes", "box times", []], ["arithmetic", "boxed operators", "boxdot", "\\boxdot", "box dot", []], ["arithmetic", "binary operators", "wreath", "\\wr", "wreath product", []], ["arithmetic", "binary operators", "amalgamation", "\\amalg", "amalgamated product", []],
  ["relations", "negated order", "notLess", "\\nless", "not less than", []], ["relations", "negated order", "notGreater", "\\ngtr", "not greater than", []], ["relations", "negated order", "notLessEqual", "\\nleq", "not less than or equal", []], ["relations", "negated order", "notGreaterEqual", "\\ngeq", "not greater than or equal", []], ["relations", "order", "precedesEqual", "\\preceq", "precedes or equals", []], ["relations", "order", "succeedsEqual", "\\succeq", "succeeds or equals", []], ["relations", "geometric", "notParallel", "\\nparallel", "not parallel", []], ["relations", "algebraic", "divides", "\\mid", "divides", ["such that"]], ["relations", "algebraic", "notDivides", "\\nmid", "does not divide", []], ["relations", "equality", "doteq", "\\doteq", "dot equals", ["defined approximately"]], ["relations", "geometric", "bowtie", "\\bowtie", "bowtie relation", ["join"]],
  ["functions", "trigonometric", "sin", "\\sin", "sine", []], ["functions", "trigonometric", "cos", "\\cos", "cosine", []], ["functions", "trigonometric", "tan", "\\tan", "tangent", []], ["functions", "trigonometric", "cot", "\\cot", "cotangent", []], ["functions", "trigonometric", "sec", "\\sec", "secant", []], ["functions", "trigonometric", "csc", "\\csc", "cosecant", []], ["functions", "inverse trigonometric", "arcsin", "\\arcsin", "inverse sine", ["asin"]], ["functions", "inverse trigonometric", "arccos", "\\arccos", "inverse cosine", ["acos"]], ["functions", "inverse trigonometric", "arctan", "\\arctan", "inverse tangent", ["atan"]],
  ["functions", "hyperbolic", "sinh", "\\sinh", "hyperbolic sine", []], ["functions", "hyperbolic", "cosh", "\\cosh", "hyperbolic cosine", []], ["functions", "hyperbolic", "tanh", "\\tanh", "hyperbolic tangent", []], ["functions", "hyperbolic", "coth", "\\coth", "hyperbolic cotangent", []], ["functions", "elementary", "exponential", "\\exp", "exponential function", ["exp"]], ["functions", "elementary", "naturalLog", "\\ln", "natural logarithm", ["ln"]], ["functions", "elementary", "logarithm", "\\log", "logarithm", ["log"]], ["functions", "number theory", "gcd", "\\gcd", "greatest common divisor", []], ["functions", "number theory", "lcm", "\\operatorname{lcm}", "least common multiple", []], ["functions", "elementary", "signum", "\\operatorname{sgn}", "signum function", ["sign function"]],
  ["calculus", "integrals", "idotsint", "\\int\\!\\cdots\\!\\int", "multiple integral", ["iterated integral"]], ["calculus", "integrals", "oiiint", "\\oiiint", "closed volume integral", []], ["calculus", "derivatives", "prime", "f'", "first derivative", []], ["calculus", "derivatives", "doublePrime", "f''", "second derivative", []], ["calculus", "operators", "dalembertian", "\\Box", "d Alembertian", ["wave operator"]],
  ["analysis", "limits", "limitSuperior", "\\limsup", "limit superior", ["lim sup"]], ["analysis", "limits", "limitInferior", "\\liminf", "limit inferior", ["lim inf"]], ["analysis", "bounds", "essentialSupremum", "\\operatorname*{ess\\,sup}", "essential supremum", ["ess sup"]], ["analysis", "asymptotics", "bigO", "\\mathcal{O}", "big O", ["order notation"]], ["analysis", "asymptotics", "littleO", "o", "little o", []], ["analysis", "convergence", "weakConvergence", "\\rightharpoonup", "weak convergence", []], ["analysis", "convergence", "weakStarConvergence", "\\overset{*}{\\rightharpoonup}", "weak star convergence", []], ["analysis", "convergence", "uniformConvergence", "\\rightrightarrows", "uniform convergence", []],
  ["analysis", "complex analysis", "realPart", "\\operatorname{Re}", "real part", []], ["analysis", "complex analysis", "imaginaryPart", "\\operatorname{Im}", "imaginary part", []], ["analysis", "complex analysis", "complexArgument", "\\arg", "complex argument", ["phase"]], ["analysis", "complex analysis", "complexConjugate", "\\overline{z}", "complex conjugate", ["conjugate"]], ["analysis", "complex analysis", "residue", "\\operatorname{Res}", "complex residue", []], ["analysis", "complex analysis", "imaginaryUnit", "\\mathrm{i}", "imaginary unit", []],
  ["sets", "containment", "notSubsetEqual", "\\nsubseteq", "not subset or equal", []], ["sets", "containment", "notSupersetEqual", "\\nsupseteq", "not superset or equal", []], ["sets", "operations", "bigUnion", "\\bigcup", "indexed union", []], ["sets", "operations", "bigIntersection", "\\bigcap", "indexed intersection", []], ["sets", "operations", "disjointUnion", "\\bigsqcup", "disjoint union", []], ["sets", "number systems", "quaternions", "\\mathbb{H}", "quaternion numbers", []], ["sets", "number systems", "finiteField", "\\mathbb{F}", "finite field", ["field"]],
  ["logic", "proof", "proves", "\\vdash", "proves", ["turnstile", "syntactic entailment"]], ["logic", "proof", "dashv", "\\dashv", "reverse turnstile", []], ["logic", "constants", "top", "\\top", "true", ["tautology"]], ["logic", "constants", "bottom", "\\bot", "false", ["contradiction"]],
  ["linearAlgebra", "matrix operations", "dagger", "A^\\dagger", "dagger", ["conjugate transpose", "pseudoinverse"]], ["linearAlgebra", "operators", "diagonalOperator", "\\operatorname{diag}", "diagonal operator", ["diag"]], ["linearAlgebra", "spaces", "dimension", "\\dim", "dimension", []], ["linearAlgebra", "spaces", "kernel", "\\ker", "kernel", ["null space"]], ["linearAlgebra", "spaces", "image", "\\operatorname{im}", "image", ["range"]], ["linearAlgebra", "spaces", "span", "\\operatorname{span}", "linear span", []], ["linearAlgebra", "spaces", "orthogonalComplement", "V^\\perp", "orthogonal complement", []], ["linearAlgebra", "spaces", "directSum", "\\oplus", "direct sum", []], ["linearAlgebra", "spaces", "bigDirectSum", "\\bigoplus", "indexed direct sum", []], ["linearAlgebra", "products", "hadamardProduct", "\\odot", "Hadamard product", ["elementwise product"]], ["linearAlgebra", "norms", "oneNorm", "\\lVert x\\rVert_1", "one norm", ["L1 norm", "Manhattan norm"]], ["linearAlgebra", "norms", "twoNorm", "\\lVert x\\rVert_2", "two norm", ["L2 norm", "Euclidean norm"]], ["linearAlgebra", "norms", "infinityNorm", "\\lVert x\\rVert_\\infty", "infinity norm", ["max norm"]], ["linearAlgebra", "norms", "frobeniusNorm", "\\lVert A\\rVert_{\\mathrm F}", "Frobenius norm", []], ["linearAlgebra", "spectral", "spectralRadius", "\\rho(A)", "spectral radius", []],
  ["discrete", "combinatorics", "fallingFactorial", "n^{\\underline{k}}", "falling factorial", []], ["discrete", "combinatorics", "risingFactorial", "n^{\\overline{k}}", "rising factorial", ["Pochhammer symbol"]], ["discrete", "graph theory", "graphDegree", "\\deg(v)", "vertex degree", ["graph degree"]], ["discrete", "graph theory", "graph", "G=(V,E)", "graph", ["vertex edge"]], ["discrete", "number theory", "congruentModulo", "a\\equiv b\\pmod n", "congruent modulo", ["modular arithmetic"]],
  ["probability", "moments", "conditionalExpectation", "\\mathbb{E}[X\\mid Y]", "conditional expectation", []], ["probability", "probability", "indicator", "\\mathbf{1}_A", "indicator function", ["characteristic function of event"]], ["probability", "statistics", "sampleMean", "\\bar{x}", "sample mean", ["average"]], ["probability", "statistics", "sampleVariance", "s^2", "sample variance", []], ["probability", "statistics", "standardDeviation", "\\sigma", "standard deviation", []], ["probability", "statistics", "standardError", "\\operatorname{SE}", "standard error", []],
  ["probability", "distributions", "normalDistribution", "\\mathcal{N}(\\mu,\\sigma^2)", "normal distribution", ["Gaussian distribution"]], ["probability", "distributions", "uniformDistribution", "\\mathcal{U}(a,b)", "uniform distribution", []], ["probability", "distributions", "bernoulliDistribution", "\\operatorname{Bern}(p)", "Bernoulli distribution", []], ["probability", "distributions", "binomialDistribution", "\\operatorname{Bin}(n,p)", "binomial distribution", []], ["probability", "distributions", "poissonDistribution", "\\operatorname{Pois}(\\lambda)", "Poisson distribution", []], ["probability", "distributions", "exponentialDistribution", "\\operatorname{Exp}(\\lambda)", "exponential distribution", []],
  ["probability", "convergence", "convergenceProbability", "\\xrightarrow{p}", "convergence in probability", []], ["probability", "convergence", "convergenceDistribution", "\\xrightarrow{d}", "convergence in distribution", ["weak convergence in law"]], ["probability", "convergence", "convergenceAlmostSure", "\\xrightarrow{\\mathrm{a.s.}}", "almost sure convergence", ["almost surely"]], ["probability", "information theory", "entropy", "H(X)", "Shannon entropy", ["entropy"]], ["probability", "information theory", "conditionalEntropy", "H(X\\mid Y)", "conditional entropy", []], ["probability", "information theory", "mutualInformation", "I(X;Y)", "mutual information", []], ["probability", "information theory", "klDivergence", "D_{\\mathrm{KL}}(P\\parallel Q)", "Kullback Leibler divergence", ["KL divergence", "relative entropy"]],
  ["optimization", "convex analysis", "convexHull", "\\operatorname{conv}", "convex hull", []], ["optimization", "convex analysis", "subgradient", "\\partial f(x)", "subgradient", ["subdifferential"]], ["optimization", "convex analysis", "proximalOperator", "\\operatorname{prox}_f", "proximal operator", ["prox"]], ["optimization", "duality", "convexConjugate", "f^*", "convex conjugate", ["Fenchel conjugate", "dual"]], ["optimization", "cones", "positiveSemidefinite", "A\\succeq0", "positive semidefinite", ["PSD"]], ["optimization", "cones", "negativeSemidefinite", "A\\preceq0", "negative semidefinite", ["NSD"]], ["optimization", "cones", "positiveDefinite", "A\\succ0", "positive definite", ["PD"]],
  ["numerical", "floating point", "machineEpsilon", "\\varepsilon_{\\mathrm{mach}}", "machine epsilon", ["unit roundoff"]], ["numerical", "error", "absoluteError", "|x-\\hat{x}|", "absolute error", []], ["numerical", "error", "relativeError", "\\frac{|x-\\hat{x}|}{|x|}", "relative error", []], ["numerical", "conditioning", "conditionNumber", "\\kappa(A)", "condition number", []], ["numerical", "finite differences", "forwardDifference", "\\Delta f", "forward difference", []], ["numerical", "finite differences", "backwardDifference", "\\nabla f", "backward difference", []], ["numerical", "finite differences", "centralDifference", "\\delta f", "central difference", []], ["numerical", "error", "truncationError", "\\mathcal{O}(h^p)", "truncation error", ["order p"]], ["numerical", "iterative methods", "iteration", "x^{(k)}", "iteration", ["iterate"]],
  ["geometry", "angles", "measuredAngle", "\\measuredangle ABC", "measured angle", []], ["geometry", "angles", "sphericalAngle", "\\sphericalangle ABC", "spherical angle", []], ["geometry", "shapes", "squareShape", "\\square", "square", []],
  ["arrows", "directional", "longLeftArrow", "\\longleftarrow", "long left arrow", []], ["arrows", "directional", "longLeftRightArrow", "\\longleftrightarrow", "long bidirectional arrow", []], ["arrows", "directional", "upDownArrow", "\\updownarrow", "up down arrow", []], ["arrows", "harpoons", "rightHarpoonUp", "\\rightharpoonup", "right harpoon", ["weak convergence"]], ["arrows", "harpoons", "rightLeftHarpoons", "\\rightleftharpoons", "equilibrium", ["reversible reaction"]], ["arrows", "directional", "northEastArrow", "\\nearrow", "northeast arrow", ["increasing"]], ["arrows", "directional", "southEastArrow", "\\searrow", "southeast arrow", ["decreasing"]],
  ["transforms", "Fourier", "fourierTransform", "\\mathcal{F}", "Fourier transform", ["frequency transform"]], ["transforms", "Fourier", "inverseFourierTransform", "\\mathcal{F}^{-1}", "inverse Fourier transform", []], ["transforms", "Laplace", "laplaceTransform", "\\mathcal{L}", "Laplace transform", []], ["transforms", "Laplace", "inverseLaplaceTransform", "\\mathcal{L}^{-1}", "inverse Laplace transform", []], ["transforms", "Z transform", "zTransform", "\\mathcal{Z}", "z transform", []], ["transforms", "signal operations", "convolution", "*", "convolution", []], ["transforms", "signal operations", "crossCorrelation", "\\star", "cross correlation", []], ["transforms", "signals", "diracDelta", "\\delta(t)", "Dirac delta", ["impulse"]], ["transforms", "signals", "heaviside", "u(t)", "Heaviside step", ["unit step"]], ["transforms", "signals", "sinc", "\\operatorname{sinc}", "sinc function", []], ["transforms", "control", "transferFunction", "G(s)", "transfer function", []], ["transforms", "control", "stateSpace", "\\dot{x}=Ax+Bu", "state space equation", []], ["transforms", "control", "controllability", "\\mathcal{C}", "controllability matrix", []], ["transforms", "control", "observability", "\\mathcal{O}", "observability matrix", []],
  ["physics", "quantum", "outerProductQuantum", "|\\psi\\rangle\\langle\\phi|", "quantum outer product", ["ket bra"]], ["physics", "mechanics", "poissonBracket", "\\{f,g\\}", "Poisson bracket", []], ["physics", "mechanics", "hamiltonianPhysics", "\\mathcal{H}", "Hamiltonian mechanics", []], ["physics", "mechanics", "momentum", "\\mathbf{p}", "linear momentum", []], ["physics", "mechanics", "angularMomentum", "\\mathbf{L}", "angular momentum", []], ["physics", "mechanics", "torque", "\\boldsymbol{\\tau}", "torque", []],
  ["physics", "electromagnetism", "electricField", "\\mathbf{E}", "electric field", []], ["physics", "electromagnetism", "magneticField", "\\mathbf{B}", "magnetic field", []], ["physics", "electromagnetism", "electricDisplacement", "\\mathbf{D}", "electric displacement field", []], ["physics", "electromagnetism", "magneticIntensity", "\\mathbf{H}", "magnetic field intensity", []], ["physics", "electromagnetism", "vacuumPermittivity", "\\varepsilon_0", "vacuum permittivity", ["electric constant"]], ["physics", "electromagnetism", "vacuumPermeability", "\\mu_0", "vacuum permeability", ["magnetic constant"]],
  ["physics", "thermodynamics", "partitionFunction", "Z", "partition function", []], ["physics", "thermodynamics", "thermodynamicEntropy", "S", "thermodynamic entropy", []], ["physics", "thermodynamics", "helmholtzFreeEnergy", "F", "Helmholtz free energy", []], ["physics", "thermodynamics", "gibbsFreeEnergy", "G", "Gibbs free energy", []], ["physics", "continuum mechanics", "stressTensor", "\\boldsymbol{\\sigma}", "stress tensor", ["Cauchy stress"]], ["physics", "continuum mechanics", "strainTensor", "\\boldsymbol{\\varepsilon}", "strain tensor", []], ["physics", "continuum mechanics", "materialDerivative", "\\frac{D}{Dt}", "material derivative", ["substantial derivative"]], ["physics", "fluid mechanics", "reynoldsNumber", "\\mathrm{Re}", "Reynolds number", []],
  ["tensors", "index notation", "einsteinSum", "A^iB_i", "Einstein summation", ["index contraction"]], ["tensors", "differential geometry", "covariantDerivative", "\\nabla_\\mu", "covariant derivative", []], ["tensors", "differential geometry", "christoffel", "\\Gamma^\\rho_{\\mu\\nu}", "Christoffel symbol", []], ["tensors", "differential geometry", "riemannTensor", "R^\\rho{}_{\\sigma\\mu\\nu}", "Riemann curvature tensor", []], ["tensors", "differential geometry", "ricciTensor", "R_{\\mu\\nu}", "Ricci tensor", []], ["tensors", "differential geometry", "metricTensor", "g_{\\mu\\nu}", "metric tensor", []], ["tensors", "differential geometry", "lieDerivative", "\\mathcal{L}_X", "Lie derivative", []], ["tensors", "differential forms", "wedgeProduct", "\\wedge", "wedge product", ["exterior product"]], ["tensors", "differential forms", "exteriorDerivative", "\\mathrm{d}", "exterior derivative", []], ["tensors", "differential forms", "hodgeStar", "\\star", "Hodge star", []],
  ["accents", "accents", "wideTilde", "\\widetilde{ABC}", "wide tilde", []], ["accents", "accents", "tripleDot", "\\dddot{x}", "triple dot", ["third time derivative"]], ["accents", "vectors", "boldVector", "\\mathbf{x}", "bold vector", []], ["accents", "vectors", "boldSymbol", "\\boldsymbol{x}", "bold symbol", []], ["accents", "accents", "overleftarrow", "\\overleftarrow{AB}", "over left arrow", []], ["accents", "braces", "overbrace", "\\overbrace{x+y}", "overbrace", []], ["accents", "braces", "underbrace", "\\underbrace{x+y}", "underbrace", []],
];


// Second independent inventory pass: stochastic processes, ordinary statistical
// families, algebra/analysis spaces, and configurable STEM structures.
/** @type {Array<[string, string, string, string, string, string[]]>} */
const supplementalSpecs = [
  ["functions", "hyperbolic", "sech", "\\operatorname{sech}", "hyperbolic secant", []],
  ["functions", "hyperbolic", "csch", "\\operatorname{csch}", "hyperbolic cosecant", []],
  ["functions", "inverse functions", "arccot", "\\operatorname{arccot}", "inverse cotangent", []],
  ["functions", "inverse functions", "arcsec", "\\operatorname{arcsec}", "inverse secant", []],
  ["functions", "inverse functions", "arccsc", "\\operatorname{arccsc}", "inverse cosecant", []],
  ["functions", "inverse functions", "arsinh", "\\operatorname{arsinh}", "inverse hyperbolic sine", ["asinh"]],
  ["functions", "inverse functions", "arcosh", "\\operatorname{arcosh}", "inverse hyperbolic cosine", ["acosh"]],
  ["functions", "inverse functions", "artanh", "\\operatorname{artanh}", "inverse hyperbolic tangent", ["atanh"]],
  ["functions", "special functions", "gammaFunction", "\\Gamma(z)", "Gamma function", []],
  ["functions", "special functions", "betaFunction", "B(x,y)", "Beta function", []],
  ["functions", "special functions", "errorFunction", "\\operatorname{erf}(x)", "error function", []],
  ["functions", "special functions", "besselFunction", "J_\\nu(x)", "Bessel function", []],
  ["probability", "distributions", "gammaDistribution", "\\operatorname{Gamma}(\\alpha,\\beta)", "Gamma distribution", []],
  ["probability", "distributions", "betaDistribution", "\\operatorname{Beta}(\\alpha,\\beta)", "Beta distribution", []],
  ["probability", "distributions", "studentT", "t_\\nu", "Student t distribution", []],
  ["probability", "distributions", "chiSquared", "\\chi^2_\\nu", "chi squared distribution", []],
  ["probability", "distributions", "fDistribution", "F_{m,n}", "F distribution", []],
  ["probability", "distributions", "geometricDistribution", "\\operatorname{Geom}(p)", "geometric distribution", []],
  ["probability", "statistics", "cdf", "F_X(x)", "cumulative distribution function", ["cdf"]],
  ["probability", "statistics", "pdf", "f_X(x)", "probability density function", ["pdf"]],
  ["probability", "statistics", "mgf", "M_X(t)", "moment generating function", ["mgf"]],
  ["probability", "statistics", "characteristicFunction", "\\varphi_X(t)", "characteristic function", []],
  ["probability", "statistics", "fisherInformation", "\\mathcal{I}(\\theta)", "Fisher information", []],
  ["probability", "stochastic processes", "brownianMotion", "W_t", "Brownian motion", ["Wiener process"]],
  ["probability", "stochastic processes", "filtration", "\\mathcal{F}_t", "filtration", ["sigma algebra"]],
  ["probability", "stochastic processes", "quadraticVariation", "[X]_t", "quadratic variation", []],
  ["probability", "stochastic processes", "transitionProbability", "p_{ij}(t)", "Markov transition probability", []],
  ["optimization", "machine learning", "softmax", "\\operatorname{softmax}(z)", "softmax", []],
  ["optimization", "machine learning", "sigmoid", "\\sigma(z)", "sigmoid logistic function", []],
  ["optimization", "machine learning", "relu", "\\operatorname{ReLU}(z)", "rectified linear unit", ["relu"]],
  ["optimization", "machine learning", "crossEntropy", "H(p,q)", "cross entropy loss", []],
  ["optimization", "convex analysis", "subjectTo", "\\text{s.t.}", "subject to constraints", []],
  ["analysis", "function spaces", "lpSpace", "L^p(\\Omega)", "Lebesgue L p space", []],
  ["analysis", "function spaces", "sobolevSpace", "W^{k,p}(\\Omega)", "Sobolev space", []],
  ["analysis", "function spaces", "continuousSpace", "C^k(\\Omega)", "continuously differentiable functions", []],
  ["analysis", "topology", "closure", "\\overline{A}", "closure of set", []],
  ["analysis", "topology", "interior", "A^\\circ", "interior of set", []],
  ["analysis", "topology", "boundary", "\\partial\\Omega", "boundary of domain", []],
  ["sets", "abstract algebra", "normalSubgroup", "\\trianglelefteq", "normal subgroup", []],
  ["sets", "abstract algebra", "quotientGroup", "G/H", "quotient group", []],
  ["sets", "abstract algebra", "homomorphism", "\\operatorname{Hom}(V,W)", "homomorphism space", []],
  ["sets", "abstract algebra", "automorphism", "\\operatorname{Aut}(G)", "automorphism group", []],
  ["relations", "negated", "notEquivalent", "\\not\\equiv", "not equivalent", []],
  ["relations", "negated", "notApproximate", "\\not\\approx", "not approximately equal", []],
  ["relations", "set relations", "properSubset", "\\subsetneq", "proper subset", []],
  ["logic", "quantifiers", "uniqueExists", "\\exists!", "there exists uniquely", ["unique existence"]],
  ["arrows", "mappings", "isomorphism", "\\xrightarrow{\\sim}", "isomorphism arrow", []],
  ["linearAlgebra", "decompositions", "pseudoinverse", "A^+", "Moore Penrose pseudoinverse", []],
  ["linearAlgebra", "decompositions", "singularValues", "\\sigma_i(A)", "singular values", ["svd"]],
  ["linearAlgebra", "products", "bigTensorProduct", "\\bigotimes", "tensor product large operator", []],
  ["calculus", "large operators", "bigWedge", "\\bigwedge", "large wedge", []],
  ["calculus", "large operators", "bigVee", "\\bigvee", "large vee", []],
  ["delimiters", "ellipsis", "horizontalDots", "\\cdots", "centered horizontal dots", ["ellipsis"]],
  ["delimiters", "ellipsis", "verticalDots", "\\vdots", "vertical dots", []],
  ["delimiters", "ellipsis", "diagonalDots", "\\ddots", "diagonal dots", []],
  ["physics", "thermodynamics", "boltzmannConstant", "k_{\\mathrm B}", "Boltzmann constant", []],
  ["physics", "quantum", "densityOperator", "\\hat{\\rho}", "density operator", ["density matrix"]],
  ["physics", "quantum", "tensorState", "|\\psi\\rangle\\otimes|\\phi\\rangle", "tensor product state", []],
  ["transforms", "signals", "discreteFourier", "\\operatorname{DFT}(x)", "discrete Fourier transform", ["dft fft"]],
  ["transforms", "control", "frequencyResponse", "H(i\\omega)", "frequency response", []],
];
/** @type {Array<[string, string, string, string[]]>} */
const supplementalStructureSpecs = [
  ["stochasticDifferential", "dX_t=□\\,dt+□\\,dW_t", "stochastic differential equation", ["ito sde stochastic processes"]],
  ["itoIntegral", "\\int_{□}^{□} □\\,dW_t", "Ito stochastic integral", ["stochastic calculus"]],
  ["bracketMatrix", "\\begin{bmatrix}□&□\\\\□&□\\end{bmatrix}", "bracket matrix", []],
  ["columnVector", "\\begin{pmatrix}□\\\\□\\\\□\\end{pmatrix}", "column vector", []],
  ["augmentedMatrix", "\\left[\\begin{array}{cc|c}□&□&□\\\\□&□&□\\end{array}\\right]", "augmented matrix", ["linear system"]],
  ["tensorMixedIndices", "T^{□}{}_{□}{}^{□}{}_{□}", "mixed tensor indices", ["contravariant covariant tensor"]],
  ["matrixElement", "\\langle □|□|□\\rangle", "quantum matrix element", ["bra operator ket"]],
  ["logBase", "\\log_{□}(□)", "logarithm with base", []],
  ["multinomial", "\\binom{□}{□,□}", "multinomial coefficient", ["combinatorics"]],
  ["normalDerivative", "\\frac{\\partial □}{\\partial n}\\bigg|_{□}", "normal boundary derivative", ["neumann boundary condition pde"]],
  ["initialCondition", "□\\big|_{t=0}=□", "initial condition", ["ode pde boundary"]],
  ["fourierSeries", "\\sum_{n=-\\infty}^{\\infty} □ e^{in□}", "Fourier series", []],
  ["alignedSystem", "\\begin{aligned}□&=□\\\\□&=□\\\\□&=□\\end{aligned}", "three aligned equations", ["system"]],
  ["annotatedArrow", "\\xrightarrow[□]{□}", "annotated arrow", ["mapping convergence"]],
];
const supplementalStructures = supplementalStructureSpecs.map(([id, latex, name, aliases]) => entry(id, "structures", latex, latex, name, aliases, {type: "structure", subcategory: "advanced STEM"}));

const advancedEntries = advancedSpecs.map(([category, subcategory, id, latex, name, aliases]) => entry(id, category, latex, latex, name, aliases, { subcategory }));

const symbolEntries = Object.entries(groups).flatMap(([category, items]) => items.map(([id, insertion, display = insertion, name = id]) => entry(id, category, display, insertion, name, [id.replace(/([A-Z])/g, " $1").toLowerCase(), insertion.replace(/\\/g, "")])))
  .concat(greekLower.map(([id, value]) => entry(id, "greek", value, value, id, [id.replace("var", "variant")])))
  .concat(greekUpper.map(([id, value]) => entry(`upper${id}`, "greek", value, value, id, [id.toLowerCase(), "uppercase greek"])))
  .concat([entry("realNumbers", "numberSystems", "\\mathbb{R}", "\\mathbb{R}", "real numbers", ["reals"]), entry("complexNumbers", "numberSystems", "\\mathbb{C}", "\\mathbb{C}", "complex numbers", ["complex"]), entry("integers", "numberSystems", "\\mathbb{Z}", "\\mathbb{Z}", "integers", ["whole numbers"]), entry("rationals", "numberSystems", "\\mathbb{Q}", "\\mathbb{Q}", "rational numbers", ["fractions"]), entry("naturals", "numberSystems", "\\mathbb{N}", "\\mathbb{N}", "natural numbers", ["natural"])]).concat(advancedEntries);

export const MATH_SYMBOL_REGISTRY = Object.freeze([...symbolEntries, ...supplementalSpecs.map(([category, subcategory, id, latex, name, aliases]) => entry(id, category, latex, latex, name, aliases, {subcategory})), ...structures, ...supplementalStructures]);
export const MATH_CATEGORIES = Object.freeze([...new Set(MATH_SYMBOL_REGISTRY.map((item) => item.category))]);
export const MATH_SUBCATEGORIES = Object.freeze(Object.fromEntries(MATH_CATEGORIES.map((category) => [category, Object.freeze([...new Set(MATH_SYMBOL_REGISTRY.filter((item) => item.category === category).map((item) => item.subcategory))])] )));
export function searchMathSymbols(query = "") {
  const needle = String(query).trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!needle) return MATH_SYMBOL_REGISTRY;
  const synonyms = { contour: "contour integral", approximately: "approximately equal", hessian: "hessian", kronecker: "kronecker", surface: "surface integral", "levi civita": "levi civita" };
  const expandedNeedle = synonyms[needle] || needle;
  const terms = expandedNeedle.split(" ");
  return MATH_SYMBOL_REGISTRY.filter((item) => {
    const haystack = [item.id, item.name, item.insertion, item.editorInsertion, ...item.aliases].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function validateMathSymbolRegistry(registry = MATH_SYMBOL_REGISTRY) {
  const ids = new Set();
  return registry.every((item) => item.id && !ids.has(item.id) && ids.add(item.id)
    && item.category && item.subcategory && item.displayLatex && item.insertion && item.editorInsertion
    && Array.isArray(item.aliases) && item.insertOptions?.insertionMode && item.insertOptions?.selectionMode);
}
