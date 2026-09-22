# Model identity and accounting investigation

## Finding

The observed hover mismatch is reproducible offline with one request, so it is not caused by concurrent-request correlation, retry routing, or a provider fallback. The hover request is routed to and sent as `gpt-4.1-mini`; the fixture provider returns the versioned identity `gpt-4.1-mini-2025-04-14`; the later `[omnimath:ai-request]` record reports `gpt-5.6-luna` because its logger independently calls the solver-default accessor.

This is a post-settlement observability defect. Aggregate token and cost accounting use the hover call's model-tagged usage and are correct in the deterministic fixture. The usage settlement response has a separate loss of detail: `actualInputTokens` and `actualOutputTokens` are both zero because the hover handler passes only total tokens and cost to `settleTokenUsage`.

## Deterministic reproduction B

[`tests/architectureModelReconciliation.test.mjs`](../tests/architectureModelReconciliation.test.mjs#L47) performs a real `/api/explain-token` handler invocation with an offline-signed Clerk session, a temporary local usage store, and a mocked Responses API. External sockets are blocked by [`tests/helpers/noExternalNetwork.mjs`](../tests/helpers/noExternalNetwork.mjs#L1).

The fixture configures the solver as `gpt-5.6-luna` and hover as `gpt-4.1-mini` ([lines 63-78](../tests/architectureModelReconciliation.test.mjs#L63)). One mocked provider success returns `gpt-4.1-mini-2025-04-14` and 1,000 input plus 2,000 output tokens ([lines 86-104](../tests/architectureModelReconciliation.test.mjs#L86)). The assertions establish:

- outgoing payload and request log: `gpt-4.1-mini`;
- provider response log: `gpt-4.1-mini-2025-04-14` with response ID `resp_hover_model_reconciliation`;
- final `[omnimath:ai-request]`: `gpt-5.6-luna` and no request ID ([lines 143-154](../tests/architectureModelReconciliation.test.mjs#L143));
- response settlement and the persisted aggregate store: 3,000 total tokens and 5,000 cost micros, using fixture pricing for `gpt-4.1-mini` ([lines 156-173](../tests/architectureModelReconciliation.test.mjs#L156));
- settlement input/output detail: zero/zero despite the provider usage having 1,000/2,000.

Command:

```sh
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/architectureModelReconciliation.test.mjs
```

Result: 1 passed, 0 failed. No provider call was made.

## End-to-end identity trace

| Stage | Representation and owner | Observed value | Assessment |
| --- | --- | --- | --- |
| Browser operation | `ExplanationPanel` creates a component-local numeric request ID and derives a transport ID as `mode-requestId-cacheHash` ([`ExplanationPanel.jsx:100`](../src/components/math/ExplanationPanel.jsx#L100), [`:320`](../src/components/math/ExplanationPanel.jsx#L320)) | e.g. `hover-1-...` | UI lifecycle identity, not model identity |
| HTTP entry | `handleLazyExplanationRequest` accepts that value as `debugRequestId`, or generates `hover-*` if absent ([`app.js:3066`](../server/app.js#L3066)) | hover request ID | Logical handler/diagnostic identity |
| Role selection | `createLazyTokenExplanation` chooses `hover` for token mode ([`openai.js:2262`](../server/openai.js#L2262)); `selectOpenAiModel` resolves the role-specific environment/default ([`openaiModels.js:473`](../server/openaiModels.js#L473)) | `gpt-4.1-mini` | Authoritative selected/requested model |
| Provider request | `requestOpenAi` copies `selection.modelId` into `payload.model` ([`openai.js:1577`](../server/openai.js#L1577)) | `gpt-4.1-mini` | Correct; routing mismatch falsified |
| Transport metadata | `fetchOpenAiWithRetry` retains the payload model, role, attempt ordinal, and app request ID in non-enumerable `_omniOpenAiMeta` ([`openai.js:869`](../server/openai.js#L869), [`:1030`](../server/openai.js#L1030)) | selected model + attempt | Correct within provider pipeline |
| Provider response | Response body owns `id` and `model`; the standard response log prints them ([`openai.js:548`](../server/openai.js#L548)) | response ID plus `gpt-4.1-mini-2025-04-14` | Legitimately distinct from requested alias |
| Usage provenance | On provider success, usage is tagged with the requested model from the payload ([`openai.js:133`](../server/openai.js#L133), [`:1017`](../server/openai.js#L1017)) | `_omni_model_usage[0].model = gpt-4.1-mini` | Carries the correct pricing identity |
| Result boundary | Lazy result returns parsed content and tagged `responseBody.usage` ([`openai.js:2273`](../server/openai.js#L2273)) | usage carries requested model; response model is not returned as an ordinary field | Enough for current cost calculation, insufficient for complete observability |
| Reservation | Handler reserves estimated tokens and cost before the call ([`app.js:3146`](../server/app.js#L3146)) | scalar estimates | Estimate uses global cost defaults, not the selected role model |
| Settlement | Handler normalizes actual usage, estimates cost from tagged usage, then supplies only total tokens and cost ([`app.js:3198`](../server/app.js#L3198)) | 3,000 tokens; 5,000 micros | Aggregate correct; input/output breakdown silently defaults to zero |
| Persistence | `settleTokenUsage` adjusts scalar counters keyed by period, metric, and identity ([`usageLimits.js:126`](../server/usageLimits.js#L126), [`:835`](../server/usageLimits.js#L835)) | request/token/cost counters | No model, request, response, or attempt dimension is persisted |
| Final app log | `logExplanationSource` ignores originating operation metadata and calls `getOpenAiModel()`, which returns the solver path ([`app.js:1943`](../server/app.js#L1943), [`openai.js:251`](../server/openai.js#L251)) | `gpt-5.6-luna` | Exact divergence point |
| HTTP response | Payload contains explanation, semantic target, usage, and cache flag ([`app.js:3251`](../server/app.js#L3251)) | no model identity | UI behavior unaffected |

## Selection, copying, defaulting, normalization, and overwriting audit

- **Selected:** once per provider call by `selectOpenAiModel`. Hover and pinned have independent role configuration; defaults are both `gpt-4.1-mini` ([`openaiModels.js:16`](../server/openaiModels.js#L16), [`:80`](../server/openaiModels.js#L80)).
- **Copied:** into provider `payload.model`, transport diagnostics, `_omniOpenAiMeta.model`, and `_omni_model_usage[].model`. These copies agree in the reproduction.
- **Provider-owned normalization/versioning:** `responseBody.model` is logged separately and is not overwritten. The requested alias and returned dated model are legitimate distinct facts.
- **Usage normalization:** `normalizeOpenAiUsage` strips usage down to token categories for arithmetic ([`openai.js:1218`](../server/openai.js#L1218)); `_omni_model_usage` remains on the original usage object used by the cost estimator.
- **Cost selection:** `estimateOpenAiCost` prefers `_omni_model_usage` and applies model-specific pricing ([`openai.js:1239`](../server/openai.js#L1239)). It does not use the later incorrect log field.
- **Defaulted/reconstructed:** in the scoped successful hover flow, the final app-level log is the stage that reconstructs model identity from the current solver configuration. Cached calls also pass no originating usage to this logger and therefore get the same solver-default label despite making no provider request ([`app.js:2313`](../server/app.js#L2313)).
- **Overwritten:** no evidence shows the provider request model, provider response model, or usage model being overwritten. The incorrect log is a newly constructed record.

## Correlation and ownership audit

The relevant identities are distinct:

- Clerk user ID owns quota scope and is included in the app-level log.
- Clerk session ID is verified from the JWT but is not included in hover logs, cache keys, reservations, or persisted counters.
- Browser request ID is component-local and starts from a `useRef(0)` counter ([`ExplanationPanel.jsx:480`](../src/components/math/ExplanationPanel.jsx#L480), [`:531`](../src/components/math/ExplanationPanel.jsx#L531)). The derived transport ID can repeat after a component remount for the same cache key; it is diagnostic/UI lifecycle identity, not a globally unique operation ID.
- Backend hover request ID adopts the browser transport ID and is present in debug-only hover/OpenAI records.
- Cache key is a SHA-256 hash of user, problem, target/reference, and mode ([`explanationCache.js:15`](../server/explanationCache.js#L15)). It owns cache and in-flight deduplication identity, not request-attempt identity.
- Provider attempt identity is only the ordinal inside `_omniOpenAiMeta`/transport diagnostics. No provider request header ID is captured.
- Provider response ID comes from `responseBody.id` and appears in `[omnimath:openai-response]`.
- Usage reservation has no correlation ID; persistent usage aggregates by date/month, metric, and user/global identity.
- `[omnimath:ai-request]` has neither backend request ID nor provider response ID. Under concurrency, it cannot be reliably joined to either record by ID.

The deterministic single-request reproduction falsifies bad correlation as the cause of this specific model mismatch. The missing IDs remain an observability weakness because they prevent robust reconciliation of real concurrent logs.

## Accounting impact

The observed wrong `model` field does **not** drive settlement. `estimateOpenAiCost(result.usage)` sees model-tagged provider usage before `logExplanationSource` runs. The temporary persisted store proves correct aggregate totals for the fixture. The PostgreSQL `app_users`/explanation store is not on the hover path and is not the usage counter store; its missing-schema fallback cannot cause this mismatch.

Current accounting limitations:

1. Reservations use `estimateOpenAiCostBudget` with global per-token defaults ([`openai.js:1200`](../server/openai.js#L1200)), so the pre-call reservation can differ from selected-model pricing until settlement corrects the aggregate.
2. Hover/pin settlement omits actual input/output arguments, producing a false zero/zero breakdown while total tokens and cost remain right.
3. Persistent counters contain no per-model ledger, so historical cost cannot be audited by requested or returned model from stored usage alone.
4. Usage is priced by requested model alias, while returned version is retained only in response diagnostics/logs. This is reasonable for the current alias-based pricing table, but exact provider-billing reconciliation is unproven because no provider-reported cost or response-version ledger exists.

## Duplicated states: legitimate and dangerous

Legitimate plurality:

- selected role (`hover`), requested model (`gpt-4.1-mini`), and returned provider model version (`gpt-4.1-mini-2025-04-14`) answer different questions;
- browser lifecycle ID, cache/deduplication key, provider attempt ordinal, and provider response ID describe different scopes;
- estimated reservation and actual settlement are separate lifecycle states.

Dangerous divergence:

- `[omnimath:ai-request].model` is reconstructed from the solver default instead of carried from the completed provider operation;
- app/provider/usage records lack a common correlation ID at the final logging and persistent-accounting boundaries;
- input/output token categories exist in provider usage but are dropped at the handler-to-settlement call;

The same generic logger is used by solve, cached solve, hover/pin, compare, and follow-up paths ([`app.js:1943`](../server/app.js#L1943)). Therefore model-label errors are not limited to hover: role-specific and multi-attempt routes can also be mislabeled, and cached records are labeled with a model despite no provider call.

## Narrow invariant and smallest justified milestone

The narrow invariant is: **provider-call metadata must be created at model selection and carried through response parsing, settlement, and telemetry; later stages must not reconstruct it from route defaults.** This metadata should preserve separate fields for role, requested model, returned model, provider response ID, app request ID, and attempt ordinal. It does not require a global state object or collapsing requested and returned model identities.

Smallest production correction:

1. Introduce/pass a compact settled-call metadata value from `createLazyTokenExplanation` into the hover handler and `logExplanationSource`.
2. Make the logger consume explicit `requestId`, role, requested model, returned model, and response ID. For local/cache records, emit no provider model unless origin metadata is actually available.
3. As an adjacent correction at the same handler boundary, pass normalized input/output token counts and provider call count to `settleTokenUsage`. This is independently observable but is not required to correct the model label.

Tests accompanying that correction should invert the current mismatch assertions, cover hover and pinned role separation, verify a cached response does not claim a live model, verify dated returned model remains distinct, and verify settlement input/output totals if the adjacent correction is included. A persistence test should be added only if a per-call/model usage ledger is intentionally introduced; scalar counter behavior is already covered by this fixture.

Reservation estimate consistency should be evaluated separately. Making `estimateOpenAiCostBudget` model-aware could align the pre-call reservation with settled pricing, but the reproduction shows settlement already corrects the aggregate and does not justify changing reservation architecture as part of the observed logging fix. Likewise, broader cross-request correlation work may be valuable, but a concurrent-request change is not necessary to fix a mismatch reproduced with one isolated request.

## What remains unproven

- No real provider call was made, so exact provider billing semantics for requested aliases versus returned dated versions were not verified.
- Existing runtime log ordering/captures were not supplied in the repository, so the exact observed production/local event sequence was not replayed; the same values were reproduced deterministically.
- The test proves local-file aggregate persistence. KV persistence runs the same scalar key/delta path, but this fixture did not call a KV service.
- There is no persistent per-call model ledger to inspect, so historical per-model attribution cannot be validated or disproved from storage.
- This investigation did not determine whether the follow-up route's use of the solver model with a pinned timeout role is intentional; it is outside the hover mismatch.
