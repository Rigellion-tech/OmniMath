# Provider-attempt timeout recovery

This phase fixes execution after a primary provider timeout. The canonical deadline remains 90 seconds, with 65.5 seconds for primary work, 22.5 seconds reserved for recovery, and 2 seconds for response/cleanup. Initial model routing is unchanged.

## Investigation

The shared canonical handler is `handleExplainRequest` in `server/app.js`; reviewed OCR solves call that same handler. There is no separate `handleCanonicalSolve` function.

`fetchOpenAiWithRetry` in `server/openai.js` creates an owned provider-attempt error through `createSolveTimeoutError`: HTTP 504, `AI_SOLVE_TIMEOUT`, `responseFailureType: request_timeout`, `timeoutScope: model_request`, `timeoutSource: provider_attempt_timeout`, and the limiting stage in `budgetLimitReason`. The provider timer aborts its attempt controller, leaving the canonical budget signal active. Canonical expiry and client abort use the shared canonical signal instead.

`createMathExplanationWithBudget` rethrows a provider failure before parsing a candidate. It records the failure and attaches dispatch accounting. A provider timeout therefore has no candidate to repair or present.

Before this fix, `classifyOrdinarySolveFailure` returned `request_timeout`, and `decideOrdinaryRecovery` admitted only `structured_output_failure`. The handler consequently logged `fail`, with no next route attempt, despite the reserved time. `recoveryEligible` was computed and logged by routing but never passed into the ordinary recovery decision. Timeout ownership fields reached the classifier on the error but were not used to distinguish recoverable provider timeouts.

`solveBudget.canStartRecovery()` exposes minimum usable recovery time; `remainingMs({ recovery: true })` and `attemptBudget({ recovery: true })` expose the allocation. Previously an early recovery could receive all time until the recovery cutoff. Recovery now has a fixed allocation beginning at its first provider allocation, bounded by that cutoff. Repeated allocations share its remaining time.

Progressive recovery already allows one timing retry before authoritative steps are published. The ordinary policy owns the new ordinary timeout decision; the handler supplies context and executes it. Existing structured-output escalation remains separate.

## Resulting control flow

1. Primary success proceeds normally without timeout recovery.
2. An owned provider timeout can select one `retry` when routing permits recovery, the canonical deadline is live, meaningful recovery time remains, no usable candidate exists, and the request has not been cancelled.
3. Route attempt 2 uses the existing primary model path and canonical prompt, a distinct route ID/index, the shared request ID and dispatch ledger, the recovery budget stage, and disabled compact recovery.
4. A usable recovery candidate follows the normal acceptance and response path. Primary timeout and recovery selection/success remain visible in telemetry.
5. Failure of that final recovery returns one typed timeout; cancellation and canonical expiry retain their terminal ownership. No route attempt 3 is launched.

Ordinary typed and reviewed OCR solves propagate disconnect/cancellation into the canonical budget. Reviewed OCR cancellation uses the original HTTP request/response rather than relying on copied internal adapters.

## Accounting and frontend

Each actual dispatch remains a separate provider-call record. Missing primary usage remains unknown. Known recovery usage is retained as observed values; aggregate usage is `partially_observed`, aggregate actual token/cost totals remain unknown, and cost remains unreconciled. No token usage is invented.

The existing failure card displays final `AI_SOLVE_TIMEOUT`. A fresh typed failure retains its canonical submitted problem in the owning session; reviewed OCR failures retain their extraction and edited text. No visual redesign is included.

Verification uses mocked providers and offline network guards. No live provider calls or commits are part of this phase.

## Changed files

- Backend: `server/ordinaryRecoveryPolicy.js`, `server/solveBudget.js`, `server/app.js`, `server/openai.js` (stage telemetry).
- Frontend: `src/components/math/PrimaryMathComposer.jsx`, `src/pages/Home.jsx`, `src/lib/solutionState.js`, `src/lib/generationStatus.js`, `src/lib/imageIngestionLifecycle.js`.
- Tests: `tests/ordinaryRecoveryPolicy.test.mjs`, `tests/ordinaryRecoveryIntegration.test.mjs`, `tests/solveBudget.test.mjs`, new `tests/providerTimeoutRecovery.test.mjs`, `tests/solveResponseNormalization.test.mjs`, `tests/phase4ClientIngestion.test.mjs`.
- Documentation: this report and a follow-up link in `docs/canonical-solve-deadline-fix.md`.

## Verification results

The timer-driven integration tests use real AbortControllers with Node's mocked clock/timers. They prove a primary dispatch aborts at 65.5 seconds, recovery receives 22.5 seconds, success returns normally, and a second abort returns exactly one final typed timeout with both records and no third dispatch.

| Required regression | Coverage |
| --- | --- |
| A, B, F, H, I | Timer-driven recovery success: actual primary abort, recovery-stage allocation, usable solution, distinct dispatches, unknown primary plus observed recovery usage |
| C, D | Ordinary integration and policy: canonical deadline and client AbortSignal cancellation suppress recovery |
| E | Existing ordinary successful-primary integration assertions retain one provider call |
| G, J | Timer-driven double timeout, malformed recovery integration, and policy attempt-limit guards |
| K | Full suite, including existing fast/easy solve, canonical model policy, model execution configuration, and model capabilities tests |

Additional policy guards cover recovery eligibility, insufficient recovery budget, and usable candidate presence. Budget tests prove the entire recovery stage cannot reset its allocation across successive provider allocations. Frontend tests prove typed canonical input/source-mode preservation, clearing stale solution steps, typed timeout status, and reviewed-image timeout messaging.

- Focused backend policy/budget/integration: 38 passed.
- Timer-driven integration: 2 passed.
- Focused frontend state/ingestion: 37 passed.
- Full offline suite: `NODE_OPTIONS='--import ./tests/helpers/noExternalNetwork.mjs' npm test` — 1,511 tests, 1,490 passed, 0 failed, 0 cancelled, 21 existing skipped tests, 73 suites.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check` passed.

The exact reported hard primary-stage timeout should now produce a second provider dispatch when the request remains active and the recovery reserve is available. Whether that fresh provider request produces a usable solution within its reserve remains dependent on the provider; no live reproduction was run in this phase.
