# OmniMath — Major Architecture Audit #2

Date: 2026-09-28. Scope: the existing working tree, including progressive solving and the completed UI-hardening work. This report consolidates the completed investigation; it does not implement remediation.

No application fixes, commits, pushes, live provider calls, or database migrations were performed. Audit additions consist of reports, captured observations, and a targeted diagnostic script. Existing changes remain the baseline; Git HEAD is not an adequate substitute for it.

## 1. Executive summary

OmniMath has materially stronger input, acceptance, provenance, and UI lifecycle boundaries than the earlier architecture described in the September records. Typed and reviewed OCR solving share the canonical solve handler. Structural acceptance now distinguishes fatal defects from recoverable formatting and warnings. Successful answers survive later annotation failure. Session operations and progressive attempts have explicit ownership. Follow-ups use immutable, versioned provenance. Rendering preserves valid TeX and exposes errors. Semantic preparation runs in a worker, and stationary pointers can acquire targets after geometry arrives.

These improvements do not establish mathematical correctness or reliable ownership for every advanced expression.

The most important remaining risks are:

1. **Wrong mathematics can reach the UI by deliberate policy.** A structurally usable candidate is accepted even when verification reports a contradiction. Verification is limited evidence, not a correctness gate, and does not establish assumptions, cross-step implications, or completeness. This is a **P0 correctness risk**, not a newly discovered accidental policy regression.
2. **Repeated scripted occurrences can acquire each other's identities.** In `J^2 + J^* + J^{-1}`, the semantic base identity for `J^*` attaches to the painted J in `J^{-1}`. This is a confirmed **P1 ownership defect** with a traced fallback-indexing cause.
3. **Local density still causes large stalls and interaction loss.** Pointer entry can synchronously measure fallback geometry before worker output is ready. The identical-subscript case blocked for about 1.24 seconds. One hundred repeated `J^2` terms produced 503 semantic nodes, 535 rejection records affecting 422 unique IDs, duplicate fallback owners, and about 1.82 seconds of event-loop delay.
4. **Routing behavior is less adaptive than its vocabulary suggests.** Complexity classification always chooses the initial solver role. Ordinary JSON solving has no active quality escalation; its repair branch is unreachable. Progressive recovery is real but bounded, and default escalation is suppressed because initial and escalation model IDs are identical even though reasoning efforts differ.
5. **Provider success can still be withheld by usage settlement.** History saving is outside answer delivery, but usage settlement is awaited and its storage operations lack a composed operation deadline. Local usage storage remains an unlocked direct JSON rewrite; quota reservation and reconciliation are not atomic across counters.
6. **Logs can misidentify the model.** Hover/pin provider paths select their own model, but the later `ai-request` event falls back to the solver model. Logs alone cannot reliably reconstruct every presentation failure through visible UI acceptance.

**The historical 691-owner repeated-subscript incident remains unresolved.** It was not reproduced by identical 180-term subscripts, numbered 180-term subscripts, or backend-annotated 180-term input. The related scripted-notation reproduction must not be relabeled as the same historical incident.

The focused browser suite passed **23/23 with retries disabled**, while targeted probes reproduced real ownership and scaling defects. This is direct evidence that the current green suite is useful but incomplete.

### Evidence classification

- **Confirmed current defect:** a runtime reproduction or deterministic implementation/contract violation. Each finding states which form of evidence exists.
- **Architectural weakness:** an established limitation or fragile boundary whose full user-visible consequence may not have been reproduced.
- **Test weakness:** the test does not establish the property an operator might infer from its name or passing result.
- **Historical incident not reproduced:** retained evidence without a recovered causal chain in this audit.
- **Unresolved hypothesis:** a possible mechanism requiring further evidence. It is not counted as a confirmed defect.

Severity follows user impact. A code-supported limitation is not promoted to P0 merely because its implementation is complex.

## 2. Evidence set and verification

The following artifacts are part of this report:

- [Semantic evidence and causal analysis](audit2-semantic-evidence.md).
- [Initial semantic observations](audit2-semantic-observations.json) and [additional observations](audit2-semantic-additional-observations.json).
- [Backend evidence](audit2-backend-evidence.md).
- [Lifecycle evidence](audit2-lifecycle-evidence.md).
- [Verification, skips, and browser results](audit2-tests-resume.md), with [earlier verification record](audit2-verification-evidence.md).
- [Resume checkpoint](audit2-checkpoint.md), retained as a historical checkpoint rather than current completion status.
- [Targeted probe](../scripts/audit2-semantic-probe.mjs), which intercepts API requests and uses fixture responses.

Completed agent results were merged from the backend, lifecycle, verification, and browser reports. Interrupted agents without durable output were never treated as completed evidence. Runtime reconnects lost some processes and temporary logs; recovered JSON observations were copied into the durable evidence files.

| Check | Recorded outcome | Limit |
|---|---|---|
| Initial `npm test` | 1,270 pass, 21 skip, 0 fail | Provider transports controlled; no browser coverage |
| Guarded full Node rerun | First run: 1,269 pass, 1 fail, 21 skip; subsequent captured run: 1,270 pass, 0 fail, 21 skip | First failure identity/output was lost; retry does not erase it |
| Focused lifecycle tests | 49/49 pass | Reducers/helpers and controlled boundaries |
| Focused browser suite | 23/23 pass, retries disabled | Chromium/Vite, mocked auth/API, no live backend/provider |
| Lint | Passed in verification phase | Not evidence of semantic correctness |
| Typecheck | Fails at `src/lib/solutionState.js:148:39`, TS2339 on `extractionValidation` | Existing development-check failure; no fix attempted |
| Production build | Passed in verification phase | Does not run browser interaction tests |

Browser breakdown: UI hardening 7, semantic TeX ownership 1, hover lifecycle 6, provenance follow-up 2, pinned lens 7. The exact commands and limitations are preserved in the test report. No tests were weakened or deleted.

## 3. Current architecture map

### Typed and OCR entry

```text
Typed input
  PrimaryMathComposer / visual editor / Advanced LaTeX
    → composer serialization → canonical ProblemInput
    → Home origin-session operation + revision
    → mathClient request → /api/explain

Image input
  ImageUpload → file checks → /api/extract-image-problem
    → provider transcription → normalization + extraction validation
    → direct/review/edit/solve-anyway decision
    → canonical ProblemInput + review action + canonical hash
    → /api/solve-extracted-problem
    → header-preserving internal request → shared /api/explain handler
```

Shared input does not mean every surrounding lifecycle is identical. Extraction has separate auth, quota, transport, validation and review state. Compatibility image routes/adapters remain. Local development authentication differs by endpoint. Ordinary JSON and progressive solving also have different recovery and abort policies.

### Solve, acceptance, and delivery

