# Sep 11 IIT presentation incident — final reconstruction

## A. Executive summary

Evidence interval: **2026-09-11 15:00–15:35 America/Chicago, CDT (UTC−5)**, equivalent to **20:00–20:35 UTC**; suspicious events from about 15:19 onward. Evidence consists of the user's surviving local-dev excerpts. There is no saved Sep 11 trace in the repository and no complete stream, parsed solution payloads, or browser lifecycle trace. July snapshots are not this incident.

**None of the observed presentation failures is conclusively attributable to a request and failed lifecycle boundary.** Several provider calls succeeded; that does not prove HTTP delivery, accepted frontend state, or visible DOM.

Offline reproductions confirmed defects in real internal-request auth preservation, history-save latency gating, structural/render content handling, and enforcement of existing OCR structural/critical findings. These are **CONFIRMED ARCHITECTURAL DEFECTS**, not proven Sep 11 causes. The earlier hover leave/unmount-abort hypothesis was incorrect and its lease refactor was removed. Actual pinned-chat/Home persistence tests demonstrate that current UI commit is already independent of save/list success.

Classification vocabulary:

- **CONFIRMED ARCHITECTURAL DEFECT:** deterministic production-boundary reproduction, not necessarily presentation attribution.
- **STRONGLY SUPPORTED:** converging evidence short of full causal proof. Provider success and a local persistence outage qualify as observations; no entire visible incident reaches this attribution level.
- **PLAUSIBLE BUT UNPROVEN:** reachable mechanism without presentation correlation.
- **NOT CONCLUSIVELY ATTRIBUTABLE:** insufficient evidence to assign the visible incident to a request/boundary.

### Diagnostic semantics

In server/openai.js, the log with purpose "json_parse" and status "completed" is emitted **before JSON.parse and the assertion callback**. Its status is copied from the provider. That line alone proves neither parsing nor schema acceptance. The user separately reports valid JSON/parsing for some examples; that testimony is retained, without treating this log line as a parser-success event. Token usage and a sent HTTP response are not UI acknowledgements.

## B. Evidence inventory

The following is **excerpt order**, not a recovered timeline. Unknown means not supplied, not necessarily absent at runtime. These are all solver calls represented by the supplied evidence; they are not all requests in the interval.

| Field | S1 | S2 |
| --- | --- | --- |
| Time/order | Image evidence block; exact time unknown | Second image call in excerpt; exact time unknown |
| Request ID | canonical-solve-mtxed20v-w1u2fj | Unknown |
| Provider response ID | resp_095f746c4699a821006aa461af881487d1be2318a8660c1de6 | Unknown |
| Endpoint/source | /api/solve-extracted-problem, internally /api/explain; image, ocr-direct | /api/solve-extracted-problem; image |
| Extraction ID/image hash | Unknown | Unknown |
| OCR review | Confidence92/high/noncritical/no reasons; OCR96/model99; superscripts2/2, subscripts0/0; difference .592; cleanup substantial false, changed characters0/ratio0 | Unknown |
| Canonical input/hash | Input text unknown; hash 5a3c5b7f; solveDecision direct | Unknown |
| Routing/model | gpt-5.6-luna; solver role, initial/medium, default standard, output budget6500 | gpt-5.6-luna; remaining routing unknown |
| Provider/tokens | Completed; input1632/output2432 including reasoning1034; visible1398; total4064; chars3490 | Successful usage record; input1532/output2820 including reasoning1624; total4352; visible1196 inferred by subtraction |
| Truncation | responseTruncated=false; zero-visible truncation false | Unknown |
| Parse | User reports success; sampled json_parse status alone is not proof | Unknown |
| Acceptance/transformation | Code uses shared fast text solve conversion, annotation and candidate boundary — **not legacy image-solution conversion**. Actual accepted payload unavailable | Same endpoint; actual per-stage records unavailable |
| Duration | 20584ms, one AI call | Unknown |
| Backend identity/persistence | Internal missing-token log, local-dev fallback identity local-dev-solve-extracted-problem; no uniquely attached save event | Followed in excerpt by DATABASE_UNAVAILABLE history warning, without request correlation |
| Frontend delivery | Unknown | Unknown |

