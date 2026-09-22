import {
  addQ, binary, canonicalDifference, differentiate, divQ, exactValue, format,
  mulQ, negQ, num, parseExpression, parseStatement, qText, rational, substitute, variables,
} from "./expression.js";
import { assumptionContext, domainObligations, evaluate, quadratureSafe, sampleAllowed, substituteAll } from "./domain.js";

export const VERIFICATION_VERSION = "scalar-real-v1";
export const VERIFICATION_STATES = Object.freeze(["verified", "numerically_supported", "inconclusive", "contradicted"]);
const ABS_TOLERANCE = 1e-10;
const REL_TOLERANCE = 1e-9;
const MIN_SAMPLES = 5;
const SAMPLE_VALUES = [0, -1.37, 0.23, 2.11, -0.61, 3.07, -2.43, 0.79, 1.63, -3.19, 4.31, -4.73];
const result = (state, method, reason, details = {}) => ({ state, method, reason, ...details });

function numericalComparison(left, right, extraDomains, context, options) {
  const names = [...new Set([...variables(left), ...variables(right), ...extraDomains.flatMap((a) => [...variables(a)])])].sort();
  if (names.length > 4) return result("inconclusive", "numerical_substitution", "variable_limit");
  const planned = options.samples || SAMPLE_VALUES.map((_, i) => Object.fromEntries(names.map((name, j) => [name, SAMPLE_VALUES[(i * [1, 5, 7, 11][j] + j * 3) % SAMPLE_VALUES.length]])));
  const samples = []; const excluded = []; const seen = new Set();
  for (const point of planned.slice(0, 32)) {
    const bindings = Object.fromEntries(names.map((name) => [name, point[name]]));
    const key = JSON.stringify(bindings);
    if (seen.has(key)) continue;
    seen.add(key);
    if (names.some((name) => !Number.isFinite(bindings[name])) || !sampleAllowed(bindings, context)) {
      excluded.push({ bindings, reason: "outside_assumptions_or_missing_binding" }); continue;
    }
    try {
      extraDomains.forEach((a) => evaluate(a, bindings));
      const a = evaluate(left, bindings); const b = evaluate(right, bindings);
      const tolerance = ABS_TOLERANCE + REL_TOLERANCE * Math.max(Math.abs(a.v), Math.abs(b.v));
      const errorBound = 64 * (a.e + b.e);
      if (errorBound > tolerance / 4) { excluded.push({ bindings, reason: "roundoff_or_conditioning" }); continue; }
      const residual = Math.abs(a.v - b.v);
      const disagrees = residual > 32 * tolerance + errorBound;
      const supports = residual <= tolerance;
      let exactCounterexample = false;
      let exactValues = null;
      try {
        const exactBindings = Object.fromEntries(Object.entries(bindings).map(([name, value]) => [name, parseExpression(String(value))]));
        const qa = exactValue(substituteAll(left, exactBindings)); const qb = exactValue(substituteAll(right, exactBindings));
        exactCounterexample = Boolean(qa && qb && qa.n * qb.d !== qb.n * qa.d);
        if (qa && qb) exactValues = { left: qText(qa), right: qText(qb) };
      } catch { /* Nonrational expressions retain numerical evidence only. */ }
      samples.push({ bindings, left: a.v, right: b.v, residual, tolerance, estimatedRoundoff: errorBound, supports, disagrees, exactCounterexample, exactValues });
    } catch (error) { excluded.push({ bindings, reason: error.message }); }
  }
  const details = { numerical: { precision: "IEEE-754 binary64", absTolerance: ABS_TOLERANCE, relTolerance: REL_TOLERANCE, minimumSamples: MIN_SAMPLES, sampling: options.samples ? "caller_supplied" : "fixed-distinct-v1", samples, excluded } };
  if (samples.some((s) => s.exactCounterexample)) return result("contradicted", "exact_rational_counterexample", "valid_substitution_disagrees", details);
  if (samples.filter((s) => s.disagrees).length >= (names.length ? 2 : 1)) return result("contradicted", "numerical_counterexample", "stable_residual_exceeds_tolerance", details);
  if (!names.length && samples.length === 1 && samples[0].supports) return result("numerically_supported", "constant_evaluation", "floating_point_agreement_is_not_proof", details);
  // Distinct joint points alone are insufficient if any independent variable
  // never varied (e.g. a caller supplied only a diagonal or fixed coordinate).
  const varied = names.every((name) => new Set(samples.map((s) => s.bindings[name])).size >= MIN_SAMPLES);
  if (samples.length >= MIN_SAMPLES && varied && samples.every((s) => s.supports)) return result("numerically_supported", "numerical_substitution", "multiple_valid_samples_agree_not_proof", details);
  return result("inconclusive", "numerical_substitution", "insufficient_or_mixed_stable_samples", details);
}

