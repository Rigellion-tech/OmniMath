# OCR review ownership and canonical-attempt investigation

Date: 2026-09-14

Scope: offline investigation only. No provider was called and no production file was changed.

## Result

The OCR contradiction is reproduced in the actual browser flow and at the server route boundary. It has two exact divergence points:

1. A user action labeled **Continue with reviewed text** is encoded as `solveDecision: "direct"` whenever the text was not modified. The backend defines `direct` as lacking an explicit user review decision and rejects it when canonical structural findings require review.
2. Before the server responds, the pending problem is committed with `extractionValidation` nested under `problem.imageSource`. `ProblemBlock` reads only `problem.extractionValidation`, defaults the absent value to `{}`, and therefore renders **Extraction checked**. Its **reviewed extraction** metadata is derived merely from the presence of OCR/image fields.

These are related ownership defects. The extraction evidence itself is preserved in the request; the disagreement is caused by reconstructing review completion and display status from proxies at two boundaries.

Repeated `canonical-solve-*` IDs for one server image-content hash are expected across distinct solve invocations. One click produced exactly one request in the focused browser test, and idle/rerender time produced no additional request. A second explicit click after the 409 produced a second ID with the same image hash. No automatic retry loop was found. Existing logs without client operation events cannot prove whether observed repeats were separate user clicks, browser automation, or an unusual duplicate DOM event.

## End-to-end ownership trace

