import { validateGeneratedLatex } from "./generatedLatexValidation.js";
import { hasVisibleMath } from "./solveCandidateStructure.js";
import { isRenderableSolutionStep } from "../src/lib/solutionSteps.js";

const STEP_KEYS = ["id", "heading", "latex", "reasoning", "anchors"];
const ANCHOR_KEYS = ["id", "latex", "type", "priority"];
const PRIORITIES = new Set(["high", "medium", "low"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;

function reject(reason) {
  return Object.assign(new Error(`Streamed step rejected: ${reason}`), {
    code: "PROGRESSIVE_STEP_REJECTED", reason,
  });
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function nonemptyText(value, max = 8_000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function checkLatex(value, field) {
  if (!nonemptyText(value) || !hasVisibleMath(value)) throw reject(`${field}:empty_or_invisible`);
  if (/(?:[=+\-*/^_,;:]|\\(?:times|cdot|pm|mp|le|ge|neq|to|Rightarrow))\s*$/u.test(value)
    || /\\(?:sqrt|frac|dfrac|tfrac|text|mathrm|mathbf|operatorname)\s*\{\s*\}/u.test(value)) {
    throw reject(`${field}:obvious_truncation`);
  }
  const result = validateGeneratedLatex(value, { fieldPath: field, strictParse: true });
  // A warning can still reveal a truncated expression accepted by KaTeX.
  const structuralWarnings = result.warnings.filter((issue) => /^(?:unmatched_|incomplete_)/u.test(issue));
  if (!result.valid || structuralWarnings.length) throw reject(`${field}:invalid_latex`);
}

function frozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function canonicalStep(candidate, stepIndex) {
  const { id, heading, latex, reasoning, anchors } = candidate;
  const parts = anchors.map((anchor) => ({
    id: `${id}-${anchor.id}`,
    display: anchor.latex,
    short: anchor.type,
    medium: "Hover to explain this part of the step.",
    deep: "Pin this part for a deeper explanation.",
    text: anchor.type,
    latex: anchor.latex,
    role: anchor.type,
    conceptIds: [], relatedTokenIds: [], children: [],
    anchorId: anchor.id,
    anchorType: anchor.type,
    anchorPriority: anchor.priority,
  }));
  return {
    id, label: heading, title: heading, math: latex,
    summary: reasoning, plainExplanation: reasoning,
    chunks: [{ id: `${id}-chunk-1`, display: latex, short: heading,
      medium: reasoning, deep: reasoning, parts }],
    lines: [{ id: `${id}-line-1`, kind: "math", role: stepIndex === 0 ? "problem" : "solution_step",
      text: "", latex, tokens: [] }],
    expressions: [{ id: `${id}-expr-1`, latex,
      role: stepIndex === 0 ? "other" : "equation", tokens: [] }],
  };
}

/** Server authority for a single closed provider step. It never accepts a client marker. */
export function createProgressiveStepValidator({ sourceHash, authority = "server-provider-stream" } = {}) {
  if (!nonemptyText(sourceHash, 256) || !nonemptyText(authority, 128)) {
    throw new TypeError("Step validation requires sourceHash and authority.");
  }
  const accepted = [];
  const acceptedIds = new Set();
  const sourceCandidates = [];

  function accept(candidate, { stepIndex, sourceHash: claimedSourceHash } = {}) {
    if (claimedSourceHash !== sourceHash) throw reject("source_identity_mismatch");
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= 10) throw reject("invalid_index");
    if (stepIndex !== accepted.length) throw reject(stepIndex < accepted.length ? "duplicate_or_conflicting_step" : "out_of_order");
    if (!exactKeys(candidate, STEP_KEYS)) throw reject("invalid_shape");
    if (!SAFE_ID.test(candidate.id) || acceptedIds.has(candidate.id)) throw reject("duplicate_or_invalid_id");
    if (!nonemptyText(candidate.heading, 500) || !nonemptyText(candidate.reasoning, 8_000)) {
      throw reject("missing_text");
    }
    checkLatex(candidate.latex, `steps[${stepIndex}].latex`);
    if (!Array.isArray(candidate.anchors) || candidate.anchors.length > 3) throw reject("invalid_anchors");
    const anchorIds = new Set();
    for (const [index, anchor] of candidate.anchors.entries()) {
      if (!exactKeys(anchor, ANCHOR_KEYS) || !SAFE_ID.test(anchor.id)
        || anchorIds.has(anchor.id) || !nonemptyText(anchor.type, 100)
        || !PRIORITIES.has(anchor.priority)) throw reject(`invalid_anchor_${index}`);
      checkLatex(anchor.latex, `steps[${stepIndex}].anchors[${index}].latex`);
      anchorIds.add(anchor.id);
    }
    const step = frozen(canonicalStep(candidate, stepIndex));
    if (!isRenderableSolutionStep(step)) throw reject("unrenderable_step");
    accepted.push(step);
    acceptedIds.add(candidate.id);
    sourceCandidates.push(JSON.stringify(candidate));
    return { step, validation: { status: "accepted", authority, sourceHash } };
  }

  function assertPrefix(fullSolution) {
    if (!Array.isArray(fullSolution?.steps) || fullSolution.steps.length < sourceCandidates.length) {
      throw reject("completed_prefix_missing");
    }
    for (let i = 0; i < sourceCandidates.length; i += 1) {
      if (JSON.stringify(fullSolution.steps[i]) !== sourceCandidates[i]) throw reject("completed_prefix_mutated");
    }
    return true;
  }

  return { accept, assertPrefix, get acceptedCount() { return accepted.length; } };
}
