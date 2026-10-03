# Canonical solve deadline and dispatch accounting

This change addresses hard manually entered solves timing out without a solution and reporting pre-provider/zero usage despite dispatched provider work. It preserves the canonical 90-second default, model selection, routing, UI, deduplication, and deployment configuration.

The subsequent [provider-timeout recovery phase](provider-timeout-recovery.md) adds bounded recovery for eligible primary provider timeouts. This document records the earlier deadline/accounting checkpoint.

## Current path traced before implementation

| Layer | File / function / setting | Previous behavior |
| --- | --- | --- |
| Browser | `src/api/mathClient.js`, `parseResponse` and fetch callers | Caller cancellation signal; no independent solve timeout. Non-2xx JSON becomes a thrown client error. |
| Canonical handler | `server/app.js`, `handleExplainRequest` | Creates `solveDeadlineAt` before usage reservation. All ordinary/progressive attempts receive the same absolute deadline. |
| Global configuration | `server/openaiModels.js`, `DEFAULT_CANONICAL_SOLVE_TIMEOUT_MS`; `server/openai.js`, `getSolveTotalTimeoutMs` | 90,000 ms default, overridden by `OMNIMATH_SOLVE_TOTAL_TIMEOUT_MS`. |
| Role ceilings | `server/openaiModels.js`, `DEFAULT_OPENAI_TIMEOUTS_MS`, `resolveOpenAiRequestTimeout` | Solver 90s, repair 120s, escalation/premium escalation 180s; role-specific environment overrides, clamped to 5–300s. |
| Buffered provider | `server/openai.js`, `fetchOpenAiWithRetry` | Each fetch receives `AbortSignal.timeout(min(role ceiling, remaining canonical time))`. Retries and their backoff share remaining canonical time. No recovery/completion reservation. |
| Full/compact generation | `server/openai.js`, `createMathExplanation` | Full and compact requests share canonical deadline; compact could start with almost no time. |
| Streaming provider | `server/openai.js`, `streamOpenAiTextResponse`, `readProviderChunk` | Same clamp; combines caller signal with timer and races reads against abort. No stage reservation. |
| Recovery policies | `server/app.js`; `ordinaryRecoveryPolicy.js`, `progressiveRecoveryPolicy.js`, `mathAssurancePolicy.js` | Handler supplied only `Date.now() < solveDeadlineAt`, without a meaningful minimum remaining budget. |
| Function envelope | `vercel.json`, `api/explain.js`, `api/solve-extracted-problem.js`, `api/explain-image.js` | Typed/extracted solve functions 100s; combined image endpoint 160s. `waitUntil` does not extend the configured function maximum. |
| Local server | `server/index.js` | Plain Node HTTP server, no custom solve response timer. |
| Accounting | `server/openai.js`, `providerCallCountFromError`; `server/app.js`, `settleFailureUsageOrRelease`; `server/usageLimits.js`, `settleTokenUsage` | Buffered transport counts successful/provider HTTP responses rather than dispatches. Timeout before a response can count as zero calls; missing usage is normalized to zero and releases the estimate. |
| Failure records | `server/failedSolveDiagnostics.js`, `summarizeUsageSettlement` | Missing usage can appear as zero actual tokens. |

There was no separately running 90s outer timer in the buffered transport. The absolute canonical deadline clamped the repair role's configured 120s fetch timer to roughly 90s. Thus the effective fetch timer won, while model-selection logs still displayed the role ceiling. A slow first request exhausted time intended for all later stages. Provider billing cannot be inferred from a missing terminal usage object.

Dispatch is locally observable immediately before `fetch()` after constructing the headers/body. This proves dispatch was attempted, not that the provider accepted or billed it. Provider request/response IDs are recorded when observed.

## New timing sequence

`createSolveBudget` owns the absolute canonical deadline, stage allocation, and dispatch ledger. Every canonical generation/transport attempt uses the same budget object. The default sequence is:

1. Canonical deadline: 90s.
2. Recovery reserve: 25% of total, capped at 30s (22.5s at default).
3. Final response reserve: 2s at default.
4. Primary stage cutoff: 65.5s. Transport retries share this cutoff; they do not reset it.
5. Compact/repair/escalation recovery cutoff: 88s. Recovery is admitted only with at least 5s of usable provider time. If not, it is explicitly skipped as `insufficient_recovery_budget`.
6. Every provider timer is `min(role ceiling, remaining canonical budget, remaining stage allocation)`, recalculated before dispatch.

