# OmniMath architecture reconciliation

Investigation started 2026-09-14; consolidation resumed 2026-09-15. Baseline: the existing dirty working tree, including its untracked lifecycle/policy modules. No production fix, acceptance-policy change, external provider call, database migration, or commit was performed. Provider responses in reproductions are mocked.

## Decision

**Classification B: partially shared mechanism with independent defects.** The shared-source-of-truth hypothesis is **partially confirmed as a boundary design pattern**, not confirmed as one common executable root cause.

OCR decisions and model logs reconstruct a stronger claim from a weaker proxy: image provenance becomes “reviewed,” missing validation becomes “checked,” unchanged text becomes “no review,” and the solver default becomes the model for a completed hover. These are independent locations with a similar mistake. Mathematical verification and acceptance, however, have an explicit, intentional boundary; their separation is a counterexample to treating all plural state as architectural drift.

The narrow principle is: **a stage must report the fact owned by its originating operation, or explicitly report it as unknown; a proxy, default, or earlier lifecycle stage cannot establish that fact.** This does not require a global state object or merging evidence with policy.

Final falsification check: model mislabeling occurs with a single request and correctly tagged settled usage, so a concurrency race is unnecessary. OCR disagreement occurs before shared solver/provider/persistence work. Trust finalization explicitly produces both evidence and acceptance, and cache hits refresh both. Thus A is unsupported; C incorrectly treats the trust boundary as a third independent defect; D understates the reproduced evidence. B describes the narrow shared pattern while preserving independent causes.

## Reproduction status

| Member | Result | Limit |
|---|---|---|
| A. OCR checked/reviewed versus review required | Reproduced through the actual submission builder, pending state builder, backend gate, and actual browser components. Unchanged confirmation carries `source=ocr-reviewed` but `solveDecision=direct`; server returns 409 `OCR_REVIEW_REQUIRED`. The browser renders the error, “Extraction checked,” and “reviewed extraction” together. | Browser API responses are mocked; the backend gate is separately executed. The historical image and complete incident event stream are unavailable. |
| B. Hover model attribution | Reproduced with one mocked provider response: request `gpt-4.1-mini`, returned `gpt-4.1-mini-2025-04-14`, final log `gpt-5.6-luna`. | Synthetic prices test arithmetic and metadata ownership, not provider billing or current market prices. |
| C. Contradiction coexistence | Existing injected fixture reproduces claimed integral 3, deterministic exact integral 2, accepted HTTP 200 on typed, direct OCR, and typed cache paths. | This is deliberately injected content, not a demonstrated live-provider math error. The existing test title says reviewed OCR, but its helper sends `direct`. |
| D. Repeated canonical solve IDs | Browser test: one Continue click produces one request; 250 ms idle after rendering produces no extra request; a second explicit click produces a distinct canonical ID for the same image hash. Retries can remain within one UI operation. | No automatic duplicate was reproduced. This bounded observation does not establish the historical clicks or exclude rare duplicate events, remounts, or other scenarios. |
| E. Missing persistence schema | Two focused tests pass with mocked PostgreSQL 42P01: development session create/update preserve the submitted session in explicit fallback responses; typed solve returns HTTP 200 and steps despite a background save warning. | The immediate-rejection fixture proves success despite persistence failure, not relative timing of HTTP versus failure completion. The actual local schema was not inspected or repaired. |

Detailed subsystem evidence: [OCR](architecture-ocr-investigation.md), [model identity](architecture-model-investigation.md), [mathematical trust](architecture-trust-investigation.md), [persistence](architecture-persistence-investigation.md).

## OCR ownership and transitions

