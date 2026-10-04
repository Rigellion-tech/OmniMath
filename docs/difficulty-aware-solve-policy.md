# Difficulty-aware routing, budgets, and cost policy

This phase replaces topic-triggered escalation with a single server-owned solve policy. No live provider calls or commits were made. The frontend, OCR extraction/validation/review, and semantic hover code were not changed.

## Investigation and root causes

The previous path was:

`canonical problem → topic regex → standard/repair/escalation label → solver or repair role`

The canonical deadline was created before routing. Output tokens came from role configuration, and the canonical reservation used global pricing for the initial generation only. Thus routine matrix arithmetic could select a 16,000-token repair/high request (roughly $0.48 in output allowance at the configured $30/million estimate), while difficult variational work still shared the universal 90-second canonical deadline.

The old classifier supported these reasons:

- `prior_mathematical_validation_failure`, `prior_symbol_validation_failure`, `low_ocr_confidence`
- `variational_calculus`, `partial_differential_equation`, `vector_or_multivariable_calculus`
- `matrix_or_linear_operator`, `differential_equation`, `functional_analysis`, `optimization`
- `advanced_physics_math`, `infinite_series`, `improper_integral_standard_first`
- `long_context_standard_first`, `one_dimensional_integral`, `default_standard`

Every nonstandard classification mapped to `repair`, including the label `escalation`. A matrix environment or determinant alone triggered that route. Variational notation triggered it too. `repair` was overloaded: fresh hard solves and progressive candidate repair used the same role. Terra was selected through configured repair settings; source defaults were Sol.

The relevant ownership boundaries are:

| File/functions | Responsibility |
| --- | --- |
| `server/solverRouting.js`: `inspectProblemDifficulty`, `classifyProblemComplexity`, `chooseSolverRoleForProblem` | Deterministic task features and difficulty |
| `server/solvePolicy.js`: `selectSolvePolicy`, `estimateSolvePolicyReservation`, `policyTelemetry` | Unified selected policy, runtime constraints, conservative reservation |
| `server/app.js`: `resolveInitialSolveRouting`, `solveExecutionConfig`, `handleExplainRequest`, `handleProgressiveProviderSolve` | Reservation and ordinary/progressive orchestration |
| `server/openaiModels.js`: `selectOpenAiModel`, `getSolvePolicySelection`, `resolveOpenAiRequestTimeout`, reasoning/pricing resolvers | Configurable roles, capabilities, selected settings |
| `server/openai.js`: `getSolveOutputTokenBudget`, `createMathExplanation`, `requestOpenAi`, `fetchOpenAiWithRetry`, streaming transport | Provider payloads, stage-bounded transport, usage provenance |
| `server/modelExecutionConfig.js`: `buildModelExecutionConfig` and identity comparisons | Execution snapshots and meaningful escalation checks |
| `server/solveBudget.js`: `createSolveBudget` | Authoritative deadline/signal, stage allocations, provider ledger |
| `server/ordinaryRecoveryPolicy.js`, `server/progressiveRecoveryPolicy.js`, `server/mathAssurancePolicy.js` | Recovery eligibility and terminal decisions |
| `server/usageLimits.js`: `checkAndReserveUsage`, `settleTokenUsage`, `resolveSpendLimitsUsd` | Quotas, spend protection, conservative unknown-usage settlement |
| `server/failedSolveDiagnostics.js`, `server/solveOrchestrationTelemetry.js` | Failure artifacts and existing correlated generation/usage telemetry |
| `api/explain.js`, `api/solve-extracted-problem.js`, `api/explain-image.js`, `server/index.js`, `vercel.json` | HTTP adapters and runtime constraints |

The image adapter still canonicalizes through the existing shared solve boundary. The browser passes its caller AbortSignal directly to fetch and has no separate canonical solve timeout. The local Node server has no configured response deadline. Vercel function limits are the hosting constraint.

## New flow and taxonomy

`canonical problem → task features/difficulty → selected solve policy → reservation → canonical budget/orchestration → correlated provider/settlement telemetry`

The policy is selected before creating the canonical budget or reserving usage. Provider model, reasoning, output allowance, and role ceiling consume that selection, rather than rerouting independently.