```text
Shared solve handler
  → verified identity / request validation / throttling
  → canonical request context + process-local cache / in-flight dedup
  → usage reservation
  → local candidate or model request
      → role/path configuration → provider attempts and deadlines
      → provider completion/refusal/incomplete checks
      → JSON parse or progressive framing
      → schema assertion → normalization/conversion
      → structural + visible-math/renderability acceptance
      → mathematical verification evidence (does not gate acceptance)
      → selected candidate + semantic decoration
  → awaited usage settlement
  → cache + HTTP result / progressive terminal event
  └→ unawaited, observed best-effort explanation save

Client response/event
  → normalization + session/operation/attempt ownership check
  → current solution state / accepted progressive steps
  → independent session/history persistence effects
  → SolutionFlow / ProblemBlock / MathStep / MathChunk
```

Ordinary full-response generation can make a compact retry only after the first candidate fails its parsing/structural boundary. It does not intentionally discard a previously usable full candidate. An accepted candidate is retained if later annotation fails. Progressive recovery is allowed only before authoritative steps are published; afterwards the accepted prefix remains and failure is terminal/partial.

### Semantic rendering and explanation

```text
Step/chunk math + optional explicit parts
  → canonical semantic tree with half-open source ranges and occurrence IDs
  → worker serialization/preparation
  → TeX grammar + inline/display layout equivalence checks
  → accepted annotated TeX, with unsupported-node diagnostics
  → MathRenderer → KaTeX HTML
  → annotated DOM owners
  → measured painted geometry / structural residual ink
  → targeted fallback where permitted; legacy path before annotations
  → geometry snapshot + revision + owner DOM identity
  → pointer candidate scoring → hover target
  → lazy explanation request/cache → owner/reducer acceptance → tooltip
  → pin → immutable provenance snapshot
  → follow-up conversation/request/target revision
  → server provenance validation + evidence compaction/selection
  → provider answer or grounded local fallback
  → echoed identity checks → reducer → visible lens response
```

The principal semantic risk is at the transition from validated annotations to fallback DOM assignment. The fallback may mutate DOM identity, and subsequent measurement may treat that mutation as an authoritative owner. Correct source IDs do not guarantee that the glyphs bearing them are correct.

### Identity and concurrency ownership

| Identity | Purpose / boundary | Audit result |
|---|---|---|
| Home operation ID + per-session revision | Owns typed/OCR work and its completion | Existing/current operation and origin session checked before commit |
| Canonical input hash | Binds reviewed text to the submitted canonical problem | Content identity; not a unique action ID or authenticated OCR receipt |
| Request ID | Correlates logical API work | Reuse across OCR extraction/review can represent one logical operation; historical duplicate ID collision not established |
| Provider attempt / candidate / response ID | Separates retries and generated candidates | Richer solve telemetry exists; not uniformly present on later generic AI logs |
| Progressive request + attempt + sequence | Rejects stale/out-of-order stream data | Reducer fails closed; immutable accepted steps preserved |
| Semantic occurrence ID + source range | Distinguishes repeated notation | Distinct source IDs survive; fallback can attach them to wrong glyphs |
| Geometry/render revision + DOM owner | Prevents stale-layout selection | Explicit validity checks; some overlap/re-ranking cases remain unproven |
| Solution revision + target revision | Binds provenance and follow-ups | Follow-up binding explicit; lazy pin cache omits solution revision |
| Conversation + follow-up request ID | Blocks duplicate/stale follow-up commits | Owner, echo, and reducer checks present |
| Verified Clerk user + session ID | Scopes persisted data | Server-side user-scoped queries inspected; no cross-user leak found |

Deduplication/cache scope is process-local. It is not deployment-wide exactly-once execution. UI cancellation, server cancellation, provider cancellation, and accounting settlement are distinct stages.

## 4. Confirmed current defects

### D1 — Repeated scripted bases acquire the wrong occurrence (P1)

- **Subsystem:** semantic fallback ownership → geometry → hover/pin grounding.
- **Evidence:** the mixed-script browser fixture places ID `base.J.4-5` from `J^*` on the J painted inside `J^{-1}` at source 8–14. The wrong owner is later accepted as `semantic-dom`; the intended third base has no geometry. See semantic evidence and initial observations.
- **Reproduction:** `J^2+J^*+J^{-1}+u_i'+u''+u_i^j+T_{ij}^{kl}` through the actual UI renderer. Inspect the third J's DOM ID and the second power's aggregate geometry.
- **Root cause:** semantic wrapping of J changes KaTeX superscript layout, so the serializer correctly rejects it. Fallback then filters already-claimed rendered matches but indexes the filtered list using the occurrence index from the original source sequence. With three J bases, the second source occurrence selects the third rendered occurrence. `MathChunk.jsx:1673-1684,1742-1756,1823-1846,2943-2950`; grammar validation at `texAnnotationGrammar.js:138-158`.
- **Violated invariant:** each interactive occurrence must retain its own authoritative rendered owner; aggregate geometry must not inherit another occurrence's ink.
- **User impact:** a hover/pin can refer to the wrong occurrence and provide incorrectly grounded context. The wrong DOM/geometry ownership is reproduced; a live provider response at that misplaced target was not tested.

The layout guard must remain. Unwrapped `J^2` has HTML-tree height `0.8141em`; wrapping its base changes it to `0.8873em`. Removing that guard would exchange an interaction defect for altered mathematical layout.

### D2 — Dense scripted notation exhausts safe annotation coverage (P1)

- **Subsystem:** annotation planning/work budget → fallback reconciliation.
- **Evidence:** 100 repeated `J^2` terms produce **503 semantic nodes, 535 rejection records, 422 unique IDs affected, duplicate fallback owners, and approximately 1.82 seconds event-loop delay**. The first base resolves to the whole first power. The authoritative pass counts 50 owners before fallback; the later DOM has 162 owners for 143 unique IDs.
- **Reproduction:** `Array(100).fill('J^2').join('+') + '=0'` through the saved browser probe. Node probes at 10/30/100 powers accept 31/53/50 annotations and use 67/160/160 validation attempts.
- **Root cause:** repeated layout-sensitive bases consume the per-expression 160-validation budget. At 100 powers, 325 nodes are marked `annotation-work-budget`. Recovery then enters the fallback path implicated in D1; some fallback targets inherit zero-size metadata without consistently rebuilding painted metadata. Runtime annotation can add several owners for one semantic ID.
- **Violated invariant:** local density must not silently replace precise occurrence ownership with unsupported or incorrect mapping.
- **User impact:** missing or aggregate-only interaction and substantial presentation stalls in dense advanced notation.

The rejection count includes structural and intentionally hidden syntax. **422 unique IDs affected does not mean 422 visible glyphs disappeared.** This is a related scripted failure, not a reproduction of the historical 691-owner subscript incident.

### D3 — Pointer entry bypasses worker-readiness scheduling and blocks the UI (P1)

