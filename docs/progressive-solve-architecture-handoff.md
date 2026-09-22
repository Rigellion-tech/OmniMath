# Progressive step delivery: architecture audit and handoff

Date: 2026-09-22  
Scope: investigation and design only. No progressive-streaming production code was implemented.

## 1. Current production solve architecture

### Typed composer to server

1. `src/components/math/PrimaryMathComposer.jsx`
   - `PrimaryComposerSession.handleSubmit` serializes the visual/raw composer, calls `onGenerationStart`, creates an `AbortController`, records the active request, and calls `explainProblem` (`~165-217`).
   - The request is guarded by object identity (`activeRequestRef.current === request`) and Home's `canApplyOperation`. Reset aborts the controller (`~220-225`).
2. `src/api/mathClient.js`
   - `explainProblem` creates a canonical payload and delegates to `solveCanonicalProblem` (`~326-339`).
   - `solveCanonicalProblem` creates a client debug/request id, obtains a fresh Clerk token, POSTs JSON to `/api/explain`, then fully buffers `parseResponse` and calls `normalizeSolveResponse` (`~267-324`).
   - `parseResponse` uses `response.json()` or `response.text()`; there is no streaming reader (`~11-38`).
3. `server/app.js`
   - `handleApiRequest` dispatches `/api/explain` to `handleExplainRequest` (`~3626-3646`).
   - OCR review eventually re-enters the same canonical solve path: `handleSolveExtractedProblemRequest` constructs an internal `/api/explain` request and stores server-owned source context (`~3018-3050`).
   - `handleExplainRequest` authenticates, throttles, parses and canonicalizes input, validates problem/history, computes the cache key, and handles a completed cache hit (`~2256-2344`).

### Ownership, cache, and deduplication

- The server request id is `debugRequestId || clientRequestId || generated id` (`server/app.js:2273-2276`). It is diagnostic/correlation identity, not a solve revision protocol.
- The cache/dedup key is built from verified user id, canonical problem, reference, depth, and solve type (`server/app.js:2305-2314`). It does not include the frontend operation revision.
- `server/duplicateRequests.js:3-22` stores one in-flight Promise per key. Duplicates await the same final value. It has no event subscription, replay, or fan-out semantics.
- Frontend ownership is stronger than the wire contract. `Home.createOperationContext` creates a per-session monotonic `revision` plus `operationId` and records it in `activeOperationsRef` (`src/pages/Home.jsx:309-335`). `getOperationApplyDecision` rejects missing sessions, stale operation ids, and stale revisions (`~337-357`). These fields are not currently sent to `/api/explain` or echoed by the server.

### Routing and provider request

- `server/app.js:156-166` `resolveInitialSolveRouting` calls `chooseSolverRoleForProblem`.
- `server/solverRouting.js:1-40` classifies inputs as `standard`, `repair`, or `escalation`, but `chooseSolverRoleForProblem` currently always returns `role: "solver"`. The classification is logged, while the canonical initial model remains the canonical solver.
- `server/openaiModels.js:489-533` `selectOpenAiModel` resolves model, reasoning effort, capability, output limit, sampling, and role timeout. The canonical solver policy resolves to `gpt-5.6-sol` in the audited local source.
- `server/app.js:2346-2384` builds the prompt, establishes the total solve deadline, records routing, calculates output/usage budgets, and enters `runDeduplicatedRequest`.
- A deterministic local rule can satisfy the request before any provider call (`server/app.js:2384-2425`). This is an existing separate behavior and was not changed.
- Otherwise `createMathExplanation` is called with the canonical prompt, request context, routing, and shared `solveDeadlineAt` (`server/app.js:2428-2457`).

### OpenAI transport and strict structured output

- `server/openai.js:2071-2395` `createMathExplanation` runs the full structured solve, then possibly a compact structured retry.
- `requestOpenAi` builds a Responses API payload with `text.format.type = "json_schema"`, `strict: true`, and schema name `math_fast_solve` (`server/openai.js:1656-1729`).
- `fastSolveSchema` is in `server/mathExplanationSchema.js:32-62,107-123`. The root order is `title`, `problemLatex`, `steps`, `finalAnswerLatex`, `numericCheck`; each step requires `id`, `heading`, `latex`, `reasoning`, and `anchors`.
- `fetchOpenAiWithRetry` performs raw `fetch` to `/v1/responses` without `stream: true` (`server/openai.js:948-1265`). `readOpenAiResponseBody` then calls `response.text()` and parses the complete provider HTTP body (`~930-946`).
- There is no provider streaming path anywhere in the audited source.