- **Simple:** direct linear/quadratic solving, bounded arithmetic, elementary probability, explicitly small numeric matrix computations. Matrix proof/operator signals take precedence over the arithmetic shortcut. All recognized matrices must qualify as small numeric matrices for that shortcut.
- **Standard:** undergraduate integrals, ordinary ODEs, routine PDEs, textbook vector calculus/series/optimization, matrix tasks without evidence of deeper work, unknown tasks.
- **Advanced:** matrix/operator proofs, harder ODE/PDE tasks, variational tasks with less structural depth, proof-oriented optimization/calculus, prior mathematical validation failures.
- **Elite:** variational tasks with multiple structural difficulty signals; nonlinear PDE proof/regularity analysis; deep operator/functional-analysis proofs.

The classifier does not use string length or notation density to escalate. Task verbs, numeric matrix structure, proof requirements, and combinations of mathematical features distinguish computation from analysis. OCR confidence is not mathematical difficulty evidence. Glossary questions and notation-heavy arithmetic have negative regression coverage.

This is a conservative heuristic, not a semantic theorem prover. Unknown advanced work can still be under-classified; the recorded evidence enables subsequent corpus-driven tuning without changing transport/accounting.

## Model and role decision

| Difficulty | Initial role/path | Default model | Default reasoning | Default full output allowance |
| --- | --- | --- | --- | --- |
| simple | solver / canonicalSolve | existing canonical Sol | medium | 3,200 |
| standard | solver / canonicalSolve | existing canonical Sol | medium | 6,500 |
| advanced | hardSolve | configured hard solver; default Sol | high | 12,000 |
| elite | hardSolve | configured hard solver; default Sol | high | 24,000 |

`hardSolve` names fresh difficult generation accurately. `repair` remains for candidate repair and explicit prior symbol-repair metadata. This is a small role extension, not a rewrite.

`OMNIMATH_CANONICAL_SOLVE_MODEL` explicitly configures canonical simple/standard models while preserving the old rule that generic solver overrides do not silently replace canonical Sol. Hard-solver model, reasoning, timeout, and output controls have dedicated variables. Blank hard-solver settings retain legacy repair override compatibility, including solver fallback where previously applicable. No model is assumed to be universally best for elite mathematics.

Configured role output limits constrain default profile allowances; explicit tier output overrides can replace those role allowances, always within the selected model's capability. Unsupported reasoning parameters are omitted using the existing capability rules.

## Budget profiles and invariants

Default **local**, unconstrained allocations:

| Tier | Total | Primary | Recovery | Response reserve |
| --- | ---: | ---: | ---: | ---: |
| simple | 45s | 35s | 7s | 3s |
| standard | 90s | 65.5s | 22.5s | 2s |
| advanced | 150s | 110s | 35s | 5s |
| elite | 240s | 180s | 50s | 10s |

Primary is derived from total minus recovery and response reserves. Oversized reserves are normalized; response reserves remain within the budget helper's 10% limit. Explicit profile recovery allocations can exceed the old 30-second default cap. Legacy callers without explicit reserves retain the previous behavior.

Every provider attempt remains bounded by its selected role ceiling, the remaining allocated stage, and the canonical deadline. Recovery cannot extend the deadline. Canonical exhaustion and user/client cancellation remain terminal. Dispatches without observed usage remain unknown/unreconciled.

A legacy explicit `OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS` applies to all tiers and preserves the old 25% recovery (up to 30s) plus completion allocation, unless tier timing overrides are supplied. **Clear an old `90000` value to enable differentiated defaults.** Set the dedicated hard-solve ceiling to 180000 and its full output allowance to 24000 (as in the updated template) when migrating; otherwise existing explicit repair ceilings/allowances remain inherited and can constrain the new hard profile. Per-tier variables can override total, recovery reserve, response reserve, full output, and compact output. All are listed in `.env.example`.

## Deployment implications

The runtime compatibility phase raised only functions that own canonical solve
work. The full timeout chain and platform constraints are documented in
[Hosted solve runtime compatibility](./hosted-solve-runtime.md).

| Function | maxDuration |
| --- | ---: |
| `/api/extract-image-problem` | 70s |
| `/api/explain` | 300s |
| `/api/solve-extracted-problem` | 300s |
| `/api/explain-image` | 300s, including extraction and solve |

Hosted policies subtract elapsed request time and an enforced five-second
infrastructure headroom. The effective canonical budget never exceeds that
remainder. A capped profile is labeled, for example,
`elite_runtime_capped`; selected and effective durations and the cap reason are
logged. Stage proportions are scaled to the available lifetime. Exhausted
runtime produces a typed terminal solve timeout.

