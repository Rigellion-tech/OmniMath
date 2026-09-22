import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import { createMathExplanation } from "../server/openai.js";
import { resolveInitialSolveRouting } from "../server/app.js";

function providerBody(outputText) {
  return new Response(JSON.stringify({
    id: "resp_canonical_policy_fixture",
    status: "completed",
    model: "gpt-5.6-sol",
    output_text: outputText,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function validSolve(problemLatex = "x+7=9") {
  return JSON.stringify({
    title: "Solve equation",
    problemLatex,
    steps: [
      { id: "subtract", heading: "Subtract seven", latex: "x=9-7", reasoning: "Subtract seven from both sides.", anchors: [] },
      { id: "answer", heading: "Final answer", latex: "x=2", reasoning: "Simplify.", anchors: [] },
    ],
    finalAnswerLatex: "x=2",
    numericCheck: "",
  });
}

function recorder() {
  return {
    statusCode: null,
    body: "",
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(chunk = "") { this.body += chunk; },
  };
}

function signedSession() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "canonical-model-policy" })}.${encode({
    sub: "user_canonical_model_policy", sid: "sess_canonical_model_policy",
    iss: "https://offline-test.clerk.accounts.dev", iat: now, nbf: now - 1, exp: now + 300,
  })}`;
  return {
    jwtKey: publicKey.export({ type: "spki", format: "pem" }),
    token: `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`,
  };
}

it("sends Sol in actual canonical solve and compact provider payloads despite solver overrides", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const summaryModels = [];
  const selections = [];
  const ocrReviews = [];
  console.info = (...args) => {
    if (args[0] === "[omnimath:ai-request]") summaryModels.push(args[1].model);
    if (args[0] === "[omnimath:openai-model]") selections.push(args[1]);
    if (args[0] === "[omnimath:ocr-review]") ocrReviews.push(args[1]);
  };
  const storeDir = join(tmpdir(), `omnimath-canonical-model-${Date.now()}-${Math.random()}`);
  await mkdir(storeDir, { recursive: true });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    process.env = originalEnv;
    await rm(storeDir, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    NODE_ENV: "test",
    OPENAI_API_KEY: "offline-canonical-model-fixture",
    OMNIMATH_SOLVER_MODEL: "gpt-5.6-luna",
    OPENAI_SOLVER_MODEL: "gpt-5.6-terra",
    OMNIMATH_REPAIR_MODEL: "gpt-5.6-terra",
    USAGE_LOCAL_STORE_PATH: join(storeDir, "usage.json"),
  });
  const session = signedSession();
  delete process.env.CLERK_SECRET_KEY;
  process.env.CLERK_JWT_KEY = session.jwtKey;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  const payloads = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    payloads.push(JSON.parse(options.body));
    return providerBody(validSolve());
  };
  const { handleExplainRequest, handleSolveExtractedProblemRequest, handleExplainImageRequest } = await import(`../server/app.js?canonical-model-${Date.now()}-${Math.random()}`);
  const req = (url, body, address) => ({
    method: "POST", url, headers: { "content-type": "application/json", host: "localhost:8787", authorization: `Bearer ${session.token}` },
    socket: { remoteAddress: address }, body,
  });
  const typed = recorder();
  await handleExplainRequest(req("/api/explain", { problem: "x+7=9", debugRequestId: "canonical-typed-model" }, "127.9.0.1"), typed);
  assert.equal(typed.statusCode, 200, typed.body);
  assert.equal(payloads.length, 1);
  assert.equal(payloads.at(-1).model, "gpt-5.6-sol");
  assert.equal(summaryModels.at(-1), "gpt-5.6-sol");

  const composer = recorder();
  await handleExplainRequest(req("/api/explain", {
    problemInput: { problemText: "x+7=9", source: "typed" },
    canonicalProblem: { canonicalText: "x+7=9", canonicalLatex: "x+7=9", source: "typed" },
    reference: "separate-composer-cache-entry", debugRequestId: "canonical-composer-model",
  }, "127.9.0.3"), composer);
  assert.equal(composer.statusCode, 200, composer.body);
  assert.equal(payloads.length, 2);
  assert.equal(payloads.at(-1).model, "gpt-5.6-sol");
  assert.equal(summaryModels.at(-1), "gpt-5.6-sol");

  const ocr = recorder();
  await handleSolveExtractedProblemRequest(req("/api/solve-extracted-problem", {
    problem: "x+7=9", extraction: { confidence: 91, ocrConfidence: 91, mathIntegrityScore: 91, confidenceTier: "high", issues: [] },
    solveDecision: "direct",
    reference: "separate-ocr-cache-entry", debugRequestId: "canonical-ocr-model",
  }, "127.9.0.2"), ocr);
  assert.equal(ocr.statusCode, 200, ocr.body);
  assert.equal(payloads.length, 3);
  assert.equal(payloads.at(-1).model, "gpt-5.6-sol");
  assert.equal(summaryModels.at(-1), "gpt-5.6-sol");
  for (const selection of selections.filter((item) => item.path === "canonicalSolve")) {
    assert.equal(selection.role, "solver");
    assert.equal(selection.model, "gpt-5.6-sol");
    assert.equal(selection.modelSource, "canonical_solve_policy");
    assert.equal(selection.reasoningEffort, "medium");
    assert.equal(selection.solveMode, "initial");
  }

  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return providerBody(payload.text.format.name === "math_image_extract"
      ? JSON.stringify({ extractedProblemLatex: "x+8=10", extractedProblemText: "x + 8 = 10", confidence: 100, issues: [] })
      : validSolve("x+8=10"));
  };
  const boundary = "canonical-model-boundary";
  const gif = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.gif"\r\nContent-Type: image/gif\r\n\r\n`),
    gif,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const legacy = recorder();
  await handleExplainImageRequest({
    method: "POST", url: "/api/explain-image",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, host: "localhost:8787", authorization: `Bearer ${session.token}` },
    socket: { remoteAddress: "127.9.0.4" }, body: multipart,
  }, legacy);
  assert.equal(legacy.statusCode, 200, `${legacy.body}\n${JSON.stringify(ocrReviews)}`);
  assert.equal(payloads.length, 5);
  assert.deepEqual(payloads.slice(3).map((payload) => [payload.text.format.name, payload.model]), [
    ["math_image_extract", "gpt-4.1"], ["math_fast_solve", "gpt-5.6-sol"],
  ]);
  assert.equal(summaryModels.at(-1), "gpt-5.6-sol");

  payloads.length = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    payloads.push(JSON.parse(options.body));
    return providerBody(payloads.length === 1 ? '{"title":}' : JSON.stringify({
      title: "Compact solve", problemLatex: "x+7=9",
      steps: [{ id: "answer", heading: "Final answer", latex: "x=2", reasoning: "Subtract seven.", anchors: [] }],
    }));
  };
  await createMathExplanation({ prompt: "Solve x+7=9", originalProblem: "x+7=9", modelPath: "canonicalSolve" });
  assert.deepEqual(payloads.map((payload) => payload.model), ["gpt-5.6-sol", "gpt-5.6-sol"]);
  assert.deepEqual(payloads.map((payload) => payload.text.format.name), ["math_fast_solve", "math_compact_solve"]);
  assert.equal(resolveInitialSolveRouting({ problem: "x+7=9" }).selectedInitialModel, "gpt-5.6-sol");
});