1. **Input/readability.** `ImageUpload` owns file selection, local quality results, per-session workflow state and abort ownership. Local readability/OCR confidence is not human review completion.
2. **Extraction.** `handleExtractImageProblemRequest` owns OCR output normalization and `validateExtraction`. It creates `extractionValidation` containing structural issues, criticality, status, tier and metrics. Top-level confidence/tier/issues and `imageSource` contain projections of that assessment (`server/app.js:2781–2843`).
3. **Automatic solve choice.** `ImageUpload.jsx:571–580` uses high confidence and absence of criticality. The backend's `assessOcrSolveDecision` additionally recognizes structural review issue types. These are competing eligibility predicates; high confidence is not evidence of absence of a structural review finding.
4. **Review action.** The review panel presents “Continue with reviewed text.” `solveReviewedExtraction` compares edited and extracted strings and maps unchanged text to `direct`, even after that human action (`ImageUpload.jsx:694–701`). The same payload marks canonical provenance `ocr-reviewed`. Acknowledgement and editing are different facts; the current mapping loses acknowledgement.
5. **Pending UI commit.** `Home.handleReviewedProblemSubmitted` commits before the request settles. `createPendingReviewedProblemState` nests extraction evidence under `imageSource`, without putting `extractionValidation` at the top level (`solutionState.js:114`). This is also used by the automatic path; the function's name is not proof of human review.
6. **Labels.** `ProblemBlock.getProblemMetadata` calls an image-backed, unedited problem “reviewed extraction” (`ProblemBlock.jsx:127`). Its extracted-problem card reads only top-level validation and defaults absent status to `ok`, yielding “Extraction checked” (`ProblemBlock.jsx:226`). Pending-state nested evidence is therefore invisible to that label. Neither label is an authoritative review-completion record.
7. **Canonical submission.** `solveCanonicalProblem` sends canonical text, provenance, extraction metadata and `solveDecision`. Backend `handleSolveExtractedProblemRequest` uses nested `extraction.extractionValidation`, with a legacy-summary fallback only if it is absent. `assertOcrSolveAllowed` owns server eligibility: structural/critical findings block `direct`; existing explicit `edited`/`anyway` decisions are allowed.
8. **Shared solver.** Only after the gate passes does the adapter normalize canonical provenance from the decision, preserve the request ID and authenticated request, and invoke the typed solver through a server-owned context. It does not trust the client provenance label to bypass review (`server/app.js:2915–2998`).
9. **Error/UI.** A 409 leaves the already committed pending problem visible, alongside generation failure and a retained review workflow. Thus the positive labels and review-required error can coexist without any provider solve call.

Exact divergence points are the acknowledgement-to-`direct` mapping, pending-state-to-label evidence loss, and source-presence-to-reviewed label inference. The server is correctly enforcing its existing gate in the reproduction.

## Model identity and accounting

The hover route passes mode and request context to `createLazyTokenExplanation`; role selection resolves the hover configuration. That selected model becomes the provider request's model. The dated model in the provider response is a distinct legitimate fact.

On success `requestOpenAi` tags usage with the **requested model** in `_omni_model_usage` and retains diagnostics. The route passes that usage to cost estimation and settles the reserved quota. `estimateOpenAiCost` consumes tagged per-model usage before its generic fallback; normalizing token totals does not supply the model label for the log.

The exact incorrect transition is `logExplanationSource` in `server/app.js:1943–1963`: line 1959, `model: getOpenAiModel()`, queries the default solver model anew. It does not read the completed operation's requested model. The isolated reproduction falsifies a need for misrouting, cross-request concurrency, or provider model substitution to explain the mismatch. Both this reference and the settlement call at line 3199 were rechecked against the working tree on resumption.

The fixture settles and persists 3,000 tokens and 5,000 cost micro-units using intentionally configured synthetic mini prices, while printing the Luna model label. The label is wrong; the reproduced aggregate settlement is correctly priced. A second demonstrated detail loss occurs at `app.js:3199`: hover settlement passes total tokens and cost but omits input/output counts, so its response reports `actualInputTokens:0` and `actualOutputTokens:0` despite provider usage of 1,000/2,000. Current usage storage contains aggregate counters, not a per-model billing ledger. A consumer grouping these log records by `model` would be misled, but such a downstream consumer was not demonstrated.

Further observability limits: the final `ai-request` event omits request/response IDs; usage reservations have aggregate keys but no unique settlement ID; generic preflight cost estimates are distinct from settled model-aware cost. Requested alias versus returned version must remain separate fields. See the model appendix for selection/default/normalization sites.

## Mathematical trust and delivery

The live pipeline normalizes a candidate and finalizes it before delivery; cache hits clone and re-finalize the cached candidate. `finalizeSolveCandidate` asserts usable structure, obtains an assessment, and replaces provider/cached evidence fields with the server assessment (`solveCandidateLifecycle.js:5–27`).

`verifySolution` owns bounded claim extraction from original step/final-answer fields and links supported final claims to submitted input. The deterministic verifier owns per-claim evidence (`verified`, `numerically_supported`, `inconclusive`, `contradicted`). Its summary explicitly keeps whole-solution correctness `not_established`. Coverage does not imply a proof of all prose, intermediate implications, or completeness.

`decideCandidateAcceptance` owns a separate explicit policy: usable structure is accepted in `evidence_only` mode, including with contradiction evidence; correctness remains `not_established`, and this policy requests neither repair nor escalation. The acceptance reason explicitly names contradiction evidence. This is not a lost contradiction or a competing “mathematically correct” flag.

