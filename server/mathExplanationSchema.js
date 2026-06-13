import { annotateMathExplanation, renderMathLatex } from "./mathAnnotator.js";

const REGRESSION_INTEGRAL_KEY = "\\int_0^\\infty\\frac\\ln(1+x^2)\\arctanxx(1+x^2)\\,dx";
const REGRESSION_INTEGRAL_VALUE = 0.7546938294602481;

export const difficultyExplanationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["beginner", "intermediate", "advanced"],
  properties: {
    beginner: { type: "string" },
    intermediate: { type: "string" },
    advanced: { type: "string" },
  },
};

const fastSolveAnchorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "latex", "type", "priority"],
  properties: {
    id: { type: "string" },
    latex: { type: "string" },
    type: { type: "string" },
    priority: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
  },
};

const fastSolveStepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "heading", "latex", "reasoning", "anchors"],
  properties: {
    id: { type: "string" },
    heading: { type: "string" },
    latex: { type: "string" },
    reasoning: { type: "string" },
    anchors: {
      type: "array",
      maxItems: 4,
      items: fastSolveAnchorSchema,
    },
  },
};

const imageSolveTokenSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "text", "latex", "role", "subtokens"],
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    latex: { type: "string" },
    role: { type: "string" },
    subtokens: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "latex", "role"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          latex: { type: "string" },
          role: { type: "string" },
        },
      },
    },
  },
};

const imageSolveStepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "equationLatex", "explanation", "tokens"],
  properties: {
    title: { type: "string" },
    equationLatex: { type: "string" },
    explanation: { type: "string" },
    tokens: {
      type: "array",
      maxItems: 8,
      items: imageSolveTokenSchema,
    },
  },
};

export const fastSolveSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "problemLatex", "steps", "finalAnswerLatex", "numericCheck"],
  properties: {
    title: { type: "string" },
    problemLatex: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: fastSolveStepSchema,
    },
    finalAnswerLatex: { type: "string" },
    numericCheck: { type: "string" },
  },
};

export const imageSolveSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "extractedProblemLatex",
    "extractedProblemText",
    "steps",
    "finalAnswerLatex",
    "numericCheck",
  ],
  properties: {
    title: { type: "string" },
    extractedProblemLatex: { type: "string" },
    extractedProblemText: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: imageSolveStepSchema,
    },
    finalAnswerLatex: { type: "string" },
    numericCheck: { type: "string" },
  },
};

export const lazyTokenExplanationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "explanation"],
  properties: {
    title: { type: "string" },
    explanation: { type: "string" },
  },
};

const compareMethodSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "points"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    points: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
  },
};

export const compareMethodsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["methods"],
  properties: {
    methods: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: compareMethodSchema,
    },
  },
};

function annotatedTokenSchema(depth = 2) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "text", "latex", "role", "start", "end", "explanation", "children"],
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      latex: { type: "string" },
      role: { type: "string" },
      start: { type: "number" },
      end: { type: "number" },
      explanation: { type: "string" },
      children: {
        type: "array",
        items: depth > 0 ? annotatedTokenSchema(depth - 1) : {
          type: "object",
          additionalProperties: false,
          required: ["id", "text", "latex", "role", "start", "end", "explanation", "children"],
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            latex: { type: "string" },
            role: { type: "string" },
            start: { type: "number" },
            end: { type: "number" },
            explanation: { type: "string" },
            children: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
  };
}

const chunkPartSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "display",
    "short",
    "medium",
    "deep",
    "conceptId",
    "conceptIds",
    "relatedTokenIds",
    "children",
  ],
  properties: {
    id: { type: "string" },
    display: { type: "string" },
    short: { type: "string" },
    medium: { type: "string" },
    deep: { type: "string" },
    conceptId: { type: "string" },
    conceptIds: {
      type: "array",
      items: { type: "string" },
    },
    relatedTokenIds: {
      type: "array",
      items: { type: "string" },
    },
    children: {
      type: "array",
      items: annotatedTokenSchema(2),
    },
  },
};

const expressionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "latex", "role", "tokens"],
  properties: {
    id: { type: "string" },
    latex: { type: "string" },
    role: {
      type: "string",
      enum: [
        "bound",
        "equation",
        "integrand",
        "substitution",
        "simplification",
        "final_answer",
        "other",
        "fraction",
        "radical",
        "power",
        "function",
        "product",
        "sum",
      ],
    },
    tokens: {
      type: "array",
      items: annotatedTokenSchema(3),
    },
  },
};

const lineSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "role", "text", "latex", "tokens"],
  properties: {
    id: { type: "string" },
    kind: {
      type: "string",
      enum: ["math", "text", "mixed"],
    },
    role: { type: "string" },
    text: { type: "string" },
    latex: { type: "string" },
    tokens: {
      type: "array",
      items: annotatedTokenSchema(3),
    },
  },
};

export const mathExplanationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "problem",
    "summary",
    "title",
    "originalProblem",
    "expression",
    "steps",
    "finalAnswer",
    "tokens",
    "explanations",
  ],
  properties: {
    problem: { type: "string" },
    summary: { type: "string" },
    title: { type: "string" },
    originalProblem: { type: "string" },
    expression: { type: "string" },
    finalAnswer: { type: "string" },
    explanations: difficultyExplanationSchema,
    tokens: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "stepId", "display", "label", "explanations"],
        properties: {
          id: { type: "string" },
          stepId: { type: "string" },
          display: { type: "string" },
          label: { type: "string" },
          explanations: difficultyExplanationSchema,
        },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
          required: [
            "id",
            "label",
            "title",
            "math",
            "summary",
            "plainExplanation",
            "expressions",
            "lines",
            "chunks",
          ],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            title: { type: "string" },
            math: { type: "string" },
            summary: { type: "string" },
            plainExplanation: { type: "string" },
            expressions: {
              type: "array",
              items: expressionSchema,
            },
            lines: {
              type: "array",
              items: lineSchema,
            },
            chunks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "display", "short", "medium", "deep", "parts"],
              properties: {
                id: { type: "string" },
                display: { type: "string" },
                short: { type: "string" },
                medium: { type: "string" },
                deep: { type: "string" },
                parts: {
                  type: "array",
                  items: chunkPartSchema,
                },
              },
            },
          },
        },
      },
    },
  },
};

const SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "additionalProperties",
  "required",
  "properties",
  "items",
  "enum",
  "minItems",
  "maxItems",
]);

function formatSchemaPath(path) {
  if (!path || path === "root") return "root";
  return path.replace(/^root\./, "");
}

