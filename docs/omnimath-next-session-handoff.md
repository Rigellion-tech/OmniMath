# OmniMath next-session handoff

## A. CURRENT OMNIMATH STATE

OmniMath is a Vite/React frontend with a local Node HTTP backend. Typed and OCR input converge on the canonical solve pipeline (typed `/api/explain`; extracted images adapt into the same handler). OCR provenance and canonical review evidence remain metadata/policy inputs. Structural acceptance is required; mathematical verification is evidence-only, not a guarantee or a contradiction-based rejection/routing trigger. Operational roles remain configured server-side; do not change model routing as an incident workaround.

Semantic rendering builds ownership/provenance-aware math targets. Hover requests carry semantic identity, request ownership, and revisions through provider, parser, registry/cache, tooltip state, and DOM. Follow-ups and pinned explanations use immutable provenance snapshots and operation ownership.

Home commits valid live answers independently of session persistence. Backend history save is observed in the background and may return `saveStatus=pending`; it is not durable work. Usage-reservation settlement is distinct and still awaited. Internal request adapters preserve authenticated IncomingMessage headers; unauthenticated development fallback is local-only. OCR direct-solve policy reads `extraction.extractionValidation.issues`/`critical`; logged `reasons` are a projection of those issues, not a competing evidence shape. Explicit reviewed `edited`/`anyway` decisions remain allowed.

Diagnostics distinguish provider completion, parsing, candidate acceptance, normalization, UI commit, and visible rendering; do not infer later stages from earlier logs. Tests are Node offline tests plus Playwright fixture/browser regressions. Use the local Node/Vite setup and `tests/helpers/noExternalNetwork.mjs`; avoid external providers.

Runtime: Node >=20.9; environment configuration in `.env.example`, verified Clerk identity for private user data, optional Postgres migrations under `db/migrations`. Do not expose server credentials to Vite. `npm run dev` runs client/backend; browser tests start fixture Vite with no provider backend. This workspace's Chromium uses `PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright` and `LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu`; use a free `OMNIMATH_E2E_PORT`. No dependency installation is needed unless dependencies are missing.

## B. SEP 11 INCIDENT OUTCOME

See [final reconstruction](sep11-presentation-incident-reconstruction.md) and [change audit](sep11-investigation-change-audit.md), which are authoritative. Confirmed architectural defects: internal IncomingMessage auth loss, awaited history save blocking HTTP, content-boundary loss/hidden errors, and missing server enforcement of canonical OCR structural review findings. **No OCR evidence-shape mismatch was demonstrated.** Unsupported hover leases, duplicate-ID/key changes and broad OCR thresholds were reverted. Apparent solve failures and the pinned-follow-up loss remain unresolved; blank/hover paths are structurally prevented/observable for demonstrated mechanisms, not retrospectively attributable. No visible Sep 11 incident was conclusively assigned to a surviving request.

## C. INVARIANTS THAT MUST NOT REGRESS

- Provider/API success must not depend on persistence success for visible UI delivery.
- Hover transport and each owner need explicit meaningful terminal outcomes; cache success is not proof of a visible tooltip.
- Blank/content loss must retain boundary/index/request evidence. Hidden/unmeasurable DOM is not proven empty; bounded browser buffers are not durable incident capture.
- Real authenticated identity survives internal request adaptation.
- Direct-solve policy consumes canonical structural/critical review findings.
- Stale responses cannot overwrite newer valid state.
- Ownership, revision, and provenance envelopes remain intact.
- Diagnostics never claim a later lifecycle stage than observed.

## D. WORKING TREE / CHANGE PROVENANCE

The repository was already heavily dirty before the Sep 11 investigation. **Git HEAD was NOT the Sep 11 baseline.** Do not revert whole files. Especially mixed: `server/app.js`, `server/mathExplanationSchema.js`, `src/api/mathClient.js`, `src/lib/solutionSteps.js`, `ExplanationPanel.jsx`, and their tests. Home operation ownership, `server/openai.js`/semantic hardening, mathematical verifier and provenance architecture are pre-existing, not incident-created fixes. Investigation-only hunks are itemized in the change audit. Even untracked `solveCandidateStructure.js`/`solveCandidateLifecycle.js` were originally earlier trust-boundary work. Treat unrelated/uncertain changes as user-owned.

