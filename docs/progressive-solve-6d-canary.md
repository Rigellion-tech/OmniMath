# Phase 6D progressive solve canary

## Switches and deployment scope

| Path | Browser request switch | Server acceptance switch | Default |
| --- | --- | --- | --- |
| Typed `/api/explain` | `VITE_PROGRESSIVE_SOLVE=true`, or `?providerStream` in Vite development | `OMNIMATH_PROGRESSIVE_SOLVE_ENABLED=true` | Full response |
| OCR direct and OCR reviewed `/api/solve-extracted-problem` | Same browser switch | Same server switch after OCR review validation | Full response |
| Local development | Vite build environment or development query parameter | Local server environment | Full response |
| Vercel Preview | `VITE_PROGRESSIVE_SOLVE=true` in **Preview** build environment | `OMNIMATH_PROGRESSIVE_SOLVE_ENABLED=true` in **Preview** runtime environment | Full response |
| Vercel Production | Production build switch, if explicitly configured | Both server switch and `OMNIMATH_PROGRESSIVE_PRODUCTION_CANARY_ENABLED=true` | Full response |

The browser flag is baked into the Vite build; server flags are read at request time. Both ordinary solve components use `providerStreamingEnabled()`. The server advertises its effective capability as `progressiveProviderEnabled` from `/api/health`. Set both switches in the **Preview** environment only for this canary, and check `/api/health` before any paid request. The production guard stays false for Phase 6D. The development URL query parameter is ignored in built deployments.

When only the server switch is on, the client sends a normal solve and receives the existing full response. When only the browser switch is on, an uncached stream request receives JSON `404 PROGRESSIVE_SOLVE_DISABLED` before provider work or usage reservation; the UI shows the error. A cached request may return its existing full JSON result, which the client recognizes by content type. Neither mismatch can be mistaken for an authoritative SSE step. Canary evidence must record the actual response content type and event timing, rather than inferring stream mode from flags.

## Preview protocol

Use a test account with valid Clerk access and unique problem text to avoid the existing solve cache. Preserve the browser Network headers, browser event and presentation timestamps, and server logs under the same request ID. Start with one simple algebra problem, then one moderate multistep problem, then one Master's-level problem. Run one OCR-reviewed solve after a controlled extraction and review. Stop after this small set unless the evidence requires one targeted repeat. No provider API calls are part of automated tests.

For each solve, record the initial routing model, each provider attempt's model and usage, recovery decision, final authoritative model, provider call count, first provider event time, first validated step time, browser SSE receipt time, visible and hoverable times, completion time, completed step count, terminal status, and aggregate usage/cost. Compare normal browser `Accept-Encoding` with an identity-encoding request where the deployment permits it. Verify `text/event-stream`, `no-store, no-transform`, no `Content-Length`, and separate arrival of Step 1, later steps, and `solve_completed`. A readable SSE body after completion alone is insufficient.

For cancellation, wait for Step 1, cancel, and check the server transport cancellation log and one settlement log for the request. Confirm the completed prefix remains visible and interactive, no incomplete next step appears, and no late terminal event changes the solve. For recovery, use the existing provider fixture to exercise retry, repair, and escalation without inducing paid failures. Record any actual canary recovery seen in the preview logs; do not manufacture a production recovery rate from fixture runs.

Server `[omnimath:progressive-recovery]` and `[omnimath:progressive-terminal]` records are single-line JSON with a shared request ID. They contain no problem text or provider output. Terminal records distinguish complete usage reports from partial reports; missing usage remains unknown. Analyze exported text logs with `node scripts/analyze-progressive-canary.mjs --json <log-file>`. Recovery frequencies computed from deliberately failing fixtures are test coverage, not a prediction of real traffic frequency. Browser timing and response headers must be collected separately because server logs cannot show CDN buffering or DOM interactivity.

## Local evidence collected on 2026-09-25

- The provider-stream browser fixture passed 5/5. In its held-provider case, Step 1 was browser-visible 1,701 ms after submit, with 94.5 ms from event receipt to visible frame and 170.2 ms from event receipt to valid hover geometry. The test hovered and pinned Step 1 before releasing Step 2. Its performance counters recorded zero old-step geometry remeasurements, zero pointer-time layout reads, and zero long tasks in that scenario. These are local fixture timings, not model or deployment timings.
- The recovery policy tests passed 9/9. Fixture cases covered same-model retry, structured repair, configured escalation, model attribution, bounded calls, no duplicate visible solve, cancellation, and post-prefix failure. The route fixture preserves OCR-reviewed canonical source and review metadata through `/api/solve-extracted-problem`.
- The Node suite passed 1,268, failed 0, skipped 21. Lint and build passed. Typecheck reported only the previously known `src/lib/solutionState.js:148 TS2339 extractionValidation` error.
- Standard Playwright finished 104/105 with one notation-heavy responsiveness threshold failure under six workers. Its largest long task was 1,702 ms and event-loop delay 2,200 ms; pointer-time layout reads were zero. The same test passed 1/1 in isolation, with a 540 ms largest long task, 757 ms event-loop delay, and zero pointer-time layout reads. This points to worker contention in this environment, but the six-worker threshold result remains recorded.
- No Preview URL or linked Vercel project is present in this workspace, and the user selected local fixture evidence for now. No deployed SSE, compression, real-provider typed/OCR/cancellation, or cost measurement has been made in this phase.

## Evidence boundary and default decision

The local fixture holds the provider before Step 2 and verifies browser-visible, hoverable, pinnable Step 1; it also covers pre-prefix recovery, partial-prefix failure, and cancellation. This establishes application and local proxy behavior. It cannot establish Vercel CDN buffering, normal browser compression behavior on the deployed route, real model first-step latency or cost, or deployed abort delivery. Those must be measured on a reachable Preview deployment before progressive solving is declared technically ready to become the default. Do not flip either production default as part of this audit.

The legacy full-response quality-repair branch is a separate backlog item. `classifySolveFailure` always returns `response_generation_failure`; the full-response handler throws on that category before reaching quality repair. Progressive solves use `classifyProgressiveFailure` and `decideProgressiveRecovery`, so this issue does not block the canary.