| Stage | Representation | Owner and transition |
| --- | --- | --- |
| Local image selection | client `imageHash` | `ImageUpload.getImageHash` joins filename, MIME type, byte size, last-modified time, and client OCR-confidence metric. It is an operation fingerprint, not a content hash ([ImageUpload.jsx:450](../src/components/math/ImageUpload.jsx#L450)). |
| UI operation | `operationId`, `originSessionId`, `revision`, client `imageHash` | `Home.createOperationContext` creates one logical UI workflow identity and owns stale-result suppression ([Home.jsx:299](../src/pages/Home.jsx#L299)). |
| Extraction HTTP attempt | `image-extract-*` | The API client creates a new extraction-attempt ID and sends it as multipart `debugRequestId` ([mathClient.js:344](../src/api/mathClient.js#L344)). The UI `operationId` is not sent. |
| Server image identity | server `imageHash` | The extraction route computes SHA-256 over the uploaded bytes ([explanationCache.js:35](../server/explanationCache.js#L35), [app.js:2743](../server/app.js#L2743)). This differs semantically and usually in value from the client field also named `imageHash`. |
| OCR extraction | raw/cleaned text, LaTeX, display segments | Provider extraction is normalized, while raw text is retained ([app.js:2778](../server/app.js#L2778)). |
| Structural evidence | `extraction.extractionValidation` | `validateExtraction` owns `status`, `tier`, `critical`, confidence scores, issues, and metrics ([extractionValidation.js:478](../server/extractionValidation.js#L478), [extractionValidation.js:628](../server/extractionValidation.js#L628)). The extraction route also copies summaries to `extraction.confidenceTier`, `issues`, and `imageSource` ([app.js:2822](../server/app.js#L2822)). |
| Auto-solve eligibility in UI | high tier and not critical | `ImageUpload` auto-solves only `confidenceTier === "high" && !extractionValidation.critical`; otherwise it opens review ([ImageUpload.jsx:579](../src/components/math/ImageUpload.jsx#L579), [ImageUpload.jsx:638](../src/components/math/ImageUpload.jsx#L638)). This is a client workflow branch, not backend authorization. |
| Review UI | `editing`, edited text, tier/status copy | The review panel exists because `workflow.extraction` exists. Its guidance derives from tier. Its button always says **Continue with reviewed text** ([ImageUpload.jsx:94](../src/components/math/ImageUpload.jsx#L94), [ImageUpload.jsx:105](../src/components/math/ImageUpload.jsx#L105)). `editing` means that the editor was opened; it is not persisted review completion. |
| User continue action | callback argument then `solveDecision` | The button sends `"direct"` unless the editor is open ([ImageUpload.jsx:207](../src/components/math/ImageUpload.jsx#L207)). The solve handler then ignores that editor-open signal and recomputes `edited` solely by string comparison; unchanged text becomes `"direct"` ([ImageUpload.jsx:693](../src/components/math/ImageUpload.jsx#L693)). There is no reachable `"anyway"` action in this component. |
| Canonical input | `canonicalProblem`, canonical hashes, `source` | `buildExtractionSubmissionPayload` normalizes editable text, builds a new canonical problem, preserves extraction evidence, and labels the source `ocr-reviewed` when explicitly requested by the caller ([mathClient.js:436](../src/api/mathClient.js#L436)). Here `ocr-reviewed` is assigned even though `solveDecision` remains `direct`, so it cannot safely mean review completion. |
| Pending UI problem | `pendingSolve`, `imageSource.solveDecision` | `Home` commits a pending problem and labels generation **Solving reviewed problem** before the HTTP eligibility result ([Home.jsx:811](../src/pages/Home.jsx#L811)). `createPendingReviewedProblemState` puts the entire extraction under `imageSource`, sets `pendingSolve`, and does not copy validation to the top level ([solutionState.js:109](../src/lib/solutionState.js#L109)). |
| Canonical solve HTTP attempt | `canonical-solve-*` | Every `solveCanonicalProblem` invocation generates a fresh ID immediately before fetch ([mathClient.js:254](../src/api/mathClient.js#L254), [mathClient.js:267](../src/api/mathClient.js#L267)). It is an attempt identity. It carries canonical/input hashes and extraction metadata, but no UI `operationId` or attempt ordinal. |
| Backend solve eligibility | `ocrDecision.reviewRequired/allowed/reason` | The extracted-problem route prefers the nested canonical validation object and calls `assertOcrSolveAllowed` before entering the shared solver ([app.js:2887](../server/app.js#L2887), [app.js:2895](../server/app.js#L2895)). The policy blocks structural findings only when `solveDecision === "direct"`; `edited` and `anyway` count as explicit review decisions ([ocrSolvePolicy.js:30](../server/ocrSolvePolicy.js#L30)). |
| Rejection UI | generation error plus still-pending problem | A 409 becomes an image-solve generation error, while the previously committed pending OCR problem stays rendered ([ImageUpload.jsx:738](../src/components/math/ImageUpload.jsx#L738), [Home.jsx:895](../src/pages/Home.jsx#L895)). The upload workflow remains available because only successful solve resets it. |
| OCR status badge | `problem.extractionValidation || {}` | `ProblemBlock` misses `problem.imageSource.extractionValidation`, defaults status to `ok`, and renders **Extraction checked** ([ProblemBlock.jsx:217](../src/components/math/ProblemBlock.jsx#L217), [ProblemBlock.jsx:228](../src/components/math/ProblemBlock.jsx#L228)). |
| OCR provenance label | presence of image/OCR fields | `ProblemBlock` renders **reviewed extraction** for every image/OCR problem unless it was edited ([ProblemBlock.jsx:127](../src/components/math/ProblemBlock.jsx#L127)). It does not inspect a completed review event. |

## Review-state inventory

### Legitimate distinct states

- `extractionValidation.status/tier/issues/critical`: evidence and presentation severity from extraction validation.
- client auto-solve branch: whether the UI should stop at the review panel.
- backend `ocrDecision.allowed`: solve eligibility under current server policy.
- `pendingSolve`: whether a solve attempt has been launched and has no result yet.
- `canonicalProblem.source`: input provenance, provided it is treated only as provenance.

These concepts should stay distinct because a warning can legitimately require a human action, and evidence is not itself the user action or delivery policy.

### Dangerous or misleading duplication

- Review completion is represented by the button label, canonical source `ocr-reviewed`, pending status **Solving reviewed problem**, image-presence metadata **reviewed extraction**, edit delta, and `solveDecision`. Only `solveDecision` reaches backend policy, and unchanged confirmation maps to `direct`.
- Validation evidence exists canonically at `payload.extraction.extractionValidation` but the pending UI asks only for `problem.extractionValidation`; it silently invents `ok` when the path is absent.
- Extraction validation is copied into top-level summaries and `imageSource` summaries. The backend correctly prefers the canonical nested object, but UI consumers do not consistently use the same path.
- Both a metadata fingerprint and a SHA-256 byte digest are named `imageHash`. They are legitimate separate identities with a dangerous shared label.
- A logical UI `operationId` spans extraction, review, and retries, but it stops at the browser boundary. The canonical request ID identifies only an HTTP attempt, so server-only logs cannot group attempts into one UI operation.

## Repeated canonical solve IDs

The identity hierarchy in this flow is:

```text
user/session
  -> UI operationId + revision (logical image OCR workflow)
     -> client image fingerprint (selected-file lifecycle)
     -> image-extract-* (extraction HTTP attempt)
        -> server SHA-256 imageHash (image content identity)
     -> canonical problem hash/contentHash (canonical input identity)
     -> canonical-solve-* (each solve HTTP attempt)
        -> provider response/request identity, only if eligibility passes
        -> persistence identity, only after a delivered solve is scheduled for save
```

The focused browser test observed:

- First Continue click: one HTTP solve request.
- 250 ms idle/rerender period: still one request.
- Second Continue click after 409: a second request with a distinct `canonical-solve-*` ID and the same server image hash.

The 409 is thrown before the shared solver, cache lookup/deduplication, usage reservation, provider call, or save. Therefore repeated `ocr-structural-review-required` records with distinct canonical IDs reflect repeated inbound solve requests, not backend provider retries or persistence fallback. The client has no solve retry loop in `ImageUpload`. A 409 also leaves the continue button available and does not set the upload panel's special `solveError`, so repeated user clicks are a straightforward explanation. Proof of the historical trigger requires correlated browser operation logs or interaction telemetry.

## Persistence relevance

PostgreSQL fallback is not causal for either reproduced OCR symptom. The UI contradiction exists before persistence, and the server rejects review-required input before the shared solve handler reaches identity, usage settlement, provider, or save. A missing `app_users` table cannot create the 409, change `solveDecision`, lose `extractionValidation` in the pending UI object, or generate a second client request ID.

## Narrow invariants and smallest milestone

The narrowest preventive invariants are:

1. A user review action has an explicit operation field owned by the review UI and carried unchanged to server eligibility. Text mutation is separate evidence and must not be used as a proxy for confirmation.
2. Extraction validation has one canonical payload path across extraction, pending UI state, canonical submission, and response. UI labels must derive from that evidence plus the explicit review action; absence must render unknown rather than checked.
3. `operationId` identifies the logical OCR workflow; `requestId` identifies one attempt. Carry both, plus an attempt ordinal, across the canonical solve boundary.
4. Rename or type the two image identities as client file fingerprint and server content hash so correlation does not assume equality.

The smallest justified production milestone is an OCR contract reconciliation, not a policy weakening:

- add an explicit unchanged-confirmation review decision distinct from auto/direct solve and edited confirmation;
- preserve/read canonical extraction validation in pending problem state;
- derive **reviewed extraction** from the explicit confirmation state;
- carry operation identity and attempt ordinal with canonical solve diagnostics.

Tests should include:

- a component test proving unchanged Continue is an explicit reviewed decision and passes the existing structural-review guard;
- a route contract test proving auto/direct remains blocked while reviewed-unchanged and reviewed-edited are allowed;
- a pending-state render test proving warning/danger evidence cannot become **Extraction checked**;
- a lifecycle test proving one click emits one attempt and a retry retains operation ID while incrementing attempt ID/ordinal;
- high-tier auto-solve coverage proving no human-review receipt is invented.

## Reproduction evidence and uncertainty

- `tests/architectureOcrReconciliation.test.mjs`: route and data-boundary reproduction. Passed 2/2 offline.
- `tests/architectureOcrReconciliation.layoutRegression.spec.mjs`: actual component/browser reproduction and attempt-count check. Passed 1/1 offline.
- No production code was changed and no external provider endpoint was called. Browser API routes were intercepted locally; the Node socket guard does not govern Chromium networking, so this run does not establish a general no-network guarantee for the browser process.

Unproven:

- Which exact interaction created each historical repeated request.
- Whether a rare duplicate browser event can bypass React's discrete-event state flush; the deterministic browser test did not reproduce one.
- Whether any historical log compared the client fingerprint to the server SHA-256 value as if they were equal.
- Live provider behavior, intentionally outside this investigation.