Retry/repair/delivery eligibility also involves the existing structural candidate ledger and provider/parse/presentation failure orchestration in `app.js`; mathematical verification does not drive those retries. `handleExplainRequest` owns HTTP delivery and caching. The client normalizer preserves verification/acceptance metadata; `Home` owns operation-safe UI commit. `getGeneratedProblemStatus` owns readiness based on steps and save warnings. No frontend consumer renders these new mathematical verification/acceptance fields as a trust status.

The exact coexistence point is the deliberate return of `accepted: true` by `solveAcceptancePolicy.js:7`, after evidence exists. “Explanation ready” describes content availability, not established mathematical correctness. The UI's lack of an evidence presentation contract is a separate product/architecture gap; this investigation does not make the verifier authoritative or alter delivery.

## Identity hierarchy and correlation gaps

| Identity | Owner / meaning | Propagation and limits |
|---|---|---|
| Clerk `sub` / user ID | Verified account identity | Used for quota and cache partitioning; mapped to internal `app_users.id` for persistence. Local dev fallback identities are route-specific. |
| Clerk `sid` | Authentication session | Logged during verification; distinct from the workspace session UUID, and not retained in the returned usage identity. |
| Workspace session UUID | `Home.createSession` UI/persistence identity | Reused for `user_sessions.id` when valid. Owns problems, windows and operation revisions. |
| `operationId`, `originSessionId`, revision | Home logical workflow and stale-response ownership | A reviewed retry reuses the image operation. These values protect UI commits but do not travel in the canonical solve wire payload. |
| Client `imageHash` | ImageUpload file metadata fingerprint | Filename/type/size/mtime/confidence concatenation, **not** a byte hash. |
| Server `imageSource.imageHash` | SHA-256 of uploaded bytes | Content correlation, not action or attempt identity. Repeated uploads and retries can share it. |
| Canonical `hash` | Hash of text, LaTeX, source, warnings, confidence | Identifies a canonical representation; not an authorization or unique operation ID. Review provenance changes can change it. |
| Canonical `contentHash` | Hash of canonical text | Can remain stable while provenance changes; intentionally distinct from payload hash. |
| `canonical-solve-*` | Client HTTP solve invocation/attempt | Generated on each `solveCanonicalProblem` call; forwarded through the OCR internal adapter, responses and solve diagnostics. Backend fallback IDs use `solve-text-*`/`solve-extracted-*`. |
| `image-extract-*` | Client extraction HTTP invocation | Appears in extraction review logging; not a durable parent ID linking all subsequent solve attempts. |
| Cache/dedup key | Server semantic work-sharing identity | User, normalized problem, reference, depth, type, and optional image hash. It is not a request ID. In-flight followers can share one provider operation. OCR reference defaults include image hash and decision. |
| Provider attempt ordinal | Provider transport attempt within a request | Retries need not produce new canonical IDs. Provider body `id` is retained as response ID; a distinct provider HTTP request-header ID is not captured here. |
| Hover request / owner / transport IDs | React consumer lifetime versus shared request | Owner-local counter and owner sequence distinguish consumers; in-flight reuse carries the originating transport ID. Transport ID derives from mode/counter/cache hash and is not globally unique across remounts. |
| Semantic target / step / source range | Math interaction identity | Carries selected math context; not a provider request or persistence key. |
| Solution revision / target revision | Hashed provenance content and selection revision | Protects follow-up interpretation against stale target content. |
| Conversation ID | Stable problem/step/target/range identity | Distinct from per-message `followup-*` request ID; target revision must still match. |
| Usage reservation keys | User/global, metric, daily/monthly counter scope | Settlement uses the originating reservation object; no standalone durable operation/settlement ledger or per-model key. |
| Saved explanation UUID | `user_explanations` persistence record | Background-generated; independent from delivered solve request and workspace session IDs. |

Relevant implementations: `usageIdentity.js:240`, `Home.jsx:58,298`, `sessionOperations.js:6`, `canonicalProblem.js:44`, `mathClient.js:118,253`, `explanationCache.js:16`, `duplicateRequests.js:3`, `ExplanationPanel.jsx:100,320,531,991`, `explanationProvenance.js:110,156,165`, `usageLimits.js:820`.

## Repeated solve IDs: what the evidence permits

One image interaction can contain extraction, an automatic direct solve, then explicit review/retry submissions. Every solve call generates a new canonical ID, while the image bytes and originating operation can stay the same. Conversely, multiple provider transport attempts remain under the same canonical ID. The OCR adapter forwards its request ID into the shared handler rather than creating another.

