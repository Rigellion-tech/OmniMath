const SNAPSHOT_VERSION = 1;
const MAX_PROMPT_CHARS = 24_000;

function badInput(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: "BAD_INPUT" });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badInput(`${label} must be an object.`);
  }
  return value;
}

function text(value, max = 2_400) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function range(value) {
  if (value == null) return null;
  const candidate = object(value, "provenanceSnapshot.target.sourceRange");
  const start = integer(candidate.start);
  const end = integer(candidate.end);
  if (start == null || end == null || end <= start) {
    throw badInput("provenanceSnapshot.target.sourceRange must be a valid half-open range.");
  }
  return { start, end };
}

function compactNode(value, maxChars = 1_600) {
  if (typeof value === "string") return text(value, maxChars);
  if (!value || typeof value !== "object") return null;
  const result = {
    id: text(value.id || value.semanticNodeId, 240),
    type: text(value.type || value.kind, 120),
    role: text(value.role, 120),
    text: text(value.source || value.sourceText || value.text || value.display || value.latex, maxChars),
  };
  const nodeRange = value.sourceRange || (value.start != null || value.end != null
    ? { start: value.start, end: value.end }
    : null);
  if (nodeRange) result.sourceRange = range(nodeRange);
  return result;
}

function compactStep(value, fallbackIndex = null) {
  if (typeof value === "string") {
    return { index: fallbackIndex, id: "", title: "", math: text(value, 3_200), reasoning: "", branchId: "", assumptions: [] };
  }
  const step = value && typeof value === "object" ? value : {};
  return {
    index: integer(step.index) ?? fallbackIndex,
    id: text(step.id || step.stepId, 240),
    title: text(step.title || step.stepTitle, 400),
    math: text(step.math || step.latex || step.equationLatex, 3_200),
    reasoning: text(step.reasoning || step.explanation || step.plainExplanation, 2_000),
    branchId: text(step.branchId, 240),
    assumptions: Array.isArray(step.assumptions)
      ? step.assumptions.slice(0, 12).map((item) => text(item, 500)).filter(Boolean)
      : [],
  };
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

function assertConsistentSnapshot(body, snapshot) {
  const declaredTargets = distinct([
    text(body.targetId, 240),
    text(body.semanticId, 240),
    text(body.semanticSelection?.id, 240),
  ]);
  const snapshotTargets = distinct([snapshot.target.targetId, snapshot.target.semanticId]);
  if (declaredTargets.length && snapshotTargets.length
    && declaredTargets.some((id) => !snapshotTargets.includes(id))) {
    throw badInput("Follow-up target identity does not match provenanceSnapshot.target.");
  }

  const declaredStepId = text(body.stepId, 240);
  const snapshotStepIds = distinct([snapshot.target.stepId, snapshot.origin.stepId]);
  if (declaredStepId && snapshotStepIds.length && !snapshotStepIds.includes(declaredStepId)) {
    throw badInput("Follow-up step identity does not match provenanceSnapshot origin.");
  }
}

export function normalizeProvenanceSnapshot(value, body = {}) {
  if (value == null) return null;
  const input = object(value, "provenanceSnapshot");
  if (input.version !== SNAPSHOT_VERSION) {
    throw badInput(`Unsupported provenanceSnapshot version: ${String(input.version)}.`);
  }

  const targetInput = object(input.target, "provenanceSnapshot.target");
  const originInput = object(input.origin, "provenanceSnapshot.origin");
  const evidenceInput = object(input.evidence, "provenanceSnapshot.evidence");
  const confidenceKind = text(input.confidence?.kind, 40);
  if (!targetInput.targetId && !targetInput.semanticId) {
    throw badInput("provenanceSnapshot.target requires targetId or semanticId.");
  }
  const conceptTarget = /concept/i.test(text(targetInput.type || targetInput.role, 120));
  if (!originInput.stepId && integer(originInput.stepIndex) == null
    && confidenceKind !== "insufficient" && !conceptTarget) {
    throw badInput("provenanceSnapshot.origin requires stepId or stepIndex.");
  }
  if (!Array.isArray(evidenceInput.steps)) {
    throw badInput("provenanceSnapshot.evidence.steps must be an array.");
  }
  if (!new Set(["explicit", "reconstructed", "insufficient"]).has(confidenceKind)) {
    throw badInput("provenanceSnapshot.confidence.kind is invalid.");
  }

  const snapshot = {
    version: SNAPSHOT_VERSION,
    target: {
      semanticId: text(targetInput.semanticId, 240),
      targetId: text(targetInput.targetId, 240),
      stepId: text(targetInput.stepId, 240),
      sourceRange: range(targetInput.sourceRange),
      sourceText: text(targetInput.sourceText, 1_600),
      role: text(targetInput.role, 120),
      type: text(targetInput.type, 120),
      parentExpression: typeof targetInput.parentExpression === "string"
        ? text(targetInput.parentExpression, 3_200)
        : text(targetInput.parentExpression?.math || targetInput.parentExpression?.latex || targetInput.parentExpression?.text, 3_200),
      selectedNode: compactNode(targetInput.selectedNode),
      ancestors: Array.isArray(targetInput.ancestors)
        ? targetInput.ancestors.slice(0, 6).map((item) => compactNode(item, 500)).filter(Boolean)
        : [],
    },
    origin: {
      problemId: text(originInput.problemId, 240),
      problemText: text(originInput.problemText, 4_000),
      solutionRevision: text(originInput.solutionRevision, 240),
      stepIndex: integer(originInput.stepIndex),
      stepId: text(originInput.stepId, 240),
      stepTitle: text(originInput.stepTitle, 400),
      currentStep: compactStep(originInput.currentStep, integer(originInput.stepIndex)),
      branchId: text(originInput.branchId, 240),
    },
    evidence: {
      steps: evidenceInput.steps.slice(0, 48).map((step, index) => {
        const normalized = compactStep(step, index);
        return {
          ...normalized,
          math: text(normalized.math, 1_200),
          reasoning: text(normalized.reasoning, 700),
          assumptions: normalized.assumptions.slice(0, 6).map((item) => text(item, 300)),
        };
      }),
      relevantInputs: Array.isArray(evidenceInput.relevantInputs)
        ? evidenceInput.relevantInputs.slice(0, 12).map((item) => text(item, 400)).filter(Boolean)
        : [],
      assumptions: Array.isArray(evidenceInput.assumptions)
        ? evidenceInput.assumptions.slice(0, 12).map((item) => text(item, 400)).filter(Boolean)
        : [],
    },
    confidence: { kind: confidenceKind },
  };
  assertConsistentSnapshot(body, snapshot);
  return snapshot;
}

function legacySnapshot(body) {
  const semantic = body.semanticSelection || {};
  const firstToken = Array.isArray(body.selectedTokens) ? body.selectedTokens[0] || {} : {};
  const stepId = text(body.stepId || firstToken.stepId, 240);
  const currentStep = compactStep(body.currentStep || {
    id: stepId,
    title: body.stepTitle,
    math: body.stepLatex,
  });
  return {
    version: SNAPSHOT_VERSION,
    target: {
      semanticId: text(semantic.id || firstToken.semanticNodeId || firstToken.id, 240),
      targetId: text(body.targetId || semantic.id || firstToken.id, 240),
      stepId,
      sourceRange: semantic.sourceRange ? range(semantic.sourceRange) : null,
      sourceText: text(body.selectedText || body.selectedLatex || semantic.selectedText, 1_600),
      role: text(firstToken.role || semantic.kind, 120),
      type: text(firstToken.type || firstToken.kind || semantic.kind, 120),
      parentExpression: text(body.parentExpression, 3_200),
      selectedNode: compactNode(firstToken),
      ancestors: [],
    },
    origin: {
      problemId: text(body.problemId, 240),
      problemText: text(body.problem || body.solution?.originalProblem || body.solution?.problem || body.solution?.expression, 4_000),
      solutionRevision: "",
      stepIndex: null,
      stepId,
      stepTitle: text(body.stepTitle, 400),
      currentStep,
      branchId: "",
    },
    evidence: { steps: currentStep.math || currentStep.reasoning ? [currentStep] : [], relevantInputs: [], assumptions: [] },
    confidence: { kind: "insufficient" },
  };
}

function selectEvidence(snapshot) {
  const steps = snapshot.evidence.steps;
  if (steps.length <= 12) return steps;
  const wanted = new Set([0, 1, steps.length - 2, steps.length - 1]);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.id === snapshot.origin.stepId || step.id === snapshot.target.stepId
      || step.index === snapshot.origin.stepIndex
      || (snapshot.origin.branchId && step.branchId === snapshot.origin.branchId)) {
      for (let offset = -2; offset <= 2; offset += 1) wanted.add(index + offset);
    }
  }
  if (wanted.size < 12) {
    const stride = Math.max(1, Math.floor(steps.length / (12 - wanted.size)));
    for (let index = 0; index < steps.length && wanted.size < 12; index += stride) wanted.add(index);
  }
  const valid = [...wanted].filter((index) => index >= 0 && index < steps.length);
  const required = valid.filter((index) => {
    const step = steps[index];
    return index === 0 || index === steps.length - 1
      || step.id === snapshot.origin.stepId || step.id === snapshot.target.stepId
      || step.index === snapshot.origin.stepIndex;
  });
  const selected = new Set(required.slice(0, 12));
  valid.sort((a, b) => a - b).forEach((index) => {
    if (selected.size < 12) selected.add(index);
  });
  return [...selected].sort((a, b) => a - b).map((index) => steps[index]);
}