export function compareExpressions(left, right, { assumptions = [], extraDomains = [], ...options } = {}) {
  const context = assumptionContext(assumptions);
  if (context.inconsistent || context.unsupported.length) return result("inconclusive", "assumption_check", context.inconsistent ? "inconsistent_assumptions" : "unsupported_assumptions");
  const obligations = domainObligations([left, right, ...extraDomains], context);
  const domain = { universe: "real", obligations, complete: obligations.every((o) => o.resolved) };
  const exactLeft = exactValue(left); const exactRight = exactValue(right);
  if (exactLeft && exactRight && domain.complete) {
    const equal = exactLeft.n * exactRight.d === exactRight.n * exactLeft.d;
    return result(equal ? "verified" : "contradicted", "exact_rational_evaluation", equal ? "exact_values_equal" : "exact_values_differ", { domain, exactLeft: qText(exactLeft), exactRight: qText(exactRight) });
  }
  if (format(left) === format(right) && domain.complete) return result("verified", "parsed_expression_identity", "identical_defined_expressions", { domain });
  let zero = false; let symbolicReason = "nonzero_or_unsupported_normal_form";
  try { zero = canonicalDifference(left, right); } catch (error) { symbolicReason = error.message; }
  if (zero && domain.complete) return result("verified", "exact_rational_normal_form", "difference_is_exactly_zero_on_stated_domain", { domain });
  const numerical = numericalComparison(left, right, extraDomains, context, options);
  if (numerical.state === "numerically_supported" && !domain.complete) {
    return result("inconclusive", numerical.method, "unresolved_domain_obligations", { ...numerical, state: "inconclusive", reason: "unresolved_domain_obligations", domain, symbolicReason, symbolicZero: zero });
  }
  return { ...numerical, domain, symbolicReason, symbolicZero: zero };
}

function polynomial(ast, variable) {
  const put = (map, degree, value) => {
    if (degree > 24) throw new Error("polynomial_degree_limit");
    const q = addQ(map.get(degree) || rational(0n), value); if (q.n) map.set(degree, q); else map.delete(degree);
  };
  const multiply = (a, b) => { const out = new Map(); for (const [i, x] of a) for (const [j, y] of b) put(out, i + j, mulQ(x, y)); return out; };
  if (ast.type === "number") return new Map([[0, ast.value]]);
  if (ast.type === "variable" && ast.name === variable) return new Map([[1, rational(1n)]]);
  if (ast.type !== "binary") throw new Error("not_rational_polynomial");
  const a = polynomial(ast.left, variable);
  if (ast.op === "/") {
    const q = exactValue(ast.right); if (!q?.n) throw new Error("not_constant_denominator");
    return new Map([...a].map(([i, x]) => [i, divQ(x, q)]));
  }
  if (ast.op === "^") {
    const q = exactValue(ast.right); if (!q || q.d !== 1n || q.n < 0n || q.n > 12n) throw new Error("unsupported_polynomial_power");
    let out = new Map([[0, rational(1n)]]); for (let i = 0; i < Number(q.n); i++) out = multiply(out, a); return out;
  }
  const b = polynomial(ast.right, variable);
  if (ast.op === "*") return multiply(a, b);
  const out = new Map(a); for (const [i, q] of b) put(out, i, ast.op === "+" ? q : negQ(q)); return out;
}

