import assert from "node:assert/strict";
import test from "node:test";
import { validateGeneratedLatex } from "../server/generatedLatexValidation.js";
import {
  inspectLatexControlCharacterStage,
  recoverDeclaredLatexControlCharacters,
} from "../server/latexControlCharacterRecovery.js";
import { assertCompactSolveResponse } from "../server/mathExplanationSchema.js";
import { parseJsonResponse } from "../server/openai.js";
import { numericalFinalAnswerCheck } from "../server/mathValidationAnalysis.js";
import { evaluateSolutionQualityRules } from "../server/solutionValidation.js";
import { sanitizeStringValues } from "../src/lib/textSanitization.js";

process.env.OPENAI_API_KEY ||= "test-key";

function responseBody(outputText) {
  return {
    output_text: outputText,
    model: "mock-model",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function compactCandidate(latex) {
  return {
    title: "Fixture",
    problemLatex: "x",
    steps: [{
      id: "final",
      heading: "Final Answer",
      latex,
      reasoning: "Fixture response.",
      anchors: [],
    }],
  };
}

function predecessorCount(diagnostic, codePoint) {
  return diagnostic.commandPredecessorCodePoints
    .find((item) => item.codePoint === codePoint)?.count || 0;
}

test("redacted stage diagnostics distinguish all four backslash/control cases", () => {
  const cases = [
    {
      value: "\\frac{1}{2}",
      literal: 0,
      actual: 0,
      predecessor: "U+005C",
    },
    {
      value: "\\u0005frac",
      literal: 1,
      actual: 0,
      predecessor: "U+0035",
    },
    {
      value: "\u0005frac",
      literal: 0,
      actual: 1,
      predecessor: "U+0005",
    },
    {
      value: "frac{1}{2}",
      literal: 0,
      actual: 0,
      predecessor: "START",
    },
  ];

  for (const fixture of cases) {
    const diagnostic = inspectLatexControlCharacterStage(fixture.value, "fixture_stage");
    assert.equal(diagnostic.stage, "fixture_stage");
    assert.equal(diagnostic.literalUnicodeEscapeCount, fixture.literal);
    assert.equal(diagnostic.actualControlCharacterCount, fixture.actual);
    assert.equal(predecessorCount(diagnostic, fixture.predecessor), 1);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      "actualControlCharacterCount",
      "actualControlCharacterPresent",
      "commandPredecessorCodePoints",
      "literalUnicodeEscapeCount",
      "literalUnicodeEscapePresent",
      "recognizedCommandRemnantCount",
      "stage",
    ]);
  }
});

test("provider envelope and candidate JSON retain a literal escape until JSON.parse", () => {
  const rawCandidateJson = JSON.stringify(compactCandidate("\u0005frac{1}{2}"));
  const rawProviderResponse = JSON.stringify(responseBody(rawCandidateJson));
  const providerObject = JSON.parse(rawProviderResponse);
  let parsedObject;

  parseJsonResponse(providerObject, (value) => {
    parsedObject = value;
    return value;
  });

  const http = inspectLatexControlCharacterStage(rawProviderResponse, "provider_http_response");
  const sdkObject = inspectLatexControlCharacterStage(providerObject, "provider_response_object");
  const extracted = inspectLatexControlCharacterStage(providerObject.output_text, "extracted_output_text");
  const rawJson = inspectLatexControlCharacterStage(rawCandidateJson, "raw_json_text");
  const parsed = inspectLatexControlCharacterStage(parsedObject, "parsed_javascript_object");

  for (const diagnostic of [http, sdkObject, extracted, rawJson]) {
    assert.equal(diagnostic.literalUnicodeEscapeCount, 1, diagnostic.stage);
    assert.equal(diagnostic.actualControlCharacterCount, 0, diagnostic.stage);
  }
  assert.equal(parsed.literalUnicodeEscapeCount, 0);
  assert.equal(parsed.actualControlCharacterCount, 1);
  assert.equal(parsedObject.steps[0].latex, "\u0005frac{1}{2}");
  assert.equal(sanitizeStringValues(parsedObject).steps[0].latex, "frac{1}{2}");
});

test("an unescaped actual U+0005 in raw candidate JSON is rejected as malformed JSON", () => {
  const invalidRawJson = '{"title":"Fixture","problemLatex":"x","steps":[{"id":"final","heading":"Final Answer","latex":"\u0005frac{1}{2}","reasoning":"Fixture","anchors":[]}]}';
  assert.equal(inspectLatexControlCharacterStage(invalidRawJson, "raw_json_text").actualControlCharacterCount, 1);
  assert.throws(
    () => parseJsonResponse(responseBody(invalidRawJson), (value) => value),
    (error) => error.code === "AI_RESPONSE_INVALID"
      && error.responseFailureType === "json_parse"
  );
});

test("only actual U+0005 before recognized commands in declared LaTeX fields is recovered", () => {
  const candidate = compactCandidate("\u0005frac{1}{2}");
  candidate.problemLatex = "\u0005int_0^1 x\u0005,dx";
  candidate.title = "Keep \u0005frac as prose";
  candidate.steps[0].reasoning = "Keep \u0005sum as prose";

  const recovered = recoverDeclaredLatexControlCharacters(candidate);
  assert.equal(recovered.problemLatex, "\\int_0^1 x\u0005,dx");
  assert.equal(recovered.steps[0].latex, "\\frac{1}{2}");
  assert.equal(recovered.title, candidate.title);
  assert.equal(recovered.steps[0].reasoning, candidate.steps[0].reasoning);

  const asserted = assertCompactSolveResponse(candidate);
  assert.equal(asserted.problemLatex, "\\int_0^1 x,dx");
  assert.equal(asserted.finalAnswerLatex, "\\frac{1}{2}");
  assert.equal(validateGeneratedLatex(asserted.finalAnswerLatex).valid, true);
});

test("literal escape text and missing-backslash commands remain diagnostic-only", () => {
  for (const latex of ["\\u0005frac{1}{2}", "frac{1}{2}"]) {
    const parsed = assertCompactSolveResponse(compactCandidate(latex));
    assert.equal(typeof parsed.finalAnswerLatex, "string");
    assert.ok(parsed.finalAnswerLatex.length > 0);
  }
});

test("repaired Terra compact expression is still rejected by numerical validation", () => {
  const problem = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";
  const finalAnswerLatex = "\\frac{\\pi^2}{24}+\\frac{\\pi}{2}G-\\frac74\\zeta(3)";
  const corruptedFinalAnswerLatex = finalAnswerLatex.replace(/\\/gu, "\u0005");
  const repaired = assertCompactSolveResponse({
    title: "Terra compact fixture",
    problemLatex: problem,
    steps: [{
      id: "final",
      heading: "Final Answer",
      latex: corruptedFinalAnswerLatex,
      reasoning: "State the proposed symbolic answer.",
      anchors: [],
    }],
  });
  assert.equal(repaired.finalAnswerLatex, finalAnswerLatex);

  const result = {
    ...repaired,
    expression: problem,
    numericCheck: "0.7546930417050932",
  };

  const numerical = numericalFinalAnswerCheck(problem, result);
  assert.equal(numerical.applicable, true);
  assert.equal(numerical.issue, "numerical_final_answer_mismatch");
  assert.ok(Math.abs(numerical.proposedValue - (-0.2535706730131524)) < 1e-12);
  assert.ok(Math.abs(numerical.numericalEstimate - 0.7546930417050932) < 1e-5);

  const quality = evaluateSolutionQualityRules(result, { problem });
  assert.equal(quality.issues.includes("numerical_final_answer_mismatch"), true);
});