### Parsing, normalization, and acceptance

- `parseJsonResponse` waits for a complete root JSON object, parses it, invokes the supplied assertion/normalizer, and attaches diagnostics (`server/openai.js:1394-1654`). Its `extractFirstCompleteJsonObject` helper recognizes only a complete root object; it is not an incremental step parser.
- `normalizeProviderSolveCandidate` calls `assertFastSolveResponse`, then `convertFastSolveToMathExplanation`, then checks normalized structure (`server/openai.js:2028-2068`).
- `assertFastSolveResponse` performs required-field, per-step shape, generated-LaTeX, renderability, id, and whole-candidate structural checks (`server/mathExplanationSchema.js:1304-1396`).
- `convertFastSolveToMathExplanation` converts provider steps into the production `MathStep` shape, generates chunks/lines/expressions/tokens, and calls the shared semantic annotator (`server/mathExplanationSchema.js:1583-1767`; `src/lib/mathAnnotator.js:1709-1788`).
- `createMathExplanation` treats parse/schema/generated-response failures as candidates for a compact retry while sharing the same solve deadline (`server/openai.js:2141-2318`).
- Back in `handleExplainRequest`, local adjustments and structural acceptance occur before `finalizeSolveCandidate`; `finalizeSolveCandidate` performs structural inspection plus server verification/acceptance metadata through `server/solveCandidateLifecycle.js` and `server/verification/solutionVerifier.js` (`server/app.js:2461-2635`). A final semantic annotation pass is checked, with a structurally usable pre-annotation fallback if decoration fails.
- Only the accepted complete result is cached and selected for UI (`server/app.js:2669-2735`).

### Response and frontend state

- `buildResponse` adds request/canonical/usage/save metadata (`server/app.js:2000-2035`). `sendJson` writes one complete JSON document and ends the response (`~1335-1342`; final solve send at `~2737-2761`).
- `src/api/mathClient.js:145-239` `normalizeSolveResponse` selects the first renderable step array, retains visible boundary-error placeholders for malformed accepted entries, and constructs one complete normalized response.
- `src/pages/Home.jsx:643-749` `handleProblemGenerated` re-normalizes the complete response, creates a complete problem state, and replaces the session's problem/steps in one commit through `createGeneratedProblemState` and `commitGeneratedProblemToSessions` (`src/lib/solutionState.js:41-107`). There is no append operation or progressive reducer.
- Loading/status is per session, but effectively `empty/loading/success/error/limit`; `isGenerating` is true only for `generationStatus.type === "loading"` (`Home.jsx:963`).

### Render path

- `Home` passes the current problem and loading flag to `ProblemBlock` (`src/pages/Home.jsx:1082-1090`).
- `ProblemBlock` calls `annotateMathExplanation(withNormalizedSolutionSteps(rawProblem))` on every changed problem object (`src/components/math/ProblemBlock.jsx:384-403`). This recreates step/line objects even when an append operation preserves earlier state references.
- While `loading` is true, `ProblemBlock` renders only skeletons and hides all available steps (`~519-529`). This directly blocks partial display.
- Its effect keyed by the entire `steps` array resets selected step, expansion state, and workspace mode (`~422-427`). An append would therefore disturb interaction state.
- `SolutionFlow` maps stable `step.id` keys to the production `MathStep` component (`src/components/math/SolutionFlow.jsx:4-30`).
- `MathStep` renders its normal interactive lines and is memoized by step identity, request id, selection/expansion, and relevant hover state (`src/components/math/MathStep.jsx:333-487`). This is a useful append-only boundary, but `ProblemBlock`'s repeated annotation currently defeats stable step-object identity.
- `InteractiveMathLine` reaches the existing `MathRenderer`; there is no separate streaming renderer. Progressive delivery must continue through this exact path.

### Provenance, hover, and follow-up ownership