- **Subsystem:** pointer lifecycle / geometry scheduling / semantic worker boundary.
- **Evidence:** identical 180-term subscripts cause a 1,236.6 ms geometry pass and a 1,241.9 ms enter handler. Numbered subscripts cause 320.4 ms and 324.9 ms respectively. Both precede worker completion and report `canonical-katex-dom` fallback geometry.
- **Reproduction:** submit the dense fixture with the pointer left where the composer action occurred; the solution appears under it and invokes the real entry handler.
- **Root cause:** the scheduled layout effect waits for `semanticRenderReady`, but pointer entry directly calls `measureSemanticTargets`. Without annotations it runs the expensive legacy structural/text matching path. A scheduler budget checked after a callback cannot preempt that callback. `MathChunk.jsx:5985,6150`; `mathGeometryScheduler.js:58-67`.
- **Violated invariant:** interaction with not-yet-ready semantic content must not synchronously reconstruct an unbounded local expression.
- **User impact:** apparent freezing precisely when the solution first becomes visible, despite moving serialization into a worker.

### D4 — AI telemetry substitutes the solver model for the hover/pin model (P2)

- **Subsystem:** provider attribution / observability.
- **Evidence:** `logExplanationSource` defaults to `getOpenAiModel()` at `server/app.js:2014-2033`. Hover/pin callers omit `model` at `:3863-3870`, while provider functions choose hover/pinned paths at `server/openai.js:2790-2808`.
- **Reproduction:** deterministic code path: configure solver and hover differently; a successful hover emits the solver label in the later generic event. The known mini-provider/Luna-label incident is consistent with this exact mechanism. No live provider call was made to recreate its original event.
- **Root cause:** a missing observed-model argument is replaced with a configuration default rather than recorded as unknown/not applicable.
- **Violated invariant:** telemetry must distinguish actual provider model from requested model, role, alias, and accounting model.
- **User impact:** misleading incident reconstruction and false conclusions about routing or cost. This defect alone does not change the model that actually handled the request.

### D5 — Geometry rejection totals double-count targets (P3)

- **Subsystem:** semantic diagnostics.
- **Evidence:** working subscript cases report three rejection records for two unique IDs; the same chunk appears twice. `MathChunk.jsx:4138-4145` supplies rejected targets, then `:3930-3942` combines them with newly rejected prepared targets without deduplication.
- **Reproduction:** all three completed 180-term subscript shapes show the duplicate structural/chunk rejection.
- **Root cause:** overlapping rejection collections are concatenated.
- **Violated invariant:** counts must identify whether they measure events, records, distinct nodes, or lost painted primitives.
- **User impact:** inflated severity/coverage diagnostics and misleading comparisons. This does not explain the historical wrong first target or prove why its count was 499.

### D6 — Long follow-up evidence is truncated before origin-aware selection (P2)

- **Subsystem:** provenance compaction → follow-up prompt.
- **Evidence:** client retains a 64-step window; server first applies `slice(0,48)` and only then chooses up to 12 relevant entries. A recorded direct probe with origin `step-55` loses that step from normalized and selected ordered evidence. `explanationProvenance.js:60-67`; `followupProvenance.js:147-156,208-235`.
- **Reproduction:** 64 evidence entries, selected origin at index 55. Normalized evidence has 48 entries; prompt evidence contains only earlier entries. **`origin.currentStep` still survives.**
- **Root cause:** independent client/server limits are applied before the server's relevance-preserving selection.
- **Violated invariant:** evidence compaction must preserve the selected occurrence's relevant local context before spending the remaining budget.
- **User impact:** loss of nearby derivation dependencies, weaker grounding, or unnecessary uncertainty in long imported/persisted solutions. Ordinary provider schemas currently cap steps at 10, so this is a long-solution boundary defect, not proof that a normal 10-step response loses its selected step.

### D7 — Evaluation-role contracts leave the evaluation bar ineligible (P2)

- **Subsystem:** semantic vocabulary / ownership eligibility.
- **Evidence:** the recorded tree probe for `\left.x^2\right|_{0}^{1}` finds an ineligible, non-aggregate `evaluation` group and an ineligible `evaluationBar` leaf. Renderer group roles and hover aggregate roles disagree. `semanticMathRenderer.js:6-33,219-243`; `semanticHitboxes.js:298-325,372-395`; `MathChunk.jsx:1247-1271`.
- **Reproduction:** the direct semantic-tree/eligibility probe establishes the contract mismatch; no complete browser evaluation-bar trace was collected.
- **Root cause:** the bar is suppressed on the assumption that its parent owns it, but that parent is not eligible under the hover vocabulary.
- **Violated invariant:** hidden leaf syntax with meaningful interaction must have an eligible owning parent.
- **User impact:** a common calculus notation can lack an intended hover target. Neighboring numeric conditions can remain interactive.

Other code-supported limits, including inactive escalation, pin version caching and storage concurrency, are classified as architectural weaknesses below rather than presented as independently reproduced runtime incidents.

## 5. Solve, validation, and structured-output assessment

### What is currently protected

Structural acceptance requires meaningful final math and nonempty/renderable step math. It separates fatal `issues`, recoverable normalization, and warnings. Provider refusal, incomplete/truncated output, empty/unparseable JSON and unusable structure have explicit rejection paths. Blank or malformed display input has boundary diagnostics and a visible renderer error instead of an intentionally emptied host.

A usable full candidate returns without compact retry. An unusable candidate can trigger the bounded compact generation path; there is no demonstrated replacement of a previously accepted full candidate by a worse compact result. Later annotation failure retains the accepted candidate. Progressive accepted steps are immutable and drafts are not durable/UI-authoritative work. These protections reduce several historical failure mechanisms without proving the September incidents' causes.

### Mathematical correctness remains outside acceptance — P0 architectural risk

`server/solveAcceptancePolicy.js:1-15` accepts any structurally usable candidate, including one with contradiction evidence, and explicitly reports correctness as not established. It requests neither repair nor escalation. Therefore an internally inconsistent or wrong answer can reach the UI without violating the implemented acceptance policy.

The verifier does not infer prose assumptions, all cross-step implications, or completeness. Unsupported notation becomes inconclusive; this is preferable to treating a heuristic as proof, but it leaves a wide master's-level domain uncovered. A provider's numerical-check text is not an independent oracle. Generated-symbol and final-answer numerical heuristics must be judged for applicability, domains, binding and branches; their historical warnings are not proof of wrong mathematics.

The verifier examines the first 32 fields after appending the final answer. At 32 or more steps the final answer is omitted and a coverage-limit record appears. Ordinary provider schemas cap steps at 10, so this edge concerns broader lifecycle/imported candidates rather than normal schema-compliant provider output. See `solutionVerifier.js:4,18-24,57-64` and backend evidence.

**Recommended direction:** establish an explicit assurance policy distinguishing structural usability, supported mathematical checks, contradiction evidence and unsupported claims. Do not restore blanket rejection based on notation-sensitive warnings, or imply that every accepted answer is independently verified.

