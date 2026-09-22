// Deterministic, provider-independent fixtures for provenance and follow-up tests.
// A fixture's `selected` occurrence is authoritative; `dependencies` describes
// the oracle, not text that a provider is required to repeat verbatim.
const step = (id, title, math, reasoning, extra = {}) => ({ id, title, math, reasoning, ...extra });
const target = (semanticId, stepId, occurrence, text, parentExpression, branch = "main") => {
  const match = typeof occurrence === "string" ? occurrence.match(/^(\d+):(\d+)$/) : null;
  return {
    semanticId,
    stepId,
    sourceRange: match ? { start: Number(match[1]), end: Number(match[2]) } : null,
    occurrenceKey: match ? `source:${occurrence}` : String(occurrence || semanticId),
    text,
    parentExpression,
    branch,
  };
};
const dep = (id, kind, relation, stepId, extra = {}) => ({ id, kind, relation, stepId, ...extra });
const fixture = (id, domain, problem, steps, selected, dependencies, originalInputs, followups, hazards, extra = {}) => ({
  id, domain, problem, steps, selected, dependencies, originalInputs, followups, hazards,
  requiredClaims: dependencies.filter(({ kind }) => kind !== "unknown").map(({ id: dependencyId }) => dependencyId),
  forbiddenClaims: [],
  ...extra,
});