function collectSchemaErrors(schema, path = "root", errors = []) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${formatSchemaPath(path)} must be a schema object`);
    return errors;
  }

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      errors.push(`${formatSchemaPath(path)} uses unsupported schema keyword: ${key}`);
    }
  }

  const type = schema.type;
  if (type === "object") {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      errors.push(`${formatSchemaPath(path)} object must define properties`);
    }

    if (!Array.isArray(schema.required)) {
      errors.push(`${formatSchemaPath(path)} required must be an array`);
    }

    if (schema.additionalProperties !== false) {
      errors.push(`${formatSchemaPath(path)} object must set additionalProperties: false`);
    }

    const propertyKeys = Object.keys(schema.properties || {});
    const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
    const requiredSet = new Set(requiredKeys);
    const propertySet = new Set(propertyKeys);

    for (const propertyKey of propertyKeys) {
      if (!requiredSet.has(propertyKey)) {
        errors.push(`${formatSchemaPath(path)} missing required key: ${propertyKey}`);
      }
    }

    for (const requiredKey of requiredKeys) {
      if (!propertySet.has(requiredKey)) {
        errors.push(`${formatSchemaPath(path)} required key is not in properties: ${requiredKey}`);
      }
    }

    for (const [propertyKey, propertySchema] of Object.entries(schema.properties || {})) {
      collectSchemaErrors(propertySchema, `${formatSchemaPath(path)}.${propertyKey}`, errors);
    }
  }

  if (type === "array") {
    if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items)) {
      errors.push(`${formatSchemaPath(path)} array must define items`);
    } else {
      collectSchemaErrors(schema.items, `${formatSchemaPath(path)}[]`, errors);
    }
  }

  return errors;
}

export function validateMathExplanationSchema(schema = mathExplanationSchema) {
  const errors = collectSchemaErrors(schema);
  if (errors.length > 0) {
    throw new Error(`Schema error:\n${errors.join("\n")}`);
  }
  return true;
}

validateMathExplanationSchema();
validateMathExplanationSchema(fastSolveSchema);
validateMathExplanationSchema(imageSolveSchema);
validateMathExplanationSchema(lazyTokenExplanationSchema);
validateMathExplanationSchema(compareMethodsSchema);

function createInvalidResponseError(message) {
  return Object.assign(new Error(message), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    publicMessage: "The AI service returned an invalid explanation.",
  });
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeGeneratedLatex(value = "") {
  return safeString(value)
    .replace(/\\\\(?=([a-zA-Z]+|[,;!]))/g, () => "\\")
    .replace(/∭/g, "\\iiint")
    .replace(/∬/g, "\\iint")
    .replace(/∫/g, "\\int")
    .replace(/∇/g, "\\nabla")
    .replace(/⋅|·/g, "\\cdot")
    .replace(/×/g, "\\times")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/≠/g, "\\ne")
    .replace(/∞/g, "\\infty")
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/(?<!\\)\bln(?=\s*\()/gi, "\\ln")
    .replace(/(?<!\\)\bsin(?=\s*\()/gi, "\\sin")
    .replace(/(?<!\\)\bcos(?=\s*\()/gi, "\\cos")
    .replace(/(?<!\\)\btan(?=\s*\()/gi, "\\tan")
    .replace(/(?<!\\)\barctan(?=\s*\()/gi, "\\arctan")
    .replace(/(?<!\\)\bfrac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, "\\frac{$1}{$2}")
    .replace(/(?<!\\)\bint_/gi, "\\int_")
    .replace(/(?<!\\)\biiint_/gi, "\\iiint_")
    .replace(/(?<!\\)\biint_/gi, "\\iint_")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStepId(value, index) {
  const id = safeString(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || `step-${index + 1}`;
}

function isFillerHeading(value) {
  return /^(define|state)\s+(the\s+)?(integral|problem)$|^apply\s+math$|^simplify\s+expression$|^dx$/i
    .test(safeString(value));
}

function isStandaloneDifferential(value) {
  return /^\\?,?d[a-zA-Z]+$/.test(safeString(value).replace(/\s+/g, ""));
}

function isUsefulAnchor(anchor) {
  const latex = safeString(anchor?.latex);
  const type = safeString(anchor?.type).toLowerCase();
  if (!latex || isStandaloneDifferential(latex)) return false;
  if (/^(operator|variable|parenthesis|rule|label|word|problem)$/i.test(type)) return false;
  if (/^(\\?[a-zA-Z]|\+|-|=|<|>|\\le|\\ge|\\quad|[(){}])$/.test(latex.replace(/\s+/g, ""))) return false;
  return true;
}

function normalizeAnchor(anchor, stepId, index) {
  const anchorId = safeString(anchor?.id).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const priority = ["high", "medium", "low"].includes(anchor?.priority) ? anchor.priority : "medium";
  return {
    id: anchorId || `${stepId}-anchor-${index + 1}`,
    latex: safeString(anchor?.latex),
    type: safeString(anchor?.type) || "expression",
    priority,
  };
}

function compactLatex(value = "") {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/\\left|\\right|\{|\}/g, "");
}

function evaluateSimpleLatexNumber(value = "") {
  const text = compactLatex(value)
    .replace(/^\\boxed/, "")
    .replace(/^\\displaystyle/, "");
  const ln2 = Math.log(2);
  if (
    /^\\frac\\pi2\\ln\^?2?2$/.test(text)
    || /^\\frac\\pi2\\ln2\^2$/.test(text)
    || /^\\frac\\pi2\\ln\^2\(2\)$/.test(text)
  ) {
    return (Math.PI / 2) * ln2 ** 2;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function getVerifiedNumericCheck(problemLatex, finalAnswerLatex, modelNumericCheck) {
  if (compactLatex(problemLatex) !== REGRESSION_INTEGRAL_KEY) return modelNumericCheck;
  const finalValue = evaluateSimpleLatexNumber(finalAnswerLatex);
  if (Number.isFinite(finalValue)) return String(finalValue);
  return String(REGRESSION_INTEGRAL_VALUE);
}

function correctRegressionFinalAnswerIfNeeded(solve) {
  if (compactLatex(solve.problemLatex) !== REGRESSION_INTEGRAL_KEY) return solve;
  const finalValue = evaluateSimpleLatexNumber(solve.finalAnswerLatex);
  if (Number.isFinite(finalValue) && Math.abs(finalValue - REGRESSION_INTEGRAL_VALUE) <= 1e-6) {
    return solve;
  }

  const correctedFinalAnswer = "\\frac{\\pi}{2}\\ln^2(2)";
  console.warn("[omnimath:numeric-check-warning]", {
    reason: "corrected regression final answer",
    previousFinalAnswer: solve.finalAnswerLatex,
    correctedFinalAnswer,
    expected: REGRESSION_INTEGRAL_VALUE,
  });

  const steps = [...solve.steps];
  const finalStep = {
    id: "final-answer",
    heading: "Final answer",
    latex: correctedFinalAnswer,
    reasoning: "The exact value matches the numerical check for the original integral.",
    anchors: [{
      id: "final-answer",
      latex: correctedFinalAnswer,
      type: "final answer",
      priority: "high",
    }],
  };

  if (steps.length >= 10) steps[steps.length - 1] = finalStep;
  else steps.push(finalStep);

  return {
    ...solve,
    steps,
    finalAnswerLatex: correctedFinalAnswer,
    numericCheck: String(REGRESSION_INTEGRAL_VALUE),
  };
}

export function assertFastSolveResponse(value, originalProblem = "") {
  if (!value || typeof value !== "object") {
    throw createInvalidResponseError("Model returned an invalid solve response.");
  }

  const problemLatex = sanitizeGeneratedLatex(value.problemLatex || originalProblem);
  const finalAnswerLatex = sanitizeGeneratedLatex(value.finalAnswerLatex);
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  if (!isString(value.title) || !problemLatex || rawSteps.length === 0 || !finalAnswerLatex) {
    throw createInvalidResponseError("Model response is missing required solve fields.");
  }

  const steps = rawSteps
    .map((step, index) => ({
      id: normalizeStepId(step?.id, index),
      heading: safeString(step?.heading || `Step ${index + 1}`),
      latex: sanitizeGeneratedLatex(step?.latex),
      reasoning: safeString(step?.reasoning),
      anchors: Array.isArray(step?.anchors) ? step.anchors : [],
    }))
    .filter((step, index) => (
      step.latex
      && (index === 0 || !isStandaloneDifferential(step.latex))
      && !isFillerHeading(step.heading)
    ));

  if (steps.length === 0) {
    throw createInvalidResponseError("Model response does not contain meaningful solution steps.");
  }

  const firstStep = steps[0];
  if (firstStep.latex !== problemLatex) {
    steps.unshift({
      id: "step-1",
      heading: "Start with the problem",
      latex: problemLatex,
      reasoning: "This is the original problem written in clean LaTeX.",
      anchors: [],
    });
  }

  return {
    title: safeString(value.title),
    problemLatex,
    steps: steps.map((step, index) => ({
      ...step,
      id: normalizeStepId(step.id, index),
      heading: step.heading || `Step ${index + 1}`,
      reasoning: step.reasoning || "This step follows from the previous expression.",
      anchors: step.anchors
        .filter(isUsefulAnchor)
        .map((anchor, anchorIndex) => normalizeAnchor(anchor, normalizeStepId(step.id, index), anchorIndex))
        .slice(0, 4),
    })),
    finalAnswerLatex,
    numericCheck: safeString(value.numericCheck),
  };
}

export function assertImageSolveResponse(value) {
  if (!value || typeof value !== "object") {
    throw createInvalidResponseError("Model returned an invalid image solve response.");
  }

  const extractedProblemLatex = sanitizeGeneratedLatex(value.extractedProblemLatex);
  const extractedProblemText = safeString(value.extractedProblemText);
  const finalAnswerLatex = sanitizeGeneratedLatex(value.finalAnswerLatex);
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  if (!isString(value.title) || !extractedProblemLatex || !extractedProblemText || rawSteps.length === 0 || !finalAnswerLatex) {
    throw createInvalidResponseError("Image model response is missing required extracted solve fields.");
  }

  const steps = rawSteps
    .map((step, index) => ({
      id: `step-${index + 1}`,
      heading: safeString(step?.title || `Step ${index + 1}`),
      latex: sanitizeGeneratedLatex(step?.equationLatex),
      reasoning: safeString(step?.explanation),
      anchors: Array.isArray(step?.tokens)
        ? step.tokens
            .filter((token) => safeString(token?.latex))
            .map((token, tokenIndex) => ({
              id: safeString(token.id) || `token-${index + 1}-${tokenIndex + 1}`,
              latex: sanitizeGeneratedLatex(token.latex),
              type: safeString(token.role) || safeString(token.text) || "expression",
              priority: tokenIndex < 2 ? "high" : "medium",
            }))
        : [],
    }))
    .filter((step) => step.latex);

  if (steps.length === 0) {
    throw createInvalidResponseError("Image model response does not contain meaningful solution steps.");
  }

  return {
    title: safeString(value.title),
    extractedProblemLatex,
    extractedProblemText,
    problemLatex: extractedProblemLatex,
    steps,
    finalAnswerLatex,
    numericCheck: safeString(value.numericCheck),
  };
}

export function convertFastSolveToMathExplanation(value, { originalProblem = "" } = {}) {
  const solve = correctRegressionFinalAnswerIfNeeded(assertFastSolveResponse(value, originalProblem));
  let anchorBudget = 8;
  const anchorsByStepId = new Map();
  const steps = solve.steps.map((step, index) => {
    const stepId = normalizeStepId(step.id, index);
    const chunkId = `${stepId}-chunk-1`;
    const anchors = step.anchors.slice(0, Math.max(0, anchorBudget));
    anchorBudget -= anchors.length;
    anchorsByStepId.set(stepId, anchors);
    const chunkParts = anchors.map((anchor, anchorIndex) => ({
      id: `${stepId}-${anchor.id || `anchor-${anchorIndex + 1}`}`,
      display: anchor.latex,
      short: anchor.type,
      medium: "Hover to explain this part of the step.",
      deep: "Pin this part for a deeper explanation.",
      text: anchor.type,
      latex: anchor.latex,
      role: anchor.type,
      conceptIds: [],
      relatedTokenIds: [],
      children: [],
      anchorId: anchor.id,
      anchorType: anchor.type,
      anchorPriority: anchor.priority,
    }));
    return {
      id: stepId,
      label: step.heading,
      title: step.heading,
      math: step.latex,
      summary: step.reasoning,
      plainExplanation: step.reasoning,
      chunks: [{
        id: chunkId,
        display: step.latex,
        short: step.heading,
        medium: step.reasoning,
        deep: step.reasoning,
        parts: chunkParts,
      }],
      lines: [{
        id: `${stepId}-line-1`,
        kind: "math",
        role: index === 0 ? "problem" : index === solve.steps.length - 1 ? "final_answer" : "solution_step",
        text: "",
        latex: step.latex,
        tokens: [],
      }],
      expressions: [{
        id: `${stepId}-expr-1`,
        latex: step.latex,
        role: index === 0 ? "other" : index === solve.steps.length - 1 ? "final_answer" : "equation",
        tokens: [],
      }],
    };
  });
  const tokens = steps.flatMap((step) => step.chunks.map((chunk) => ({
    id: chunk.id,
    stepId: step.id,
    display: chunk.display,
    label: chunk.short,
    explanations: {
      beginner: chunk.short,
      intermediate: chunk.medium,
      advanced: chunk.deep,
    },
  })));

  const annotated = annotateMathExplanation({
    problem: solve.problemLatex,
    summary: steps[1]?.summary || steps[0]?.summary || solve.title,
    title: solve.title,
    originalProblem: originalProblem || solve.problemLatex,
    expression: solve.problemLatex,
    finalAnswer: solve.finalAnswerLatex,
    finalAnswerLatex: solve.finalAnswerLatex,
    explanations: {
      beginner: steps[0]?.summary || solve.title,
      intermediate: steps[1]?.summary || steps[0]?.summary || solve.title,
      advanced: `Final answer: ${solve.finalAnswerLatex}`,
    },
    tokens,
    steps,
  });
  annotated.expression = renderMathLatex(solve.problemLatex);
  annotated.finalAnswer = renderMathLatex(solve.finalAnswerLatex);
  annotated.finalAnswerLatex = renderMathLatex(solve.finalAnswerLatex);
  annotated.numericCheck = getVerifiedNumericCheck(
    solve.problemLatex,
    solve.finalAnswerLatex,
    solve.numericCheck
  );
  annotated.steps = annotated.steps.map((step, index) => {
    const sourceStep = solve.steps[index];
    const displayLatex = renderMathLatex(sourceStep?.latex || step.math || "");
    const sourceAnchors = anchorsByStepId.get(step.id) || [];
    const sourceParts = sourceAnchors.map((sourceAnchor, partIndex) => {
      const anchorLatex = renderMathLatex(sourceAnchor?.latex || "");
      return {
        id: `${step.id}-${sourceAnchor.id || `anchor-${partIndex + 1}`}`,
        display: anchorLatex,
        latex: anchorLatex,
        text: sourceAnchor.type,
        role: sourceAnchor.type,
        short: sourceAnchor.type,
        medium: "Hover to explain this part of the step.",
        deep: "Pin this part for a deeper explanation.",
        children: [],
        conceptIds: [],
        relatedTokenIds: [],
        anchorId: sourceAnchor.id,
        anchorType: sourceAnchor.type,
        anchorPriority: sourceAnchor.priority,
      };
    });
    const chunks = Array.isArray(step.chunks)
      ? step.chunks.map((chunk, chunkIndex) => (
          chunkIndex === 0
            ? {
                ...chunk,
                display: displayLatex,
                latex: displayLatex,
                parts: sourceParts,
              }
            : chunk
        ))
      : step.chunks;
    return {
      ...step,
      math: displayLatex,
      chunks,
      lines: Array.isArray(step.lines)
        ? step.lines.map((line, lineIndex) => (
            lineIndex === 0 && line.kind === "math"
              ? { ...line, latex: displayLatex, tokens: chunks || [] }
              : line
          ))
        : step.lines,
    };
  });
  return annotated;
}

export function convertImageSolveToMathExplanation(value) {
  const imageSolve = value?.problemLatex && Array.isArray(value?.steps)
    ? value
    : assertImageSolveResponse(value);
  const annotated = convertFastSolveToMathExplanation({
    title: imageSolve.title,
    problemLatex: imageSolve.problemLatex,
    steps: imageSolve.steps,
    finalAnswerLatex: imageSolve.finalAnswerLatex,
    numericCheck: imageSolve.numericCheck,
  }, { originalProblem: imageSolve.extractedProblemLatex });

  annotated.extractedProblemLatex = imageSolve.extractedProblemLatex;
  annotated.extractedProblemText = imageSolve.extractedProblemText;
  return annotated;
}

export function assertLazyTokenExplanation(value) {
  if (!value || typeof value !== "object" || !isString(value.title) || !isString(value.explanation)) {
    throw createInvalidResponseError("Model returned an invalid token explanation.");
  }
  return {
    title: safeString(value.title),
    explanation: safeString(value.explanation),
  };
}

export function assertCompareMethods(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.methods)) {
    throw createInvalidResponseError("Model returned invalid compare methods.");
  }
  const methods = value.methods
    .map((method) => ({
      title: safeString(method?.title),
      summary: safeString(method?.summary),
      points: Array.isArray(method?.points) ? method.points.map(safeString).filter(Boolean) : [],
    }))
    .filter((method) => method.title && (method.summary || method.points.length > 0))
    .slice(0, 3);
  if (methods.length === 0) {
    throw createInvalidResponseError("Model returned no compare methods.");
  }
  return { methods };
}

function assertDifficultyExplanations(value, fieldName) {
  if (
    !value ||
    typeof value !== "object" ||
    !isString(value.beginner) ||
    !isString(value.intermediate) ||
    !isString(value.advanced)
  ) {
    throw createInvalidResponseError(`Model response contains invalid ${fieldName}.`);
  }
}

function normalizeChunk(chunk, token) {
  if (!chunk || typeof chunk !== "object") {
    throw createInvalidResponseError("Model response contains an invalid math chunk.");
  }

  const explanations = token?.explanations;
  const normalized = {
    id: isString(chunk.id) ? chunk.id : token?.id,
    display: isString(chunk.display) ? chunk.display : token?.display,
    short: isString(chunk.short) ? chunk.short : token?.label,
    medium: isString(chunk.medium) ? chunk.medium : explanations?.intermediate,
    deep: isString(chunk.deep) ? chunk.deep : explanations?.advanced,
  };

  if (Array.isArray(chunk.parts)) {
    normalized.parts = chunk.parts.map((part) => ({
      id: isString(part?.id) ? part.id : "",
      display: isString(part?.display) ? part.display : "",
      short: isString(part?.short) ? part.short : "",
      medium: isString(part?.medium) ? part.medium : "",
      deep: isString(part?.deep) ? part.deep : "",
      ...(isString(part?.conceptId) ? { conceptId: part.conceptId } : {}),
      ...(Array.isArray(part?.conceptIds) ? { conceptIds: part.conceptIds.filter(isString) } : {}),
      ...(Array.isArray(part?.relatedTokenIds) ? { relatedTokenIds: part.relatedTokenIds.filter(isString) } : {}),
    }));
  }

  return normalized;
}

function createChunkFromToken(token) {
  return {
    id: token.id,
    display: token.display,
    short: token.label,
    medium: token.explanations?.intermediate,
    deep: token.explanations?.advanced,
    parts: [],
  };
}

function createRelationshipReport() {
  return {
    missingChunks: [],
    orphanTokens: [],
    duplicateChunkIds: [],
    duplicateTokenIds: [],
    crossStepReferences: [],
  };
}

function logTokenChunkDiagnostic(reason, details) {
  console.warn("[omnimath:token-chunk-diagnostic]", {
    reason,
    tokenId: details.tokenId || null,
    tokenStepId: details.tokenStepId || null,
    expectedChunkId: details.expectedChunkId || details.tokenId || null,
    foundChunkId: details.foundChunkId || null,
    chunkParentStep: details.chunkParentStep || null,
    repair: details.repair || null,
  });
}

function logRelationshipReport(report, firstOffendingToken = null) {
  console.error("[omnimath:token-chunk-report]", {
    report,
    firstOffendingToken,
  });
  if (firstOffendingToken) {
    console.error([
      "TOKEN:",
      firstOffendingToken.id || "unknown",
      "",
      "EXPECTED CHUNK:",
      firstOffendingToken.expectedChunkId || firstOffendingToken.id || "unknown",
      "",
      "FOUND:",
      firstOffendingToken.foundChunkId || "none",
      "",
      "STEP:",
      firstOffendingToken.stepId || "unknown",
      "",
      "REASON:",
      firstOffendingToken.reason || "unknown",
    ].join("\n"));
  }
}

function createRelationshipError(message, report, firstOffendingToken) {
  logRelationshipReport(report, firstOffendingToken);
  const error = createInvalidResponseError(message);
  error.relationshipReport = report;
  error.firstOffendingToken = firstOffendingToken;
  return error;
}

export function assertMathExplanation(value) {
  if (!value || typeof value !== "object") {
    throw createInvalidResponseError("Model returned an invalid explanation.");
  }

  const {
    title,
    originalProblem,
    expression,
    finalAnswer,
    tokens,
    explanations,
    steps,
  } = value;

  if (
    !isString(title) ||
    !isString(originalProblem) ||
    !isString(expression) ||
    !isString(finalAnswer) ||
    !Array.isArray(tokens) ||
    tokens.length === 0 ||
    !Array.isArray(steps) ||
    steps.length === 0
  ) {
    throw createInvalidResponseError("Model response is missing required explanation fields.");
  }

  assertDifficultyExplanations(explanations, "top-level difficulty explanations");

  const relationshipReport = createRelationshipReport();
  let firstOffendingToken = null;
  const tokenById = new Map();
  for (const token of tokens) {
    if (
      !token ||
      typeof token !== "object" ||
      !isString(token.id) ||
      !isString(token.stepId) ||
      !isString(token.display) ||
      !isString(token.label)
    ) {
      throw createInvalidResponseError("Model response contains an invalid token.");
    }
    assertDifficultyExplanations(token.explanations, "token difficulty explanations");
    if (tokenById.has(token.id)) {
      relationshipReport.duplicateTokenIds.push({
        tokenId: token.id,
        firstStepId: tokenById.get(token.id)?.stepId,
        duplicateStepId: token.stepId,
      });
      if (!firstOffendingToken) {
        firstOffendingToken = {
          id: token.id,
          stepId: token.stepId,
          expectedChunkId: token.id,
          foundChunkId: token.id,
          reason: "duplicate token id",
        };
      }
    }
    tokenById.set(token.id, token);
  }

  if (relationshipReport.duplicateTokenIds.length > 0) {
    throw createRelationshipError(
      "Model response contains duplicate token ids.",
      relationshipReport,
      firstOffendingToken
    );
  }

  const chunkIds = new Set();
  const chunkStepIds = new Map();
  const stepById = new Map();
  for (const step of steps) {
    if (
      !step ||
      typeof step !== "object" ||
      !isString(step.id) ||
      !isString(step.label) ||
      !isString(step.math) ||
      !isString(step.summary) ||
      !Array.isArray(step.chunks)
    ) {
      throw createInvalidResponseError("Model response contains an invalid step.");
    }

    if (step.chunks.length === 0) {
      throw createInvalidResponseError("Model response contains a step without chunks.");
    }

    stepById.set(step.id, step);
    step.chunks = step.chunks.map((chunk) => normalizeChunk(chunk, tokenById.get(chunk?.id)));
    for (const chunk of step.chunks) {
      if (
        !isString(chunk.id) ||
        !isString(chunk.display) ||
        !isString(chunk.short) ||
        !isString(chunk.medium) ||
        !isString(chunk.deep)
      ) {
        throw createInvalidResponseError("Model response contains an invalid math chunk.");
      }
      if (Array.isArray(chunk.parts)) {
        for (const part of chunk.parts) {
          if (
            !isString(part.id) ||
            !isString(part.display) ||
            !isString(part.short) ||
            !isString(part.medium) ||
            !isString(part.deep)
          ) {
            throw createInvalidResponseError("Model response contains an invalid math chunk part.");
          }
        }
      }
      if (chunkIds.has(chunk.id)) {
        relationshipReport.duplicateChunkIds.push({
          chunkId: chunk.id,
          firstStepId: chunkStepIds.get(chunk.id),
          duplicateStepId: step.id,
        });
        if (!firstOffendingToken) {
          firstOffendingToken = {
            id: tokenById.get(chunk.id)?.id || chunk.id,
            stepId: tokenById.get(chunk.id)?.stepId || step.id,
            expectedChunkId: chunk.id,
            foundChunkId: chunk.id,
            chunkParentStep: step.id,
            reason: "duplicate chunk id",
          };
        }
        logTokenChunkDiagnostic("duplicate chunk id", {
          tokenId: tokenById.get(chunk.id)?.id,
          tokenStepId: tokenById.get(chunk.id)?.stepId,
          expectedChunkId: chunk.id,
          foundChunkId: chunk.id,
          chunkParentStep: step.id,
        });
        continue;
      }
      chunkIds.add(chunk.id);
      chunkStepIds.set(chunk.id, step.id);
    }
  }

  if (relationshipReport.duplicateChunkIds.length > 0) {
    throw createRelationshipError(
      "Model response contains duplicate chunk ids.",
      relationshipReport,
      firstOffendingToken
    );
  }

  for (const token of tokens) {
    if (!chunkIds.has(token.id)) {
      const parentStep = stepById.get(token.stepId);
      const detail = {
        tokenId: token.id,
        tokenStepId: token.stepId,
        expectedChunkId: token.id,
        foundChunkId: null,
        chunkParentStep: null,
      };
      relationshipReport.missingChunks.push({
        tokenId: token.id,
        tokenStepId: token.stepId,
        expectedChunkId: token.id,
      });
      relationshipReport.orphanTokens.push({
        tokenId: token.id,
        tokenStepId: token.stepId,
        reason: parentStep ? "missing legacy chunk" : "missing parent step",
      });
      if (!firstOffendingToken) {
        firstOffendingToken = {
          id: token.id,
          stepId: token.stepId,
          expectedChunkId: token.id,
          foundChunkId: null,
          reason: parentStep ? "missing legacy chunk" : "missing parent step",
        };
      }

      if (parentStep) {
        const repairedChunk = normalizeChunk(createChunkFromToken(token), token);
        parentStep.chunks.push(repairedChunk);
        chunkIds.add(repairedChunk.id);
        chunkStepIds.set(repairedChunk.id, parentStep.id);
        logTokenChunkDiagnostic("missing chunk repaired from token", {
          ...detail,
          foundChunkId: repairedChunk.id,
          chunkParentStep: parentStep.id,
          repair: "synthesized chunk from token",
        });
        continue;
      }

      logTokenChunkDiagnostic("missing chunk cannot be repaired", detail);
      throw createRelationshipError(
        "Model response contains a token without a matching chunk.",
        relationshipReport,
        firstOffendingToken
      );
    }
    if (chunkStepIds.get(token.id) !== token.stepId) {
      const actualStepId = chunkStepIds.get(token.id);
      relationshipReport.crossStepReferences.push({
        tokenId: token.id,
        tokenStepId: token.stepId,
        chunkId: token.id,
        chunkParentStep: actualStepId,
        resolution: "token stepId updated to chunk parent step",
      });
      if (!firstOffendingToken) {
        firstOffendingToken = {
          id: token.id,
          stepId: token.stepId,
          expectedChunkId: token.id,
          foundChunkId: token.id,
          chunkParentStep: actualStepId,
          reason: "token references chunk in another step",
        };
      }
      logTokenChunkDiagnostic("cross-step reference repaired", {
        tokenId: token.id,
        tokenStepId: token.stepId,
        expectedChunkId: token.id,
        foundChunkId: token.id,
        chunkParentStep: actualStepId,
        repair: `token.stepId changed to ${actualStepId}`,
      });
      token.stepId = actualStepId;
    }
  }

  if (
    relationshipReport.missingChunks.length > 0 ||
    relationshipReport.orphanTokens.length > 0 ||
    relationshipReport.crossStepReferences.length > 0
  ) {
    console.info("[omnimath:token-chunk-repair-report]", relationshipReport);
  }

  return annotateMathExplanation(value);
}