S1/S2 are **not identified as the two failed solves**. Both have provider output. There is no defensible evidence-based ranking of "the two most likely" failed requests from this subset.

| Label | ID/time | Evidence | Missing downstream evidence |
| --- | --- | --- | --- |
| U1 | Follow-up ID unknown; near session failure at15:19:22 | /api/explain-followup, Luna; input1935/output125/reasoning29/total2060 | Actual answer, accepted API response, browser ownership/state/DOM |
| U2 | ID unknown; nearby | Same endpoint/model; 2012/76/0/2088 | Same |
| P1 | Pin ID/time unknown | /api/explain-pin; input328/output65/reasoning0/total393; model not supplied | Pin target, revision, delivery |
| H1 | hover-19-1v3chhk; time unknown | Mini, completed, visible66, chars227, nontruncated; parsing success separately reported | Browser parser, registry/cache, owner/revision, tooltip/DOM |
| H2 | hover-62-1rbr2dn; time unknown | Mini, completed, visible107, chars446 | Same; sampled per-stage parser record absent |
| H3 | hover-17-1vx4mym; time unknown | Completed, visible84; model not printed in this abbreviated row | Same |
| O1 | Extraction ID/hash/time unknown | About confidence64/medium/noncritical; cleanup review + text_latex_mismatch; OCR95/model100, superscripts2/3, subscripts0/1, difference .649, substantial cleanup61/.513 | Correlated direct submission, canonical hash, solve request, payload and UI |

Session 58ff7d93-a74c-471f-acf7-639b8b64ba77 has Vite ECONNRESET at15:19:22 and repeated around15:28:02, with other nearby ECONNABORTED writes. Session 94794db6-4842-4f4a-bcdf-f6f29a082f7a has a write abort at15:34:32. Session create/list report Postgres42P01, missing relation app_users, and local user-data fallback; history reports DATABASE_UNAVAILABLE. The missing table is established. It does not by itself explain the socket resets or prove a live answer was withheld.

### Observed incident table

| Symptom | ID/time | Provider | Backend | Frontend | Root cause/confidence |
| --- | --- | --- | --- | --- | --- |
| Apparent solve failure #1 | Unknown, within interval | Unknown for this incident; S1/S2 succeeded | No correlated failing response | User observed apparent failed solve | **NOT CONCLUSIVELY ATTRIBUTABLE** |
| Apparent solve failure #2 | Unknown, within interval | Same limitation | Same | Same | **NOT CONCLUSIVELY ATTRIBUTABLE** |
| Blank-middle-step solution #1 | Unknown | No actual payload | No source/destination step records | User observed empty intermediate work | **NOT CONCLUSIVELY ATTRIBUTABLE** |
| Blank-middle-step solution #2 | Unknown | Same limitation | Same | Same | **NOT CONCLUSIVELY ATTRIBUTABLE** |
| Pinned follow-up without visible answer | U1/U2 are candidates, not identified matches; nearby15:19 cluster | Two successful calls supplied | No correlated accepted HTTP response | No request/reducer/DOM record | **NOT CONCLUSIVELY ATTRIBUTABLE**; current persistence gating rejected |
| Roughly3–4 missing hovers | H1–H3 are examples, not confirmed one-to-one matches | Supplied examples completed | User reports valid output/parsing; delivery unrecorded | No owner/tooltip record | **NOT CONCLUSIVELY ATTRIBUTABLE**; provider failure contradicted for these successful calls |

## C. Confirmed architectural boundaries

### Internal image authentication

First incorrect boundary: adapting a real Node IncomingMessage using object spread. Accessor-backed/non-enumerable headers are lost; internal /api/explain sees no authorization. Local fallback masks this with a different local identity; production can return401. This is not random provider failure.