Recovery remains subject to existing policy. Reserving time does not make an otherwise ineligible failure eligible for retry. In particular, ordinary provider timeouts return a typed timeout rather than introducing a new recovery strategy.

Owned timeouts return HTTP 504 / `AI_SOLVE_TIMEOUT`, a safe user-visible message, failure classification, timeout scope/source, and the existing request ID. Timeout logs distinguish provider attempt ownership from canonical deadline ownership; stage limits explain why an attempt stopped before the total deadline. Existing streaming caller abort behavior remains intact.

## Accounting

Every canonical solve dispatch counts as a provider call regardless of response success. The shared ledger preserves model, request/attempt/route correlation, attempt number, dispatch timestamp, abort timestamp, timeout source, input estimate, and available provider request/response IDs.

When usage is absent after an abort, settlement reports `usageStatus: unknown_due_to_abort` and `costStatus: unreconciled`; aggregate actual tokens/cost are `null`. A missing terminal object without abort is `unknown_unreconciled`. If some attempts report usage while another does not, aggregate accounting is `partially_observed`. Known values are retained separately as observed values. Estimates are retained as reservations, never presented as actual provider usage or charges. Pre-dispatch failures still release their reservation.

The existing benchmark accounting reader and aggregate metrics now preserve unknown cost, billed-call counts, and token totals rather than coercing null settlement values back to zero. Its call cap uses dispatch counts; its spend cap uses the held estimate while reported actual cost remains unknown. This is a propagation fix for the settlement contract, without changing benchmark solve policy.

There is no automatic provider billing reconciliation added in this pass. Dispatch/outcome and settlement logs plus existing failure records retain the evidence needed to investigate/reconcile missing usage.

## Repair-first routing remains unchanged

`handleExplainRequest` calls `resolveInitialSolveRouting`, which calls `chooseSolverRoleForProblem` in `server/solverRouting.js`. Fresh variational calculus, PDEs, matrices/operators, ODEs, functional analysis, optimization, advanced physics, and infinite series intentionally select the `repair` role. Nonstandard complexity tiers, including the tier named `escalation`, map to `repair` here. The role resolves high reasoning and the 120s role ceiling, even though this is the first generation and no repair has occurred. Budget stage is determined by attempt position/purpose, not by that role name. This routing is documented, not modified.

Deployment/runtime limits are unchanged. A total-timeout override exceeding the hosted function envelope remains a deployment configuration issue; runtime termination can prevent application settlement/logging. This scoped fix does not redesign runtime ownership or duplicate-request/client cancellation.

## Regression verification

- `tests/solveBudget.test.mjs`: primary allocation, role ceiling, elapsed remaining-time clamp, recovery time after primary exhaustion, minimum recovery admission, dispatch metadata, cancellation propagation, and typed total expiry.
- `tests/ordinaryRecoveryIntegration.test.mjs`: real AbortController expiry after a hard manual dispatch produces HTTP 504 with typed timeout and unknown accounting; insufficient compact/route-recovery budget is explicitly skipped; existing normal solves still succeed.
- `tests/solveUnknownUsage.test.mjs`: retained reservations, partial observed usage, true pre-dispatch release, and failure artifact metadata.
- Existing buffered/streaming transport, image handler, progressive cancellation, benchmark, and model-selection suites check compatibility with the new budget and settlement contract.

## Files changed in this fix

Backend: `server/solveBudget.js`, `server/openai.js`, `server/app.js`, `server/usageLimits.js`, `server/failedSolveDiagnostics.js`.

Accounting consumers: `scripts/benchmarkSolverModels.mjs`, `server/solverBenchmarkMetrics.js`.

Configuration documentation: `.env.example` (comments only; no new environment variables).

Tests: `tests/solveBudget.test.mjs`, `tests/solveUnknownUsage.test.mjs`, `tests/ordinaryRecoveryIntegration.test.mjs`, `tests/openaiTransport.test.mjs`, `tests/openAiStreamingTransport.test.mjs`, `tests/phase4ImageHandlers.test.mjs`, `tests/progressiveExplainRoute.test.mjs`, `tests/solverBenchmark.test.mjs`.

Investigation/report: this document.

Final verification: `npm run lint`, `npm run typecheck`, and `npm run build` passed. The full offline `npm test` run passed 102 of 103 test files. The remaining `tests/followupStreamingRoute.test.mjs` could not bind its loopback HTTP server (`listen EPERM: operation not permitted 127.0.0.1`); its hooks fail before route assertions in this sandbox. Focused budget, manual-handler timeout, settlement, normal solve, cancellation, recovery, and model-selection checks passed. No live provider APIs were called.