The visible retry path can repeatedly send unchanged text as `direct`, so repeated explicit clicks legitimately produce repeated 409 responses under distinct IDs. The targeted browser test executes that path: one click/one request, no additional request in 250 ms of idle time after the error renders, then a second click/second ID. IDs and image hash alone cannot recover historical clicks. There is no basis to call the historical observations duplicate provider solves: rejection occurs before shared solver/provider work. There is no solve retry loop in the inspected ImageUpload path; high-tier automatic submission and unusual event/remount races are outside this browser test.

## Persistence context and extra duplicated state

`db.query` wraps missing-relation errors as `DATABASE_UNAVAILABLE` while retaining `pgCode=42P01`. Development user-data endpoints catch this and return `databaseConfigured:false`, `fallback:missing_local_schema`; create/update may echo the session payload with its ID. Background explanation save logs and catches errors. It cannot revoke the delivered answer or supply OCR eligibility/model selection/verification evidence.

Usage counters use local-file or Redis storage independently of `app_users`; quota settlement remains awaited and is a different failure boundary from history/session storage. Missing `app_users` therefore does not explain the reproduced OCR, model or trust behaviors.

An adjacent code-confirmed boundary concern is `Home.jsx:465–477`: any successful session-save response is normalized with `persisted:true`, `dirty:false`; after applying it, line 526 sets “Saved.” It does not distinguish the development fallback's explicit `databaseConfigured:false`. This was established by backend fault injection plus static consumer inspection, not a persistence browser reproduction. It can misrepresent durability and affect later restore expectations; no historical consequence is established. These are session-save responses, not solve responses. Separately, background explanation `saveStatus:pending` is only a live-response snapshot, not a promise of durable queued work.

## Duplicated representations: legitimate versus dangerous

| Representations | Assessment |
|---|---|
| Extraction confidence, structural findings, human acknowledgement, edit state | Legitimately different concepts. Dangerous when confidence substitutes for eligibility or string equality erases acknowledgement. |
| Nested `extractionValidation`, top-level summaries, `imageSource` summaries | Projections are legitimate if tied to the same extraction revision; consumer precedence and missing-evidence defaults currently cause disagreement. |
| Canonical `source`, `solveDecision`, “reviewed extraction” label | Provenance and action can differ legitimately. Current label inference and unchanged-action mapping overclaim/lose human review. |
| Missing top-level validation versus `status=ok` | Dangerous: absence becomes a positive “checked” claim. |
| Requested model alias, returned model version, usage model tag | Legitimately distinct, originating facts. No collapse required. |
| Completed-operation model versus `getOpenAiModel()` in final log | Dangerous reconstruction from a route default; confirmed wrong label. |
| Provider input/output counts versus settlement detail | Dangerous dropped arguments: nonzero counts become default zero values, although aggregate totals/cost remain correct. |
| Estimated reservation cost versus settled actual usage cost | Legitimately separate; do not infer incorrect settlement from the generic preflight budget. |
| Verification states versus structural acceptance versus readiness | Intentional separation. Dangerous only if consumers interpret structural acceptance/readiness as proof of correctness. No contradictory correctness decision was found. |
| Structural lifecycle acceptance and fallback ledger `accepted` | Multiple structural consumers; existing tests assert agreement. No divergent mathematical authority demonstrated. |
| Logical operation, HTTP request, provider attempt, UI owner, database record | Legitimately separate identities; missing links and overloaded names impede diagnosis. |
| Client/server `imageHash` | Different concepts sharing a name; correlation hazard, not proof of duplicate submissions. |
| Server persistence fallback versus client `persisted`/“Saved” | Dangerous success-to-durability inference; adjacent to, not causal for, the three primary reproductions. |

## Recommended milestone order (future authorization required)

1. **Reconcile OCR acknowledgement and its presentation.** Give an explicit unchanged-text confirmation a distinct representable review action; retain the current structural gate for unreviewed direct submissions. Derive pending/final labels from actual assessment and action for the submitted input revision; absence is unknown. Have automatic submission consult the same structural eligibility contract the server enforces. The backend remains authoritative.
2. **Correct operation-model observability independently.** Feed final logging the settled per-call model metadata, with separate requested/returned fields and a request ID; pass the already known input/output counts into settlement. Do not change routing, prices or acceptance. Cached/no-provider events should not invent a called model. Multi-call solves should retain their model breakdown. Changing reservation estimates is a separate decision, unnecessary to correct the demonstrated final label/detail loss.
3. **Document the trust boundary as an explicit consumer contract.** Preserve `evidence_only` and `not_established`; specify how readiness and any future evidence display differ. No verifier redesign or complete-solution holdout yet.

