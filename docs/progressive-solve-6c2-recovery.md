# Phase 6C.2 progressive pre-prefix recovery

## Boundary and lifecycle

The server sets `authoritativePrefixPublished` immediately after successfully writing the first validated `step_completed` event. It buffers candidate metadata until that point. Each provider call has a fresh JSON framer and step validator. A failed call's metadata, raw deltas, and draft steps stay on the server. The browser sees one `solve_started` and one terminal event for the user-visible attempt.

Once the flag is true, a transport, framing, or validation failure ends the attempt using the existing partial-failure behavior. There is no automatic replacement solve after a published step.

## Failure decisions

`server/progressiveRecoveryPolicy.js` classifies each pre-prefix failure deterministically. One equivalent same-model retry is available for transient network/provider failures, request timeouts with overall budget remaining, truncated output, unsupported stream behavior, empty output, and unrepairable framing or malformed output. A complete parseable candidate with the five fast-solve fields can receive one repair call when framing, schema, or strict step validation rejects it. The existing repair prompt builder supplies failure feedback. The repair response uses the strict provider schema and is held until its full JSON, source identity, generated TeX, progressive steps, normalization, and solution structure have passed validation; only then does the server publish its metadata and steps. Ordinary progressive attempts continue publishing each validated step as it arrives.

One escalation is available only when a separately configured escalation role resolves to a different model and the provider explicitly reports `model_not_capable`, `model_cannot_solve`, or `unsupported_reasoning`, or when a structural, validation, or truncation failure repeats after retry or repair. The escalation call is last. A hard-problem routing tier remains diagnostic because current canonical routing deliberately starts with the solver; this phase does not change that routing rule.

Cancellation, disconnect, refusal, authentication/configuration failure, usage or rate-limit failure, bad request, and exhausted overall deadline do not retry, repair, or escalate. A refusal is terminal even if another model is configured. Internal calls are capped at four total: initial, at most one same-model retry, at most one repair, and at most one escalation. The per-call transport's own retry is disabled for this path, so every provider call has one explicit index and decision.

## Deadline, attribution, and accounting

All calls share the original `solveDeadlineAt`; a role's request timeout is bounded by its remaining time. Transport request timeout and total solve deadline are classified separately. The response model that produced the accepted steps is written into solution metadata, the completed event, and the persisted/cached solution. Earlier provider attempts remain in `progressiveRecovery.providerAttempts` with classification, decision, model, timing, prefix state, and usage report/settlement status. Structured logs carry the same identifiers and omit provider output.

The route reserves usage once, sums usage and provider-call counts from every internal call, and settles the reservation once. A call with no reported usage still contributes to the provider-call count if it was initiated. Cancellation aborts the current transport and prevents another decision from starting provider work.

## Existing full-response behavior

The full-response solve already has transport retries and a repair prompt builder, but its current `classifySolveFailure` returns `response_generation_failure` for all failures, leaving its quality-repair branch unreachable. This phase reuses the builder for progressive candidates without changing full-response routing or repair behavior. The canonical initial model is selected by the existing model policy; complexity tiers currently annotate routing but still return the solver role.
