import { annotateMathExplanation, renderMathLatex } from "./mathAnnotator.js";
import {
  collectGeneratedLatexValidationIssues,
  isFinalAnswerFieldStructureIssue,
} from "./generatedLatexValidation.js";
import { splitEquationChainLatex } from "../src/lib/equationChains.js";
import { normalizeLatexForKatex, shouldPreserveLatex, traceMathStage } from "../src/lib/mathNode.js";
import { sanitizeStringValues, stripTerminalControlSequences } from "../src/lib/textSanitization.js";
import {
  inspectLatexControlCharacterStage,
  recoverDeclaredLatexControlCharacters,
} from "./latexControlCharacterRecovery.js";

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
      maxItems: 3,
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

export const compactSolveSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "problemLatex", "steps"],
  properties: {
    title: { type: "string" },
    problemLatex: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: fastSolveStepSchema,
    },
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

const imageExtractionIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "message", "severity"],
  properties: {
    type: { type: "string" },
    message: { type: "string" },
    severity: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
  },
};

export const imageExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedProblemLatex", "extractedProblemText", "confidence", "issues"],
  properties: {
    extractedProblemLatex: { type: "string" },
    extractedProblemText: { type: "string" },
    confidence: { type: "number" },
    issues: {
      type: "array",
      maxItems: 8,
      items: imageExtractionIssueSchema,
    },
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
validateMathExplanationSchema(compactSolveSchema);
validateMathExplanationSchema(imageSolveSchema);
validateMathExplanationSchema(imageExtractionSchema);
validateMathExplanationSchema(lazyTokenExplanationSchema);
validateMathExplanationSchema(compareMethodsSchema);

export const RESPONSE_FAILURE_TYPES = {
  JSON_PARSE: "json_parse",
  SCHEMA_CONTRACT: "schema_contract",
  LATEX_SYNTAX: "latex_syntax",
  FIELD_STRUCTURE: "field_structure",
  TRUNCATED: "truncated",
  GENERATED_VALIDATION: "generated_validation",
};

function createInvalidResponseError(message, {
  responseFailureType = RESPONSE_FAILURE_TYPES.SCHEMA_CONTRACT,
  publicMessage = "The AI service returned an invalid explanation.",
  compactRetryable = true,
} = {}) {
  return Object.assign(new Error(message), {
    statusCode: 502,
    code: "AI_RESPONSE_INVALID",
    compactRetryable,
    responseFailureType,
    publicMessage,
  });
}

function solveDiagnosticsEnabled() {
  return process.env.NODE_ENV !== "production" && (
    process.env.OMNIMATH_DEBUG_SOLVE === "true"
    || process.env.OMNIMATH_DEBUG_SOLVE === "1"
    || process.env.VITE_DEBUG_SOLUTION_STATE === "true"
  );
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeString(value) {
  return typeof value === "string" ? stripTerminalControlSequences(value).trim() : "";
}

function stripGeneratedLatexWrappers(value = "") {
  let text = safeString(value);
  let previous = "";

  while (text !== previous) {
    previous = text;
    text = text.trim();
    const wrappers = [
      { pattern: /^```(?:latex|tex|math)?\s*([\s\S]*?)\s*```$/iu, replacement: "$1" },
      { pattern: /^\\\(([\s\S]*)\\\)$/u, replacement: "$1" },
      { pattern: /^\\\[([\s\S]*)\\\]$/u, replacement: "$1" },
      { pattern: /^\$\$([\s\S]*)\$\$$/u, replacement: "$1" },
      { pattern: /^\$([\s\S]*)\$$/u, replacement: "$1" },
    ];

    for (const { pattern, replacement } of wrappers) {
      if (pattern.test(text)) {
        text = text.replace(pattern, replacement).trim();
        break;
      }
    }
  }

  return text.replace(/^\\displaystyle\s*/, "").trim();
}

function normalizeGeneratedTextContent(value = "") {
  let text = String(value || "")
    .replace(/\\[,;!]/g, " ")
    .replace(/\\quad/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/isthesolidregioninsi\s*de/gi, "is the solid region inside")
    .replace(/isthesolidregioninside/gi, "is the solid region inside")
    .replace(/solidregioninsi\s*de/gi, "solid region inside")
    .replace(/solidregioninside/gi, "solid region inside");

  if (/^(and|where)$/i.test(text)) return `${text.toLowerCase()} `;
  if (/^is the\b/i.test(text)) return ` ${text} `;
  return text;
}

function normalizeGeneratedTextCommands(value = "") {
  return String(value || "")
    .replace(/\\text\{([^}]*)\}/g, (_, content) => `\\text{${normalizeGeneratedTextContent(content)}}`)
    .replace(/\\text\{([^}]*\s)\}(?=[A-Za-z0-9\\])/g, "\\text{$1} ");
}

