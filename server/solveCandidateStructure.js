import { validateGeneratedLatex } from "./generatedLatexValidation.js";
import { renderMathLatex } from "./mathAnnotator.js";
import { getSolveDiagnosticContext } from "./solveDiagnosticContext.js";

const INVISIBLE_LATEX = /\\(?:quad|qquad|enspace|enskip|thinspace|medspace|thickspace|negthinspace|negmedspace|negthickspace|hspace|vspace|phantom|hphantom|vphantom|displaystyle|textstyle|scriptstyle|scriptscriptstyle|,|;|!|:|\s)/gu;
const INVISIBLE_LATEX_WITH_ARGUMENT = /\\(?:hspace|vspace|phantom|hphantom|vphantom)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/gu;

function stepMathField(step = {}) {
  const fields = [
    ["latex", step?.latex],
    ["math", step?.math],
    ["equationLatex", step?.equationLatex],
    ["display", step?.display],
  ];
  for (const [key, value] of fields) {
    if (typeof value === "string" && value.trim()) return { key, value };
  }
  for (const [key, value] of fields) {
    if (typeof value === "string") return { key, value };
  }
  return { key: "math", value: "" };
}

function summarizeTextBoundary(value) {
  const present = value !== undefined && value !== null;
  const text = typeof value === "string" ? value : "";
  const normalized = present ? String(renderMathLatex(text) || "") : "";
  return {
    present,
    type: typeof value,
    charCount: text.length,
    trimmedCharCount: text.trim().length,
    normalizedCharCount: normalized.length,
    visibleMath: typeof value === "string" && hasVisibleMath(value),
  };
}

/**
 * A payload-safe boundary summary for incident diagnostics. It deliberately
 * records lengths and renderability, never the generated equation itself.
 * Comparing provider and post-normalization summaries identifies where a
 * blank was introduced without logging user problem content.
 */
export function summarizeSolveCandidateStructure(result, { stage = "candidate" } = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return {
    stage,
    finalAnswer: summarizeTextBoundary(result?.finalAnswerLatex ?? result?.finalAnswer),
    stepCount: steps.length,
    steps: steps.map((step, index) => ({
      index,
      id: typeof step?.id === "string" ? step.id : null,
      math: summarizeTextBoundary(step?.math),
      latex: summarizeTextBoundary(step?.latex),
      equationLatex: summarizeTextBoundary(step?.equationLatex),
      display: summarizeTextBoundary(step?.display),
      reasoning: summarizeTextBoundary(step?.reasoning ?? step?.explanation ?? step?.summary),
    })),
  };
}

/**
 * Detect a value which contains only TeX layout commands. KaTeX accepts
 * these, but the browser renders no visible equation. This remains a
 * structural/renderability check, not a mathematical correctness check.
 */
export function hasVisibleMath(value = "") {
  const source = String(value || "").trim();
  if (!source) return false;
  const rendered = renderMathLatex(source);
  if (!String(rendered || "").trim()) return false;
  const withoutLayout = String(rendered)
    .replace(INVISIBLE_LATEX_WITH_ARGUMENT, "")
    .replace(INVISIBLE_LATEX, "")
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{\s*\}/gu, "")
    .replace(/[{}\s]/gu, "")
    .trim();
  return withoutLayout.length > 0;
}

function addUnique(issues, issue) {
  if (issue && !issues.includes(issue)) issues.push(issue);
}

function createStructureError(solutionIssues = [], solutionDiagnostics = [], stage = "candidate") {
  const issues = solutionIssues.length > 0 ? solutionIssues : ["missing_required_fields"];
  const request = getSolveDiagnosticContext();
  return Object.assign(new Error("Parsed solve response is missing required structural fields."), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    responseFailureType: "schema_contract",
    publicMessage: "The AI service returned an incomplete explanation.",
    solutionIssues: issues,
    solutionDiagnostics,
    solutionStage: stage,
    requestId: request.requestId || null,
  });
}

/**
 * Return all structural/renderability issues without mutating the candidate.
 * This boundary is shared by raw provider candidates and post-normalization
 * payloads so a blank can be attributed to its stage.
 */