- `src/lib/explanationProvenance.js:88-171` builds and deep-freezes a snapshot containing target identity, step id/index, current step, bounded solution evidence, a `solutionRevision`, and confidence. Follow-up payloads carry `requestId`, `conversationId`, `targetRevision`, and the snapshot (`~184-216`).
- `solutionRevision` currently hashes the problem plus the evidence step list. Appending later steps changes the revision for a newly created snapshot of an earlier step. Existing frozen snapshots remain immutable, but the same earlier target can receive a new target revision as the solution grows.
- `server/followupProvenance.js` validates target/step consistency and accepts request/conversation ids. These are follow-up identities; there is no solve-level `conversationId` today.
- Progressive ownership should use the existing Home operation/revision model and add it to the transport. It should not overload the follow-up conversation id.

### Persistence

- `saveExplanationBestEffort` is started only after final acceptance, and `saveExplanationForRequest` inserts the complete result into `user_explanations` (`server/app.js:2669-2734`; `server/userData.js:364-399`).
- Session autosave serializes complete `problem`, `problems`, and `steps` arrays (`src/api/userClient.js:81-91`; `server/userData.js:94-109`).
- Home deliberately excludes sessions whose generation status is loading/workflow-active from autosave (`src/pages/Home.jsx:448-455`). This already prevents in-progress persistence while status remains active.
- A failed partial solve would become autosave-eligible under the current error states. Progressive state therefore needs an explicit `persistable`/`globallyValidated` guard; the first slice should keep partial results memory-only.

## 2. Streaming feasibility

### What official OpenAI documentation established

- The Responses API supports HTTP streaming over server-sent events by setting `stream: true`.
- Common events include `response.created`, `response.output_text.delta`, `response.completed`, and `error`; the streaming API reference includes ordering metadata such as `sequence_number` on delta events.
- Strict Structured Outputs can be streamed and processed before the full response completes. OpenAI recommends SDK helpers for structured streaming, but the REST stream still exposes text deltas.
- Strict Structured Outputs preserve schema key order. This matters because the current schema places `steps` before `finalAnswerLatex`.
- Strict schema adherence describes the completed structured response. A text delta is still only a fragment; it is not permission to parse or render an incomplete string as a step.

Official references:

- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming)

### Can the existing schema expose complete steps?

Yes, at the JSON syntax level, without weakening the final schema. Accumulate `response.output_text.delta` data and run a real incremental JSON lexer/parser that tracks:

- strings and escapes;
- object/array nesting;
- the current JSON path;
- entry into the root `steps` array;
- the exact byte/character span of each array element;
- provider event sequence/order.

When the parser observes the closing brace of one `steps[i]` object at the correct array depth, that exact slice can be `JSON.parse`d and validated. Regex or naive brace counting is not safe because braces and escapes can occur inside JSON strings/LaTeX. Incomplete fragments must remain only in the parser buffer and must never enter React or KaTeX.

### Whole-response context that prevents immediate publication

An object being syntactically complete is necessary but not sufficient for immutable publication:

- Current conversion assigns roles from global position: index zero is treated as the problem/other role, and `index === solve.steps.length - 1` is treated as `final_answer` (`server/mathExplanationSchema.js:1631-1643,1728-1747`). A step converted while it is merely the current last prefix element would be reclassified when another step arrives.
- The converter derives explanation summary fields from the first two steps and applies a global anchor budget (`~1591-1656`).
- It semantically annotates the whole step array and later maps all steps again (`~1658-1748`). The shared annotator itself maps steps independently, but its output objects are rebuilt as a group.
- `normalizeSolveSteps` contains problem-step filtering and final-step detection/merging/synthesis based on `problemLatex` and `finalAnswerLatex` (`server/mathExplanationSchema.js:1248-1302`). In the audited snapshot, this helper has no active call site in the fast-solve path, so it must not be described as currently applied. It is nevertheless evidence that final-answer-aware normalization exists in this module and must not be accidentally activated for already published steps.
- Whole-solution verification includes cross-step and final-answer consistency, symbol provenance, and mathematical checks. A locally renderable step can still belong to a globally rejected candidate.
- On the frontend, `ProblemBlock` re-annotates the whole problem and resets selection on every step-array change.