function quadrature(ast, variable, lower, upper) {
  if (!quadratureSafe(ast, variable)) throw new Error("quadrature_continuity_not_established");
  const a = evaluate(lower).v; const b = evaluate(upper).v;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.max(Math.abs(a), Math.abs(b)) > 10000 || a === b) throw new Error("unsupported_numerical_bounds");
  let evaluations = 0;
  const f = (x) => {
    if (++evaluations > 20000) throw new Error("quadrature_evaluation_limit");
    const y = evaluate(ast, { [variable]: x });
    if (y.e > 1e-12 * Math.max(1, Math.abs(y.v))) throw new Error("quadrature_roundoff"); return y.v;
  };
  const simpson = (l, r, fl, fm, fr) => (r - l) * (fl + 4 * fm + fr) / 6;
  function run(panels, tolerance) {
    let total = 0; let correction = 0; let estimatedError = 0;
    function refine(l, r, fl, fm, fr, whole, eps, depth) {
      const mid = (l + r) / 2; const f1 = f((l + mid) / 2); const f2 = f((mid + r) / 2);
      const s1 = simpson(l, mid, fl, f1, fm); const s2 = simpson(mid, r, fm, f2, fr);
      const delta = s1 + s2 - whole;
      if (Math.abs(delta) <= 15 * eps) { estimatedError += Math.abs(delta) / 15; return s1 + s2 + delta / 15; }
      if (!depth) throw new Error("quadrature_not_converged");
      return refine(l, mid, fl, f1, fm, s1, eps / 2, depth - 1) + refine(mid, r, fm, f2, fr, s2, eps / 2, depth - 1);
    }
    for (let i = 0; i < panels; i++) {
      const l = a + (b - a) * i / panels; const r = a + (b - a) * (i + 1) / panels;
      const fl = f(l); const fm = f((l + r) / 2); const fr = f(r);
      const value = refine(l, r, fl, fm, fr, simpson(l, r, fl, fm, fr), tolerance / panels, 16);
      const y = value - correction; const next = total + y; correction = (next - total) - y; total = next;
    }
    return { value: total, estimatedError };
  }
  // Different initial partitions reduce simple grid aliasing. Convergence is
  // supporting evidence, never a certified integration error bound.
  const coarse = run(13, 1e-10); const fine = run(29, 1e-12);
  return { coarse, fine, evaluations, lower: a, upper: b };
}

function checkIntegral(claim, options) {
  const { integrand, variable, lower, upper, right } = claim;
  const context = assumptionContext(options.assumptions);
  if (context.inconsistent || context.unsupported.length || context.supported.some((a) => a.variable === variable)) return result("inconclusive", "definite_integral", "unsupported_integral_assumptions");
  if (variables(lower).size || variables(upper).size || variables(right).size) return result("inconclusive", "definite_integral", "nonconstant_bounds_or_answer");
  const domain = domainObligations([integrand, lower, upper, right], context);
  try {
    if (domain.some((o) => !o.resolved)) throw new Error("unresolved_domain");
    const coefficients = polynomial(integrand, variable); const lo = exactValue(lower); const hi = exactValue(upper);
    if (!lo || !hi) throw new Error("nonrational_bounds");
    let value = rational(0n);
    for (const [degree, q] of coefficients) {
      const n = BigInt(degree + 1);
      value = addQ(value, mulQ(divQ(q, rational(n)), addQ(rational(hi.n ** n, hi.d ** n), negQ(rational(lo.n ** n, lo.d ** n)))));
    }
    return { ...compareExpressions(num(value), right, options), method: "exact_polynomial_integration", exactIntegral: qText(value) };
  } catch { /* A bounded numerical method is a separate evidence level. */ }
  try {
    const estimates = quadrature(integrand, variable, lower, upper);
    const answer = evaluate(right); const tolerance = 1e-9 + 1e-9 * Math.max(Math.abs(answer.v), Math.abs(estimates.fine.value));
    const delta = Math.abs(estimates.coarse.value - estimates.fine.value);
    const numerical = { precision: "IEEE-754 binary64", method: "adaptive_simpson_two_partitions", ...estimates, claimed: answer.v, tolerance, residual: Math.abs(answer.v - estimates.fine.value), certifiedErrorBound: false };
    if (delta > tolerance / 8 || estimates.fine.estimatedError > tolerance / 8 || answer.e * 64 > tolerance / 8) return result("inconclusive", "numerical_quadrature", "quadrature_or_answer_not_stable", { numerical });
    if (numerical.residual <= tolerance) return result("numerically_supported", "numerical_quadrature", "converged_estimates_agree_not_proof", { numerical });
    // Quadrature disagreement alone cannot certify a contradiction. An unseen
    // narrow peak/oscillation can defeat both partitions.
    return result("inconclusive", "numerical_quadrature", "numerical_integral_disagrees_requires_review", { numerical });
  } catch (error) { return result("inconclusive", "definite_integral", error.message); }
}

