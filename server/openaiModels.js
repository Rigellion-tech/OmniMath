import { loadEnvFiles } from "./env.js";

loadEnvFiles();

export const DEFAULT_OPENAI_MODELS = {
  imageExtraction: "gpt-4.1",
  extractionReview: "gpt-4.1-mini",
  solver: "gpt-4.1",
  hover: "gpt-4.1-mini",
  pinned: "gpt-4.1-mini",
};

export function getOpenAiModels() {
  const legacyModel = process.env.OPENAI_MODEL;
  const legacyLazyModel = process.env.OPENAI_LAZY_MODEL;

  return {
    imageExtraction: process.env.OPENAI_IMAGE_EXTRACTION_MODEL || legacyModel || DEFAULT_OPENAI_MODELS.imageExtraction,
    extractionReview: process.env.OPENAI_EXTRACTION_REVIEW_MODEL || DEFAULT_OPENAI_MODELS.extractionReview,
    solver: process.env.OPENAI_SOLVER_MODEL || legacyModel || DEFAULT_OPENAI_MODELS.solver,
    hover: process.env.OPENAI_HOVER_MODEL || legacyLazyModel || DEFAULT_OPENAI_MODELS.hover,
    pinned: process.env.OPENAI_PINNED_MODEL || legacyLazyModel || DEFAULT_OPENAI_MODELS.pinned,
  };
}

export function getOpenAiModelForPath(path) {
  return getOpenAiModels()[path] || getOpenAiModels().solver;
}

export function logOpenAiModelSelection(path, extra = {}) {
  if (process.env.NODE_ENV === "production") return;
  console.info("[omnimath:openai-model]", {
    path,
    model: getOpenAiModelForPath(path),
    ...extra,
  });
}