Server-owned runtime context follows internal request copies, so legacy image extraction cannot silently reset its outer function lifetime. This adds only deadline metadata to the shared adapter plumbing; OCR ingestion/validation/review decisions are unchanged. The standalone reviewed OCR solve starts a separate request envelope.

`OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS` can declare a local runtime constraint
or lower a hosted constraint; it cannot raise Vercel's registered lifetime.
Local development is uncapped when it is blank. Non-Vercel production requires
an explicit value, and unknown Vercel solve routes fail configuration rather
than inventing a lifetime.

The confirmed Fluid Compute Hobby plan supports the configured 300-second
maximum. Typed and separately reviewed OCR requests normally receive full
45/90/150/240-second profiles; Elite remains full when pre-solve work is at
most 55 seconds. The legacy combined image route cannot guarantee full Elite
in its worst case because its unchanged 60-second extraction allowance plus
240 seconds canonical work plus five seconds headroom totals 305 seconds.

## Cost envelopes and development limits

Reservation includes the selected initial full allowance and the most costly eligible single recovery configuration, using selected model pricing. Ordinary recovery input includes a documented conservative 512-token prompt overhead. Progressive candidate repair has a larger 4,096-token allowance for the bounded previous solution, evidence, and repair contract; ordinary reservations exclude that unavailable strategy. Token reservation independently covers the largest eligible output allowance. This replaces the previous initial-only/global-price estimate.

Simple output reservation is ordinarily 6,400 tokens across initial and one recovery, versus the previous matrix-triggered initial 16,000 allowance. At the same configured $30/million output estimate, those output components are $0.192 versus $0.48, before estimated input. This is a conservative reservation, not an expected invoice or guaranteed actual cost. Configured per-model prices take precedence over configurable default/global estimates; source fallback prices are explicitly estimates, not verified provider quotes. Unknown custom models without configured prices use a labeled estimate based on the default solver pricing, rather than a null/zero reservation; configure actual per-model rates for deployment. Empty pricing configuration now falls back correctly instead of becoming zero; explicit numeric zero remains allowed.

Observed mixed-model usage still drives settlement. Aborted requests with unknown usage retain conservative reservations; no zero usage is fabricated. Semantic recovery is bounded, but provider transport retries can still add uncertain spend. A reservation is not a provider-enforced per-request dollar cap, and reconciliation of unknown aborted usage is deferred.

`OMNIMATH_DEV_DAILY_SPEND_LIMIT_USD` and `OMNIMATH_DEV_MONTHLY_SPEND_LIMIT_USD` provide separate local ceilings. They apply only when NODE_ENV is exactly development/test and neither VERCEL=1 nor a VERCEL_ENV marker is present. Production, hosted previews, staging, and unspecified modes ignore them. Invalid values fall back to normal ceilings. Production daily/monthly spend protection, token/request limits, accounting, and telemetry remain enforced.

`npm run dev` and `npm run dev:server` default an otherwise unset NODE_ENV to development; explicitly configured modes are preserved. For example, set a chosen local daily/monthly ceiling in `.env.local` rather than removing production protection. No development disable flag was added.

## Recovery and telemetry

Timeout recovery defaults to a fresh dispatch with the same model, reasoning, prompt, and profile output allowance, within the reserved stage. `OMNIMATH_SOLVE_TIMEOUT_RECOVERY_STRATEGY` can select `same_route`, `escalation`, or `disabled`; execution selection is separate from timeout mechanics. Disabled removes recovery allocation/eligibility. Progressive loop-boundary expiry also uses the authoritative typed canonical timeout. Structured-output and mathematical-assurance recovery retain distinct purposes and use selected escalation settings. Progressive candidate repair retains its candidate/prompt strategy.

Policy-managed canonical solving permits one initial generation and at most one recovery generation. The previous full → compact → escalation sequence is replaced with initial → selected recovery. Standalone legacy helper compact fallback remains available. Progressive route attempts are also capped at two. Transport retries share their stage allocation and are separately recorded.

Correlate by requestId and routeAttemptId:

