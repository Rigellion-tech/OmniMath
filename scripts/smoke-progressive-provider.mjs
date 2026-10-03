import { createHash } from "node:crypto";
import { buildMathExplanationPrompt } from "../server/mathPrompt.js";
import { isOpenAiConfigured, normalizeProviderSolveCandidate, streamMathExplanation } from "../server/openai.js";
import { createProgressiveJsonFramer } from "../server/progressiveJsonFramer.js";
import { createProgressiveStepValidator } from "../server/progressiveStepValidation.js";

const cases = {
  simple: "Solve 2x+3=11 and verify the answer.",
  advanced: "Find the extrema of f(x,y)=x^2+xy+y^2 subject to x+y=1 using Lagrange multipliers.",
};
const caseName = process.argv[2] || "simple";
if (!Object.hasOwn(cases, caseName)) throw new Error("Use simple or advanced.");
if (!isOpenAiConfigured()) throw new Error("A server-side OpenAI configuration is required for this smoke test.");

const problem = cases[caseName];
const sourceHash = createHash("sha256").update(problem).digest("hex");
const framer = createProgressiveJsonFramer();
const validator = createProgressiveStepValidator({ sourceHash });
const prompt = buildMathExplanationPrompt({ problem, history: [] });
const startedAt = Date.now();
let firstStepAt = null;
let metadataAt = null;
let finalAt = null;
let rejected = 0;
const stepTimings = [];

const result = await streamMathExplanation({
  prompt,
  originalProblem: problem,
  debugContext: { requestId: `smoke-${caseName}`, normalizedProblem: problem },
  onTextDelta: (delta) => {
    for (const record of framer.push(delta)) {
      if (record.type === "metadata") metadataAt ??= Date.now() - startedAt;
      if (record.type === "step") {
        try {
          const accepted = validator.accept(record.value, { stepIndex: record.index, sourceHash });
          firstStepAt ??= Date.now() - startedAt;
          stepTimings.push({ index: record.index, id: accepted.step.id, atMs: Date.now() - startedAt });
        } catch (error) { rejected += 1; throw error; }
      }
      if (record.type === "final_answer") finalAt = Date.now() - startedAt;
    }
  },
});
const full = framer.finish();
validator.assertPrefix(full);
normalizeProviderSolveCandidate(full, { originalProblem: problem });
console.log(JSON.stringify({
  caseName,
  model: result.model,
  firstProviderByteMs: result.firstProviderByteMs,
  firstProviderEventMs: result.firstProviderEventMs,
  metadataAtMs: metadataAt,
  firstValidatedStepMs: firstStepAt,
  stepTimings,
  finalAnswerAtMs: finalAt,
  totalMs: result.durationMs,
  validatedSteps: validator.acceptedCount,
  rejectedSteps: rejected,
  providerCalls: result.providerCallCount,
  earlyStepBeforeCompletion: firstStepAt !== null && firstStepAt < result.durationMs,
  usageReported: Boolean(result.usage),
}, null, 2));