Therefore the current whole-response converter must not be run against a growing prefix and its output published. Before provider-backed streaming, extract a prefix-stable per-step assertion/conversion path. It must give every derivation step a role that will not change when a suffix arrives, or deliberately retain one raw-step look-behind until its non-final status is known. Final-answer presentation should be created only after final validation. At completion, compare the final normalized candidate against the hashes/content of every published step; any mismatch is a terminal validation failure, never an in-place rewrite.

## 3. Smallest safe protocol

Use POST `fetch` with an `application/x-ndjson` response for the first implementation. POST is already required for the problem payload and Clerk authorization; browser `EventSource` cannot conveniently preserve that contract. SSE-over-fetch is also viable, but NDJSON is the smaller local protocol. Each newline terminates one complete JSON event; an unterminated line is never dispatched.

Every event should include:

```text
protocolVersion
type
requestId             client-created solve request id
revisionId            immutable operation id for this solve revision
revision              per-session monotonic revision number
sessionId             Home/origin session id
attemptId             provider candidate/attempt identity
sequence              monotonic event sequence within attempt
```

Events:

```text
solve_started { routing/budget metadata safe for the client }

step_ready {
  stepIndex,
  stepId,
  stepHash,
  step                 // complete production MathStep
}

final_answer_ready {
  finalAnswer,
  finalAnswerHash
}

solve_completed {
  stepCount,
  candidateHash,
  usage/runtime/save metadata
}

solve_failed {
  failureType,
  code,
  retryable,
  partialStepsRetained
}
```

`final_answer_ready` should be emitted only after the completed provider document passes the existing full parse, normalization, structural boundary, and final verification/acceptance path. In the first slice it can immediately precede `solve_completed`.

A step is safe to publish only after all of the following:

1. provider event order is valid and the incremental parser has isolated one complete array element;
2. the element parses as JSON and passes an exported strict per-step schema check (including no extra fields, complete anchor objects, visible/renderable LaTeX, and safe text limits);
3. its index is the next contiguous index and its id is unique in the published prefix;
4. it is converted once through a new prefix-stable extraction of the normal production `MathStep` path;
5. the converted object passes the same local renderability boundary used by production;
6. its immutable hash is recorded for final prefix-consistency checking.

Do not expose raw provider fragments in protocol events.

Deduplication is a later provider-rollout concern. The present Promise deduper cannot multicast. A production stream needs a keyed solve-job hub with a replay log of already validated events and subscriber-specific request/revision envelopes, or another explicitly designed policy. Silently disabling dedup would risk duplicate provider calls and usage accounting and is not part of the first slice.

## 4. Validation and failure policy

### Level 1: per-step publication validation

Per-step validation establishes only that the object is complete, contract-valid, renderable, correctly ordered, uniquely identified, and convertible to an immutable production `MathStep`. It does not claim that the entire derivation or final answer is mathematically accepted. The UI should regard the solve as partial/provisional until completion.

### Level 2: final whole-response validation

After `response.completed`, retain the full accumulated JSON and run the unchanged complete-response pipeline: parse root, strict schema assertion, normal conversion, structural checks, annotation boundary, verification, acceptance, usage settlement, caching, and only then final persistence eligibility. Verify that every previously published step matches the final candidate's immutable step hash/content.

### If final validation fails after partial delivery

Recommended initial policy:

- Keep already published steps visible and byte/content immutable.
- Transition the revision to terminal `validation_error` with a clear “partial solution; final validation failed” state.
- Do not publish a final answer, mark complete, cache, or persist the partial solve as an accepted solution.
- Preserve hover/pin interactions against the frozen published step snapshot, but label its solve revision as partial/failed; do not imply globally verified correctness.
- Require an explicit new solve revision for retry. Do not append a new attempt to the old prefix.

Previously published steps are never mutated. The only acceptable future exception would require an explicit versioned correction event and corresponding UX; no such mechanism belongs in the initial design.

## 5. Frontend lifecycle

Use a focused pure reducer/module rather than scattering event mutation across Home. A suitable state shape is:

```text
phase: idle | starting | waiting | receiving | partial | complete | failed | aborted
failureType: null | provider_error | inactivity_timeout | solve_budget_exceeded |
             validation_error | protocol_error
requestId / revisionId / revision / sessionId / attemptId
nextSequence / nextStepIndex
steps                 // append-only; old object references preserved
stepHashes
finalAnswer
metadata
persistable           // true only after completed final validation
```