## E. TEST MAP

- Solve/candidate/normalization: `tests/fastSolvePipeline.test.mjs`, `solveCandidateLifecycle.test.mjs`, `solveResponseNormalization.test.mjs`, `incidentBlankBoundaries.test.mjs`.
- OCR: `ocrSolvePolicy.test.mjs`, `ocrSubmissionPipeline.test.mjs`, `ocrExtractionValidation.test.mjs`.
- Auth/internal solve and persistence: `internalRequestAuth.test.mjs`, `incidentBackendBoundaries.test.mjs`, `saveAuthExpiry.test.mjs`.
- Hover/semantic/render boundaries: `hoverRequestLifecycle.test.mjs`, `hoverLifecycle.layoutRegression.spec.mjs`, `semanticRenderingHardening.test.mjs`, `semanticAdversarial.layoutRegression.spec.mjs`, `layoutRegression.spec.mjs`.
- Follow-up/pinned/session: `followupLifecycle.test.mjs`, `followupProvenance.test.mjs`, `incidentFollowup.layoutRegression.spec.mjs`, `sessionIsolation.spec.mjs`.
- Canonical route/provenance/semantic coverage: `canonicalSolveRoutes.test.mjs`, `solvePipelineConvergence.test.mjs`, `provenanceFollowup.layoutRegression.spec.mjs`, `semanticTexOwnership.layoutRegression.spec.mjs`. All listed regression filenames live under `tests/`.
- Broader baseline: `env -u OPENAI_API_KEY NODE_OPTIONS=--import=./tests/helpers/noExternalNetwork.mjs node --test --test-concurrency=1 tests/*.test.mjs`; use reconstruction section G for the exact browser command. At closure: units1089 pass/21 skip/0 fail; final serial browser50 pass/0 fail/0 skip; lint/typecheck/build pass. Re-establish the baseline after later changes rather than assuming these counts persist.

## F. REMAINING RISKS / TECHNICAL DEBT

- Unresolved operational defect: Sep11 local logs show missing `app_users`; cause of Vite session resets/aborts is not reconstructed. Migrations/runtime were not repaired in this task.
- Architectural risk: background history saving is nondurable; usage settlement is still awaited after provider work. Do not conflate quotas with history/session persistence.
- Pre-existing architectural risk: sticky-lens settings affect chat persistence; clean active sessions absent from a nonempty restored list are outside dirty-session preservation. These were deliberately not redesigned.
- Missing evidence/observability: original full payloads and browser request-to-DOM trace are absent. Browser buffers roll over/disappear; DOM observations do not prove perception or compositor visibility.
- Test repeatability risk: a parallel browser run had48/49 pass with the native semantic hover/scroll/mutation identity assertion failing; final serial run50/50 passed. The difference is unexplained. Do not assume timing or investigation causality without evidence; preserve the recorded failure when assessing later changes.
- Mathematical trust/future improvement: evidence-only verification permits structurally valid wrong answers. This incident did not redesign verification.
- Missing evidence: Sep 2 audit findings are not available as an identifiable authoritative document in this workspace; do not invent a checklist.

## G. RECOMMENDED NEXT OMNIMATH MILESTONE

Build a local presentation-runtime reliability/readiness gate: verify DB migration/schema readiness and add controlled persistence-outage/latency smoke checks with correlated incident capture. This closes the highest-value operational risk without redesigning solver routing or mathematics.

## H. FRESH CODEX SESSION STARTING PROMPT

> Read `docs/omnimath-next-session-handoff.md` first, then its authoritative Sep11 reconstruction/change audit and the relevant `docs/typed-ocr-solve-unification.md`, `docs/mathematical-trust-boundary.md`, `docs/deep-explanation-provenance.md`. Continue with the single recommended local presentation-runtime reliability/readiness gate; do not reopen the entire incident or redesign solver routing/verification. Preserve live-answer/persistence independence, canonical OCR review, verified internal identity and ownership/revision boundaries. Git HEAD was NOT the investigation baseline: preserve mixed/unrelated dirty work. Establish the offline Node baseline from the handoff, run focused backend/persistence regressions and the recorded browser checks, then lint/typecheck/build. Consult the final ledger for known failures; investigate uncertain evidence before changing architecture. No unnecessary external providers; no commit unless explicitly instructed.
