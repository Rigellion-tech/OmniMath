// Presentation-only projection. Never feed this back into verification, acceptance,
// recovery or the authoritative progressive prefix.
export const FINAL_ANSWER_PRESENTATION_VERSION = 1;

const ROW_ENVIRONMENTS = new Set(["aligned", "alignedat", "gathered", "split"]);
// Definitions and TeX comments can carry meaning across row boundaries. Their
// removal would no longer be a presentation-only operation.
const STATEFUL_TEX = /\\(?:def|gdef|edef|xdef|let|global|newcommand|renewcommand|providecommand|catcode)\b|(?:^|[^\\])%/u;
const FINAL_HEADING = /^(?:final\s+answer|final\s+result|result\s+summary|conclusion)(?:\s*[:.\-(].*)?\s*$/iu;
const WARNING_CLASSES = {
  final_answer_contains_multiple_physical_lines: "presentation_normalizable",
  final_answer_contains_line_break_command: "presentation_normalizable",
  final_answer_contains_derivation_arrow: "mathematical_risk_signal",
  final_answer_contains_prose: "harmless_contextual",
  final_answer_contains_multiple_unrelated_equations: "presentation_review",
  detached_final_answer_fragment: "presentation_fallback_required",
  final_answer_splits_into_multiple_unrelated_fragments: "presentation_review",
};

function stripDisplayWrapper(value) {
  const source = String(value || "").trim();
  if (source.startsWith("\\[") && source.endsWith("\\]")) return source.slice(2, -2).trim();
  if (source.startsWith("$$") && source.endsWith("$$")) return source.slice(2, -2).trim();
  if (source.startsWith("$") && source.endsWith("$")) return source.slice(1, -1).trim();
  return source;
}

/** Only split a complete outer row environment, outside braces/nested environments.
 * Matrix/cases/array rows remain indivisible mathematical objects.
 */
export function inspectFinalAnswerRows(value = "") {
  const source = stripDisplayWrapper(value);
  const opener = source.match(/^\\begin\{([A-Za-z*]+)\}/u);
  const environment = opener?.[1] || "";
  const close = environment ? `\\end{${environment}}` : "";
  const canSplit = ROW_ENVIRONMENTS.has(environment) && source.endsWith(close);
  const body = canSplit ? source.slice(opener[0].length, -close.length) : source;
  let depth = 0;
  const environments = [];
  const rows = [];
  let start = 0;
  let malformed = false;
  let unsafeRowFormatting = false;
  for (let index = 0; index < body.length; index += 1) {
    const rest = body.slice(index);
    const env = rest.match(/^\\(begin|end)\{([A-Za-z*]+)\}/u);
    if (env) {
      if (env[1] === "begin") environments.push(env[2]);
      else if (environments.pop() !== env[2]) malformed = true;
      index += env[0].length - 1;
      continue;
    }
    if (body[index] === "\\") {
      if (canSplit && depth === 0 && environments.length === 0 && body[index + 1] === "\\") {
        rows.push(body.slice(start, index).trim());
        index += 1;
        start = index + 1;
        // Optional row spacing is formatting, but preserve it by declining extraction.
        if (body[start] === "[") unsafeRowFormatting = true;
      } else if (/[{}\\]/u.test(body[index + 1] || "")) index += 1;
      continue;
    }
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") {
      depth -= 1;
      if (depth < 0) malformed = true;
    }
  }
  if (depth !== 0 || environments.length) malformed = true;
  rows.push(body.slice(start).trim());
  return { source, environment: canSplit ? environment : "", rows, malformed,
    splittable: canSplit && !malformed && !unsafeRowFormatting && !STATEFUL_TEX.test(body) && environment !== "alignedat" };
}