function impossibleRationalDomain(ast) {
  if (ast.type === "binary") {
    const b = exactValue(ast.right); const a = exactValue(ast.left);
    if (ast.op === "/" && b?.n === 0n) return true;
    if (ast.op === "^" && a?.n === 0n && b && b.n <= 0n) return true;
    return impossibleRationalDomain(ast.left) || impossibleRationalDomain(ast.right);
  }
  if (ast.type === "call") {
    const a = exactValue(ast.argument);
    if (a && (ast.name === "sqrt" && a.n < 0n || ast.name === "ln" && a.n <= 0n || ["asin", "acos"].includes(ast.name) && (a.n < -a.d || a.n > a.d))) return true;
    return impossibleRationalDomain(ast.argument);
  }
  return false;
}

export function verifyAstClaim(claim, options = {}) {
  try {
    if (claim.kind === "equivalence" || claim.kind === "equality") return compareExpressions(claim.left, claim.right, options);
    if (["derivative", "antiderivative"].includes(claim.kind)) {
      const original = claim.kind === "derivative" ? claim.expression : claim.right;
      const target = claim.kind === "derivative" ? claim.right : claim.integrand;
      const derived = differentiate(original, claim.variable);
      return { ...compareExpressions(derived, target, { ...options, extraDomains: [original] }), operation: "symbolic_differentiation", differentiated: format(original), derivative: format(derived), variable: claim.variable };
    }
    if (claim.kind === "definite_integral") return checkIntegral(claim, options);
    if (claim.kind === "solution") {
      if (variables(claim.value).size) return result("inconclusive", "solution_substitution", "nonconstant_root");
      const left = substitute(claim.left, claim.variable, claim.value); const right = substitute(claim.right, claim.variable, claim.value);
      if (variables(left).size || variables(right).size) return result("inconclusive", "solution_substitution", "unbound_equation_parameters");
      const context = assumptionContext(options.assumptions);
      if (context.inconsistent || context.unsupported.length) return result("inconclusive", "solution_substitution", "unsupported_or_inconsistent_assumptions");
      const root = exactValue(claim.value);
      const rootAssumptions = context.supported.filter((a) => a.variable === claim.variable);
      if (rootAssumptions.length && !root) return result("inconclusive", "solution_substitution", "nonrational_root_assumption_comparison");
      if (rootAssumptions.some((a) => {
        const delta = root.n * a.exact.d - a.exact.n * root.d;
        return !{ ">": delta > 0n, ">=": delta >= 0n, "<": delta < 0n, "<=": delta <= 0n, "!=": delta !== 0n, "=": delta === 0n }[a.relation];
      })) return result("contradicted", "solution_substitution", "root_outside_stated_assumptions");
      if (impossibleRationalDomain(left) || impossibleRationalDomain(right)) return result("contradicted", "exact_domain_check", "root_outside_original_equation_domain");
      return { ...compareExpressions(left, right, options), operation: "solution_substitution", substitutedLeft: format(left), substitutedRight: format(right), variable: claim.variable, root: format(claim.value), completenessChecked: false };
    }
    return result("inconclusive", "claim_interpretation", "unsupported_claim_kind");
  } catch (error) { return result("inconclusive", "bounded_verifier", error.message); }
}

/** Public deterministic API. Inputs are complete expressions, not prose. */
export function verifyMathClaim(claim, options = {}) {
  try {
    const parsed = { ...claim };
    for (const key of ["left", "right", "expression", "integrand", "value", "lower", "upper"]) if (typeof parsed[key] === "string") parsed[key] = parseExpression(parsed[key]);
    if (["solution", "derivative", "antiderivative", "definite_integral"].includes(claim.kind) && !/^[A-Za-z]$/u.test(claim.variable || "")) throw new Error("explicit_variable_required");
    return { version: VERIFICATION_VERSION, claim: { ...claim }, assumptions: options.assumptions || [], ...verifyAstClaim(parsed, options) };
  } catch (error) { return { version: VERIFICATION_VERSION, claim: { ...claim }, assumptions: options.assumptions || [], ...result("inconclusive", "claim_parsing", error.message) }; }
}

export { parseStatement };