export function inspectSolveCandidateStructure(result, {
  stage = "candidate",
  sourceSteps = null,
  strictParse = true,
  requireFinalAnswer = true,
} = {}) {
  const issues = [];
  const warnings = [];
  const recoverableIssues = [];
  const diagnostics = [];
  const recordEmpty = ({ field, index = null, sourceField = null, sourceValue, destinationValue }) => {
    const sourceWasVisible = typeof sourceValue === "string" && hasVisibleMath(sourceValue);
    const sourceWasProvided = sourceValue !== undefined;
    const type = sourceWasVisible
      ? "normalization_emptied"
      : stage === "provider" || sourceWasProvided
        ? "provider_empty"
        : stage === "accepted" || stage === "post_annotation"
          ? "accepted_empty"
          : "candidate_empty";
    diagnostics.push({
      type,
      field,
      index,
      sourceField,
      sourcePresent: sourceWasProvided,
      sourceVisible: sourceWasVisible,
      destinationVisible: typeof destinationValue === "string" && hasVisibleMath(destinationValue),
    });
    return type;
  };
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    addUnique(issues, "missing_required_fields");
    return { usable: false, issues, warnings, recoverableIssues, diagnostics, stage };
  }

  const finalAnswer = result?.finalAnswerLatex ?? result?.finalAnswer;
  if (requireFinalAnswer) {
    if (typeof finalAnswer !== "string" || !finalAnswer.trim()) {
      addUnique(issues, "finalAnswerLatex:empty");
      recordEmpty({ field: "finalAnswerLatex", destinationValue: finalAnswer });
    } else if (!hasVisibleMath(finalAnswer)) {
      addUnique(issues, "finalAnswerLatex:empty_visible_math");
      recordEmpty({ field: "finalAnswerLatex", destinationValue: finalAnswer });
    } else {
      const validation = validateGeneratedLatex(finalAnswer, {
        fieldPath: "finalAnswerLatex",
        finalAnswer: true,
        strictFinalAnswerContract: true,
        strictParse,
      });
      validation.issues
        .filter((issue) => issue !== "lost_latex_command_backslash")
        .forEach((issue) => addUnique(issues, `finalAnswerLatex:${issue}`));
      validation.warnings.forEach((issue) => addUnique(warnings, `finalAnswerLatex:${issue}`));
    }
  }

  const steps = result?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    addUnique(issues, "steps:empty");
    diagnostics.push({
      type: stage === "provider"
        ? "provider_empty"
        : stage === "accepted" || stage === "post_annotation"
          ? "accepted_empty"
          : "candidate_empty",
      field: "steps",
      index: null,
    });
    return { usable: false, issues, warnings, recoverableIssues, diagnostics, stage };
  }

  const stepIds = new Set();
  steps.forEach((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      addUnique(issues, `steps[${index}]:invalid_object`);
      recordEmpty({ field: `steps[${index}]`, index, destinationValue: step });
      return;
    }
    if (typeof step.id === "string" && step.id.trim()) {
      if (stepIds.has(step.id)) addUnique(issues, `steps[${index}].id:duplicate`);
      stepIds.add(step.id);
    }
    const { key, value } = stepMathField(step);
    const sourceField = sourceSteps?.[index] ? stepMathField(sourceSteps[index]) : null;
    const sourceValue = sourceField?.value;
    if (typeof sourceValue === "string" && typeof value === "string" && sourceValue !== value) {
      addUnique(recoverableIssues, `steps[${index}].${key}:normalized`);
    }
    const destinationVisible = typeof value === "string" && hasVisibleMath(value);
    if (!destinationVisible) {
      const emptyType = recordEmpty({
        field: `steps[${index}].${key}`,
        index,
        sourceField: sourceField ? `steps[${index}].${sourceField.key}` : null,
        sourceValue,
        destinationValue: value,
      });
      if (emptyType === "normalization_emptied") {
        addUnique(issues, `normalization_emptied_step:steps[${index}].${key}`);
      }
    }
    if (typeof value !== "string" || !value.trim()) {
      addUnique(issues, `steps[${index}].${key}:empty`);
      return;
    }

    const validation = validateGeneratedLatex(value, {
      fieldPath: `steps[${index}].${key}`,
      strictParse,
    });
    validation.issues
      // The normalizer intentionally repairs plain function names such as
      // `sin(x)`/`ln(x)` into their TeX commands. That warning is not a
      // render failure and must remain compatible with existing solver input.
      .filter((issue) => issue !== "lost_latex_command_backslash")
      .forEach((issue) => addUnique(issues, `steps[${index}].${key}:${issue}`));
    validation.warnings.forEach((issue) => addUnique(warnings, `steps[${index}].${key}:${issue}`));

    if (!destinationVisible) {
      addUnique(issues, `steps[${index}].${key}:empty_visible_math`);
    }
  });

  return { usable: issues.length === 0, issues, warnings, recoverableIssues, diagnostics, stage };
}

export function assertSolveCandidateStructure(result, options = {}) {
  const inspection = inspectSolveCandidateStructure(result, options);
  if (!inspection.usable) {
    if (inspection.diagnostics.length > 0) {
      const request = getSolveDiagnosticContext();
      console.error("[omnimath:solve-candidate-boundary]", {
        outcome: inspection.diagnostics[0].type,
        stage: inspection.stage,
        requestId: request.requestId || options.requestId || null,
        endpoint: request.endpoint || options.endpoint || null,
        diagnostics: inspection.diagnostics,
      });
    }
    throw createStructureError(inspection.issues, inspection.diagnostics, inspection.stage);
  }
  return result;
}

export function inspectRenderedSolveStructure(result, options = {}) {
  return inspectSolveCandidateStructure(result, { ...options, stage: options.stage || "rendered" });
}