Required transition rules:

- `solve_started`: only for the active Home operation/revision; resets a new revision, never an existing one.
- `step_ready`: require exact ownership, attempt, next sequence, and next contiguous index. Append without cloning existing steps.
- Duplicate: identical `(revisionId, attemptId, stepIndex, stepHash)` is an idempotent no-op. Same index with different content is a protocol error.
- Out of order: reject/fail the protocol in the initial implementation rather than guessing or silently sorting. Buffering can be added only with bounds and tests.
- Stale/superseded: Home's existing operation decision remains the authority. Mismatched request/revision/session events are ignored and logged.
- Retry: before any published step, a server transport retry may use a new `attemptId`. After a published step, automatic retry must stop unless the new attempt proves an exactly identical validated prefix. Initial policy: terminal partial failure, user retry creates a new revision.
- Abort: abort the fetch/reader, mark the revision aborted, ignore all later events, and ensure the server/provider signal is cancelled where supported.
- Inactivity/total timeout: terminal failure types are distinct. Keep published steps immutable.
- Completion: require contiguous sequence, final validation event(s), matching step count/hashes, then set `persistable=true`.

UI integration requirements:

- Change `ProblemBlock` so existing steps remain visible while the solve is active; show a trailing skeleton/status after them.
- Reset selection/workspace only when solve revision/session changes, not whenever the steps array grows. Preserve a valid selected/expanded step on append.
- Avoid re-annotating/recreating old production steps in `ProblemBlock`; annotate once before publication or memoize by immutable step hash/revision so `MathStep` receives stable object identity.
- Continue using `SolutionFlow -> MathStep -> InteractiveMathLine -> MathRenderer`; do not add a simplified streaming renderer.
- Extend provenance snapshots with solve `revisionId`, `attemptId`, step hash, and partial/completion state. Do not derive an earlier step's target identity solely from the whole growing step list. Existing frozen snapshots must remain valid while later steps arrive.

## 6. Timeout architecture

### Current behavior

- The audited source has a solver-role provider timeout of **60,000 ms** in `server/openaiModels.js:49-63` (`OMNIMATH_OPENAI_SOLVER_TIMEOUT_MS` can override it, clamped to 5,000-300,000 ms).
- It also has a separate total solve default of **75,000 ms** in `server/openai.js:49,321-327`, documented as `OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS=75000` in `.env.example`. A deployment override can differ; the often-observed 60-second boundary may be the role timeout or a total-timeout override.
- `handleExplainRequest` creates one `solveDeadlineAt` before entering dedup/provider work (`server/app.js:2348-2349`). The same deadline is passed through initial, compact, and outer quality-repair calls.
- `fetchOpenAiWithRetry` chooses each attempt timeout as `min(role timeout, remaining total deadline)` and uses `AbortSignal.timeout(attemptTimeoutMs)` (`server/openai.js:948-1019`). The signal covers the fetch/body lifecycle; there is no separate first-byte or inactivity timer.
- Canonical solver transport allows `maxAttempts=3` (`server/openai.js:325-328`), but this is a ceiling, not reserved slices. A first attempt can consume 60 seconds of a 60-second configured total, or 60 of the audited 75 seconds, leaving no or little meaningful retry time after backoff. A successful HTTP response also ends the transport loop at one attempt even if later JSON/schema validation causes a separate higher-level retry. Non-retryable errors likewise stop at one.
- Deadline exhaustion is currently raised/mapped through `AI_SERVICE_UNAVAILABLE`, and the frontend reports “AI service timed out or connection dropped” (`server/openai.js:1005-1011,837-851`; `src/api/mathClient.js:21-23`; `Home.jsx:884-906`). This conflates OmniMath's budget with provider/network availability.

### Recommended streaming timers

Keep four explicit concepts:

1. Connection/first-provider-activity timeout: request start until the first valid provider stream event (not necessarily the first user-visible step).
2. Inactivity timeout: reset on each valid provider event/read; detects a stalled stream.
3. Maximum solve wall-time: absolute cap across attempts, parsing, and retries.
4. Attempt/retry policy: retry only when the failure class and published-prefix state make it safe.

