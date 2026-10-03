import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import {
  createImageProblemExtraction,
  estimateImageExtractionReservation,
  getImageExtractionMaxOutputTokens,
} from "../server/openai.js";
import {
  denseMultilineImageExtraction,
  malformedCompleteImageExtractionJson,
  nearBudgetImageExtraction,
  schemaInvalidImageExtractionJson,
  shortImageExtraction,
  truncatedImageExtractionJson,
} from "./fixtures/phase4ExtractionProvider.mjs";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INFO = console.info;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;

function restoreEnvironment() {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.info = ORIGINAL_INFO;
  console.warn = ORIGINAL_WARN;
  console.error = ORIGINAL_ERROR;
}

afterEach(restoreEnvironment);

function extractionJson(overrides = {}) {
  return JSON.stringify({
    ...shortImageExtraction,
    ...overrides,
  });
}

function configureOfflineExtraction() {
  process.env.NODE_ENV = "test";
  process.env.OPENAI_API_KEY = "offline-phase4-fixture";
  process.env.OPENAI_RETRY_BASE_DELAY_MS = "0";
  delete process.env.OPENAI_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS;
  delete process.env.OMNIMATH_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS;
  delete process.env.OMNIMATH_IMAGE_EXTRACTION_COMPACT_MAX_OUTPUT_TOKENS;
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
}

