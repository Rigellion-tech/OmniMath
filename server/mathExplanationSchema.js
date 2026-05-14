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

export const mathExplanationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "originalProblem",
    "expression",
    "steps",
    "finalAnswer",
    "tokens",
    "explanations",
  ],
  properties: {
    title: { type: "string" },
    originalProblem: { type: "string" },
    expression: { type: "string" },
    finalAnswer: { type: "string" },
    explanations: difficultyExplanationSchema,
    tokens: {
      type: "array",
      minItems: 1,
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
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "math", "summary", "chunks"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          math: { type: "string" },
          summary: { type: "string" },
          chunks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "display", "short", "medium", "deep"],
              properties: {
                id: { type: "string" },
                display: { type: "string" },
                short: { type: "string" },
                medium: { type: "string" },
                deep: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

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
  return {
    id: isString(chunk.id) ? chunk.id : token?.id,
    display: isString(chunk.display) ? chunk.display : token?.display,
    short: isString(chunk.short) ? chunk.short : token?.label,
    medium: isString(chunk.medium) ? chunk.medium : explanations?.intermediate,
    deep: isString(chunk.deep) ? chunk.deep : explanations?.advanced,
  };
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
    tokenById.set(token.id, token);
  }

  const chunkIds = new Set();
  const chunkStepIds = new Map();
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
      if (chunkIds.has(chunk.id)) {
        throw createInvalidResponseError("Model response contains duplicate token ids.");
      }
      chunkIds.add(chunk.id);
      chunkStepIds.set(chunk.id, step.id);
    }
  }

  for (const token of tokens) {
    if (!chunkIds.has(token.id)) {
      throw createInvalidResponseError("Model response contains a token without a matching chunk.");
    }
    if (chunkStepIds.get(token.id) !== token.stepId) {
      throw createInvalidResponseError("Model response contains a token with the wrong step id.");
    }
  }

  return value;
}