Return distinct failure types/codes for provider unavailable, provider inactivity, application solve-budget exhaustion, validation failure, and client abort. Do not label an application wall-time cap as service unavailability.

The current routing output is not sufficient by itself for calibrated difficulty budgets. It has useful signals (`routingDecision`, reason, model role, attempt stage), but `standard/repair/escalation` is a solver/validation heuristic, all initial requests currently use role `solver`, and known classification issues exist. A later versioned `solveBudgetClass` may consume routing signals, model/effort, prompt/output budget, and explicit complexity features, but it needs calibration before assigning FAST/STANDARD/HARD/EXTREME numbers. No final timeout numbers were selected in this audit.

## 7. Persistence recommendation

For the first rollout, preserve the current complete-solution assumption:

- Server explanation persistence, cache insertion, and usage-success settlement occur only after full validation.
- Frontend partial state remains memory-only with `persistable=false`.
- Autosave stays blocked through active streaming and remains blocked for terminal partial failure unless a future explicit “partial draft” schema is designed.
- On success, persist one final snapshot containing the full immutable steps, final answer, solve revision/provenance, and completion metadata.

Do not incrementally overwrite the existing accepted explanation row. Partial persistence would require explicit revision/status columns or a separate draft/event model, recovery semantics, cleanup, and privacy/retention decisions; it is not necessary for the first vertical slice.

## 8. Deterministic test architecture

Current tests use Node's built-in test runner (`npm test`) and Playwright layout tests. Browser tests already mock `/api/*` via `page.route`. There is no streaming fixture today.

Recommended deterministic setup:

- Unit-test a pure protocol decoder/reducer using `ReadableStream` chunks split at adversarial boundaries, fake timers, and no external network.
- For browser coverage, install a narrow `window.fetch` replacement with `page.addInitScript` for `/api/explain` that returns `new Response(new ReadableStream(...))`; this permits controlled delayed chunks. Continue `page.route` mocks for hover/pin/follow-up endpoints.
- Emit NDJSON frames in multiple transport fragments, including splits inside JSON escapes and LaTeX strings. Assert no callback/render occurs before the terminating newline plus event validation.
- Use the real production `ProblemBlock`, `SolutionFlow`, `MathStep`, and `MathRenderer` in Playwright. Attach an identity marker or count to Step 1 and prove later appends neither replace its DOM/state nor reset selection/hover.
- Block/assert every non-loopback request and leave `OPENAI_API_KEY` empty. No provider call is needed.

Critical cases before provider-backed streaming:

1. three complete steps arrive sequentially;
2. incomplete JSON and incomplete TeX never reach `MathRenderer`;
3. Step 1 content, object/DOM identity, selection, and expansion remain stable as Steps 2/3 arrive;
4. final answer and completion transition;
5. abort after Step 1, with later events ignored;
6. deterministic inactivity timeout after Step 1;
7. stale old-request/revision events after a new solve begins;
8. identical duplicate step event is a no-op;
9. out-of-order event is rejected as a protocol error;
10. malformed step is rejected before rendering;
11. final whole-response validation failure retains partial steps but never completes/persists;
12. hover and follow-up provenance work on Step 1 while the stream is paused before later steps;
13. zero provider/external API calls.

Focused audit verification ran 62 existing Node tests covering canonical solve routes, solve response normalization, candidate lifecycle, and follow-up lifecycle: 62 passed, 0 failed/skipped/cancelled. `OPENAI_API_KEY` was explicitly blank. There were zero external/provider calls. Two expected best-effort local PostgreSQL attempts to `127.0.0.1:5432` were refused without affecting the tests.

## 9. Minimal first vertical slice

Build only this:

```text
deterministic mocked progressive source
  -> POST-fetch NDJSON decoder
  -> validated ownership/event envelope
  -> pure append-only frontend reducer
  -> complete production-format MathStep event
  -> existing ProblemBlock/SolutionFlow/MathStep/MathRenderer
  -> append second step without replacing/resetting first
  -> final_answer_ready + solve_completed
```

Suggested new focused modules (names are proposals, not requirements):

- `server/progressiveSolveProtocol.js`: event validation/serialization only, no provider integration.
- `src/api/progressiveSolveClient.js`: NDJSON decoding, abort handling, and event dispatch.
- `src/lib/progressiveSolveState.js`: pure ownership/order/idempotency reducer.
- `tests/progressiveSolveProtocol.test.mjs`: unit cases.
- `tests/progressiveSolve.layoutRegression.spec.mjs`: real render/hover slice.