### `finalAnswerLatex` contract

The field is one string, not necessarily one scalar expression. Current normalization can stack complete physical lines into `gathered`. Findings such as `final_answer_contains_line_break_command` and `final_answer_contains_multiple_unrelated_equations` are now warnings, not fatal acceptance rules. The historical formatting-rejection issue is therefore **partially resolved**, not an active universal rejection of systems.

The remaining weakness is representational: related equations, conditions, a matrix/PDE result, derived relations, and collections of results share a free-form string. “Unrelated” is inferred from presentation syntax, not proven mathematical meaning. Compact output promotes the last returned step to the final answer. That can preserve display structure while still compressing assumptions or multi-part results into one step.

**Recommendation, without redesign here:** eventually distinguish a final expression/equation, related system, collection, and associated conditions/relations. Preserve a lossless renderable representation and explicit grouping. Keep syntactic warnings separate from mathematical claims about relatedness.

### Solution-step structure

Rich lines/chunks and prose support presentation, but theorem application, assumption, boundary condition, substitution, derivation and result semantics are not a uniformly enforced proof model. Advanced matrices, PDEs and variational statements remain largely math strings plus prose/roles. The ten-step provider schema cap can encourage compound fields on long derivations; omitted reasoning cannot be detected by renderability checks.

Current empty-step guards are materially stronger. They do not prove that every mathematically necessary intermediate step exists, or that all persisted legacy payloads meet live-response invariants. No original faulty September payload was recovered to distinguish provider omission, normalization loss and display failure retrospectively.

## 6. Routing, retries, timeouts, and cancellation

### Current route policy

These are source defaults, not an assertion about a secret-bearing live environment or actual provider availability.

| Path | Default selection | What can change it / failure behavior |
|---|---|---|
| Canonical typed/reviewed OCR initial solve | `gpt-5.6-sol`, solver, medium reasoning | Canonical selection policy; complexity classification records a tier but always chooses solver |
| Ordinary compact retry | Same solve path/role | Triggered by unusable generation/structure; not a mathematical-verification escalation |
| Progressive retry | Current initial role | Bounded, before authoritative prefix; specified transient/structured failures |
| Progressive repair | Repair role, default Sol/high | Complete repair candidate required; before published prefix |
| Progressive escalation | Escalation role, default Sol/high | Model ID must differ from initial; suppressed by identical defaults |
| OCR extraction / review | `gpt-4.1` / `gpt-4.1-mini` | Role configuration; independent extraction checks and timeout |
| Hover / pin | `gpt-4.1-mini` | Separate role configuration; generic AI log can incorrectly name solver |
| Follow-up / compare | Solver selection in current implementation | Follow-up applies pinned timeout role; not proof it uses pinned model |

`chooseSolverRoleForProblem` always returns `solver` (`solverRouting.js:31-39`). Ordinary `classifySolveFailure` always returns `response_generation_failure`; the caller rethrows before its apparent repair branch (`app.js:1054-1063,3049-3052,3084-3156`). Ranking/escalation helper definitions therefore overstate active ordinary-route recovery if read without tracing call sites.

Progressive recovery is a different policy: at most four outer attempts; no replacement after authoritative prefix publication; at most one retry/repair/escalation under its decision rules. Timeout alone does not imply escalation. Default initial and escalation IDs both equal Sol, so the model-ID availability check suppresses even a same-model/higher-reasoning escalation. These are **P1 routing/reliability weaknesses** under difficult generation, with no recovered proof assigning a particular historical failed problem to them.

### Timeout composition and abort

- Role defaults: extraction/review 60 seconds; canonical solver 90; repair 120; escalation 180; hover/pinned 30. Timeout overrides are clamped to 5–300 seconds. Follow-up UI timer is 35 seconds.
- Non-stream provider requests have per-attempt abort timeouts and a shared solve deadline. Transport retries are bounded (up to three for solve, two for other roles). Retry sleep is not clipped to the remaining budget, so completion may overshoot before the next deadline check.
- Ordinary JSON solving does not propagate the client request's cancellation signal into generation. Cancelling the UI prevents stale acceptance but can leave billable provider work running.
- Progressive streaming composes disconnect/abort with timeout and limits transport retry after bytes are seen. Accepted-prefix failure is terminal/partial rather than a fresh silent solve.
- Usage-store work and persistence operations are outside some provider deadlines. A provider deadline is not an end-to-end HTTP deadline.
- Session deletion/reset and keyed composer unmount do not uniformly reach all typed/image controllers. Existing acceptance checks prevent completion into a missing session, but cancellation controls can be lost after switching away/back. Failed deletion restoring an old session is an untested acceptance edge.

A hard problem succeeding quickly while an easy one times out is not, by itself, evidence of a timeout bug. Provider variance, output length, retries and post-provider settlement are separate mechanisms; the historical cubic-root/presentation timeouts lack correlated traces.

## 7. OCR, request identity, and trust

The current UI and server carry canonical extraction validation, review actions and a canonical-input hash. Reviewed/edited submission must match the canonical text it authorizes. The server's direct gate consumes critical/structural findings and returns `OCR_REVIEW_REQUIRED`; low numeric confidence alone is not an independent fatal rule. The earlier claimed `reasons` versus `issues` mismatch was not established: historical logs can project issue types into a reasons field.

Extraction and review are origin-session operations. Initial reviewed submission can deliberately reuse that operation; retries after an error create a new Home operation. The same image hash represents content, not a unique user action. Repeated request IDs around OCR are therefore not enough to prove duplicate execution or wrong-problem acceptance. The supplied historical collision/contradiction remains uncorrelated.

**P2 trust weakness:** the server checks hash consistency but receives both extraction findings and review action from the client. There is no server-authentic extraction receipt binding image, transcription and review. A modified client can remove findings or mint a matching review action. This is a weakness in what “reviewed extraction” proves, not an authentication bypass or proof of another user's data exposure. Users can already submit arbitrary typed mathematics; the extra claim that OCR provenance was verified needs stronger evidence than a client-generated hash.

Internal request adapters now explicitly preserve authorization headers. Production typed/OCR solve parity is substantially improved. Local typed solving can use a synthetic development identity while extraction/hover/pin/compare still require verified Clerk identity. Mock-auth browser success therefore does not establish a working local or production auth path for every endpoint.

## 8. Follow-up, pin, provenance, worker, and React lifecycle

### Strong boundaries retained

Follow-ups bind request, conversation and target revision; the current owner and server echo must both match. Revision change/unmount aborts and clears ownership. Failure restores the exact question and removes the optimistic turn. Lazy explanation reducers independently reject terminal responses for no-longer-current requests. Empty/refused/truncated provider outputs have explicit failure paths.