/** Formatting identity only; no symbolic equivalence or algebraic simplification. */
export function normalizeFinalAnswerComparison(value = "") {
  const spaced = stripDisplayWrapper(value)
    .replace(/^(?:\s|\\(?:quad|qquad|enspace|thinspace|medspace|thickspace)\b|\\[,;! ])+/u, "")
    .replace(/(?:\s|\\(?:quad|qquad|enspace|thinspace|medspace|thickspace)\b|\\[,;! ])+$/u, "");
  const parsed = inspectFinalAnswerRows(spaced);
  const source = parsed.splittable ? parsed.rows.join("\\\\") : parsed.source;
  // Preserve text bodies: deleting their whitespace could change a restriction.
  const textBodies = [];
  let marker = "\uE000";
  while (source.includes(marker)) marker += "\uE000";
  let shielded = "";
  for (let index = 0; index < source.length; index += 1) {
    const opener = source.slice(index).match(/^\\(?:text|textrm|textnormal|textsf|texttt|textbf|textit|mathrm|operatorname|mbox)\s*\{/u);
    if (!opener) {
      shielded += source[index];
      continue;
    }
    let depth = 1;
    let end = index + opener[0].length;
    for (; end < source.length && depth; end += 1) {
      if (source[end] === "\\" && /[{}\\]/u.test(source[end + 1] || "")) { end += 1; continue; }
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
    }
    // Retain the entire nested text body exactly, including meaningful spaces.
    textBodies.push(source.slice(index, end));
    shielded += `${marker}${textBodies.length - 1}${marker}`;
    index = end - 1;
  }
  // Alignment tabs outside a structure are layout; matrix/array/cases separators
  // carry mathematical identity and must survive the comparison.
  let tabs = "";
  let depth = 0;
  const environments = [];
  for (let index = 0; index < shielded.length; index += 1) {
    const env = shielded.slice(index).match(/^\\(begin|end)\{([A-Za-z*]+)\}/u);
    if (env) {
      if (env[1] === "begin") environments.push(env[2]);
      else environments.pop();
      tabs += env[0];
      index += env[0].length - 1;
      continue;
    }
    const char = shielded[index];
    if (char === "\\" && /[{}&\\]/u.test(shielded[index + 1] || "")) {
      tabs += char + shielded[index + 1];
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char !== "&" || depth !== 0 || environments.length) tabs += char;
  }
  return tabs
    .replace(/\\(?:quad|qquad|enspace|thinspace|medspace|thickspace)\b|\\[,;! ]/gu, " ")
    .replace(/\\(?:left|right)\b/gu, "")
    .replace(/\\(?:dfrac|tfrac)\b/gu, "\\frac")
    // Removing command-delimiting whitespace must not turn \sin h into \sinh.
    .replace(/(\\[A-Za-z]+)\s+(?=[A-Za-z])/gu, `$1${marker}COMMAND${marker}`)
    .replace(/\s/gu, "")
    .replaceAll(`${marker}COMMAND${marker}`, " ")
    .replace(new RegExp(`${marker}(\\d+)${marker}`, "gu"), (_, index) => textBodies[Number(index)]);
}

function stepLatex(step) {
  const direct = step?.latex || step?.math || step?.equationLatex || step?.display;
  if (typeof direct === "string" && direct.trim()) return direct;
  return (Array.isArray(step?.lines) ? step.lines : [])
    .filter((line) => line?.latex || line?.kind === "math")
    .map((line) => line.latex || "").join(" ");
}

function finalCards(steps, canonical) {
  return steps.filter((step) => {
    const heading = step.heading || step.label || step.title || "";
    const text = normalizeFinalAnswerComparison(stepLatex(step));
    return FINAL_HEADING.test(heading) && text && text === canonical;
  });
}

function stepPresentationProse(step) {
  const textLines = (Array.isArray(step?.lines) ? step.lines : [])
    .filter((line) => line?.kind === "text")
    .map((line) => line.text);
  return [...new Set([step.reasoning, step.summary, step.plainExplanation, ...textLines]
    .filter((text) => typeof text === "string" && text.trim())
    .map((text) => text.trim()))];
}

function findingsFrom(validationFindings, source) {
  const issues = new Set();
  for (const finding of validationFindings) {
    if (typeof finding === "string") issues.add(finding.replace(/^finalAnswerLatex:/u, ""));
    else if (/^finalAnswer(?:Latex)?$/u.test(finding?.fieldPath || "")) {
      for (const issue of [...(finding.warnings || []), ...(finding.issues || [])]) issues.add(issue);
    }
  }
  if (/\n/u.test(source)) issues.add("final_answer_contains_multiple_physical_lines");
  if (/\\\\|\\newline\b/u.test(source)) issues.add("final_answer_contains_line_break_command");
  if (/\\(?:Rightarrow|Longrightarrow|rightarrow|implies)\b|⇒|⟹/u.test(source)) issues.add("final_answer_contains_derivation_arrow");
  return [...issues].map((issue) => ({ issue, classification: WARNING_CLASSES[issue] || "structurally_invalid" }));
}

/** @param {any} result @param {{validationFindings?:any[]}} options */
export function assessFinalAnswerPresentation(result = {}, { validationFindings = [] } = {}) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const explicitFinal = steps.findLast((step) => FINAL_HEADING.test(step.heading || step.label || step.title || ""));
  const raw = typeof result.finalAnswerLatex === "string" && result.finalAnswerLatex.trim() ? result.finalAnswerLatex
    : typeof result.finalAnswer === "string" && result.finalAnswer.trim() ? result.finalAnswer
      : explicitFinal ? stepLatex(explicitFinal) : "";
  const parsed = inspectFinalAnswerRows(raw);
  const canonical = normalizeFinalAnswerComparison(raw);
  const cards = finalCards(steps, canonical);
  const cardIds = new Set(cards.map((step) => step.id).filter(Boolean));
  const cardObjects = new Set(cards);
  const derivation = steps.filter((step) => !cardObjects.has(step));
  const derivationProse = new Set(derivation.flatMap(stepPresentationProse));
  const retainedFinalText = cards.flatMap((step) => stepPresentationProse(step)
    .filter((text) => !derivationProse.has(text))
    .map((text) => ({ stepId: step.id, text })));
  const matches = parsed.rows.map((row) => {
    const target = normalizeFinalAnswerComparison(row);
    return derivation.find((step) => normalizeFinalAnswerComparison(stepLatex(step)) === target);
  });
  const matchedIds = [...new Set(matches.filter(Boolean).map((step) => step.id))];
  const matchedCharacters = parsed.rows.reduce((sum, row, index) => sum + (matches[index] ? row.length : 0), 0);
  const substantial = parsed.splittable
    && ((matchedIds.length >= 3 && matchedCharacters >= 240)
      || (matchedIds.length >= 2 && matchedCharacters >= 400))
    && matchedCharacters / Math.max(1, parsed.source.length) >= 0.5;
  const matrixOnly = /\\begin\{(?:[bpvBV]?matrix|cases|array)\}/u.test(parsed.source)
    && !parsed.environment;
  const oversized = !matrixOnly && (parsed.rows.length > 8
    || (parsed.source.length > 1600 && parsed.rows.length >= 3));
  const plan = {
    version: FINAL_ANSWER_PRESENTATION_VERSION,
    action: raw === parsed.source ? "preserved" : "normalized",
    originalRetained: true,
    latex: parsed.source,
    reason: "concise_result_summary",
    fallbackText: "",
    finalStepIds: [...cardIds],
    retainedFinalText,
    findings: findingsFrom(validationFindings, raw),
    duplication: { classification: substantial ? "substantial_derivation" : "none", matchedStepIds: matchedIds, removedRows: 0 },
    size: { characters: raw.length, rows: parsed.rows.length,
      environmentCount: (raw.match(/\\begin\{/gu) || []).length,
      classification: oversized ? "oversized" : matrixOnly ? "structured_matrix_or_system" : "bounded" },
    overflow: "local_math_block",
    summaryRequired: Boolean(typeof result.finalAnswerLatex === "string" && result.finalAnswerLatex.trim()
      && !cards.length && !derivation.some((step) => normalizeFinalAnswerComparison(stepLatex(step)) === canonical)),
  };
  if (!parsed.source) {
    return { ...plan, action: "fallback", summaryRequired: false, originalRetained: false, reason: "absent_final_answer",
      fallbackText: "No separate result summary is available. Review the solution steps." };
  }
  if (parsed.malformed || plan.findings.some((finding) => finding.classification === "structurally_invalid")) {
    return { ...plan, action: "fallback", summaryRequired: false, reason: "malformed_final_answer",
      duplication: { ...plan.duplication, classification: "malformed" },
      fallbackText: "Review the solution steps. The original result summary could not be formatted reliably." };
  }
  if (substantial) {
    const novelRows = parsed.rows.filter((_, index) => !matches[index]);
    if (!novelRows.length) return { ...plan, action: "suppressed", summaryRequired: false, originalRetained: false, latex: "",
      reason: "derivation_already_visible", duplication: { ...plan.duplication, removedRows: parsed.rows.length } };
    // Keep every novel row, including assumptions/branches/residuals. Also retain
    // the latest matching result row when other rows of the derivation are removed.
    const lastMatch = matches.findLastIndex(Boolean);
    const kept = parsed.rows.filter((_, index) => !matches[index]
      || (index === lastMatch && matches[index] === derivation.at(-1)));
    const latex = `\\begin{${parsed.environment}}${kept.join("\\\\")}\\end{${parsed.environment}}`;
    return { ...plan, action: "compacted", originalRetained: false, latex,
      summaryRequired: !cards.length && !derivation.some((step) => normalizeFinalAnswerComparison(stepLatex(step)) === normalizeFinalAnswerComparison(latex)),
      reason: "duplicate_derivation_rows_removed",
      duplication: { ...plan.duplication, removedRows: parsed.rows.length - kept.length } };
  }
  // A large unstructured exact copy of several steps cannot be safely cut apart.
  const embeddedMatches = derivation.filter((step) => {
    const text = normalizeFinalAnswerComparison(stepLatex(step));
    return text.length >= 60 && canonical.includes(text);
  });
  const giantNonterminalCopy = derivation.slice(0, -1).some((step) =>
    parsed.source.length >= 360 && canonical === normalizeFinalAnswerComparison(stepLatex(step))
    && (parsed.rows.length >= 4 || /\\begin\{(?:[bpvBV]?matrix)\}/u.test(parsed.source)));
  const arrowTranscript = parsed.source.length >= 180
    && (parsed.source.match(/\\(?:Rightarrow|Longrightarrow|rightarrow|implies)\b|⇒|⟹/gu) || []).length >= 2;
  if (oversized || giantNonterminalCopy || arrowTranscript || (!parsed.splittable && embeddedMatches.length >= 3)) {
    return { ...plan, action: "fallback", summaryRequired: false, reason: "no_safe_result_extraction",
      duplication: { ...plan.duplication, classification: giantNonterminalCopy ? "giant_intermediate_copy"
        : arrowTranscript ? "suspected_derivation_sequence"
        : embeddedMatches.length >= 3 ? "suspected_derivation" : "none" },
      fallbackText: "The solution steps contain the derivation. Open the original result summary to review its complete content." };
  }
  if (plan.findings.some((finding) => finding.issue === "detached_final_answer_fragment")) {
    return { ...plan, action: "fallback", summaryRequired: false, reason: "detached_result_fragment",
      fallbackText: "Review the solution steps and original result summary together." };
  }
  return plan;
}

/** Assess the declared field and every distinct explicitly titled final card.
 * A concise declared field cannot conceal a derivative dump in a separate card.
 * @param {any} result @param {{validationFindings?:any[]}} options
 */
export function assessSolutionFinalAnswerPresentations(result = {}, options = {}) {
  const primary = assessFinalAnswerPresentation(result, options);
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const lastFinal = steps.findLast((step) => FINAL_HEADING.test(step.heading || step.label || step.title || ""));
  const original = result.finalAnswerLatex || result.finalAnswer || (lastFinal ? stepLatex(lastFinal) : "");
  const seen = new Set([normalizeFinalAnswerComparison(original), normalizeFinalAnswerComparison(primary.latex)]);
  const plans = [primary];
  for (const step of steps) {
    if (!FINAL_HEADING.test(step.heading || step.label || step.title || "")) continue;
    const latex = stepLatex(step);
    const canonical = normalizeFinalAnswerComparison(latex);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    // Field validation applies to the declared field, not to a different card.
    plans.push(assessFinalAnswerPresentation({ ...result, finalAnswerLatex: latex }, {}));
  }
  return plans;
}

/** Preserve authoritative source steps. Only project a proved matching final card.
 * Compacted cards get fresh math inputs, preventing old semantic ownership reuse.
 * Suppression/fallback prose is available through plan.retainedFinalText.
 * @param {any[]} steps @param {any} plan
 */
export function presentSolutionSteps(steps = [], plan = null) {
  if (!plan) return steps;
  const finalIds = new Set(plan.finalStepIds || []);
  const projected = ["compacted", "suppressed", "fallback"].includes(plan.action) ? steps.flatMap((step) => {
    if (!finalIds.has(step.id)) return [step];
    if (plan.action !== "compacted") return [];
    const textLines = [...new Set((Array.isArray(step.lines) ? step.lines : [])
      .filter((line) => line?.kind === "text" && typeof line.text === "string" && line.text.trim())
      .map((line) => line.text.trim()))];
    const lines = [{ id: `${step.id}-final-summary-math`, kind: "math", role: "final_answer", latex: plan.latex, tokens: [] },
      ...textLines.map((text, index) => ({ id: `${step.id}-final-summary-text-${index + 1}`, kind: "text", text, tokens: [] }))];
    return [{ ...step, latex: plan.latex, math: plan.latex, equationLatex: plan.latex,
      display: plan.latex, lines, chunks: [], expressions: [], tokens: [], anchors: [],
      semanticNodes: [], semanticTree: null, finalAnswerPresentation: plan.action }];
  }) : steps;
  if (!plan.summaryRequired || !["preserved", "normalized", "compacted"].includes(plan.action)) return projected;
  const usedIds = new Set(projected.map((step) => step.id));
  let id = "omni-final-result-summary";
  for (let index = 2; usedIds.has(id); index += 1) id = `omni-final-result-summary-${index}`;
  return [...projected, { id, heading: "Final Answer", label: "Final Answer", latex: plan.latex,
    math: plan.latex, role: "final", lines: [], chunks: [], anchors: [], tokens: [],
    presentationOnly: true, finalAnswerPresentation: plan.action }];
}
