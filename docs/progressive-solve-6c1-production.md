# Phase 6C.1 progressive presentation and deployment check

## Browser baseline before 6C.1

The synthetic browser fixture showed completed steps immediately and retained Step 1's semantic ID, active hover target, and pinned lens when later steps appended. The header changed from “Solving problem” to “Solution in progress”, but there was no continuation state beneath accepted work. The page stayed at its old scroll position as the document grew beyond the viewport, with no return-to-latest control. Failure preserved accepted steps and omitted the unfinished draft, but its error card was visually separate from those steps. Cancellation used a warning status; completion used “Explanation ready”.

## Presentation policy

Only validated completed steps enter `SolutionFlow`; no provider draft or partial TeX is rendered. New cards have a short opacity arrival. The continuation indicator sits beneath accepted steps and is removed at completion, failure, or cancellation. Failure and cancellation leave a compact message below the preserved prefix.

Window scroll following starts when the reader is near the bottom. It pauses when the reader scrolls upward, hovers or selects a step, focuses step content, or interacts with a pinned lens. Manual return to the document bottom or “Jump to latest” resumes following. New steps append silently while following is paused. The arrival animation changes opacity only, so math hit targets keep their geometry; reduced-motion settings remove the animation.

Development diagnostics at `window.__OMNIMATH_PROGRESSIVE_PRESENTATION__.steps` record the server acceptance timestamp supplied with `step_completed`, browser event receipt, React step insertion, first rendered frame, and valid semantic geometry. Browser monotonic timestamps provide event-to-visible and event-to-hoverable latency without pointer-path instrumentation.

## Production stream check

The three Vercel solve functions have route-specific durations and cancellation support. The SSE route sends `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, and `X-Accel-Buffering: no`, then flushes headers before events. There is no app-level compression or buffering middleware on `/api/*`. A local forwarding-proxy fixture checks that Step 1 is visible in the browser while the provider is held before Step 2. Vercel's CDN/runtime behavior remains deployment dependent. See [Vercel streaming](https://vercel.com/docs/functions/streaming-functions), [Node runtime](https://vercel.com/docs/functions/runtimes/node-js), and [request cancellation](https://vercel.com/docs/functions/functions-api-reference).

On a preview deployment with progressive mode enabled:

1. Start an uncached typed solve and record the browser Network response headers. Confirm `text/event-stream`, `no-store, no-transform`, no `Content-Length`, and no cache hit.
2. Record the browser receipt time of the first `step_completed` event and the server terminal log time. Step 1 must render and become hoverable before `solve_completed` and before the provider finishes. Repeat with normal browser compression negotiation and with `Accept-Encoding: identity` to check for CDN compression buffering.
3. Repeat for an OCR-reviewed solve after confirming the extracted problem. Confirm the same early Step 1 behavior on its `/api/solve-extracted-problem` path.
4. Cancel after Step 1. Confirm provider abort, the accepted prefix remaining usable, and usage settlement in server logs. Vercel's `waitUntil` keeps the handler's cleanup promise alive after client disconnect, subject to the function's configured duration.

The preview check is required because the local proxy cannot reproduce Vercel's CDN compression, account-specific duration limits, or runtime cancellation delivery.