Provenance snapshots clone and freeze occurrence identity, source range, current step, assumptions and bounded evidence. Server prompts distinguish supplied evidence from prior model prose and state uncertainty where origins are unsupported. The local fallback names the selected occurrence/current step and does not invent a deeper derivation from previous explanation text.

Home operation ownership, strict session targets and progressive sequence/attempt checks substantially reduce stale solve replacement. Progressive drafts do not become accepted steps; completed steps are detached/frozen; terminal states reject later events. The UI-hardening interaction tests passed and the existing visual changes were preserved.

### Architectural weaknesses

- **Pin cache version scope — P2:** `getLazyCacheKey` includes selected context but omits full solution/provenance revision (`ExplanationPanel.jsx:203-225`). A progressive early step can be pinned, closed, followed by later solution steps, then re-pinned under the same cache key. Older explanation context can be reused. This is a reachable code-supported lifecycle weakness; no separate browser reproduction of stale pin prose was captured.
- **Compaction — P2:** D6 drops late evidence before relevance selection. Field/character limits also mean full derivation/assumptions are not guaranteed to fit. Uncertainty instructions reduce overclaiming but cannot restore removed dependencies.
- **Worker queue — P2:** cancellation removes the pending callback and blocks stale publication, but does not cancel already posted worker computation. Obsolete jobs can delay current work. Worker failure moves pending jobs to the same serializer on the main thread; background priority does not preempt a long serializer callback. No stale worker result acceptance was reproduced.
- **State ownership — P2:** request controllers partly live in keyed composer/image components while operation ownership lives in Home. The mismatch explains lost cancellation controls and motivates lifecycle consolidation, not a cosmetic component rewrite.
- **Role vocabulary — P2:** role strings participate in annotation eligibility, aggregate ownership, scoring, coverage and grounding, not just color. D7 demonstrates an actual mismatch. Domain roles such as parameter/function space/vector should eventually be separated from structural roles such as numerator/base/bound and from interaction ownership. Merely adding color categories would not fix these contracts.

### Unresolved lifecycle hypotheses

The stationary-pointer fix is verified for the no-current-target case: measured geometry can resolve the saved pointer without movement. Recorded dense probes executed post-measure resolution. If an old target remains under the pointer while a better overlapping owner appears, reconciliation retains the old identity and the post-measure resolver returns early. The necessary browser overlap transition was not reproduced; classify this as an open risk.

The follow-up success path lacks an explicit post-await timeout flag check. Native fetch abort and microtask ordering usually enforce the intended behavior; no reachable browser timeout-success race was established. This remains an open transport-boundary hypothesis, not a confirmed silent no-op cause.

## 9. Persistence, database, and usage accounting

### Persistence/data findings

`app_users`, explanation history and sessions are expected by migrations 002/003. The historical `relation "app_users" does not exist` is consistent with a configured but unmigrated or incorrectly targeted database. The live database/schema/search path was not inspected in this audit; its present readiness is **unverified**.

History saving is now unawaited and observed. Successful answer delivery is not intentionally held for explanation persistence. That improvement trades delivery coupling for **nondurable background work**: process/serverless termination can lose a save that was reported pending. “Best effort” is not a durable queue or persistence acknowledgment.

Development fallback can return empty history and synthetic session success/deletion without durable storage. Production does not use that fallback. A presentation can therefore appear functional while history is not durable. Database pool/query calls have no explicit query/connection deadline in the inspected wrapper; this can affect session/history requests even though history save no longer gates the solve.

### Usage/accounting findings

Negative corrective writes are intentional: settlement applies actual minus reserved tokens/cost, and adjusts request count according to reported provider calls. Under a successful, single, fully applied settlement, this arithmetic converges correctly. Negative writes alone are not a defect.

The surrounding protocol does not guarantee convergence:

- Reservation reads/checks quotas, then increments eight counters sequentially. Concurrent requests can pass the same check; partial writes can leave inconsistent daily/monthly/user/global state. No cross-counter transaction or idempotent settlement receipt was established.
- Local fallback reads JSON, changes one counter and directly overwrites the file without a lock or atomic replacement (`usageLimits.js:222-278`). Lost updates and interrupted/truncated JSON remain possible. The historical corruption was not reproduced against a real user store.
- Canonical failure handling attempts to settle known usage, but unknown post-provider usage can become zero tokens/cost. Extraction, hover/pin, compare and follow-up release estimated token/cost reservations on failures that may occur after billable work.
- Ordinary successful transport retries track attempts diagnostically but settle logical successful response counts, not all HTTP attempts. Progressive outer attempts follow a different count path. A quota “request” needs one explicit definition across these paths.
- Per-model usage tags support model-aware estimates, but generic logging can disagree. Normalization/pricing do not establish provider-invoice accuracy, including cached-input discounts; no live billing reconciliation was performed.
- Usage settlement is awaited before ordinary delivery and progressive terminal success (`app.js:3217-3244,2717-2726`). KV fetches have no explicit abort deadline in the inspected store code. Provider completion can therefore be followed by a blocked or failed UI delivery boundary even when history saves are nonblocking.

**Priorities:** P1 for avoiding successful-solve delivery stalls and recurring local-store corruption; P2 for transactional/idempotent accounting and accurate unknown/failure-cost representation. Do not remove server enforcement to make solving appear reliable.

## 10. Observability assessment

**Can presentation logs alone reconstruct exactly where and why every failure occurred? No.**

Existing evidence is stronger than before: request/candidate boundary records, provider details, structural findings, progressive attempts, hover owner outcomes, reducer/DOM observations, and semantic inspectors help identify stages. But the following gaps remain:

| Gap | Consequence | Required evidence direction |
|---|---|---|
| Generic AI event substitutes configured solver model | Wrong routing diagnosis | Separate requested, role, provider-returned, accounting and display label fields |
| Provider completion/parser-purpose logs can precede actual JSON/assertion success | Completion mistaken for accepted answer | Distinct parse, structure, candidate selection, HTTP and UI-commit outcomes |
| Browser diagnostics are bounded/dev/local and may be lost | Presentation failure unreconstructable after reload/restart | Bounded, privacy-aware export of request-to-visible-outcome chain |
| Fallback DOM mutation becomes indistinguishable from original annotation | Misassigned ID looks authoritative later | Preserve ownership origin and reconciliation generation |
| Rejection records mix duplicates, syntax and unique targets | Inflated missing-hitbox counts | Separate records, unique IDs, visible primitives and dispatched targets |
| Sparse cross-boundary IDs on generic usage/save events | Unclear which solve paid/saved/failed | Logical solve, attempt, candidate, session, version and persistence settlement correlation |
| Pending history save has no durable delivery guarantee | HTTP success confused with saved history | Explicit save state and terminal durability acknowledgment |
| No independent provider payload-to-render comparison for historical incidents | Wrong API answer versus UI corruption unresolved | Bounded hashes/summaries at immutable boundaries; authorized payload capture when needed |