Use a deterministic mock that already emits fully validated production-format `MathStep` objects. Do not yet add the provider SSE parser, dedup fan-out, adaptive timeout policy, persistence migration, retries after partial publication, image streaming, or production rollout. Once this slice passes, extract and test the prefix-stable server per-step converter; only then connect provider streaming.

## 10. Repository state at handoff

- HEAD: `76ad8dea64561d34771ba7ba180a9a444f8a186d` (`76ad8de fix semantic hover coverage for dense variational math`), with `main`, `origin/main`, and `origin/HEAD` at that commit.
- Index/staged changes: **none**.
- Porcelain reported 140 tracked worktree status entries and 79 untracked entries. `git diff --name-only` reported 41 tracked files with substantive diffs; `git diff --stat` reported 3,431 insertions and 2,232 deletions. The difference between status and content-diff counts should itself be reconciled, not guessed away.
- This investigation changed no production source, configuration, schema, test, or dependency files. The only file added by this session is this handoff document.
- Dirty core files overlapping a future implementation include `server/app.js`, `server/duplicateRequests.js`, `server/mathExplanationSchema.js`, `server/openai.js`, `server/openaiModels.js`, `server/solutionValidation.js`, `src/api/mathClient.js`, `src/pages/Home.jsx`, `src/components/math/ProblemBlock.jsx`, `src/components/math/MathStep.jsx`, `src/lib/solutionState.js`, and `src/lib/solutionSteps.js`.
- Important untracked production files include:
  - `server/followupProvenance.js`, `server/ocrSolvePolicy.js`, `server/solveAcceptancePolicy.js`, `server/solveCandidateLifecycle.js`, `server/solveCandidateStructure.js`, `server/solveDiagnosticContext.js`;
  - `server/verification/domain.js`, `expression.js`, `mathVerifier.js`, `solutionVerifier.js`;
  - `src/components/math/PrimaryMathComposer.jsx`, `MathInputPalette.jsx`, `VisualMathField.jsx`;
  - `src/lib/explanationProvenance.js`, `followupLifecycle.js`, `hoverRequestLifecycle.js`, `mathSymbolRegistry.js`, `primaryComposerSerialization.js`, and `richMathPaste.js`;
  - many untracked regression tests that exercise those boundaries.

These files are part of the architecture audited above but are not fully represented by HEAD. Implementing into the overlapping dirty files before capturing/reconciling the local source would make review, rollback, and regression attribution unreliable and could accidentally omit the just-completed architecture from a future commit. No cleanup/reset/staging/reconciliation was performed.

## 11. Exact next-session order

The audit supports the requested ordering: preserve the current local OmniMath source first, then implement progressive delivery from a reproducible baseline.

1. Reconcile the working tree intentionally: identify which tracked diffs and untracked production/tests belong to the completed milestones; review generated/binary/unrelated items separately.
2. Run the relevant existing checks on that exact local source.
3. Create an explicit reproducible Git checkpoint using only reviewed paths. Do not use `git add .`.
4. Confirm a clean or deliberately documented baseline and record the checkpoint hash.
5. Add protocol/state unit tests first for ownership, ordering, idempotency, immutability, abort, and partial failure.
6. Implement the mocked NDJSON client/reducer/render vertical slice and its Playwright test.
7. Fix only the two required UI integration points: partial steps visible during loading, and selection/object identity preserved across append.
8. Extract/test a prefix-stable per-step server validator/converter without changing semantic-hover behavior.
9. Add a provider SSE decoder behind deterministic mocked-fetch tests; retain complete final validation.
10. Design dedup event fan-out/replay and usage settlement before enabling provider-backed progressive requests.
11. Add timeout classes/error semantics, then persistence only after the core stream lifecycle is proven.
12. Perform a final semantic hover/provenance regression review before rollout.

## 12. Provider usage

Real OpenAI/provider/model API calls made during this investigation: **0**.

The only internet access was read-only retrieval of official OpenAI documentation. Focused tests made no external API calls; the two failed connections noted above were to local PostgreSQL only.