copyInternalRequest explicitly preserves headers and is used by internal extraction/solve adapters. The production-mode regression uses a real Node request, locally generated RSA JWT, **actual Clerk signature verification**, the real route/parser/candidate path, and mocked provider/database I/O. The verified user reaches persistence without local fallback. Missing auth still fails401 before provider invocation.

Existing explicitly local development fallback remains for local unauthenticated use; authenticated production solving no longer depends on it. The presentation's auth trace is consistent with the defect, but neither visibly failed solve is correlated to it.

### Successful solve versus history persistence

First incorrect boundary: awaiting saveExplanationBestEffort before sending successful solve output. Catching a rejected save does not protect against a never-settled DB promise. A regression holds the actual mocked pg query unresolved and proves HTTP200/steps arrive before settlement, then rejects the query with ECONNRESET.

History save is now observed in the background, with runtime.saveStatus=pending (or immediate expired-auth warning). This fixes a demonstrated live-delivery dependency, **not durability**. Background work may be lost on process/serverless termination. Usage settlement is separate and remains awaited. No evidence proves Sep11 encountered the stalled-history path.

### Blank steps and content loss

Fast/compact required step strings are id, heading, latex, reasoning, plus anchors array. Image strings are title, equationLatex, explanation, plus tokens array. Full annotated steps require id, label, title, math, summary, plainExplanation and expressions/lines/chunks. JSON schema strings have no minLength; required/type constraints alone permit blanks. Fast/compact custom checks already rejected blank IDs/headings/math. Whitespace reasoning uses an existing generic fallback. Required null/missing fields fail custom acceptance; optional anchors/tokens are filtered/defaulted. Empty optional display fields must not mask primary math. Mathematically wrong but structurally renderable answers remain accepted under the pre-existing evidence-only verification policy.

| Question | Established result |
| --- | --- |
| Provider-empty accepted? | Schema alone permits empty strings; real converter tests reject empty/whitespace/layout-only intermediate math with original index. Schema permissiveness is not proof of accepted Sep11 blanks. |
| Normalization empties content? | Layout-only \displaystyle becomes an empty string but was already visually empty. A **fault-injected production-boundary** test detects visible-source-to-empty destination loss; this is not a discovered valid-expression normalizer defect or a Sep11 reproduction. |
| Nonempty render input, empty DOM? | KaTeX failure previously cleared its host. Layout-only input can split to zero blocks or render spacing without glyphs. The first investigation error placeholder was hidden by pre-existing data-math-fallback CSS; browser tests exposed and corrected that mistake. |
| Filter/map effects? | An outer [{}] can mask complete nested steps. Legacy image assertion filtered sanitized-empty steps. Live selection now prefers complete candidates or retains original positions with visible boundary errors; image assertion detects emptiness before removal. Existing final/problem-step de-duplication does not create sparse holes. Duplicate IDs were not demonstrated to cause blank positions. |
| Optional fields? | Whitespace lines and empty chunks could suppress valid step.math. Trimming/renderability fallback corrects this. Explicit boundary-error messages remain visible, not only in collapsed reasoning. Arbitrarily corrupt historical payloads remain less strictly normalized than live responses. |

Actual lifecycle:

    parsed provider input before sanitization
      → custom schema/structure → normalization/conversion
      → candidate finalization → annotation/post-annotation assertion
      → HTTP → raw client summaries → normalized step selection
      → React step/line model → KaTeX → observed DOM

Failure classifications: provider_empty, normalization_emptied, accepted_empty, render_input_empty, render_failed, rendered_empty; structure_rejected covers other structural failures. Backend AsyncLocalStorage correlates request/endpoint; response/client/step DOM retain request ID, step ID/index. Failures log without a debug flag; successful boundary summaries use existing diagnostic flags. Renderer diagnostics may include equation content: treat captures as user data.