Model attribution must preserve provider truth where available and represent unknown/no-provider cases honestly. Accounting estimates and internal aliases are different facts. Full prompts/equations in debug captures are user data and should not be necessary for every routine event.

## 11. Performance and scaling

Measurements are single local development-browser samples, not statistically controlled production benchmarks. “Visible” means the first step heading became visible; it is not a complete first-interactive measurement.

| Fixture | Semantic nodes | Settled owners | Max event-loop delay | Key observation |
|---|---:|---:|---:|---|
| Identical subscripts ×180 | 363 | 361 distinct | 1,271.8 ms | Correct sampled first term; 1,236.6 ms pre-worker geometry |
| Numbered subscripts ×180 | 363 | 361 distinct | 354 ms | Correct sampled first term; 320.4 ms pre-worker geometry |
| Backend-annotated numbered subscripts ×180 | 363 | 361 distinct | 397 ms | Correct sampled first term; 347.5 ms pre-worker geometry |
| 20 small steps ×9 terms | 420 total | 19 per sampled chunk | 362.3 ms | 22 geometry passes; worst 23 ms, most 3–7 ms |
| Repeated powers ×100 | 503 | 162 elements / 143 IDs | 1,816.3 ms | Coverage budget exhaustion, wrong/aggregate targeting, duplicate fallback owners |
| Mixed script fixture | 35 | 23 distinct | 91.9 ms | Wrong repeated-J occurrence reproduced |
| 3×3 repeated-symbol matrix | 22 | 9 distinct | 118.5 ms | Sampled cell correct; not exhaustive primitive coverage |
| Nested fraction/radical/double integral | 56 | 44 distinct | 129.5 ms | Sampled x correct; no exhaustive gap guarantee |

Identical and numbered subscript cases have the same semantic node count but differ greatly in fallback work: approximately 50,148 versus 18,428 query calls, and 38,891 versus 7,227 client-rect calls. Authoritative geometry was much closer, roughly 154 versus 146 ms. Repeated-text candidate ambiguity and pre-worker execution matter independently of total nodes.

The worker reduces main-thread serialization work but leaves initial tree creation, KaTeX DOM rendering and geometry on the main thread. At 100 powers, worker preparation took about 1,165 ms; cancelling its owner does not remove its queued computation. The annotation cap is per expression, so distributing nodes among steps has a different failure surface.

No asymptotic law is claimed from these samples. Long PDE derivations, large aligned systems, long sums, deep tensor families, other browser engines, production builds and complete hover-activation distributions were not comprehensively profiled. The existing UI hardening remains beneficial; its passing fixtures do not cover the dense fallback path reproduced here.

## 12. Test gaps and false-confidence risks

1. **Green browser tests coexist with wrong occurrence ownership.** The 23 passing tests are meaningful for their fixtures. They do not independently enumerate every painted primitive and expected source occurrence.
2. **Serializer success stops too early.** A valid TeX wrapper and unique emitted ID do not prove geometry, pointer dispatch or follow-up grounding. Runtime fallback can modify ownership after those assertions.
3. **Coverage can be self-consistent yet wrong.** Production coverage calls may omit actual primitive, pointer-resolution and dispatch evidence. A DOM ID can agree with a measured target because both inherited the same wrong fallback assignment.
4. **Some browser helpers choose an already-overlapping rectangle.** This proves a reachable fragment but can miss uncovered fragments in a composite token.
5. **Node-count stress is not local-density stress.** The 300+ distributed-node hardening fixture passed; 503 locally dense scripted nodes degraded severely.
6. **Skipped tests are not protection.** Seventeen fast-solve cases and four JSON cases are skipped; a legacy diagnostics suite is separately skipped. Several expectations concern superseded final-answer/repair policy. Maintain reasons and replacement coverage rather than blindly re-enabling obsolete rejection behavior.
7. **Source-text tests prove wiring strings, not runtime behavior.** Composer source matching and CSS text checks cannot establish actual dispatch, computed layout or lifecycle outcomes.
8. **Mocked success is not production proof.** Auth was mocked in browser tests; real provider chunking, refusal distributions, latency, cancellation billing and hosting termination were not exercised. The separate provider-stream browser configuration also uses a local deterministic provider fixture.
9. **Concurrency/storage tests do not establish atomicity.** Cross-process local-store writes, quota check/increment races, partial settlement, and process death during pending saves need meaningful failure-injection coverage.
10. **Lifecycle boundary gaps remain.** Progressive pin re-use across revisions; 64-to-48 evidence truncation; overlapping stationary-pointer re-ranking; queued worker cancellation; and evaluation-bar ownership need explicit end-to-end oracles.
11. **The lost full-suite failure stays recorded.** One guarded run failed one unidentified test before a clean retry. Its cause cannot be labeled flaky timing, environment, or product without the missing output. Historical serial/parallel differences likewise remain unresolved.

There is no new independent human-verified master's-level answer corpus in this audit. The existing verifier calibration and fixtures provide useful bounded evidence, not a proof that difficult unseen mathematics is solved correctly.

## 13. Security and trust boundaries

Inspected protections include verified Clerk tokens, server-side user identity, user-scoped session SQL, header-preserving internal adapters, bounded request/upload sizes, MIME/signature checks, server-only provider credentials, and public-safe production error messages. No cross-user session/history disclosure was found in the inspected paths. This was not a penetration test or live deployment audit.

Remaining relevant weaknesses:

- OCR review hashes prove consistency with submitted content, not authenticity of server extraction/review findings.
- If explicitly enabled in production, `/api/debug/openai` is unauthenticated, makes a provider call and returns runtime/provider diagnostic details (`app.js:2297-2329,4223-4226`). This is a P2 configuration-dependent exposure; no claim is made that the flag is enabled in the deployed application.
- Public health output exposes operational/model/env-loading metadata. It is not evidence of API-key disclosure, but its production information surface should be deliberate.
- The inspected remote database SSL wrapper uses `rejectUnauthorized: false`; encrypted transport alone does not validate server identity. Deployment/network consequences were not tested.
- Process-local dedup and non-atomic quota checks do not provide a deployment-wide concurrency enforcement boundary.

No secret-bearing environment values were needed for the report, and no provider key was placed in frontend code.

## 14. Historical incidents retained independently