function providerResponse({
  outputText = extractionJson(),
  status = "completed",
  incompleteReason = null,
  outputTokens = 140,
  model = "gpt-4.1",
} = {}) {
  return new Response(JSON.stringify({
    id: `resp_phase4_${status}`,
    status,
    model,
    output_text: outputText,
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    usage: {
      input_tokens: 450,
      output_tokens: outputTokens,
      total_tokens: 450 + outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function providerHttpError(status = 500, code = "server_error") {
  return new Response(JSON.stringify({
    error: { type: code, code, message: `Provider HTTP ${status}` },
  }), { status, statusText: "Provider error", headers: { "content-type": "application/json" } });
}

function imageFixture() {
  return {
    filename: "quadratic.png",
    contentType: "image/png",
    buffer: Buffer.from("phase-4-image-fixture"),
  };
}

function captureProviderCalls(responses) {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    const response = responses[Math.min(payloads.length - 1, responses.length - 1)];
    return typeof response === "function" ? response(payloads.at(-1)) : response;
  };
  return payloads;
}

describe("Phase 4 image extraction provider contract", () => {
  it("sends the extraction-specific configured budget and logs the same effective provider value", async () => {
    configureOfflineExtraction();
    process.env.OPENAI_MAX_OUTPUT_TOKENS = "8000";

    const requestLogs = [];
    const modelLogs = [];
    console.info = (...args) => {
      if (args[0] === "[omnimath:openai-request]") requestLogs.push(args[1]);
      if (args[0] === "[omnimath:openai-model]") modelLogs.push(args[1]);
    };
    const payloads = captureProviderCalls([providerResponse()]);

    await createImageProblemExtraction({
      prompt: "Extract the attached problem.",
      image: imageFixture(),
      debugContext: { requestId: "ingest-token-regression" },
    });

    const configuredBudget = getImageExtractionMaxOutputTokens();
    const expectedExtractionBudget = 3200;
    assert.equal(payloads.length, 1);
    assert.equal(
      payloads[0].max_output_tokens,
      expectedExtractionBudget,
      `historical mismatch: generic request log=${requestLogs[0]?.maxOutputTokens}, extraction config=${configuredBudget}, provider payload=${payloads[0].max_output_tokens}`,
    );
    assert.equal(configuredBudget, expectedExtractionBudget);
    assert.equal(requestLogs[0]?.configuredMaxOutputTokens, configuredBudget);
    assert.equal(requestLogs[0]?.effectiveMaxOutputTokens, configuredBudget);
    assert.equal(requestLogs[0]?.providerPayloadMaxOutputTokens, configuredBudget);
    assert.equal(modelLogs[0]?.maxOutputTokenCapability, 6500);
    assert.equal(Object.hasOwn(modelLogs[0] || {}, "maxOutputTokens"), false);
  });

  it("honors the preferred extraction env and reports a model-capability clamp truthfully", async () => {
    configureOfflineExtraction();
    process.env.OMNIMATH_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS = "9000";
    const requestLogs = [];
    console.info = (...args) => {
      if (args[0] === "[omnimath:openai-request]") requestLogs.push(args[1]);
    };
    const payloads = captureProviderCalls([providerResponse()]);

    await createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() });

    assert.equal(payloads[0].max_output_tokens, 6500);
    assert.equal(requestLogs[0].configuredMaxOutputTokens, 9000);
    assert.equal(requestLogs[0].effectiveMaxOutputTokens, 6500);
    assert.equal(requestLogs[0].providerPayloadMaxOutputTokens, 6500);
    assert.equal(requestLogs[0].maxOutputTokensConfigStatus, "configured_capability_clamped");
  });

  it("reserves for the bounded full plus compact extraction policy using the extraction model", () => {
    configureOfflineExtraction();
    process.env.OPENAI_IMAGE_TOKEN_ESTIMATE = "1700";
    process.env.OMNIMATH_MODEL_GPT_4_1_INPUT_COST_PER_1M = "4";
    process.env.OMNIMATH_MODEL_GPT_4_1_OUTPUT_COST_PER_1M = "20";

    const budget = estimateImageExtractionReservation({
      prompt: "Extract the complete attached problem.",
      image: imageFixture(),
    });

    assert.equal(budget.model, "gpt-4.1");
    assert.equal(budget.estimatedOutputTokens, 5200);
    assert.equal(budget.semanticGenerationLimit, 2);
    assert.equal(budget.providerHttpAttemptLimit, 4);
    assert.equal(budget.estimatedInputTokens > 3400, true);
    assert.equal(budget.estimatedTokens, budget.estimatedInputTokens + 5200);
    assert.equal(Number.isFinite(budget.estimatedCostUsd), true);
  });

  it("accepts short, dense multiline, and near-budget complete extraction fixtures", async () => {
    configureOfflineExtraction();
    for (const [fixture, outputTokens] of [
      [shortImageExtraction, 120],
      [denseMultilineImageExtraction, 1700],
      [nearBudgetImageExtraction, 3199],
    ]) {
      const payloads = captureProviderCalls([providerResponse({
        outputText: JSON.stringify(fixture),
        outputTokens,
      })]);
      const result = await createImageProblemExtraction({
        prompt: "Extract dense math.",
        image: imageFixture(),
      });
      assert.equal(result.extractedProblemLatex, fixture.extractedProblemLatex);
      assert.equal(payloads.length, 1);
      assert.equal(result._aiCallCount, 1);
    }
  });

  it("uses one materially smaller compact contract only after explicit max-output truncation", async () => {
    configureOfflineExtraction();
    const retryLogs = [];
    const requestLogs = [];
    console.info = (...args) => {
      if (args[0] === "[omnimath:openai-request]") requestLogs.push(args[1]);
    };
    console.warn = (...args) => {
      if (args[0] === "[omnimath:image-extraction-retry]") retryLogs.push(args[1]);
    };
    const payloads = captureProviderCalls([
      providerResponse({
        outputText: truncatedImageExtractionJson,
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        outputTokens: 3200,
      }),
      providerResponse({
        outputText: JSON.stringify({
          extractedProblemLatex: "\\int_0^1 x^2\\,dx",
          confidence: 92,
          issues: [],
        }),
        outputTokens: 95,
      }),
    ]);

    const result = await createImageProblemExtraction({
      prompt: "Extract the integral.",
      image: imageFixture(),
      debugContext: {
        requestId: "ingest-truncation-recovery",
        imageHash: "safe-image-hash",
        extractionAttemptId: "extract-attempt-1",
      },
    });

    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads.map((payload) => payload.text.format.name), [
      "math_image_extract",
      "math_image_extract_compact",
    ]);
    assert.deepEqual(payloads.map((payload) => payload.max_output_tokens), [3200, 2000]);
    assert.deepEqual(requestLogs.map((entry) => entry.extractionAttemptId), [
      "extract-attempt-1",
      "extract-attempt-1:compact",
    ]);
    assert.deepEqual(requestLogs.map((entry) => entry.logicalImageIngestionRequestId), [
      "ingest-truncation-recovery",
      "ingest-truncation-recovery",
    ]);
    assert.deepEqual(requestLogs.map((entry) => entry.imageHash), [
      "safe-image-hash",
      "safe-image-hash",
    ]);
    assert.deepEqual(Object.keys(payloads[1].text.format.schema.properties), [
      "extractedProblemLatex",
      "confidence",
      "issues",
    ]);
    assert.match(payloads[1].input[0].content[0].text, /complete problem exactly once/i);
    assert.equal(result.extractedProblemLatex, "\\int_0^1 x^2\\,dx");
    assert.equal(result.extractedProblemText, result.extractedProblemLatex);
    assert.equal(result.issues.at(-1).type, "compact_extraction_recovery");
    assert.equal(result._aiUsage.output_tokens, 3295);
    assert.equal(result._aiCallCount, 2);
    const diagnosticMessages = result._omniOpenAiDiagnostics?.modelInputMessages || [];
    const diagnosticJson = JSON.stringify(diagnosticMessages);
    assert.doesNotMatch(diagnosticJson, /data:image\//u);
    assert.equal(diagnosticMessages[0].content[1].imageUrlChars > 0, true);
    assert.equal(typeof diagnosticMessages[0].content[1].imageUrlHash, "string");
    assert.equal(retryLogs.length, 1);
    assert.equal(retryLogs[0].retryReason, "provider_max_output_tokens");
    assert.equal(retryLogs[0].imageHash, "safe-image-hash");
    assert.equal(retryLogs[0].extractionAttemptId, "extract-attempt-1:compact");
  });

  it("keeps the worst case at two semantic generations and four HTTP provider attempts", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([
      providerHttpError(500),
      providerResponse({
        outputText: truncatedImageExtractionJson,
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        outputTokens: 3200,
      }),
      providerHttpError(500),
      providerResponse({
        outputText: JSON.stringify({
          extractedProblemLatex: "x=1",
          confidence: 99,
          issues: [],
        }),
        outputTokens: 40,
      }),
    ]);

    const result = await createImageProblemExtraction({
      prompt: "Extract.",
      image: imageFixture(),
    });

    assert.equal(payloads.length, 4);
    assert.deepEqual(payloads.map((payload) => payload.text.format.name), [
      "math_image_extract",
      "math_image_extract",
      "math_image_extract_compact",
      "math_image_extract_compact",
    ]);
    assert.equal(result._aiCallCount, 4);
    assert.equal(result._aiUsage.output_tokens, 3240);
  });

  it("preserves both generations' usage when compact extraction also fails", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([
      providerResponse({
        outputText: truncatedImageExtractionJson,
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        outputTokens: 3200,
      }),
      providerResponse({
        outputText: '{"extractedProblemLatex":}',
        outputTokens: 25,
      }),
    ]);

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "json_parse"
        && error._aiCallCount === 2
        && error._aiUsage.output_tokens === 3225,
    );
    assert.equal(payloads.length, 2);
  });

  it("does not compact-retry malformed complete JSON", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([providerResponse({
      outputText: malformedCompleteImageExtractionJson,
    })]);

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "json_parse"
        && error._aiCallCount === 1,
    );
    assert.equal(payloads.length, 1);
  });

  it("rejects extraction JSON with leading, trailing, or a second envelope while ordinary parsing remains unchanged", async () => {
    configureOfflineExtraction();
    const valid = extractionJson();
    for (const outputText of [
      `provider preface\n${valid}`,
      `${valid}\nprovider suffix`,
      `${valid}${valid}`,
    ]) {
      const payloads = captureProviderCalls([providerResponse({ outputText })]);
      await assert.rejects(
        createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
        (error) => error.code === "AI_RESPONSE_INVALID"
          && error.responseFailureType === "json_parse"
          && error._omniOpenAiDiagnostics?.strictJsonEnvelope === true
          && error._aiCallCount === 1,
      );
      assert.equal(payloads.length, 1);
    }
  });

  it("classifies unbalanced JSON from a completed extraction response as JSON parse failure", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([providerResponse({
      outputText: truncatedImageExtractionJson,
      status: "completed",
      incompleteReason: null,
      outputTokens: 210,
    })]);

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "json_parse"
        && error._aiCallCount === 1,
    );
    assert.equal(payloads.length, 1);
  });

  it("does not compact-retry a complete response that violates the extraction schema", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([providerResponse({
      outputText: schemaInvalidImageExtractionJson,
    })]);

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "schema_contract"
        && error._aiCallCount === 1,
    );
    assert.equal(payloads.length, 1);
  });

  it("rejects complete extraction objects before coercion when their strict shape is invalid", async () => {
    configureOfflineExtraction();
    const valid = { ...shortImageExtraction };
    const nineIssues = Array.from({ length: 9 }, (_, index) => ({
      type: `issue_${index}`,
      message: `Issue ${index}`,
      severity: "low",
    }));
    const invalidObjects = [
      { ...valid, confidence: "96" },
      { ...valid, confidence: null },
      { ...valid, confidence: -1 },
      { ...valid, confidence: 101 },
      { ...valid, unexpected: true },
      { extractedProblemLatex: valid.extractedProblemLatex, extractedProblemText: valid.extractedProblemText, issues: [] },
      { ...valid, extractedProblemLatex: 42 },
      { ...valid, extractedProblemText: { text: "Solve" } },
      { ...valid, issues: null },
      { ...valid, issues: nineIssues },
      { ...valid, issues: [{ type: "blur", message: "Blurred", severity: "urgent" }] },
      { ...valid, issues: [{ type: "blur", message: "Blurred", severity: "low", extra: true }] },
      { ...valid, issues: [{ type: 7, message: "Blurred", severity: "low" }] },
      { ...valid, issues: [{ type: "blur", severity: "low" }] },
    ];

    for (const invalid of invalidObjects) {
      const payloads = captureProviderCalls([providerResponse({ outputText: JSON.stringify(invalid) })]);
      await assert.rejects(
        createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
        (error) => error.code === "AI_RESPONSE_INVALID"
          && error.responseFailureType === "schema_contract"
          && error._aiCallCount === 1,
      );
      assert.equal(payloads.length, 1);
    }
  });

  it("does not retry explicit truncation when the extraction-stage deadline has no meaningful room", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([providerResponse({
      outputText: truncatedImageExtractionJson,
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      outputTokens: 3200,
    })]);

    await assert.rejects(
      createImageProblemExtraction({
        prompt: "Extract.",
        image: imageFixture(),
        deadlineAt: Date.now() + 1000,
      }),
      (error) => error.code === "AI_RESPONSE_TRUNCATED"
        && error.retrySuppressedReason === "insufficient_remaining_extraction_budget"
        && error._aiCallCount === 1,
    );
    assert.equal(payloads.length, 1);
  });

  it("keeps provider refusal terminal and distinct from unreadable-image/schema failures", async () => {
    configureOfflineExtraction();
    const refusal = new Response(JSON.stringify({
      id: "resp_phase4_refusal",
      status: "completed",
      model: "gpt-4.1",
      output: [{
        type: "message",
        status: "completed",
        content: [{ type: "refusal", refusal: "Cannot process this image." }],
      }],
      usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const payloads = captureProviderCalls([refusal]);

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_REQUEST_REFUSED"
        && error.responseFailureType === "refusal"
        && error._aiCallCount === 1,
    );
    assert.equal(payloads.length, 1);
  });

  it("classifies an explicit unreadable image separately from blank schema-invalid extraction", async () => {
    configureOfflineExtraction();
    const unreadable = JSON.stringify({
      extractedProblemLatex: "",
      extractedProblemText: "",
      confidence: 0,
      issues: [{
        type: "image_unreadable",
        message: "The photographed page is fully blurred.",
        severity: "high",
      }],
    });
    const unreadablePayloads = captureProviderCalls([providerResponse({ outputText: unreadable })]);
    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "OCR_IMAGE_UNREADABLE"
        && error.responseFailureType === "unreadable_image"
        && error.compactRetryable === false
        && error._aiCallCount === 1,
    );
    assert.equal(unreadablePayloads.length, 1);

    const blankPayloads = captureProviderCalls([providerResponse({
      outputText: JSON.stringify({
        extractedProblemLatex: "",
        extractedProblemText: "",
        confidence: 0,
        issues: [],
      }),
    })]);
    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_RESPONSE_INVALID"
        && error.responseFailureType === "schema_contract"
        && error._aiCallCount === 1,
    );
    assert.equal(blankPayloads.length, 1);
  });

  it("rejects inconsistent unreadable markers as schema failures", async () => {
    configureOfflineExtraction();
    const marker = {
      type: "image_unreadable",
      message: "The page is blurred.",
      severity: "high",
    };
    const inconsistent = [
      { extractedProblemLatex: "x=1", extractedProblemText: "Solve x equals one.", confidence: 0, issues: [marker] },
      { extractedProblemLatex: "", extractedProblemText: "", confidence: 1, issues: [marker] },
      { extractedProblemLatex: "", extractedProblemText: "", confidence: 0, issues: [{ ...marker, severity: "low" }] },
      { extractedProblemLatex: "", extractedProblemText: "", confidence: 0, issues: [marker, {
        type: "blur", message: "Also blurred.", severity: "high",
      }] },
    ];

    for (const invalid of inconsistent) {
      const payloads = captureProviderCalls([providerResponse({ outputText: JSON.stringify(invalid) })]);
      await assert.rejects(
        createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
        (error) => error.code === "AI_RESPONSE_INVALID"
          && error.responseFailureType === "schema_contract"
          && error._aiCallCount === 1,
      );
      assert.equal(payloads.length, 1);
    }
  });

  it("preserves explicit unreadable classification when the compact recovery is the terminal response", async () => {
    configureOfflineExtraction();
    const payloads = captureProviderCalls([
      providerResponse({
        outputText: truncatedImageExtractionJson,
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        outputTokens: 3200,
      }),
      providerResponse({
        outputText: JSON.stringify({
          extractedProblemLatex: "",
          confidence: 0,
          issues: [{
            type: "image_unreadable",
            message: "The cropped region is fully blurred.",
            severity: "high",
          }],
        }),
        outputTokens: 45,
      }),
    ]);

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "OCR_IMAGE_UNREADABLE"
        && error.responseFailureType === "unreadable_image"
        && error._aiCallCount === 2
        && error._aiUsage.output_tokens === 3245,
    );
    assert.equal(payloads.length, 2);
  });

  it("classifies an extraction provider timeout explicitly", async () => {
    configureOfflineExtraction();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };

    await assert.rejects(
      createImageProblemExtraction({ prompt: "Extract.", image: imageFixture() }),
      (error) => error.code === "AI_REQUEST_TIMEOUT"
        && error.responseFailureType === "provider_timeout"
        && /timed out/i.test(error.publicMessage),
    );
    assert.equal(calls, 1, "request timeouts are terminal and do not start a transport retry");
  });
});

export { captureProviderCalls, extractionJson, imageFixture, providerResponse };