"Rendered" means observed glyph/shape DOM, not proof of user perception or lack of occlusion. Hidden/unmeasurable containers are classified render_unobservable without replacing potentially valid math. No exhaustive guarantee is claimed for every TeX/CSS or persisted-corruption case.

### OCR canonical review

There is **no demonstrated reasons-versus-issues shape mismatch**. validateExtraction produces extractionValidation with issues, critical, confidence/tier and metrics. logExtractionReviewDebug projects issues.map(issue.type) into the logged reasons field. Frontend submission preserves extractionValidation; the adapter passes that canonical object to ocrSolvePolicy. A regression crosses buildExtractionSubmissionPayload → JSON → real endpoint, with conflicting top-level fields, and verifies canonical review wins.

Old UI auto-direct normally required high/noncritical review. Direct callers/compatibility paths defaulted to direct and the server did not enforce canonical review findings. The retained gate rejects silent direct solve for existing structural issue codes or critical=true with409 OCR_REVIEW_REQUIRED. Explicit edited/anyway decisions remain allowed. No new independent confidence, difference-ratio or cleanup-ratio thresholds remain.

O1 cannot be linked to S1/S2 or either faulty solution. Its detailed excerpt contains no correlated direct submission. S1's high review/hash must not be relabeled as O1.

## D. Follow-up and hover closure

### Pinned follow-up

    pin target → provenance/conversation/revision → submit descriptor
      → API/provider → parsed response + echoed correlation
      → owner/request/conversation/revision check → reducer assistant
      → connected assistant DOM → pinned-window propagation → Home autosave

Core reducer/provenance and Home operation ownership predate the incident task. Persistence is not a prerequisite for visible commit. Browser tests enable Home save/list effects (the earlier mock-auth fixture disabled them) and cover POST ECONNRESET, PUT ECONNABORTED, delayed list connection reset and stale successful save completion. They inspect actual pinned chat persistence payloads and assistant DOM. An unrelated rejected promise after a reducer call was not valid evidence and was removed.

Stale conversation/revision, component unmount/recreation, existing35-second timeout/abort, ownership rejection or later conversation replacement remain **PLAUSIBLE BUT UNPROVEN** for Sep11. Session socket errors belong to separate requests; no causal bridge is logged. Diagnostics now distinguish api_parsed, response_invalid, api_failed, owner/stale/abort, post-commit connected DOM, nonempty rendered assistant, and local_window_update_requested — the last is not a persistence acknowledgement.

### Hover

    API/provider → browser parse → shared in-flight promise
      → semantic response identity → transport cache
      → owner/revision validity → tooltip state → explanation-body DOM

The prior leave/unmount-abort hypothesis was false: only the creator timeout aborted the old transport. Lease/controller/deadline-extension behavior and helper-specific tests are removed. Existing duplicate suppression, cooldown, timeout and cache behavior remain.

Transport and owner outcomes are separate. A successful transport may terminate cached after an owner terminates hidden_before_completion or owner_gone. Shared callers retain the actual transport request ID; owner IDs are unique across mounts. Failure classes distinguish parser, shape, network, HTTP, explicitly provider-coded error and abort; owner outcomes distinguish stale/hidden/gone versus UI commit/render. UI commit is observed after state update and rendered examines the explanation body, not the tooltip title.

Real component regressions cover valid-owner success, hidden-owner termination followed by successful transport caching without abort, mismatched semantic identity rejected as stale, and a parsed whitespace explanation reaching an explicit render_input_empty owner outcome. A post-commit observer also distinguishes missing/empty body DOM (rendered_empty) and owner disappearance before observation. These are diagnostic outcomes, not a guarantee that every cached response was visibly shown. No browser owner/cache/revision/pin/unmount events connect H1–H3 to the visible failures. Bounded in-memory event buffers are not durable telemetry; a killed tab/process cannot promise a terminal event.

## E. Changes/provenance