function json(value) {
  return JSON.stringify(value);
}

export function buildProvenanceFollowupPrompt(body, history = []) {
  const snapshot = normalizeProvenanceSnapshot(body.provenanceSnapshot, body) || legacySnapshot(body);
  const question = text(body.question, 1_000);
  if (!question) throw badInput("Follow-up question is required.");
  const evidence = selectEvidence(snapshot);
  const conversation = history.slice(-8).map((item) => ({
    role: item.role === "assistant" || item.role === "tutor" ? "assistant" : "user",
    text: text(item.text, 1_000),
  })).filter((item) => item.text);

  const prompt = `You are OmniMath, a careful math tutor tracing one exact selected mathematical occurrence.

INSTRUCTIONS
- Anchor every answer to TARGET OCCURRENCE and ORIGIN STEP below. Identical-looking symbols or numbers elsewhere are different occurrences unless the evidence explicitly links them.
- Use ORIGINAL PROBLEM, exact CURRENT/ORIGIN STEP, PARENT EXPRESSION, ordered STEP EVIDENCE, assumptions, and conversation history together.
- Treat evidence as a dependency graph when a result has multiple inputs; do not force a branching derivation into a linear story.
- Confidence "explicit" means the provenance is recorded in supplied solution evidence. "reconstructed" means provide a mathematically valid reconstruction and label it as reconstruction. "insufficient" means state what cannot be established; never invent a prior step.
- Correct a false premise in the user's question before answering it. Do not agree that an operation, sign, formula, source, or theorem occurred unless the evidence supports it.
- Resolve "this", "that", "why", and similar references first against the selected target, then the latest assistant-introduced intermediate only when the conversation clearly shifts focus.
- If evidence conflicts, identify the conflict and be uncertain. Do not silently choose a convenient occurrence or branch.
- Answer only the follow-up, concisely and mathematically. Use LaTeX where useful.

TARGET OCCURRENCE
${json(snapshot.target)}

ORIGINAL PROBLEM AND ORIGIN
${json(snapshot.origin)}

EXACT CURRENT/ORIGIN STEP
${json(snapshot.origin.currentStep)}

PARENT EXPRESSION
${json(snapshot.target.parentExpression || null)}

ORDERED COMPACT STEP EVIDENCE
${json(evidence)}

RELEVANT ORIGINAL INPUTS
${json(snapshot.evidence.relevantInputs)}

ASSUMPTIONS
${json(snapshot.evidence.assumptions)}

PROVENANCE CONFIDENCE
${json(snapshot.confidence)}

PINNED EXPLANATION (prior model text; context only, not authoritative evidence)
${json(text(body.pinnedExplanation, 2_400) || null)}

CONVERSATION HISTORY
${json(conversation)}

USER QUESTION
${json(question)}`;

  if (prompt.length > MAX_PROMPT_CHARS) {
    throw Object.assign(new Error("Follow-up provenance context is too large."), {
      statusCode: 413,
      code: "BAD_INPUT",
      publicMessage: "The selected explanation context is too large. Please pin a more focused expression.",
    });
  }
  return { prompt, snapshot };
}