| Historical incident | Current classification | What this audit does and does not establish |
|---|---|---|
| 180-term subscript, 363 nodes, 691 owners, 499 rejections; first position mapped to later operator | **Historical incident not reproduced / unresolved** | All three 180-term shapes retained 361 distinct settled owners and correct sampled first term. Original payload and transient DOM trace unavailable. |
| Scripted-base ownership | **Confirmed current defect; related historical class reproduced** | D1 proves occurrence shift; D2 proves dense scripted degradation. Empty `ownedPrimitiveRects` alone is not missing leaf paint. |
| Sep 11 typed problem failed twice | **Historical incident not reproduced** | No surviving request-to-visible-failure correlation; cannot assign routing, provider, persistence or UI cause. |
| Sep 11 pinned chat appeared unresponsive | **Historical incident not reproduced** | Current ownership/failure recovery checks and browser cases pass; no proof which historical transition failed. |
| Sep 11 two blank middle-step solutions | **Historical incident not reproduced** | Structural/render boundaries improved; original payloads absent. Missing mathematical reasoning remains possible despite nonblank fields. |
| Sep 11 roughly 3–4 hover follow-up failures | **Historical incident not reproduced** | Provider completion does not establish visible lens completion. Current fixture coverage does not reconstruct those calls. |
| Hard problem failed four times, repeated excuse; another succeeded on third attempt | **Historical incidents not reproduced** | Ordinary same-role retries and absent quality escalation are plausible contributors, not established causes. Keep the two incidents distinct. |
| Malformed/incorrect JSON; uncertainty whether API answer or UI corrupted it | **Historical incidents not reproduced** | Current parsing/structural boundaries inspected; no original paired payload/DOM evidence. |
| Unexplained generated symbol / numerical mismatch / valid answer rejected | **Historical validator incidents, not individually reproduced** | Current warnings and evidence-only policy differ from earlier rejection behavior; no universal correctness conclusion. |
| Final answer systems/line breaks flagged | **Historical rejection mechanism partially resolved** | Current rules warn; schema still lacks explicit result grouping. |
| OCR reviewed/checked yet gate required review | **Historical incident not reproduced** | Current hash/action binding inspected; no demonstrated reasons-versus-issues mismatch. |
| OCR presentation/read failure and repeated image hash/request IDs | **Historical incidents not reproduced** | Shared solve/auth adapter improved; extraction remains separate. Repeated hash alone does not establish collision. |
| Image fallback lost auth | **Previously reproduced historical defect; current boundary improved** | Explicit header copying and existing regression evidence retained; no new live deployment reproduction. |
| Easy/cubic-root timeouts, repeated presentation failures | **Historical incidents not reproduced** | Deadline, retry and settlement weaknesses identified independently. |
| Missing/disappearing fraction/radical targets, deep matrix follow-up, long-expression failures | **Historical classes partially sampled, not closed** | Nested/matrix sample owners and focused suite pass; no exhaustive advanced-notation guarantee. |
| Missing `app_users`, session/history fallbacks | **Historical operational failure; current readiness unverified** | Schema requirements/fallback behavior confirmed; live database not repaired or queried. |
| Local usage JSON truncation/corruption | **Historical incident not reproduced; enabling weakness still present** | Unlocked direct rewrites remain in code. |
| Hover provider mini, later telemetry Luna | **Confirmed current attribution mechanism** | D4 explains how labels diverge; original event was not reissued. |

## 15. Audit #1 status

An identifiable authoritative September 2 checklist was not available in the inspected historical record. This prevents an honest item-by-item closure claim. The following compares broad concerns described in the supplied history and later retained investigations, not an invented Audit #1 inventory.

| Concern family | Status at Audit #2 |
|---|---|
| Typed/OCR duplicated solve behavior | **Partially resolved:** canonical solve convergence; extraction/review/auth and compatibility differences remain |
| Successful response blocked by history save | **Resolved for that dependency; replaced by another risk:** unawaited nondurable save; usage settlement still gates delivery |
| Internal image adapter loses authentication | **Resolved in inspected adapter path:** explicit header preservation; live deployment not verified |
| Valid multi-result final answers rejected by coarse shape rules | **Partially resolved:** warnings/recoverable formatting; ambiguous schema remains |
| Blank/malformed accepted/rendered content | **Partially resolved:** stronger structural boundaries and visible errors; completeness/legacy payload limits remain |
| Automatic difficult-problem escalation | **Still limited / changed:** solver-first ordinary policy; separate progressive recovery with default escalation suppression |
| Hover occurrence/geometry correctness | **Still present in a different demonstrated mechanism:** validated TeX followed by wrong fallback assignment |
| Follow-up provenance/stale responses | **Substantially improved, partially resolved:** version/echo/reducer safeguards; cache and compaction gaps remain |
| Rendering performance | **Improved but incomplete:** worker/scheduling benefits; dense pre-worker pointer path still blocks |
| Persistence/usage operational readiness | **Still present:** migration readiness unverified; local-store and accounting weaknesses remain |
| Incident reconstruction | **Partially resolved:** richer diagnostics, but attribution errors and nondurable browser evidence remain |

## 16. Evidence-backed bug constellations

### A. Scripted rendering → fallback identity → geometry → grounding

Layout-changing base annotation is correctly rejected → source-order fallback filters claimed matches → occurrence shifts → DOM is mutated with the wrong ID → later measurement calls it authoritative → aggregate/pin/provenance can inherit the wrong occurrence. D1 is the concrete causal anchor. Dense annotation-budget exhaustion increases exposure to this path. It does not establish the exact historical subscript incident.

### B. Worker preparation → early pointer entry → main-thread freeze

Worker output is pending → scheduled geometry waits, but pointer entry bypasses readiness → legacy matching runs synchronously over a dense expression → large DOM query/rect volume → visible solution appears unresponsive. Recorded timings isolate this mechanism. Total page nodes do not explain it alone.

### C. Structurally acceptable answer → mathematical false confidence

Schema/renderability passes → limited verifier evidence is attached → evidence-only policy accepts even contradictions → ordinary quality escalation does not run. These policies explain why a green pipeline can deliver wrong mathematics. No particular September wrong answer is attributed without its payload.

### D. Provider completes → accounting/persistence boundaries → uncertain outcome

Usage settlement remains awaited and non-atomic; history save is unawaited and nondurable. Therefore “provider completed,” “HTTP delivered,” “visible answer,” and “history saved” are separate facts. They must not be collapsed into a single persistence-root-cause explanation for presentation failures.

### E. Provenance versioning → independently bounded caches/evidence

Immutable follow-up provenance is strong, but lazy pin cache identity omits full revision and server compaction truncates before relevance selection. Context can become stale or incomplete without a stale request ID. Neither mechanism has been tied to the Sep 11 silent pinned chat.

## 17. Invariant audit