- `solve-routing`: tier, reason, bounded features, role/model/reasoning/output, requested/effective profile allocations, runtime/headroom and override sources.
- `solve-reservation`: selected conservative token/cost envelope, primary/recovery estimates, recovery model, pricing provenance.
- `provider-dispatch` / `provider-outcome`: dispatch/abort/completion times, stage, elapsed provider duration, timeout provenance, usage status.
- Existing recovery/candidate/progressive terminal logs: recovery decision, candidate selection and success/failure, observed usage and model provenance.
- `solve-policy-outcome`: total duration, primary/recovery provider duration, recovery used, outcome/failure, observed versus reserved/settled costs and usage status.
- Failed-solve artifacts now retain difficulty and budget metadata.

The selected policy and its nested settings are frozen. Recovery consumers name the selected strategy explicitly, allowing timeout and structured recovery settings to evolve independently. The full selected policy is nonenumerable on routing metadata to avoid repeatedly logging its execution-selection objects. No user-facing difficulty badges or debug frontend changes were added.

## Changed files and verification

Implementation: `server/solverRouting.js`, new `server/solvePolicy.js`, `server/app.js`, `server/openaiModels.js`, `server/openai.js`, `server/solveBudget.js`, `server/progressiveRecoveryPolicy.js`, `server/failedSolveDiagnostics.js`, `server/usageLimits.js`, `scripts/dev.js`, new `scripts/dev-server.js`, `package.json`, `.env.example`.

New tests: `tests/solvePolicy.test.mjs`, `tests/solvePolicyIntegration.test.mjs`, `tests/usageSpendLimits.test.mjs`.

Updated regressions: `tests/solverBenchmark.test.mjs`, `tests/failedSolveDiagnostics.test.mjs`, `tests/ordinaryRecoveryIntegration.test.mjs`, `tests/phase4ImageHandlers.test.mjs`. Image regression updates concern the shared canonical allowance/deadline and outer runtime metadata; image extraction, review, receipt, lifecycle, and accounting assertions remain intact.

The routing corpus covers all twelve requested classes, including small matrices versus operator proofs, graduate variational work, nonlinear PDEs, long easy prose, short advanced work, and notation-heavy computation. Handler fixtures assert actual payloads and reservations, not only classifier labels. Fake clocks verify elite 180s primary/50s recovery, terminal cancellation, and no third generation. Runtime, spend-mode guards, deadline authority, provider recovery, accounting, and image/OCR regressions are exercised offline.

Final verification on the completed implementation:

| Check | Result |
| --- | --- |
| `NODE_OPTIONS='--import ./tests/helpers/noExternalNetwork.mjs' npm test` | 1,563 tests; 1,542 passed; 0 failed; 21 skipped; 77 suites |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; no reported warnings |
| `git diff --check` | Passed |

The network preload blocks actual external connections even if local credentials exist; mocked fetch remains usable. Final logs: `/tmp/omnimath-routing-final-tests.log`, `/tmp/omnimath-routing-final-lint.log`, `/tmp/omnimath-routing-final-typecheck.log`, `/tmp/omnimath-routing-final-build.log`.

Required regression evidence:

| Requirements | Evidence |
| --- | --- |
| A–F: cheap small matrices, stronger operator proofs, elite variational work, proportional cost, standard behavior, larger elite budget | `solvePolicy`, `solvePolicyIntegration`, updated benchmark/diagnostic routing corpus |
| G–I: reserved recovery, bounded provider attempts, authoritative deadline | `solveBudget`, policy profile invariants, fake-clock elite handler test, existing `providerTimeoutRecovery` |
| J–K: cancellation terminal, no third recovery | handler cancellation/elite timeout fixtures, repeated invalid-response integration, ordinary/progressive recovery policies |
| L: selected model/profile reservation | payload/price/reservation handler assertions, price snapshot and unknown-price tests |
| M: development override cannot affect production | `usageSpendLimits` mode guards and actual reservation integration |
| N–P: provider recovery, accounting, frozen image/OCR behavior | existing provider, unknown-usage/accounting, extraction/OCR/lifecycle suites remain green; shared canonical expectations updated |
| Q: full offline suite | final 1,542 pass / 0 fail run above |


## Deferred work

OCR/image simplification and review UX; theme/contrast/failure visuals; composer and inspector redesign; semantic node/hover performance and geometry; concurrency abuse and long-session leak audits; automated provider reconciliation for aborted unknown usage; live model-quality/latency/cost calibration; hosting duration changes and deployment. No provider calls, deployment, or commits were made.
