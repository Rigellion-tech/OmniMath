# Hosted solve runtime compatibility

OmniMath keeps mathematical difficulty policy separate from infrastructure. A
selected canonical budget is reduced only when the current function invocation
cannot safely provide it:

`selected policy budget → deployment ceiling − elapsed pre-solve work − 5s deployment headroom → effective canonical budget`

The five-second deployment headroom is outside the canonical deadline. The
canonical profiles also retain their own two-to-ten-second response reserves,
which stop provider attempts early enough for synchronous usage settlement,
telemetry, normalization, and response construction. The deployment headroom
then protects cleanup, serialization, and the final HTTP response. Values below
five seconds are clamped to five seconds.

This reserve covers normal settlement and finalization work; database and
external accounting calls do not have a separate bounded deadline today. A
stalled dependency therefore remains subject to the hosting hard ceiling. No
production settlement-duration measurements were taken in this offline phase.

## Endpoint ownership

| User flow | HTTP function owning the long request | Hosted maximum |
| --- | --- | ---: |
| Typed solve, including Advanced LaTeX | `/api/explain` | 300s |
| Reviewed/direct OCR after separate extraction | `/api/solve-extracted-problem` | 300s |
| Legacy combined multipart extraction and solve | `/api/explain-image` | 300s |
| OCR extraction only | `/api/extract-image-problem` | 70s |

The current UI performs OCR extraction and canonical solving as separate HTTP
requests. The solve-extracted handler calls the shared canonical solve handler
inside the same function invocation; it does not create another network hop.
The legacy explain-image adapter performs extraction and solving inside one
300-second invocation.

The project uses Vite plus root `api/*.js` Node.js functions. Vercel documents
`vercel.json` function configuration for this layout. Fluid Compute supports a
300-second default and maximum on Hobby, and up to 800 seconds on Pro and
Enterprise. Function configuration overrides Fluid/dashboard defaults:

- [Configuring maximum duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Fluid Compute limits and precedence](https://vercel.com/docs/fluid-compute)
- [`vercel.json` function schema](https://vercel.com/docs/project-configuration/vercel-json)

These routes use the Node.js runtime and `supportsCancellation`. They do not use
the Edge runtime. Edge response-start and duration behavior therefore does not
define these solve lifetimes.

## Timeout and cancellation chain

The browser fetch has no automatic solve timeout. The UI passes an AbortSignal
for explicit cancellation, reset, navigation/stale-workflow cleanup, and image
workflow cancellation. A user cancellation is terminal.

The server verifies Clerk at request start, records the outer invocation start,
and selects one immutable solve policy after parsing and cache lookup. Its
absolute canonical deadline is anchored at that selection time and cannot move
later while usage reservation or other pre-provider work is awaited. Provider
attempt timeout is always the minimum of the selected role/model ceiling, the
remaining stage allocation, and the remaining canonical budget. Recovery is at
most one semantic generation, and canonical expiration is terminal.

The local Node server and Vite proxy do not impose a canonical response
deadline. Local development therefore receives the selected profile unless
`OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS` explicitly simulates a ceiling. Vercel
production uses the registered route ceiling. A non-Vercel production process
must set that environment variable so it cannot silently claim unlimited
runtime without knowing its host limit. On Vercel the variable may lower but
cannot raise the registered duration.

Clerk tokens are refreshed before each canonical browser request and verified
once at the start of that request. A token expiring while the model runs does
not invalidate the verified identity. Current session autosave requests also
fetch fresh tokens. Best-effort explanation persistence can report an
`auth_expired` warning without changing a completed solve response.

Vercel notes that idle HTTP/1.1 clients or intermediate network layers may close
long connections even while a function remains alive; HTTP/2 ping is supported.
OmniMath has no shorter application or Vite reverse-proxy timer. This phase does
not add keepalive frames, chunking, polling, jobs, or queues.

## Effective production budgets

With the confirmed Fluid Compute Hobby configuration, `/api/explain` and
`/api/solve-extracted-problem` normally provide the full 45s, 90s, 150s, and
240s canonical profiles. Elite remains full when pre-solve work is at most 55s;
otherwise the effective budget is capped and telemetry reports the exact value.

The legacy combined endpoint cannot guarantee a full Elite budget in its worst
case on Hobby. Its existing hosted extraction allowance is 60s, so 60s
extraction + 240s canonical + 5s deployment headroom is 305s before incidental
pre-solve work. The normal two-request image flow does not share this limit. A
guaranteed full Elite budget on the legacy combined route would require a plan
supporting more than 300 seconds and a correspondingly larger route duration;
the OCR behavior is intentionally unchanged.

Correlated solve telemetry includes `difficultyTier`,
`selectedPolicyBudgetMs`, `deploymentMaxDurationMs`,
`deploymentHeadroomMs`, `elapsedPreSolveWorkMs`,
`runtimeAvailableBudgetMs`, `effectiveCanonicalBudgetMs`,
`budgetCappedByRuntime`, and `runtimeCapReason`. Existing field names remain for
backward compatibility.