See [the complete per-file change audit](sep11-investigation-change-audit.md) for retained/reverted hunks, evidence and tests. **Git HEAD was not the investigation baseline.** Never revert entire mixed dirty files. No commit or external AI provider call occurred. Routing/unification, evidence-only verifier, provenance/reducer architecture, Home operation ownership and unrelated semantic/line-ending work pre-existed this task.

## F. Before / after

    Auth before: real request → spread loses headers → auth fails → dev identity or production401
    Auth after:  real request → explicit headers → verified identity → canonical solve

    Save before: successful candidate → await history DB → HTTP (can stall)
    Save after:  successful candidate → HTTP with save pending
                                        └→ observed best-effort history save

    Blank before: string → sanitize/filter/split → no content or KaTeX error → blank/hidden host
    Blank after:  source/destination checks → reject or preserve position/error
                  → render-input/KaTeX/DOM outcomes, correlated to request and step

    Follow-up core unchanged: accepted owner → reducer → live chat → persistence effects
    Hover transport unchanged: shared promise → cache; each owner → explicit terminal/DOM outcome

## G. Verification

Focused offline regressions preceded broad suites. Provider/database transport is stubbed; meaningful production parsing, auth, state and rendering boundaries are retained. Helper tests are not presented as integration proof.

### Final focused offline units — 111 tests: 94 passed, 0 failed, 17 skipped, 0 todo

    env -u OPENAI_API_KEY NODE_OPTIONS=--import=./tests/helpers/noExternalNetwork.mjs node --test --test-concurrency=1 tests/incidentBackendBoundaries.test.mjs tests/internalRequestAuth.test.mjs tests/ocrSolvePolicy.test.mjs tests/fastSolvePipeline.test.mjs tests/solveCandidateLifecycle.test.mjs tests/solveResponseNormalization.test.mjs tests/saveAuthExpiry.test.mjs tests/incidentBlankBoundaries.test.mjs tests/hoverRequestLifecycle.test.mjs tests/followupLifecycle.test.mjs