export const provenanceStressCorpus = [
  fixture("matrix-inverse-adjugate-entry", "linear-algebra",
    "Find the inverse of A=[[4,1,2],[0,3,1],[0,2,5]].",
    [
      step("s1", "determinant", "det(A)=52", "Expand along the first column to obtain a nonzero determinant."),
      step("s2", "minor", "M₂₂=[[4,2],[0,5]]", "Delete row 2 and column 2 for the cofactor contributing to adj(A)₂₂."),
      step("s3", "cofactor", "C₂₂=(−1)⁴ det(M₂₂)=4·5−2·0=20", "Evaluate the 2×2 minor determinant and apply the positive checkerboard sign."),
      step("s4", "adjugate", "adj(A)=[[13,−1,−5],[0,20,−4],[0,−8,12]]", "Transpose the cofactor matrix."),
      step("s5", "inverse", "A⁻¹=(1/52)adj(A)", "Multiply the adjugate by 1/det(A)."),
    ],
    target("m-adj-20", "s4", "20:22", "20", "adj(A)=[[13,−1,−5],[0,20,−4],[0,−8,12]]"),
    [dep("adjugate-position-22", "explicit", "selected adjugate entry", "s4"), dep("cofactor-22", "explicit", "transpose maps adj(A)₂₂ to C₂₂", "s3"), dep("minor-22", "explicit", "delete row 2 and column 2", "s2"), dep("minor-determinant", "explicit", "4·5−2·0", "s3"), dep("cofactor-sign", "implicit", "(−1)²⁺² is positive", "s3")],
    { matrix: [[4, 1, 2], [0, 3, 1], [0, 2, 5]], determinant: 52 },
    ["what is this?", "how did you find it?", "why is the cofactor sign positive?", "show the exact minor calculation"],
    ["deep-chain", "matrix", "follow-up-context"],
    { branch: "main" }),

  fixture("repeated-identical-occurrences", "algebra", "Simplify 2x + 2x − 2x.",
    [step("s1", "combine like terms", "2x + 2x − 2x = 2x", "The three occurrences are combined by coefficient arithmetic.")],
    target("tok-2x-third", "s1", "9:11", "2x", "2x + 2x − 2x"),
    [dep("third-2x", "explicit", "selected occurrence", "s1"), dep("first-second", "explicit", "like-term sum", "s1")],
    { expression: "2x + 2x − 2x" }, ["where did this come from?", "what about the other 2x?"],
    ["repeated-text", "identity-collision", "pronoun-reference"]),

  fixture("matrix-product-branching", "linear-algebra", "Compute (AB)₂₁ for A=[[1,2],[3,4]], B=[[5,6],[7,8]].",
    [step("s1", "row-column products", "(AB)₂₁ = 3·5 + 4·7", "Use row 2 of A and column 1 of B.", { branch: "entry-21" }),
      step("s2", "sum", "(AB)₂₁ = 15 + 28 = 43", "Add both independent products.", { branch: "entry-21" })],
    target("ab-21-result", "s2", "(AB)[2,1]", "43", "15 + 28", "entry-21"),
    [dep("row2", "explicit", "selected row", "s1"), dep("col1", "explicit", "selected column", "s1"), dep("15", "explicit", "first pairwise product", "s2"), dep("28", "explicit", "second pairwise product", "s2")],
    { A: [[1, 2], [3, 4]], B: [[5, 6], [7, 8]] }, ["how did you get 43?", "what are both terms?"], ["branching", "aggregate", "multiple-dependencies"]),

  fixture("integration-by-parts", "calculus", "Evaluate ∫ x eˣ dx.",
    [step("s1", "choose parts", "u=x, dv=eˣdx; du=dx, v=eˣ", "Apply integration by parts."), step("s2", "new integral", "xeˣ − ∫eˣdx", "Substitute u,v into uv−∫vdu."), step("s3", "result", "eˣ(x−1)+C", "Integrate the remaining eˣ term.")],
    target("ibp-minus-integral", "s2", "18:25", "∫eˣdx", "xeˣ − ∫eˣdx"),
    [dep("u-v", "explicit", "integration-by-parts choices", "s1"), dep("rule", "implicit", "uv−∫vdu theorem", "s1"), dep("new-integral", "explicit", "remaining integral", "s2")],
    { integrand: "x e^x", rule: "integration by parts" }, ["why did you use this rule?", "what did you substitute?", "where did the remaining integral come from?"], ["implicit-rule", "multi-turn", "operator-selection"]),

  fixture("wrong-premise-correction", "algebra", "Solve 4x = 20.",
    [step("s1", "divide", "x = 20/4 = 5", "Divide both sides by 4.")], target("wrong-premise-5", "s1", "8:9", "5", "20/4"),
    [dep("divide-by-4", "explicit", "inverse operation", "s1")], { equation: "4x=20" }, ["Why did you multiply by 4?", "Did the solution divide or multiply?"], ["wrong-premise", "arithmetic", "correction-required"], { forbiddenClaims: ["the solution multiplied by 4"] }),

  fixture("skipped-algebra-reconstruction", "algebra", "Solve x² − 5x + 6 = 0.",
    [step("s1", "factor", "(x−2)(x−3)=0", "The factorization is stated without showing trial arithmetic."), step("s2", "roots", "x=2 or x=3", "Use the zero-product property.")],
    target("skipped-factor-3", "s1", "6:7", "3", "(x−2)(x−3)"), [dep("factorization", "reconstructed", "factors multiply to 6 and sum to −5", "s1")],
    { polynomial: "x²−5x+6" }, ["how did you get this factor?", "was that calculation shown?"], ["skipped-step", "reconstruction-boundary", "avoid-fabrication"]),

  fixture("long-distance-chain-40", "algebra", "Starting with a₀=2, double 40 times and evaluate a₄₀−2⁴⁰.",
    Array.from({ length: 41 }, (_, i) => i === 0 ? step("s0", "initial value", "a₀=2", "Given.") : step(`s${i}`, `doubling ${i}`, `a${i}=2a${i - 1}`, "Substitute the prior result into the recurrence.", { dependsOn: [`s${i - 1}`] })).concat([step("s41", "difference", "a₄₀−2⁴⁰=0", "The recurrence gives a₄₀=2⁴⁰.", { dependsOn: ["s40", "s0"] })]),
    target("long-zero", "s41", "a40−2^40", "0", "a₄₀−2⁴⁰"), [dep("a40", "explicit", "recurrence output", "s40"), dep("power", "reconstructed", "repeated doubling from a₀", "s0", { distance: 40 })],
    { a0: 2, steps: 40 }, ["where did the power come from?", "trace this to the original input"], ["long-distance", "40-step", "context-window"]),

  fixture("multibranch-domain-assumption", "algebra", "Solve √(x−1)=x−3 over the reals.",
    [step("s1", "domain", "x≥3", "The right side must be nonnegative.", { assumptions: ["principal square root", "x−3≥0"] }), step("s2", "square", "x−1=(x−3)²", "Square both sides under the domain condition."), step("s3a", "candidate", "x=3", "Candidate from the quadratic.", { branch: "candidate-3" }), step("s3b", "candidate", "x=5", "Candidate from the quadratic.", { branch: "candidate-5" }), step("s4", "check", "x=5", "Reject x=3; it fails the original equation.", { branch: "accepted" })],
    target("accepted-five", "s4", "solution", "5", "√(x−1)=x−3", "accepted"), [dep("domain", "assumption", "principal-root domain", "s1"), dep("candidate", "explicit", "quadratic candidate", "s3b"), dep("rejection", "explicit", "substitution check", "s4")],
    { equation: "√(x−1)=x−3", domain: "real" }, ["why was 3 rejected?", "which branch is this?", "why is the domain needed?"], ["branches", "domain", "extraneous-root"]),

  fixture("approximation-provenance", "calculus", "Approximate sin(π/3) to four decimals.",
    [step("s1", "exact value", "sin(π/3)=√3/2", "Use the 60-degree special-angle identity."), step("s2", "decimal", "√3/2≈0.8660", "Evaluate numerically and round to four decimal places.", { approximation: true })],
    target("approx-08660", "s2", "15:21", "0.8660", "√3/2≈0.8660"), [dep("exact", "explicit", "special-angle identity", "s1"), dep("rounding", "approximation", "four-decimal rounding", "s2")],
    { angle: "π/3", precision: 4 }, ["where did the decimal come from?", "why four places?"], ["approximation", "exact-to-decimal", "precision"]),

  fixture("probability-variance-branching", "probability", "For X taking 0,1,2 with probabilities .2,.5,.3, find Var(X).",
    [step("s1", "mean", "E[X]=1.1", "Sum xP(X=x)."), step("s2", "second moment", "E[X²]=1.7", "Sum x²P(X=x)."), step("s3", "variance", "Var(X)=1.7−1.1²=0.49", "Use E[X²]−E[X]².")],
    target("variance-049", "s3", "Var(X)", "0.49", "1.7−1.1²"), [dep("second-moment", "explicit", "E[X²] branch", "s2"), dep("mean", "explicit", "E[X] branch", "s1"), dep("variance-rule", "implicit", "variance identity", "s3")],
    { distribution: [[0, .2], [1, .5], [2, .3]] }, ["why subtract the square of the mean?", "what are both inputs?"], ["branching", "implicit-rule", "decimal-arithmetic"]),

  fixture("discrete-and-special-notation", "discrete-special", "Evaluate Σ(k=1..3) k! and Γ(4).",
    [step("s1", "factorial sum", "1!+2!+3!=9", "Expand the finite sum."), step("s2", "gamma identity", "Γ(4)=3!=6", "Use Γ(n)=(n−1)! for positive integers."), step("s3", "combined", "9+6=15", "Add the two independent results.")],
    target("gamma-six", "s2", "Γ(4)", "6", "Γ(4)=3!"), [dep("gamma-rule", "implicit", "Gamma/factorial identity", "s2"), dep("factorial", "reconstructed", "3! = 3·2·1", "s2")],
    { sum: "Σk!", gamma: "Γ(4)" }, ["why is Γ(4) equal to 3!?", "what does the dummy index mean?"], ["special-function", "nested-sum", "implicit-definition"]),

  fixture("insufficient-provenance", "mixed", "The generated solution states only: y=42.",
    [step("s1", "answer", "y=42", "No derivation, inputs, or rule are provided.")], target("unsupported-42", "s1", "2:4", "42", "y=42"),
    [dep("origin", "unknown", "not present in supplied solution", "s1", { confidence: "insufficient" })], { statement: "y=42" }, ["where did 42 come from?", "show the exact calculation"], ["missing-provenance", "uncertainty-required", "no-fabrication"], { expectedOutcome: "uncertain-or-explicit-reconstruction", requiredClaims: [], forbiddenClaims: ["an asserted original calculation"] }),
];

export const provenanceFixtureById = Object.fromEntries(provenanceStressCorpus.map((entry) => [entry.id, entry]));