| Invariant | Result |
|---|---|
| One action has one canonical logical solve identity | Mostly established within Home; content hashes, adapters and process-local dedup are distinct identities |
| Only a usable current candidate reaches the UI | Structural/current-operation boundary established; mathematical validity explicitly not guaranteed |
| Work from solution N cannot mutate N+1 | Strong operation/attempt/reducer checks; pin cache version scope remains a contextual exception |
| Identical symbols retain distinct occurrence ownership | **Violated by D1** |
| Every hoverable node has deterministic authoritative paint ownership | **Violated for reproduced scripted cases**; unsupported syntax must be accounted separately |
| Geometry matches the current DOM/layout generation | Explicit checks present; runtime fallback identity and overlapping stationary-pointer risk remain |
| Stationary pointer resolves when geometry becomes available | Confirmed for no-current-target case; overlap re-ranking unverified |
| Follow-up uses exact target/version and sufficient evidence | Identity strong; evidence sufficiency limited by D6 and pin cache scope |
| Reviewed OCR means the same canonical content at both gates | Hash/action consistency present; server-authentic review not established |
| Telemetry reports actual provider model | **Violated by D4** |
| Best-effort history save cannot block successful delivery | Established for explanation save; usage settlement remains a separate delivery dependency |
| Reservation/reconciliation converges to actual usage | Arithmetic correct in complete single settlement; atomicity, retries and unknown usage prevent a general guarantee |
| Safe rendering does not silently become unsafe ownership | **Violated by fallback reassignment after valid layout rejection** |
| Diagnostics distinguish events, unique nodes and painted coverage | **Violated by duplicate/mixed rejection counts and incomplete coverage evidence** |

## 18. Remediation roadmap — not implemented

### P0 — Mathematical assurance policy

- Define the product's guarantee for contradictory, inconclusive and independently supported mathematics. Make verification scope and uncertainty visible where meaningful.
- Establish expert-checked advanced-math/physics cases with assumptions, branches, systems and completeness expectations. Connect supported contradiction evidence to an explicit reviewed policy rather than blindly reinstating all legacy validator rejection.
- Preserve the current distinction between structural usability and mathematical truth. No evidence supports claiming this audit certifies master's-level correctness.

### P1 — Demonstrated semantic reliability and solve delivery

- Correct repeated-occurrence fallback allocation and retain ownership provenance through remeasurement; cover J/star/inverse/prime/combined scripts and repeated families.
- Prevent the pre-worker pointer path from invoking the reproduced long synchronous geometry reconstruction. Preserve layout equivalence and the recent stationary-pointer fix.
- Make annotation-budget exhaustion an explicit, safe interaction outcome; do not silently claim precise ownership after coverage degrades.
- Align ordinary/progressive routing and escalation contracts with what the UI/operator is promised; test effective configuration, including same model with different reasoning.
- Bound usage settlement within an explicit operation lifecycle while retaining server quota enforcement; address the local JSON corruption mechanism.

### P2 — Context, durability, accounting, and trust

- Bind pin caches/in-flight reuse to the intended solution version; preserve selected-step dependencies before server compaction.
- Make quota check/reserve/settle atomic and idempotent at the required deployment scope. Record unknown provider usage rather than treating it as known zero; reconcile all route failure policies and request-count meanings.
- Validate database readiness before presentations; distinguish transient UI/session fallback from durable saving. Give pending saves an appropriate durability mechanism and observable terminal result.
- Preserve provider/requested/accounting model attribution and end-to-end correlation; provide bounded incident export.
- Unify cancellation ownership across session/composer/image lifecycles and manage obsolete worker queue work.
- Resolve evaluation-role ownership; strengthen OCR receipt semantics if the product claims server-verified extraction review; deliberately constrain debug/health production exposure and DB transport trust.

### P3 — Diagnostic and maintenance precision

- Deduplicate rejection counts and separate syntax/unsupported nodes from missing painted primitives.
- Rename misleading final-answer warnings and document the result-shape contract.
- Restore a clean typecheck; document skipped tests and their active replacements; update stale instructions that say no test script exists.
- Remove or clearly mark inactive recovery/candidate helpers only after the active contract is settled. Do not refactor giant components solely because of size.

## 19. Smallest coherent first implementation phase

**Restore trustworthy scripted-occurrence interaction at the annotation-to-geometry boundary.**

Scope it to D1 plus the directly related pre-worker interaction path in D3, with focused regression evidence for D2. Preserve the existing UI, TeX layout guard, source-range identity, worker output protocol, pin behavior and post-measure pointer acquisition.

Acceptance criteria for that future phase:

1. Every painted J in `J^2+J^*+J^{-1}` maps to its own source occurrence through hover/pin dispatch; unsupported annotation must not acquire a sibling's identity.
2. Repeated script families verify expected glyph-to-occurrence mapping independently of existing DOM IDs, including after remeasurement/scroll/reflow.
3. Entering dense math before worker readiness does not run the reproduced long synchronous fallback reconstruction; geometry arrival still resolves a stationary pointer.
4. Coverage diagnostics retain original-versus-fallback ownership and unique failure counts.
5. Existing 23 browser cases and relevant unit checks remain intact; targeted dense probes become meaningful regression oracles.

Do not redesign the full schema, rebuild MathChunk, alter mathematical acceptance policy, or expand model budgets as part of this first phase. The P0 assurance-policy work is a separate decision track because an unsafe validator change could reject valid advanced mathematics.

## 20. Confidence, blind spots, and remaining questions

**High confidence:** the mixed-J occurrence shift; correct rejection of layout-changing wrappers; the dense superscript annotation-budget/fallback failure; synchronous pre-worker geometry stalls; generic model-label substitution; current final-answer warning semantics; evidence-only acceptance; compaction limit mismatch; recorded test outcomes.

**Inspected across current code, with bounded runtime coverage:** canonical solve/routing/acceptance, OCR review/adapters, provider retry/timeout handling, usage and persistence, auth ownership, Home/progressive state, follow-up/provenance, semantic source/annotation/DOM/geometry/pointer boundaries, worker lifecycle, role eligibility, and test architecture. Backend conclusions are principally static boundary traces plus existing offline test evidence; browser probes exercise fixture content in the real frontend.

**Partially verified:** every possible normalization form; all advanced notation ownership; assumption/branch correctness; cross-process accounting; actual database readiness; cache behavior under all persisted/imported shapes; production hosting/stream buffering/termination; stationary overlapping-owner reconciliation; cancel/timeout races with real provider timing. No claim of exhaustive inspection of every line or execution path is made.

**Not reproduced:** the historical 691-owner subscript failure and wrong-later-operator selection; the individual Sep 11 presentation failures; original malformed/incorrect provider payloads; live database relation error; local usage-file corruption; the unidentified first-run unit failure; historical parallel/serial browser differences.

**Environmental limits:** reconnects interrupted agents/processes and lost temporary logs; a temporary restricted sandbox blocked Vite cache/config writes before browser access was restored; one cold-start navigation timed out before the successful run. These setup failures were not counted as product defects. Browser results are Chromium/Vite with mocked auth/API and single-run timings. No paid provider calls, live auth/store/database tests, invoice comparison, or production-like deployment benchmark was authorized/performed.

The historical 691-owner question requires its exact input/explicit-parts payload and a stage-by-stage transient ownership trace to resolve. Today's settled successes do not close it. The delivered report is the architectural baseline supported by the collected evidence; all unverified areas remain explicit rather than converted into a clean bill of health.