### Final complete offline units — 1110 tests: 1089 passed, 0 failed, 21 skipped, 0 todo

    env -u OPENAI_API_KEY NODE_OPTIONS=--import=./tests/helpers/noExternalNetwork.mjs node --test --test-concurrency=1 tests/*.test.mjs

Exit0; final run110.1s. Existing skips remain documented limitations of earlier pipeline corpus work, not waived incident regressions. An earlier closing checkpoint also passed1089/1110 with21 skips (146.7s).

### Focused real-browser regressions

Blank/renderer — **2 passed, 0 failed/skipped/todo**, final49.2s:

    env -u OPENAI_API_KEY PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu OMNIMATH_E2E_PORT=4188 node node_modules/playwright/cli.js test --config playwright.config.mjs tests/layoutRegression.spec.mjs --grep 'malformed solver math|blank render output' --workers=1 --output=test-artifacts/incident-blank-final

Home follow-up persistence — **4 passed, 0 failed/skipped/todo**, final53.1s:

    PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu OMNIMATH_E2E_PORT=4186 node node_modules/playwright/cli.js test --config playwright.config.mjs tests/incidentFollowup.layoutRegression.spec.mjs --workers=1

Hover including final observer/owner-dedupe correction — **4 passed, 0 failed/skipped/todo**, final44.5s:

    env -u OPENAI_API_KEY PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu OMNIMATH_E2E_PORT=4198 node node_modules/playwright/cli.js test --config playwright.config.mjs tests/hoverLifecycle.layoutRegression.spec.mjs --workers=1 --output=test-artifacts/incident-hover-observer-final

### Broad browser runs

Earlier parallel checkpoint, before the fourth hover observer test — **49 tests: 48 passed, 1 failed, 0 skipped, 0 todo**:

    env -u OPENAI_API_KEY PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu OMNIMATH_E2E_PORT=4189 node node_modules/playwright/cli.js test --config playwright.config.mjs --workers=2 --output=test-artifacts/incident-browser-final .

Failure: semanticAdversarial.layoutRegression.spec.mjs:66, tooltip semantic identity assertion at119. Screenshot/trace/error-context remain under test-artifacts/incident-browser-final/semanticAdversarial.layout-360a2-and-a-glyph-layout-mutation/. This failed run is not erased by a later rerun.

**Final frozen-code serial run — 50 tests: 50 passed, 0 failed, 0 skipped, 0 todo; exit0; 7.1 minutes:**

    env -u OPENAI_API_KEY PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu OMNIMATH_E2E_PORT=4199 node node_modules/playwright/cli.js test --config playwright.config.mjs --workers=1 --output=test-artifacts/incident-browser-final-serial .

The earlier semantic adversarial assertion passed in this run. Its earlier failure is not causally explained by the rerun; no semantic geometry architecture change was made to address it. Conservative Sep11 verdicts are unchanged.

### Static/build verification

    npm run lint
    npm run typecheck
    npm run build

All exit0, no diagnostics; these are checks, not test-count suites. Whitespace check of edited tracked files initially reported existing CRLF as trailing whitespace; the same check with git -c core.whitespace=cr-at-eol diff --check passed. No unrelated line-ending rewrite was performed.

Initial render-browser failures exposed hidden placeholder CSS, empty block split, and a boundary message hidden in collapsed reasoning; corrected and rerun. An expected-empty transparent-color fixture was wrong because existing CSS forces inherited visible math color; it was replaced with actual spacing-only output.

## H. Remaining risk and missing evidence

- **Missing evidence:** full timestamped request list, actual parsed solutions and transformation snapshots, browser submit IDs, follow-up ownership/revision/state, hover identities/cache/abort timing and DOM records; backend process exit/restart and socket-close records for the Vite failures. These would be required to attribute the historical failures.
- **Operational defect:** local schema is missing; original Vite reset/abort cause remains unresolved. No migrations/environment repair were performed.
- **Architectural risk:** background history saving is not durable; usage settlement remains a separate awaited post-provider dependency. Neither is fixed by a UI state label.
- **Pre-existing risks not changed:** chat persistence depends on sticky-lens settings; clean active sessions absent from a nonempty restored list are outside the dirty-session preservation rule. No new session reconciliation architecture is justified here.
- **Observability limits:** buffers roll over/disappear with a tab, DOM observations do not establish compositor/perception visibility, and arbitrary corrupt historical payloads remain less strictly normalized.
- **Broader browser repeatability risk:** one parallel run failed semanticAdversarial.layoutRegression.spec.mjs:66 at expected tooltip semantic identity in its native pointer/scroll/layout scenario (denominator x expected, a distant root selected). The final serial run passed. The difference remains unexplained; this is not provider-delivery evidence and is not assigned to Sep11 or a particular code change. No semantic architecture rewrite was attempted.
- **Mathematical trust:** structurally sound but mathematically wrong answers remain possible. No verification/routing redesign was authorized.
- The referenced **Sep2 audit is not present as an identifiable repository document or supplied checklist**. Do not invent its findings. Reconcile these established risks with that audit when supplied; existing Sep4 trust-boundary/calibration/provenance records are separate.

## I. Final verdict

| Incident class | Verdict |
| --- | --- |
| Two apparent solve failures | **unresolved** — independent auth/history defects corrected, no incident/request attribution |
| Two blank-middle-step solutions | **structurally prevented/observable but not retrospectively attributable** — demonstrated paths covered; original payloads missing |
| Pinned follow-up without visible response | **unresolved** — persistence independence verified; historical lost-answer boundary unknown |
| Roughly3–4 missing hover explanations | **structurally prevented/observable but not retrospectively attributable** — valid-owner delivery/outcome invariants covered; historical disappearance unknown |

No observed incident is labeled reproduced-and-fixed merely because an architectural regression passed. See [the fresh-session handoff](omnimath-next-session-handoff.md); the next milestone is not implemented in this session.
