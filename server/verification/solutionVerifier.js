import { format, variables } from "./expression.js";
import { parseStatement, VERIFICATION_VERSION, verifyAstClaim } from "./mathVerifier.js";

const MAX_FIELDS = 32;
const inconclusive = (reason) => ({ state: "inconclusive", method: "claim_interpretation", reason });
function parse(value) { try { return parseStatement(value); } catch { return null; } }

/** Evidence refers to immutable source fields, never tokens or renderer geometry.
 * Prose, cross-step implications and completeness are deliberately not inferred.
 */
export function verifySolution(result, { problem = "", problemText = problem, assumptions = [], inputSource = "submitted_input" } = {}) {
  const checks = [];
  const inputStatement = parse(problem);
  const original = inputStatement?.kind === "calculation_assignment" ? inputStatement.calculation : inputStatement;
  const options = { assumptions };
  const definitions = new Map();
  if (original?.kind === "function_definition") definitions.set(original.name, { ...original, fieldPath: "input" });
  const fields = (result.steps || []).map((step, index) => ({
    fieldPath: `steps[${index}].${step.latex ? "latex" : step.math ? "math" : "equationLatex"}`,
    stepId: step.id || `step-${index + 1}`,
    expression: step.latex || step.math || step.equationLatex || "",
  }));
  fields.push({ fieldPath: result.finalAnswerLatex ? "finalAnswerLatex" : "finalAnswer", stepId: null, expression: result.finalAnswerLatex || result.finalAnswer || "", final: true });
  for (const field of fields.slice(0, MAX_FIELDS)) {
    const statement = parse(field.expression);
    let evidence = inconclusive(statement ? "no_supported_claim" : "unsupported_or_ambiguous_notation");
    let kind = statement?.kind || "unparsed";
    if (statement?.kind === "function_definition") {
      // Rebinding is ambiguous; do not choose whichever provider definition makes
      // the derivative work. Only prior, single-variable definitions are usable.
      if (definitions.has(statement.name)) definitions.set(statement.name, null);
      else definitions.set(statement.name, { ...statement, fieldPath: field.fieldPath });
      evidence = inconclusive("function_definition_not_independent_correctness_evidence");
    } else if (statement?.kind === "named_derivative" && statement.right) {
      const definition = definitions.get(statement.name);
      if (definition && definition.variable === statement.variable) {
        evidence = { ...verifyAstClaim({ kind: "derivative", expression: definition.right, variable: statement.variable, right: statement.right }, options), definitionField: definition.fieldPath };
      } else evidence = inconclusive("missing_or_ambiguous_function_definition");
    } else if (statement?.right && ["derivative", "antiderivative", "definite_integral"].includes(statement.kind)) {
      evidence = verifyAstClaim(statement, options);
    } else if (field.final && original && ["derivative", "antiderivative", "definite_integral"].includes(original.kind) && (statement?.kind === "expression" || (inputStatement?.kind === "calculation_assignment" && statement?.kind === "equality" && statement.left.type === "variable" && statement.left.name === inputStatement.name))) {
      kind = original.kind;
      evidence = { ...verifyAstClaim({ ...original, right: statement.kind === "expression" ? statement.expression : statement.right }, options), linkedInput: problem, inputSource };
    } else if (field.final && original?.kind === "equality" && statement?.kind === "equality" && statement.left.type === "variable" && variables(statement.right).size === 0) {
      kind = "solution";
      evidence = { ...verifyAstClaim({ kind, left: original.left, right: original.right, variable: statement.left.name, value: statement.right }, options), linkedInput: problem, inputSource };
    } else if (statement?.kind === "equality") {
      const proof = verifyAstClaim(statement, options);
      // A statement with free variables may be a constraint, definition or local
      // substitution. Only an actual identity proof is meaningful without an
      // explicit universal-equivalence claim; numerical nonidentity is not failure.
      if (proof.state === "verified" || (!variables(statement.left).size && !variables(statement.right).size)) evidence = proof;
      else evidence = inconclusive("equation_may_be_constraint_not_universal_identity");
    }
    checks.push({ id: `math-check-${checks.length + 1}`, ...field, kind, assumptions, ...evidence });
  }
  if (fields.length > MAX_FIELDS) checks.push({ id: "coverage-limit", fieldPath: "steps", stepId: null, expression: "", ...inconclusive("candidate_field_budget_exceeded") });
  const counts = Object.fromEntries(["verified", "numerically_supported", "inconclusive", "contradicted"].map((state) => [state, checks.filter((check) => check.state === state).length]));
  return {
    version: VERIFICATION_VERSION,
    input: { text: problem, displayText: problemText, source: inputSource, assumptions, proseAssumptionsParsed: false, interpretation: original?.kind || "unsupported", providerExtractionVerifiedAgainstImage: false },
    checks,
    summary: { counts, hasContradiction: counts.contradicted > 0, solutionCorrectness: "not_established" },
    coverage: { examinedFields: Math.min(fields.length, MAX_FIELDS), totalFields: fields.length, proseChecked: false, crossStepImplicationsChecked: false, solutionCompletenessChecked: false },
  };
}

// Useful for deterministic clients/tests constructing typed claims from an AST.
export { format as formatVerificationExpression };