This order prioritizes the confirmed blocked user interaction: OCR contract first, model logging/token detail second, trust consumer documentation/tests third. The model log correction is the smallest isolated patch and can be reviewed independently. The smallest user-flow repair is the OCR action/label contract; changing just the label or just a confidence threshold would leave the underlying acknowledgement mismatch. Correlation enrichment and persistence durability labeling are separate follow-up work, not prerequisites for these narrow corrections. A unified global state redesign is not justified.

Removed from the active defect claims: repeated canonical IDs as proof of duplicate submission; requested alias versus returned version as a routing defect; wrong aggregate hover cost in the reproduction; contradiction acceptance as accidental state corruption; and missing `app_users` as the shared root cause. None of these removals claims universal correctness beyond the observed paths.

Accompanying tests: unchanged confirmation versus unreviewed automatic solve; edited/explicit reviewed actions; high-confidence structural findings; pending/rejected/restored label correctness; revision changes invalidate prior acknowledgement; one automatic attempt followed by one attempt per explicit retry; stale-operation rejection; requested alias/returned version/log/settled cost agreement; cache and mixed-model accounting metadata; preserved evidence-only contradiction acceptance and inconclusive handling. A focused missing-schema test should separately preserve answer delivery and distinguish fallback from durable save.

## Unproven and intentionally deferred

- Exact historical user click sequence, payload and DOM state; one reproduction mechanism does not uniquely reconstruct the incident.
- A live provider producing the injected wrong mathematical result.
- Mathematical verifier completeness, contradiction precision on unseen problems, or justification for changing acceptance.
- Spontaneous repeated OCR submission outside the focused tested lifecycle scenarios, and cross-tab/remount/network replay cases.
- Actual vendor billing or a downstream log-based accounting consumer; the observed accounting evidence is deterministic local settlement.
- Current local DB schema and whether fallback later contributed to a particular session restore incident.
- A common mutable object, concurrency race, or single owner whose corruption causes all three primary symptoms. Current evidence does not support that stronger claim.

No retired summer validator was restored or generalized. No complete-solution trust holdout was started.

## Executed tests and investigation artifacts

Final results across this continuous session: **31 Node tests and 1 focused browser test passed**. Earlier completed suites were not rerun on resumption; only the interrupted persistence fixture was finished. No full browser suite, provider calls, migration, or broad verification campaign was run.

| Executed scope | Final result |
|---|---|
| `tests/architectureOcrReconciliation.test.mjs` | 2 passed |
| `tests/architectureOcrReconciliation.layoutRegression.spec.mjs` (only this browser spec) | 1 passed |
| `tests/architectureModelReconciliation.test.mjs` | 1 passed |
| `tests/failedSolveDiagnostics.test.mjs`, name pattern `common mathematical evidence through HTTP solve routes` | 2 passed |
| `tests/solveCandidateLifecycle.test.mjs` | 24 passed |
| `tests/architecturePersistenceReconciliation.test.mjs` | 2 passed on final run |

Node runs used `node --import ./tests/helpers/noExternalNetwork.mjs --test`, adding the named file and, for the trust route suite, `--test-name-pattern='common mathematical evidence through HTTP solve routes'`. Provider responses were mocked. Browser extraction/solve routes were intercepted; the Node socket guard does not establish a general Chromium networking guarantee.

Persistence fixture execution on resumption initially failed twice because local-rule selection bypassed the mocked provider branch. Only its investigation-test prompt was adjusted; the final run exercises one mocked provider call and the missing-schema failure and passes both tests. These were fixture coverage failures, not evidence of a production persistence regression.

New investigation-only documents:

- `docs/architecture-reconciliation.md` (this consolidated report)
- `docs/architecture-ocr-investigation.md`
- `docs/architecture-model-investigation.md`
- `docs/architecture-trust-investigation.md`
- `docs/architecture-persistence-investigation.md`

New investigation-only tests:

- `tests/architectureOcrReconciliation.test.mjs`
- `tests/architectureOcrReconciliation.layoutRegression.spec.mjs`
- `tests/architectureModelReconciliation.test.mjs`
- `tests/architecturePersistenceReconciliation.test.mjs`

The OCR/model tests intentionally characterize current incorrect behavior; their assertions should change when a separately authorized fix is implemented. Existing tests and production files were preserved. On resumption and at final consolidation, `git diff --binary | sha256sum` matched the original tracked-diff fingerprint:

```text
e3753cc690bce772c69a34f604f940e511bd9ac41ed1efa49deab25bd7b2c5ce
```

The repository remains dirty with the original tracked changes and pre-existing untracked work, plus the nine investigation files above. No commit was made. Work stops at this report; the recommended fixes require separate authorization.