export function createGeneralFollowupFallback(body, history = [], reason = "local context") {
  const snapshot = normalizeProvenanceSnapshot(body.provenanceSnapshot, body) || legacySnapshot(body);
  const selected = snapshot.target.sourceText || "the selected mathematical object";
  const step = snapshot.origin.currentStep;
  const prior = text(body.pinnedExplanation, 2_400);
  const source = step.math
    ? `The selected occurrence \`${selected}\` belongs to the saved step \`${step.math}\`.`
    : `The selected occurrence is \`${selected}\`, but its exact derivation is not present in the saved step context.`;
  return [
    `${source} (${reason})`,
    prior ? `The prior pinned explanation says: ${prior}` : "",
    snapshot.confidence.kind === "insufficient"
      ? "I cannot establish a deeper origin from the supplied evidence without reconstructing or inventing missing work."
      : "Its origin should be traced using the saved evidence for this exact occurrence.",
    history.length ? "The prior follow-up turns remain associated with this selection." : "",
  ].filter(Boolean).join(" ");
}

export function followupCorrelation(body = {}) {
  return {
    requestId: text(body.requestId, 240) || null,
    conversationId: text(body.conversationId, 240) || null,
    targetRevision: Number.isFinite(body.targetRevision)
      ? body.targetRevision
      : text(body.targetRevision, 240) || null,
  };
}
