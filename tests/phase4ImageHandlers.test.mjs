import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import "./helpers/noExternalNetwork.mjs";
import { buildExtractionSubmissionPayload } from "../src/api/mathClient.js";
import { createCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";
import { IMAGE_SLOT_CAS_SCRIPT } from "../server/imageIngestionRegistry.js";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
let sequence = 0;
function session(userId) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "phase4-handlers" })}.${encode({ sub: userId, sid: `session-${userId}`,
    iss: "https://offline-test.clerk.accounts.dev", iat: now, nbf: now - 1, exp: now + 300 })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keyPair.privateKey).toString("base64url")}`;
}
function recorder() {
  return {
    statusCode: null, headers: {}, body: "", headersSent: false, writableEnded: false,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
    json() { return JSON.parse(this.body || "{}"); },
  };
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function providerResponse(output, { status = "completed", reason = null, outputTokens = 100, inputTokens = 50 } = {}) {
  return jsonResponse({ id: `response-${++sequence}`, model: "fixture-provider", status,
    ...(reason ? { incomplete_details: { reason } } : {}),
    output_text: typeof output === "string" ? output : JSON.stringify(output),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
}
const extractionResponse = (text = "x+7 = 9", extra = {}) => providerResponse({ extractedProblemText: text, extractedProblemLatex: text, confidence: 96, issues: [], ...extra });
const solveResponse = (problem = "x+7 = 9", final = "x=2") => providerResponse({ title: "Solve equation", problemLatex: problem, finalAnswerLatex: final, numericCheck: "",
  steps: [{ id: "subtract", heading: "Subtract seven", latex: final, reasoning: "Subtract seven from both sides.", anchors: [] }] });

async function fixture(t) {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  for (const key of Object.keys(process.env)) if (/^(?:OPENAI_|OMNIMATH_|CLERK_|DATABASE_|POSTGRES_|USAGE_|KV_|UPSTASH_|AI_)/u.test(key)) delete process.env[key];
  const userId = `user_phase4_handlers_${++sequence}`;
  const token = session(userId);
  const clientIp = `127.64.0.${sequence}`;
  Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", OPENAI_API_KEY: "offline-phase4-fixture", OPENAI_RETRY_BASE_DELAY_MS: "0",
    CLERK_JWT_KEY: keyPair.publicKey.export({ type: "spki", format: "pem" }), CLERK_SECRET_KEY: "", DATABASE_URL: "", POSTGRES_URL: "",
    USAGE_KV_REST_API_URL: "https://phase4-kv.invalid", USAGE_KV_REST_API_TOKEN: "offline-phase4-fixture",
    OMNIMATH_IMAGE_EXTRACTION_MODEL: "gpt-4.1", OMNIMATH_SOLVER_MODEL: "gpt-5.6-sol", OMNIMATH_REPAIR_MODEL: "gpt-5.6-sol",
    OMNIMATH_ESCALATION_MODEL: "gpt-5.6-sol", OMNIMATH_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS: "3200", OMNIMATH_IMAGE_EXTRACTION_COMPACT_MAX_OUTPUT_TOKENS: "2000" });
  const events = [];
  for (const method of ["info", "warn", "error"]) t.mock.method(console, method, (...args) => events.push(args));
  const kv = new Map();
  const commands = [];
  const calls = [];
  let rejectSettlement = false;
  let provider = (payload) => payload.text.format.name.startsWith("math_image_extract") ? extractionResponse() : solveResponse();
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://phase4-kv.invalid/get/")) return jsonResponse({ result: kv.get(decodeURIComponent(target.split("/get/")[1])) || 0 });
    if (target === "https://phase4-kv.invalid/pipeline") {
      return jsonResponse(JSON.parse(options.body).map((command) => {
        commands.push(command);
        const [verb, key, count] = command;
        if (verb === "GET") return { result: kv.get(key) ?? null };
        if (verb === "EVAL") {
          assert.equal(key, IMAGE_SLOT_CAS_SCRIPT, "shared-state script is the reviewed atomic CAS contract");
          const [, , keyCount, slot, expected, next, ttl] = command;
          assert.equal(keyCount, "1");
          assert.equal(ttl, "1800000");
          if ((kv.get(slot) || "") !== expected) return { result: 0 };
          kv.set(slot, next);
          return { result: 1 };
        }
        if (verb === "INCRBY" || verb === "DECRBY") kv.set(key, (kv.get(key) || 0) + (verb === "INCRBY" ? Number(count) : -Number(count)));
        else assert.equal(verb, "EXPIRE", "fixture must implement every store command");
        if (rejectSettlement && verb === "DECRBY") { rejectSettlement = false; return { error: "fixture partial settlement failure" }; }
        return { result: verb === "EXPIRE" ? 1 : kv.get(key) || 0 };
      }));
    }
    assert.equal(target, "https://api.openai.com/v1/responses", "tests never reach a real provider");
    const payload = JSON.parse(options.body);
    calls.push(payload);
    return provider(payload, options);
  });
  const app = await import(`../server/app.js?phase4-handlers-${sequence}`);
  const invoke = async (handler, body, { contentType = "application/json", requestToken = token } = {}) => {
    const req = { method: "POST", url: "/api/phase4-fixture", headers: { host: "localhost:8787", "content-type": contentType, authorization: `Bearer ${requestToken}` },
      socket: { remoteAddress: clientIp }, body };
    const res = recorder();
    await handler(req, res);
    return res;
  };
  const uploadIdentity = (patch = {}) => ({ ingestionScopeId: `scope-${userId}`, uploadId: `upload-${userId}`, uploadRevision: 1, ingestionRequestId: `ingestion-${userId}`, ...patch });
  const png = Buffer.from("89504e470d0a1a0a000000000000", "hex");
  const multipart = (identity, image = png) => {
    const boundary = "phase4-handler-boundary";
    const parts = Object.entries({ prompt: "Extract this mathematics.", ...identity }).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    return { body: Buffer.concat([...parts, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
  };
  const extract = (identity = uploadIdentity(), image) => { const form = multipart(identity, image); return invoke(app.handleExtractImageProblemRequest, form.body, form); };
  const solvePayload = (extraction, { text = extraction.extractedProblemText, decision = "direct", revision = 0, requestId = `solve-${++sequence}` } = {}) => ({
    ...buildExtractionSubmissionPayload({ extraction, displayText: text, rawText: extraction.rawExtractedText, solveDecision: decision,
      reviewRevision: revision, source: decision === "direct" ? "ocr-direct" : "ocr-reviewed" }), debugRequestId: requestId,
  });
  return { app, invoke, extract, solvePayload, uploadIdentity, token, events, kv, commands, calls,
    failNextSettlement: () => { rejectSettlement = true; },
    setProvider: (value) => { provider = value; } };
}

it("actual extraction and canonical solve preserve authenticated identity, provider budgets, and telemetry", async (t) => {
  const f = await fixture(t);
  const extraction = await f.extract();
  assert.equal(extraction.statusCode, 200, extraction.body);
  const selected = extraction.json();
  assert.equal(selected.ingestion.state, "ready");
  const solved = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(selected, { requestId: "phase4-continuity-solve" }));
  assert.equal(solved.statusCode, 200, solved.body);
  assert.deepEqual(f.calls.map((call) => [call.text.format.name, call.max_output_tokens]), [["math_image_extract", 3200], ["math_fast_solve", 6500]]);
  const body = solved.json();
  assert.equal(body.ingestion.state, "solved");
  assert.equal(body.canonicalProblem.canonicalText, selected.extractedProblemText);
  assert.equal(body.imageSource.finalProblemText, selected.extractedProblemText);
  assert.equal(body.ingestion.extractionId, selected.ingestion.extractionId);
  assert.equal(body.ingestion.ingestionRequestId, selected.ingestion.ingestionRequestId);
  const requests = f.events.filter(([name]) => name === "[omnimath:openai-request]").map(([, event]) => event);
  assert.equal(requests[0].configuredMaxOutputTokens, 3200);
  assert.equal(requests[0].effectiveMaxOutputTokens, 3200);
  assert.equal(requests[0].providerPayloadMaxOutputTokens, 3200);
  assert.equal(requests[1].extractionId, selected.ingestion.extractionId);
  assert.equal(requests[1].reviewRevisionId, body.ingestion.reviewRevisionId);
  assert.equal(requests[1].canonicalProblemId, body.canonicalProblemId);
  assert.equal(requests[1].canonicalSolveRequestId, "phase4-continuity-solve");
  const lifecycle = f.events.filter(([name]) => name === "[omnimath:image-ingestion]").map(([, event]) => event);
  for (const name of ["extraction_started", "extraction_completed", "canonical_solve_started", "canonical_solve_completed"]) {
    const event = lifecycle.find((item) => item.event === name);
    assert.equal(event.imageHash, selected.ingestion.imageHash, name);
    assert.equal(event.extractionId, selected.ingestion.extractionId, name);
    assert.equal(event.ingestionRequestId, selected.ingestion.ingestionRequestId, name);
  }
  assert.equal(lifecycle.find((event) => event.event === "canonical_solve_started").canonicalProblemId, body.canonicalProblemId);
  assert.equal(JSON.stringify(f.events).includes("data:image"), false);
  assert.equal(selected.usage.settlement.providerCalls, 1);
  assert.equal(body.usage.settlement.providerCalls, 1);
});

it("concurrent duplicate extraction submissions join one paid call and one reservation", async (t) => {
  const f = await fixture(t);
  let release, started;
  const waiting = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  f.setProvider(async () => { started(); await waiting; return extractionResponse(); });
  const first = f.extract();
  await Promise.race([entered, first.then((result) => { throw new Error(`Provider was not entered: ${result.statusCode} ${result.body}`); })]);
  const second = f.extract();
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((res) => res.statusCode), [200, 200]);
  assert.equal(f.calls.length, 1);
  assert.equal(results[0].json().extractionReceipt, results[1].json().extractionReceipt);
  assert.equal(results[0].json().usage.count, results[1].json().usage.count);
  const replay = await f.extract();
  assert.equal(replay.statusCode, 200);
  assert.equal(f.calls.length, 1);
});

it("concurrent equivalent reviewed solves join and preserve each submitter's request id", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  let release, started;
  const waiting = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  f.setProvider(async () => { started(); await waiting; return solveResponse(); });
  const first = f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction, { requestId: "solve-first" }));
  await Promise.race([entered, first.then((result) => { throw new Error(`Provider was not entered: ${result.statusCode} ${result.body}`); })]);
  const second = f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction, { requestId: "solve-second" }));
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.statusCode), [200, 200]);
  assert.deepEqual(results.map((result) => result.json().requestId), ["solve-first", "solve-second"]);
  assert.equal(f.calls.length, 2, "one extraction plus one canonical solve");
  const replay = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction));
  assert.equal(replay.statusCode, 200);
  assert.equal(f.calls.length, 2);
});

it("edited reviewed B is exactly the canonical prompt after extraction A, with no stale LaTeX", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  const edited = "Solve x+7=10.";
  f.setProvider(() => solveResponse(edited, "x=3"));
  const payload = f.solvePayload(extraction, { text: edited, decision: "edited", revision: 4 });
  assert.equal(payload.canonicalProblem.canonicalLatex, "");
  const solved = await f.invoke(f.app.handleSolveExtractedProblemRequest, payload);
  assert.equal(solved.statusCode, 200, solved.body);
  assert.equal(solved.json().canonicalProblem.canonicalText, edited);
  assert.equal(solved.json().imageSource.finalProblemText, edited);
  assert.equal(solved.json().reviewAction.extractionId, extraction.ingestion.extractionId);
  assert.ok(f.calls[1].input[0].content[0].text.includes(edited));
  assert.equal(solved.json().ingestion.reviewRevision, 4);
});

it("a newer reviewed revision prevents stale or conflicting canonical submissions before provider work", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction));
  f.setProvider(() => solveResponse("x+7=10", "x=3"));
  const newer = f.solvePayload(extraction, { text: "x+7=10", decision: "edited", revision: 1 });
  const solved = await f.invoke(f.app.handleSolveExtractedProblemRequest, newer);
  assert.equal(solved.statusCode, 200, solved.body);
  const stale = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction));
  assert.equal(stale.json().code, "OCR_REVIEW_STALE");
  const conflict = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction, { text: "x+7=11", decision: "edited", revision: 1 }));
  assert.equal(conflict.json().code, "OCR_REVIEW_REVISION_CONFLICT");
  assert.equal(f.calls.length, 3);
});

it("replacement upload C prevents stale extraction A from authorizing C", async (t) => {
  const f = await fixture(t);
  const a = (await f.extract()).json();
  const c = (await f.extract(f.uploadIdentity({ uploadRevision: 2, uploadId: "upload-c", ingestionRequestId: "ingestion-c" }))).json();
  assert.equal(c.ingestion.imageHash, a.ingestion.imageHash, "same image reupload is a distinct action");
  assert.notEqual(c.ingestion.extractionId, a.ingestion.extractionId);
  const stale = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(a));
  assert.equal(stale.json().code, "OCR_EXTRACTION_STALE");
  const crossed = f.solvePayload(c, { decision: "confirmed" });
  crossed.reviewAction.extractionId = a.ingestion.extractionId;
  const rejected = await f.invoke(f.app.handleSolveExtractedProblemRequest, crossed);
  assert.equal(rejected.json().code, "OCR_REVIEW_REQUIRED");
  assert.equal(f.calls.length, 2);
  const correct = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(c));
  assert.equal(correct.statusCode, 200, correct.body);
});

it("distinct images with identical mathematics preserve their own extraction and solution provenance", async (t) => {
  const f = await fixture(t);
  const a = (await f.extract()).json();
  const image = Buffer.from("89504e470d0a1a0a111111111111", "hex");
  const b = (await f.extract(f.uploadIdentity({ ingestionScopeId: "scope-other-image", uploadId: "upload-b", ingestionRequestId: "ingestion-b" }), image)).json();
  assert.equal(a.extractedProblemText, b.extractedProblemText);
  assert.notEqual(a.ingestion.imageHash, b.ingestion.imageHash);
  const [solveA, solveB] = await Promise.all([a, b].map((extraction) => f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction))));
  assert.equal(solveA.statusCode, 200, solveA.body);
  assert.equal(solveB.statusCode, 200, solveB.body);
  assert.equal(solveA.json().imageSource.imageHash, a.ingestion.imageHash);
  assert.equal(solveB.json().imageSource.imageHash, b.ingestion.imageHash);
});

it("canonical field mismatch, forged receipts, and changed unreviewed text fail closed", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  const mismatch = f.solvePayload(extraction); mismatch.problemInput = { problemText: "x+7=10" };
  assert.equal((await f.invoke(f.app.handleSolveExtractedProblemRequest, mismatch)).json().code, "OCR_CANONICAL_INPUT_MISMATCH");
  const changed = f.solvePayload(extraction, { text: "x+7=10", decision: "confirmed" });
  assert.equal((await f.invoke(f.app.handleSolveExtractedProblemRequest, changed)).json().code, "OCR_REVIEW_TEXT_CHANGED");
  const forged = f.solvePayload(extraction); forged.extractionReceipt = "forged";
  assert.equal((await f.invoke(f.app.handleSolveExtractedProblemRequest, forged)).json().code, "OCR_EXTRACTION_STALE");
  const absent = f.solvePayload(extraction); absent.extractionReceipt = null; absent.extraction.extractionReceipt = null;
  assert.equal((await f.invoke(f.app.handleSolveExtractedProblemRequest, absent)).json().code, "OCR_EXTRACTION_RECEIPT_REQUIRED");
  const wrongOwner = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction), { requestToken: session("another_phase4_user") });
  assert.equal(wrongOwner.json().code, "OCR_EXTRACTION_EXPIRED");
  assert.equal(f.calls.length, 1);
});

it("one compact token-truncation recovery requires actual review and settles both calls", async (t) => {
  const f = await fixture(t);
  f.setProvider((payload) => payload.text.format.name === "math_image_extract"
    ? providerResponse('{"extractedProblemLatex":"x+7=', { status: "incomplete", reason: "max_output_tokens", outputTokens: 3200 })
    : providerResponse({ extractedProblemLatex: "x+7=9", confidence: 96, issues: [] }, { outputTokens: 80 }));
  const extracted = await f.extract();
  assert.equal(extracted.statusCode, 200, extracted.body);
  const extraction = extracted.json();
  assert.deepEqual(f.calls.map((call) => call.max_output_tokens), [3200, 2000]);
  assert.equal(extraction.ingestion.state, "review_required");
  assert.equal(extraction.ocrSolveDecision.allowed, false);
  assert.equal(extraction.usage.settlement.providerCalls, 2);
  assert.equal(extraction.usage.settlement.actualOutputTokens, 3280);
  const forgedFindings = f.solvePayload(extraction); forgedFindings.extraction.extractionValidation = { issues: [], critical: false };
  assert.equal((await f.invoke(f.app.handleSolveExtractedProblemRequest, forgedFindings)).json().code, "OCR_REVIEW_REQUIRED");
  f.setProvider(() => solveResponse());
  const reviewed = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction, { decision: "confirmed" }));
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(f.calls.length, 3, "two extraction calls plus one canonical solve");
});

it("billable failed extraction keeps observed usage while a failure before output refunds the reservation", async (t) => {
  const f = await fixture(t);
  f.setProvider(() => providerResponse('{"extractedProblemLatex":}', { outputTokens: 120 }));
  const invalid = await f.extract();
  assert.equal(invalid.statusCode, 502);
  assert.equal(invalid.json().code, "AI_RESPONSE_INVALID");
  assert.equal(invalid.json().failureClassification, "json_parse");
  assert.equal(invalid.json().usage.settlement.providerCalls, 1);
  assert.equal(invalid.json().usage.settlement.actualTotalTokens, 170);
  f.setProvider(() => { throw new DOMException("timeout before output", "TimeoutError"); });
  const timeout = await f.extract(f.uploadIdentity({ uploadRevision: 2, uploadId: "upload-timeout", ingestionRequestId: "ingestion-timeout" }));
  assert.equal(timeout.json().code, "AI_REQUEST_TIMEOUT");
  assert.equal(timeout.json().usage.settlement.providerCalls, 0);
  assert.equal(timeout.json().usage.settlement.actualTotalTokens, 0);
  assert.equal(timeout.json().usage.count, invalid.json().usage.count);
});

it("canonical solve refusal after extraction success retains a truthful separate stage", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  f.setProvider(() => jsonResponse({ id: "refused", status: "completed", usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
    output: [{ type: "message", content: [{ type: "refusal", refusal: "Fixture refusal" }] }] }));
  const solve = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction));
  assert.equal(solve.json().code, "AI_REQUEST_REFUSED");
  assert.equal(solve.json().ingestionStage, "canonical_solve");
  assert.equal(solve.json().extractionSucceeded, true);
  assert.equal(solve.json().ingestion.state, "solve_failed");
  assert.equal(solve.json().usage.settlement.providerCalls, 1);
  assert.equal(f.calls.length, 2);
});

it("typed and authenticated reviewed OCR use equivalent provider input and routing semantics", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  const typedCanonical = createCanonicalProblemPayload({ canonicalText: extraction.extractedProblemText, source: "typed" });
  const typed = await f.invoke(f.app.handleExplainRequest, { problem: extraction.extractedProblemText, canonicalProblem: typedCanonical });
  const reviewed = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction, { decision: "confirmed" }));
  assert.equal(typed.statusCode, 200, typed.body);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.deepEqual(f.calls[1].input, f.calls[2].input);
  assert.deepEqual(f.calls[1].reasoning, f.calls[2].reasoning);
  assert.equal(f.calls[1].model, f.calls[2].model);
  assert.equal(f.calls[1].text.format.name, f.calls[2].text.format.name);
  assert.equal(typed.json().canonicalProblem.canonicalText, reviewed.json().canonicalProblem.canonicalText);
  assert.equal(typed.json().assurance.policy, reviewed.json().assurance.policy);
});

it("expired or unavailable shared lifecycle state never falls back to client findings", async (t) => {
  const f = await fixture(t);
  const extraction = (await f.extract()).json();
  const slot = [...f.kv.keys()].find((key) => key.startsWith("omnimath:ocr:"));
  f.kv.delete(slot);
  const expired = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction));
  assert.equal(expired.json().code, "OCR_EXTRACTION_EXPIRED");
  delete process.env.USAGE_KV_REST_API_URL; delete process.env.USAGE_KV_REST_API_TOKEN;
  const unavailable = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extraction));
  assert.equal(unavailable.json().code, "OCR_LIFECYCLE_UNAVAILABLE");
  assert.equal(f.calls.length, 1);
});

it("extraction finishing just before its deadline leaves a fresh canonical solve budget", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture(t);
  f.setProvider((payload) => {
    if (payload.text.format.name === "math_image_extract") { clock += 59999; return extractionResponse(); }
    return solveResponse();
  });
  const extracted = await f.extract();
  assert.equal(extracted.statusCode, 200, extracted.body);
  const solved = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(extracted.json()));
  assert.equal(solved.statusCode, 200, solved.body);
  const timeouts = f.events.filter(([name]) => name === "[omnimath:openai-timeout]").map(([, event]) => event);
  assert.equal(timeouts[0].configuredRoleTimeoutMs, 60000);
  assert.equal(timeouts[0].effectiveAttemptTimeoutMs, 60000);
  assert.equal(timeouts[1].remainingLogicalBudgetMs, 90000);
  assert.equal(timeouts[1].effectiveAttemptTimeoutMs, 65500);
  assert.equal(timeouts[1].remainingAttemptBudgetMs, 65500);
  assert.equal(timeouts[1].budgetLimitReason, "primary_stage_budget");
});

it("hosted extraction caps a larger configured timeout inside its function envelope", async (t) => {
  const f = await fixture(t);
  process.env.OMNIMATH_OPENAI_IMAGE_EXTRACTION_TIMEOUT_MS = "120000";
  const extracted = await f.extract();
  assert.equal(extracted.statusCode, 200, extracted.body);
  const event = f.events.find(([name, item]) => name === "[omnimath:image-ingestion]" && item.event === "extraction_started")[1];
  assert.equal(event.configuredExtractionTimeoutMs, 120000);
  assert.equal(event.logicalExtractionBudgetMs, 60000);
  const attempt = f.events.find(([name]) => name === "[omnimath:openai-timeout]")[1];
  assert.equal(attempt.configuredRoleTimeoutMs, 120000);
  assert.ok(attempt.effectiveAttemptTimeoutMs <= 60000);
});

it("compact extraction consumes only the remaining logical time and suppresses recovery without meaningful time", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture(t);
  f.setProvider((payload) => {
    if (payload.text.format.name === "math_image_extract") {
      clock += 20000;
      return providerResponse('{"extractedProblemLatex":"x+', { status: "incomplete", reason: "max_output_tokens", outputTokens: 3200 });
    }
    clock += 39999;
    return providerResponse({ extractedProblemLatex: "x+7 = 9", confidence: 96, issues: [] });
  });
  const recovered = await f.extract();
  assert.equal(recovered.statusCode, 200, recovered.body);
  const timeouts = f.events.filter(([name]) => name === "[omnimath:openai-timeout]").map(([, event]) => event);
  assert.equal(timeouts[1].remainingLogicalBudgetMs, 40000);
  assert.equal(timeouts[1].effectiveAttemptTimeoutMs, 40000);
  f.setProvider(() => {
    clock += 57000;
    return providerResponse('{"extractedProblemLatex":"x+', { status: "incomplete", reason: "max_output_tokens", outputTokens: 3200 });
  });
  const stopped = await f.extract(f.uploadIdentity({ uploadRevision: 2, uploadId: "no-time-upload", ingestionRequestId: "no-time-ingestion" }));
  assert.equal(stopped.json().code, "AI_RESPONSE_TRUNCATED");
  assert.equal(stopped.json().failureClassification, "truncated");
  assert.doesNotMatch(stopped.json().message, /Retrying/i);
  assert.equal(f.calls.length, 3, "no fourth compact provider call starts");
});

it("a partial usage-settlement failure is surfaced and never triggers a second refund", async (t) => {
  const f = await fixture(t);
  f.failNextSettlement();
  const failed = await f.extract();
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.json().code, "USAGE_STORE_UNAVAILABLE");
  assert.equal(failed.json().accountingStatus, "unsettled");
  assert.equal(f.commands.filter(([verb]) => verb === "DECRBY").length, 1, "no compensating release repeats partially applied deltas");
  assert.equal(f.calls.length, 1);
});

it("a newer upload while extraction is pending discards the old result and accounts its completed call", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let count = 0;
  f.setProvider(async () => {
    count += 1;
    if (count === 1) { entered(); await waiting; }
    return extractionResponse();
  });
  const old = f.extract();
  await Promise.race([started, old.then((result) => { throw new Error(`Provider not entered: ${result.body}`); })]);
  const current = await f.extract(f.uploadIdentity({ uploadRevision: 2, uploadId: "replacement-upload", ingestionRequestId: "replacement-ingestion" }));
  release();
  const stale = await old;
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(stale.json().code, "OCR_EXTRACTION_STALE");
  assert.equal(f.calls.length, 2);
  assert.equal(f.events.filter(([name]) => name === "[omnimath:image-ingestion]").some(([, event]) => event.event === "extraction_failed" && event.providerCallCount === 1), true);
  f.setProvider(() => solveResponse());
  const solved = await f.invoke(f.app.handleSolveExtractedProblemRequest, f.solvePayload(current.json()));
  assert.equal(solved.statusCode, 200, solved.body);
  assert.equal(solved.json().ingestion.extractionId, current.json().ingestion.extractionId);
});