function normalizeEscapedGeneratedLatex(value = "") {
  let text = String(value || "");
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/\\\\(?=([a-zA-Z]+|[,;!]))/g, "\\")
      .replace(/\\\\(?=[{}_^])/g, "\\");
  }
  return text;
}

function needsGeneratedLatexRepair(value = "") {
  return /\\(?:mathbf|vec|hat)[A-Za-z]/.test(value)
    || /\\text\{[^}]*\}(?=[A-Za-z0-9\\])/.test(value)
    || /\\z\b/.test(value)
    || /\\(?:iint|int)\s+(?:lim\s*its|limits)\s*_/i.test(value);
}

export function sanitizeGeneratedLatex(value = "") {
  const stripped = normalizeEscapedGeneratedLatex(stripGeneratedLatexWrappers(value));
  if (/\\begin\s*\{([A-Za-z*]+)\}[\s\S]*\\end\s*\{\1\}/u.test(stripped)) {
    traceMathStage("LLM response parsing", value, stripped, "preserved complete LaTeX environment");
    return stripped;
  }
  if (shouldPreserveLatex(stripped) && !needsGeneratedLatexRepair(stripped)) {
    const preserved = normalizeLatexForKatex(stripped);
    traceMathStage("LLM response parsing", value, preserved, "preserved immutable LaTeX");
    return preserved;
  }

  const sanitized = normalizeGeneratedTextCommands(stripped)
    .replace(/\\\\(?=([a-zA-Z]+|[,;!]))/g, () => "\\")
    .replace(/\\mathbf\s*([A-Za-z])/g, "\\mathbf{$1}")
    .replace(/\\mathbf([A-Za-z])/g, "\\mathbf{$1}")
    .replace(/\\vec\s*([A-Za-z])/g, "\\vec{$1}")
    .replace(/\\vec([A-Za-z])/g, "\\vec{$1}")
    .replace(/\\hat\s*([A-Za-z])/g, "\\hat{$1}")
    .replace(/\\hat([A-Za-z])/g, "\\hat{$1}")
    .replace(/\\mathbf\{dr\}/g, "d\\mathbf{r}")
    .replace(/\\mathbf\{d\}r/g, "d\\mathbf{r}")
    .replace(/\\cdot\s*d(?=\\mathbf\{[A-Za-z]\})/g, "\\cdot d")
    .replace(/\\iint\s+(?:lim\s*its|limits)\s*_\s*([A-Za-z])/gi, "\\iint_{$1}")
    .replace(/\\int\s+(?:lim\s*its|limits)\s*_\s*([A-Za-z])/gi, "\\int_{$1}")
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
    .replace(/\\([xyz])\b/g, "$1")
    .replace(/(?<!\\)\bln(?=\s*\()/gi, "\\ln")
    .replace(/(?<!\\)\bsin(?=\s*\()/gi, "\\sin")
    .replace(/(?<!\\)\bcos(?=\s*\()/gi, "\\cos")
    .replace(/(?<!\\)\btan(?=\s*\()/gi, "\\tan")
    .replace(/(?<!\\)\barctan(?=\s*\()/gi, "\\arctan")
    .replace(/(?<!\\)\bfrac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, "\\frac{$1}{$2}")
    .replace(/(?<!\\)\bint_/gi, "\\int_")
    .replace(/(?<!\\)\biiint_/gi, "\\iiint_")
    .replace(/(?<!\\)\biint_/gi, "\\iint_")
    .replace(/\\text\{([^}]*\s)\}(?=[A-Za-z0-9\\])/g, "\\text{$1} ")
    .replace(/\s+/g, " ")
    .trim();
  traceMathStage("LLM response parsing", value, sanitized, "legacy generated LaTeX repair");
  return sanitized;
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

function normalizeLatexForComparison(value = "") {
  return compactLatex(value)
    .replace(/\\,/g, "")
    .replace(/^\\boxed/, "")
    .replace(/\\text(?:or|and)/gi, "")
    .replace(/\\quad(?:\\text(?:or|and))?\\quad/gi, "")
    .replace(/\\mathrm(?:or|and)/gi, "");
}

function parsePerfectSquareQuadratic(problemLatex = "") {
  const compact = compactLatex(problemLatex);
  const match = compact.match(/^x\^2([+-])(\d+)x([+-])(\d+)=0$/i);
  if (!match) return null;

  const middleCoefficient = (match[1] === "-" ? -1 : 1) * Number(match[2]);
  const constant = (match[3] === "-" ? -1 : 1) * Number(match[4]);
  if (!Number.isSafeInteger(middleCoefficient) || !Number.isSafeInteger(constant) || constant <= 0) return null;
  if (middleCoefficient % 2 !== 0) return null;

  const signedK = middleCoefficient / 2;
  const absK = Math.abs(signedK);
  if (absK ** 2 !== constant) return null;

  const sign = signedK < 0 ? "-" : "+";
  const originalLeft = `x^2${sign}${Math.abs(middleCoefficient)}x+${constant}`;
  return {
    absK,
    sign,
    originalEquation: `${originalLeft}=0`,
    groupedEquation: `(x${sign}${absK})^2=0`,
    linearEquation: `x${sign}${absK}=0`,
    finalAnswer: `x=${-signedK}`,
    invalidChain: `${originalLeft}=(x${sign}${absK})^2=0`,
  };
}

function isSolveForXHeading(value = "") {
  return /solve\s+for\s+x|set\s+the\s+equation\s+and\s+solve|solve\s+the\s+(?:linear|resulting|repeated root)/iu.test(safeString(value));
}

function isInvalidPerfectSquareEqualityChain(latex = "", perfectSquare = null) {
  if (!perfectSquare) return false;
  return compactLatex(latex) === compactLatex(perfectSquare.invalidChain);
}

function repairPerfectSquareSteps(steps = [], perfectSquare = null, finalAnswerLatex = "") {
  if (!perfectSquare) return steps;
  const expectedFinal = finalAnswerLatex || perfectSquare.finalAnswer;

  return steps.map((step) => {
    if (isInvalidPerfectSquareEqualityChain(step.latex, perfectSquare)) {
      return {
        ...step,
        latex: `${perfectSquare.originalEquation}\n${perfectSquare.groupedEquation}`,
        reasoning: step.reasoning || "Rewrite the perfect-square trinomial as a grouped square while preserving the original equation.",
      };
    }

    if (!step.latex && isSolveForXHeading(step.heading)) {
      return {
        ...step,
        latex: `${perfectSquare.groupedEquation}\n${perfectSquare.linearEquation}\n${expectedFinal}`,
        reasoning: step.reasoning || "Solve the repeated-root linear equation.",
      };
    }

    return step;
  });
}

function renderStepLatexLines(value = "") {
  const source = String(value || "").trim();
  const completeEnvironment = /\\begin\s*\{([A-Za-z*]+)\}[\s\S]*\\end\s*\{\1\}/u.test(source);
  if (completeEnvironment) return [sanitizeGeneratedLatex(source)].filter(Boolean);

  const sourceLines = source
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = sourceLines.length > 0 ? sourceLines : [value];
  return lines.flatMap((line) => {
    const rendered = /\\[A-Za-z]+[ \t]+[A-Za-z]/u.test(line)
      ? sanitizeGeneratedLatex(line).replace(/\\(quad|qquad)(?=\\[A-Za-z])/gu, "\\$1 ")
      : renderMathLatex(line);
    return splitEquationChainLatex(rendered);
  }).filter(Boolean);
}

function createLatexValidationError(issues = []) {
  const issueNames = issues.flatMap((issue) => issue.issues.map((name) => `invalid_latex:${issue.fieldPath}:${name}`));
  const hasFinalAnswerStructureIssue = issues.some((issue) => (
    issue.fieldPath === "finalAnswerLatex"
    && issue.issues.some((name) => isFinalAnswerFieldStructureIssue(name))
  ));
  const error = createInvalidResponseError(
    hasFinalAnswerStructureIssue
      ? "Generated solution has invalid final-answer structure."
      : "Generated solution contains invalid LaTeX.",
    {
      responseFailureType: hasFinalAnswerStructureIssue
        ? RESPONSE_FAILURE_TYPES.FIELD_STRUCTURE
        : RESPONSE_FAILURE_TYPES.LATEX_SYNTAX,
      publicMessage: hasFinalAnswerStructureIssue
        ? "The generated solution used an invalid final-answer structure."
        : "Generated solution contains invalid LaTeX.",
    }
  );
  error.solutionIssues = issueNames.length > 0 ? issueNames : ["invalid_latex"];
  error.latexValidationIssues = issues;
  return error;
}

function assertGeneratedLatexFields(fields = []) {
  if (solveDiagnosticsEnabled()) {
    console.info("[omnimath:latex-control-character-stage]", inspectLatexControlCharacterStage(
      fields.map((field) => field.value),
      "generated_latex_validation_input"
    ));
  }
  const issues = collectGeneratedLatexValidationIssues(fields);
  if (issues.length > 0) {
    if (solveDiagnosticsEnabled()) {
      console.warn("[omnimath:latex-validation]", {
        status: "fail",
        issues: issues.map((issue) => ({
          fieldPath: issue.fieldPath,
          value: issue.value,
          issues: issue.issues,
        })),
      });
    }
    throw createLatexValidationError(issues);
  }
  if (solveDiagnosticsEnabled()) {
    console.info("[omnimath:latex-validation]", {
      status: "pass",
      fieldCount: fields.length,
    });
  }
}

function assertRawGeneratedLatexFields(fields = []) {
  if (solveDiagnosticsEnabled()) {
    console.info("[omnimath:latex-control-character-stage]", inspectLatexControlCharacterStage(
      fields.map((field) => field.value),
      "assertRawGeneratedLatexFields_input"
    ));
  }
  const issues = collectGeneratedLatexValidationIssues(fields.map((field) => ({
    ...field,
    strictParse: false,
  })));
  if (issues.length > 0) {
    if (solveDiagnosticsEnabled()) {
      console.warn("[omnimath:latex-validation]", {
        status: "raw-fail",
        issues: issues.map((issue) => ({
          fieldPath: issue.fieldPath,
          value: issue.value,
          issues: issue.issues,
        })),
      });
    }
    throw createLatexValidationError(issues);
  }
  if (solveDiagnosticsEnabled()) {
    console.info("[omnimath:latex-validation]", {
      status: "raw-pass",
      fieldCount: fields.length,
    });
  }
}

function generatedLatexLineFields(value = "", basePath = "latex") {
  const source = String(value || "");
  if (/\\begin\s*\{([A-Za-z*]+)\}[\s\S]*\\end\s*\{\1\}/u.test(source)) return [];
  return source.split(/\r?\n+/).map((line, lineIndex) => ({
    fieldPath: `${basePath}.lines[${lineIndex}]`,
    value: line,
  }));
}

function solveLatexFields({ problemLatex = "", finalAnswerLatex = "", steps = [] } = {}) {
  return [
    { fieldPath: "problemLatex", value: problemLatex },
    { fieldPath: "finalAnswerLatex", value: finalAnswerLatex, finalAnswer: true, strictFinalAnswerContract: true },
    ...steps.flatMap((step, stepIndex) => [
      { fieldPath: `steps[${stepIndex}].latex`, value: step.latex },
      ...generatedLatexLineFields(step.latex, `steps[${stepIndex}]`),
      ...(Array.isArray(step.anchors) ? step.anchors.map((anchor, anchorIndex) => ({
        fieldPath: `steps[${stepIndex}].anchors[${anchorIndex}].latex`,
        value: anchor?.latex,
      })) : []),
    ]),
  ].filter((field) => typeof field.value === "string" && field.value.trim());
}

function rawSolveLatexFields({ problemLatex = "", finalAnswerLatex = "", steps = [], includeProblemLatex = true } = {}) {
  return [
    includeProblemLatex ? { fieldPath: "problemLatex", value: problemLatex } : null,
    { fieldPath: "finalAnswerLatex", value: finalAnswerLatex, finalAnswer: true, strictFinalAnswerContract: true },
    ...steps.flatMap((step, stepIndex) => [
      { fieldPath: `steps[${stepIndex}].latex`, value: step?.latex },
      ...generatedLatexLineFields(step?.latex, `steps[${stepIndex}]`),
      ...(Array.isArray(step?.anchors) ? step.anchors.map((anchor, anchorIndex) => ({
        fieldPath: `steps[${stepIndex}].anchors[${anchorIndex}].latex`,
        value: anchor?.latex,
      })) : []),
    ]),
  ].filter((field) => field && typeof field.value === "string" && field.value.trim());
}

function simplifyDisplayedLatex(value = "") {
  if (/\\begin\s*\{([A-Za-z*]+)\}[\s\S]*\\end\s*\{\1\}/u.test(String(value || ""))) {
    return String(value || "").trim();
  }
  let output = String(value || "");
  let previous = "";
  const zeroProductPatterns = [
    /(?:^|(?<=[=,+\-]))\s*0\s*\\cdot\s*[^,+\-=&]+/g,
    /(?:^|(?<=[=,+\-]))\s*[^,+\-=&]+\s*\\cdot\s*0(?=\s*(?:[,+\-=&]|$))/g,
  ];

  while (output !== previous) {
    previous = output;
    output = output
      .replace(/\\sin\s*(?:\{0\}|\(0\)|0\b)/g, "0")
      .replace(/\\cos\s*(?:\{0\}|\(0\)|0\b)/g, "1")
      .replace(/\\ln\s*(?:\{1\}|\(1\)|1\b)/g, "0")
      .replace(/e\^\{0\}|e\^0\b/g, "1");

    for (const pattern of zeroProductPatterns) {
      output = output.replace(pattern, "0");
    }

    output = output
      .replace(/\+\s*0(?=\s*(?:[,+\-\]&]|\\right|\\rangle|$))/g, "")
      .replace(/(?<=[=,\[\{(])\s*0\s*\+\s*/g, "")
      .replace(/-\s*0(?=\s*(?:[,+\-\]&]|\\right|\\rangle|$))/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return output;
}

function isDuplicateProblemStep(step, problemLatex, index = 0) {
  const stepLatex = sanitizeGeneratedLatex(step?.latex);
  if (!stepLatex || !problemLatex) return false;
  if (compactLatex(stepLatex) === compactLatex(problemLatex)) return true;
  return /^(start|read|state|write)\b|original problem|the problem/i.test(safeString(step?.heading))
    && compactLatex(stepLatex).includes(compactLatex(problemLatex).slice(0, 32));
}

function isFinalAnswerHeading(value = "") {
  return /(?:^|\b)final\b|answer$/iu.test(safeString(value));
}

function stepHeadingValue(step = {}) {
  return step?.heading || step?.label || step?.title || "";
}

function stepLatexValue(step = {}) {
  return step?.latex || step?.math || step?.display || "";
}

function finalAnswerCandidateContains(stepLatex = "", finalAnswerLatex = "") {
  const step = normalizeLatexForComparison(stepLatex);
  const finalAnswer = normalizeLatexForComparison(finalAnswerLatex);
  if (!step || !finalAnswer) return false;
  if (step === finalAnswer) return true;
  if (step.includes(finalAnswer)) return true;

  const stepParts = step.split(/(?:\\text\{?(?:or|and)\}?|or|and|,|;)/i).filter(Boolean);
  return stepParts.some((part) => part === finalAnswer || part.endsWith(`=${finalAnswer}`));
}

function isRedundantFinalAnswerStep(step, finalAnswerLatex = "") {
  if (!finalAnswerLatex) return false;
  const stepLatex = normalizeLatexForComparison(sanitizeGeneratedLatex(stepLatexValue(step)));
  const finalLatex = normalizeLatexForComparison(finalAnswerLatex);
  return Boolean(stepLatex && finalLatex && stepLatex === finalLatex);
}

function isFinalAnswerStep(step, finalAnswerLatex = "") {
  return isFinalAnswerHeading(stepHeadingValue(step))
    || isRedundantFinalAnswerStep(step, finalAnswerLatex)
    || (isFinalAnswerHeading(stepHeadingValue(step)) && finalAnswerCandidateContains(sanitizeGeneratedLatex(stepLatexValue(step)), finalAnswerLatex));
}

function summarizeSolvePipelineStage(stage, steps = [], extra = {}) {
  if (!solveDiagnosticsEnabled()) return;
  const finalAnswerSteps = steps.filter((step) => isFinalAnswerStep(step, extra.finalAnswerLatex));
  const duplicateFinalAnswerNodes = Math.max(0, finalAnswerSteps.length - 1);
  console.info("[omnimath:solve-pipeline]", {
    stage,
    stepCount: steps.length,
    stepIds: steps.map((step) => step?.id || null),
    finalAnswerStepIds: finalAnswerSteps.map((step) => step?.id || null),
    duplicateFinalAnswerNodes,
    semanticNodeCount: steps.reduce((count, step) => count + (Array.isArray(step?.expressions) ? step.expressions.length : 0), 0),
    leafTokenCount: steps.reduce((count, step) => count + (Array.isArray(step?.anchors) ? step.anchors.length : 0), 0),
    annotatedTokenCount: steps.reduce((count, step) => count + (Array.isArray(step?.tokens) ? step.tokens.length : 0), 0),
    generatedHitboxCount: 0,
    skippedNodes: extra.skippedNodes || [],
    parserFailures: extra.parserFailures || [],
    fallbackUsage: extra.fallbackUsage || [],
    retries: extra.retries || 0,
    exceptions: extra.exceptions || [],
    ...extra,
  });
}

function assertSingleFinalAnswerStep(steps = [], finalAnswerLatex = "", stage = "step-normalization") {
  const finalAnswerSteps = steps.filter((step) => isFinalAnswerStep(step, finalAnswerLatex));
  if (finalAnswerSteps.length <= 1) return;
  const diagnostic = {
    stage,
    finalAnswerLatex,
    duplicateFinalAnswerNodes: finalAnswerSteps.length,
    stepIds: steps.map((step) => step.id),
    finalAnswerStepIds: finalAnswerSteps.map((step) => step.id),
    finalAnswerStepLatex: finalAnswerSteps.map(stepLatexValue),
  };
  console.error("[omnimath:solve-pipeline-invariant]", diagnostic);
  if (process.env.NODE_ENV !== "production") {
    throw createInvalidResponseError(`Duplicate Final Answer steps after ${stage}.`);
  }
}

function normalizeSolveSteps(rawSteps, { problemLatex, finalAnswerLatex } = {}) {
  const perfectSquare = parsePerfectSquareQuadratic(problemLatex);
  summarizeSolvePipelineStage("LLM response", Array.isArray(rawSteps) ? rawSteps : [], { finalAnswerLatex });
  const steps = repairPerfectSquareSteps(rawSteps
    .map((step, index) => ({
      id: normalizeStepId(step?.id, index),
      heading: safeString(step?.heading || `Step ${index + 1}`),
      latex: simplifyDisplayedLatex(sanitizeGeneratedLatex(step?.latex)),
      reasoning: safeString(step?.reasoning),
      anchors: Array.isArray(step?.anchors) ? step.anchors : [],
    })), perfectSquare, finalAnswerLatex)
    .filter((step, index) => (
      step.latex
      && !isStandaloneDifferential(step.latex)
      && !isFillerHeading(step.heading)
      && !isDuplicateProblemStep(step, problemLatex, index)
    ));

  summarizeSolvePipelineStage("step normalization", steps, { finalAnswerLatex });

  const finalSteps = steps.filter((step) => (
    isRedundantFinalAnswerStep(step, finalAnswerLatex)
    || (isFinalAnswerHeading(step.heading) && finalAnswerCandidateContains(step.latex, finalAnswerLatex))
  ));
  const finalStep = finalSteps.find((step) => isRedundantFinalAnswerStep(step, finalAnswerLatex))
    || finalSteps[finalSteps.length - 1]
    || null;
  const nonFinalSteps = steps.filter((step) => !isFinalAnswerStep(step, finalAnswerLatex));
  if (finalAnswerLatex) {
    const normalizedSteps = [
      ...nonFinalSteps,
      finalStep
        ? { ...finalStep, id: "final-answer", heading: "Final Answer", latex: finalAnswerLatex }
        : {
            id: "final-answer",
            heading: "Final Answer",
            latex: finalAnswerLatex,
            reasoning: "This is the simplified final result.",
            anchors: [],
          },
    ];
    summarizeSolvePipelineStage("duplicate removal", normalizedSteps, {
      finalAnswerLatex,
      skippedNodes: finalSteps.slice(0, Math.max(0, finalSteps.length - 1)).map((step) => ({
        id: step.id,
        reason: "merged duplicate final-answer candidate",
      })),
    });
    assertSingleFinalAnswerStep(normalizedSteps, finalAnswerLatex);
    return normalizedSteps;
  }

  assertSingleFinalAnswerStep(steps, finalAnswerLatex);
  return steps;
}

export function assertFastSolveResponse(value, originalProblem = "", { includeProblemStep = false } = {}) {
  value = sanitizeStringValues(recoverDeclaredLatexControlCharacters(value));
  originalProblem = stripTerminalControlSequences(originalProblem);
  if (!value || typeof value !== "object") {
    throw createInvalidResponseError("Model returned an invalid solve response.");
  }

  const problemLatex = sanitizeGeneratedLatex(value.problemLatex || originalProblem);
  const finalAnswerLatex = sanitizeGeneratedLatex(value.finalAnswerLatex);
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  if (!isString(value.title) || !problemLatex || rawSteps.length === 0 || !finalAnswerLatex) {
    throw createInvalidResponseError("Model response is missing required solve fields.");
  }
  const structurallyInvalidStep = rawSteps.some((step) => (
    !step
    || typeof step !== "object"
    || !isString(step.id)
    || !isString(step.heading)
    || !isString(step.latex)
    || typeof step.reasoning !== "string"
    || !Array.isArray(step.anchors)
  ));
  if (structurallyInvalidStep) {
    throw createInvalidResponseError("Model response contains an invalid solve step.");
  }

  const steps = rawSteps.map((step, index) => ({
    id: normalizeStepId(step.id, index),
    heading: safeString(step.heading),
    latex: sanitizeGeneratedLatex(step.latex),
    reasoning: safeString(step.reasoning),
    anchors: step.anchors
      .filter((anchor) => anchor && typeof anchor === "object" && isString(anchor.latex))
      .map((anchor, anchorIndex) => normalizeAnchor(anchor, normalizeStepId(step.id, index), anchorIndex))
      .slice(0, 3),
  }));

  if (steps.length === 0) {
    throw createInvalidResponseError("Model response does not contain meaningful solution steps.");
  }

  const firstStep = steps[0];
  if (includeProblemStep && firstStep?.latex !== problemLatex) {
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
      anchors: step.anchors,
    })),
    finalAnswerLatex,
    numericCheck: safeString(value.numericCheck),
  };
}

export function assertCompactSolveResponse(value, originalProblem = "") {
  value = sanitizeStringValues(recoverDeclaredLatexControlCharacters(value));
  originalProblem = stripTerminalControlSequences(originalProblem);
  if (!value || typeof value !== "object") {
    throw createInvalidResponseError("Model returned an invalid compact solve response.");
  }

  const problemLatex = sanitizeGeneratedLatex(value.problemLatex || originalProblem);
  const rawSteps = Array.isArray(value.steps) ? value.steps.slice(0, 8) : [];
  if (!isString(value.title) || !problemLatex || rawSteps.length === 0) {
    throw createInvalidResponseError("Compact model response is missing required solve fields.");
  }
  const structurallyInvalidStep = rawSteps.some((step) => (
    !step
    || typeof step !== "object"
    || !isString(step.id)
    || !isString(step.heading)
    || !isString(step.latex)
    || typeof step.reasoning !== "string"
    || !Array.isArray(step.anchors)
  ));
  if (structurallyInvalidStep) {
    throw createInvalidResponseError("Compact model response contains an invalid solve step.");
  }

  const steps = rawSteps
    .map((step, index) => ({
      id: normalizeStepId(step.id, index),
      heading: safeString(step.heading),
      latex: sanitizeGeneratedLatex(step.latex),
      reasoning: safeString(step.reasoning),
      anchors: [],
    }));

  if (steps.length === 0) {
    throw createInvalidResponseError("Compact model response does not contain meaningful solution steps.");
  }

  const finalAnswerLatex = sanitizeGeneratedLatex(steps.at(-1)?.latex || problemLatex);
  return {
    title: safeString(value.title),
    problemLatex,
    steps: steps.map((step, index) => ({
      ...step,
      id: normalizeStepId(step.id, index),
      heading: step.heading || `Step ${index + 1}`,
      reasoning: step.reasoning || "This step follows from the previous expression.",
      anchors: [],
    })),
    finalAnswerLatex,
    numericCheck: "",
  };
}

export function assertImageSolveResponse(value) {
  value = sanitizeStringValues(recoverDeclaredLatexControlCharacters(value));
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
  const structurallyInvalidStep = rawSteps.some((step) => (
    !step
    || typeof step !== "object"
    || !isString(step.title)
    || !isString(step.equationLatex)
    || typeof step.explanation !== "string"
    || !Array.isArray(step.tokens)
  ));
  if (structurallyInvalidStep) {
    throw createInvalidResponseError("Image model response contains an invalid solve step.");
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

export function assertImageExtractionResponse(value) {
  if (!value || typeof value !== "object") {
    throw createInvalidResponseError("Model returned an invalid image extraction response.");
  }

  const extractedProblemLatex = sanitizeGeneratedLatex(value.extractedProblemLatex);
  const extractedProblemText = safeString(value.extractedProblemText);
  if (!extractedProblemLatex || !extractedProblemText) {
    throw createInvalidResponseError("Image extraction response is missing extracted problem fields.");
  }
  assertGeneratedLatexFields([{ fieldPath: "extractedProblemLatex", value: extractedProblemLatex }]);

  const confidence = Math.max(0, Math.min(100, Math.round(Number(value.confidence) || 0)));
  const issues = Array.isArray(value.issues)
    ? value.issues.map((issue) => ({
        type: safeString(issue?.type) || "ocr_unclear",
        message: safeString(issue?.message) || "Review this extracted problem.",
        severity: ["low", "medium", "high"].includes(issue?.severity) ? issue.severity : "medium",
      })).filter((issue) => issue.message).slice(0, 8)
    : [];

  return {
    extractedProblemLatex,
    extractedProblemText,
    confidence,
    issues,
  };
}

export function convertFastSolveToMathExplanation(value, {
  originalProblem = "",
  includeProblemStep = false,
  preserveProblemLatex = false,
} = {}) {
  const solve = assertFastSolveResponse(value, originalProblem, { includeProblemStep });
  summarizeSolvePipelineStage("schema validation", solve.steps, { finalAnswerLatex: solve.finalAnswerLatex });
  let anchorBudget = 20;
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
  summarizeSolvePipelineStage("annotation generation", annotated.steps || [], {
    finalAnswerLatex: solve.finalAnswerLatex,
    semanticNodeCount: (annotated.steps || []).reduce((count, step) => (
      count + (step.expressions || []).reduce((exprCount, expression) => (
        exprCount + (expression.tokens || []).reduce((tokenCount, token) => (
          tokenCount + 1 + (Array.isArray(token.children) ? token.children.length : 0)
        ), 0)
      ), 0)
    ), 0),
    annotatedTokenCount: (annotated.steps || []).reduce((count, step) => (
      count + (step.lines || []).reduce((lineCount, line) => lineCount + (line.tokens || []).length, 0)
    ), 0),
  });
  annotated.expression = preserveProblemLatex ? solve.problemLatex : renderMathLatex(solve.problemLatex);
  annotated.finalAnswer = renderMathLatex(solve.finalAnswerLatex);
  annotated.finalAnswerLatex = renderMathLatex(solve.finalAnswerLatex);
  annotated.numericCheck = solve.numericCheck;
  annotated.steps = annotated.steps.map((step, index) => {
    const sourceStep = solve.steps[index];
    const displayLatexLines = renderStepLatexLines(sourceStep?.latex || step.math || "");
    const renderedStepMath = displayLatexLines.join("\n");
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
                display: renderedStepMath,
                latex: renderedStepMath,
                parts: sourceParts,
              }
            : chunk
        ))
      : step.chunks;
    const renderedMathLines = displayLatexLines.map((latex, lineOffset) => ({
      id: `${step.id}-line-${lineOffset + 1}`,
      kind: "math",
      role: index === 0 ? "problem" : index === solve.steps.length - 1 ? "final_answer" : "solution_step",
      text: "",
      latex,
      tokens: displayLatexLines.length === 1 ? chunks || [] : [],
    }));
    return {
      ...step,
      math: renderedStepMath,
      chunks,
      lines: Array.isArray(step.lines)
        ? step.lines.flatMap((line, lineIndex) => (
            lineIndex === 0 && line.kind === "math"
              ? renderedMathLines
              : [line]
          ))
        : step.lines,
    };
  });
  summarizeSolvePipelineStage("KaTeX render preparation", annotated.steps || [], {
    finalAnswerLatex: solve.finalAnswerLatex,
  });
  assertSingleFinalAnswerStep(
    (annotated.steps || []).map((step) => ({
      id: step.id,
      heading: step.label || step.title,
      latex: step.math,
    })),
    solve.finalAnswerLatex,
    "conversion"
  );
  return annotated;
}

export function convertImageSolveToMathExplanation(value) {
  const imageSolve = value?.problemLatex && Array.isArray(value?.steps)
    ? value
    : assertImageSolveResponse(value);
  const steps = imageSolve.steps.filter((step, index) => !isDuplicateProblemStep(step, imageSolve.extractedProblemLatex || imageSolve.problemLatex, index));
  const annotated = convertFastSolveToMathExplanation({
    title: imageSolve.title,
    problemLatex: imageSolve.extractedProblemLatex || imageSolve.problemLatex,
    steps: steps.length > 0 ? steps : imageSolve.steps,
    finalAnswerLatex: imageSolve.finalAnswerLatex,
    numericCheck: imageSolve.numericCheck,
  }, {
    originalProblem: imageSolve.extractedProblemLatex,
    includeProblemStep: false,
    preserveProblemLatex: true,
  });

  annotated.extractedProblemLatex = imageSolve.extractedProblemLatex;
  annotated.extractedProblemText = imageSolve.extractedProblemText;
  annotated.originalProblem = imageSolve.extractedProblemLatex;
  annotated.expression = imageSolve.extractedProblemLatex;
  annotated.problem = imageSolve.extractedProblemLatex;
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
