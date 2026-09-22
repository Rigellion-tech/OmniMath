# Typed/OCR solve unification

## Pre-change production audit

This audit reflects the working tree immediately before the unification milestone.

### Typed entry and call graph

`ProblemInput.handleSubmit` → `mathClient.explainProblem` → `POST /api/explain`
→ `handleExplainRequest` → canonical problem normalization → history parsing →
cache/deduplication → local-rule lookup or `createMathExplanation` → provider
transport/schema parsing/compact retry → local normalization → structural
acceptance/finalization → math annotation → usage settlement → cache/persistence →
response normalization → `Home.handleProblemGenerated` → operation ownership gate
→ solution/session commit.

### Current staged OCR entry and call graph

`ImageUpload.handleSubmit` → `mathClient.extractImageProblem` →
`POST /api/extract-image-problem` → upload validation → image transcription → OCR
text cleanup/display construction → extraction validation → review/direct decision →
`buildExtractionSubmissionPayload` → `mathClient.solveExtractedProblem` →
`POST /api/solve-extracted-problem` → a second, independent solve orchestrator →
response normalization → the same Home operation ownership gate and session commit.

The Home operation context already spans extraction and solving. It records the
origin session, operation ID, revision, problem/image hashes, and rejects a result
when its session was removed or its operation/revision was superseded.

### Legacy image entry and call graph

`mathClient.explainImageProblem` → `POST /api/explain-image` → upload validation →
combined multimodal image solve via `createMathExplanation({ image })` → a third
initial/repair/accept/persist implementation. No current UI component calls this
client function, but the production endpoint remains reachable.

### Verified divergence

- Typed used canonical text and tutor history; staged OCR preferred canonical
  LaTeX, built a dual display/math prompt, and omitted tutor history.
- Typed and OCR constructed different cache identities and used different cache
  read behavior.
- Typed had initial/repair handling. Staged OCR additionally had a candidate
  ledger, presentation-degraded handling, escalation, structural recovery,
  fallback selection, and orchestration telemetry. Legacy image had another
  initial/repair implementation.
- Staged OCR passed extraction confidence into difficulty classification. The
  current routing function still selects the solver role first for every tier,
  so this changed diagnostic classification rather than the selected model.
- Solve usage was accounted as `explanation` for typed and `image` for OCR. OCR
  extraction also has its own image usage reservation.
- All three paths used provider transport/schema parsing and eventually used
  structural finalization, annotation, settlement, persistence, and response
  shaping, but those stages were invoked by duplicated route bodies.
- No solve client supplied an abort signal. Provider attempts had transport
  timeouts, while independently invoked repair/escalation calls could establish
  fresh total deadlines.
- Typed optimistic history updates and rollback were not guarded by the Home
  operation owner, so a late typed completion could mutate the currently active
  session's history even when the solution result itself was rejected as stale.
- OCR image/provenance decoration was embedded inside its solver body instead of
  being a source metadata adapter after shared solve finalization.

### Source-specific behavior that belongs before/around solving

Image validation, image transcription, OCR-only text cleanup, extraction
confidence/issues, review/edit decisions, original image metadata, and extraction
usage remain OCR concerns. After those steps produce canonical problem text, they
must be metadata and provenance inputs to the same solver implementation used by
typed text. Product quota labeling and persistence source labels may remain
source-aware, but must use the same accounting and persistence mechanism.

### Acceptance-policy qualification

The current authoritative acceptance boundary is structural:
`finalizeSolveCandidate` calls structural inspection and records advisory
verification metadata. The old OCR mathematical repair/escalation/fallback body
is historical policy residue under this boundary; schema/refusal/truncation
recovery already lives in the shared provider transport/parser layer, including
the bounded compact retry.

## Post-change architecture

Typed requests and OCR-derived requests now construct the same canonical
`ProblemInput` shape (`problemText`, source, and source metadata) in the client.
Typed input calls the canonical solve client directly. Image input retains a
separate extraction/review stage, then passes its canonical text and the origin
session's captured conversation history to that same client.

On the server, `handleExplainRequest` is the single authoritative downstream
solve implementation. `handleSolveExtractedProblemRequest` is an OCR adapter: it
validates the canonical text, freezes trusted OCR provenance, and invokes that
shared implementation. The legacy multipart `/api/explain-image` endpoint is now
also only a compatibility adapter over extraction followed by canonical solve.

The shared implementation owns routing, prompt/history construction, one total
solve deadline across initial and repair attempts, provider schema parsing and
compact retry, structural acceptance, normalization, refusal/truncation errors,
cache/deduplication, usage settlement, persistence, response shaping, and gated
diagnostics. Routing receives only canonical solver text, so OCR-only display
LaTeX and confidence cannot alter downstream solve policy.

Source-specific behavior now consists of image validation/transcription,
OCR cleanup and review, extraction diagnostics, image quota labeling, image
persistence labeling, and source provenance. A private server request context
sets those trusted policies; client-supplied source labels cannot change them.
Cache values are stored before source decoration, and source metadata is added to
a cloned result so provenance cannot leak between requests.

The client owns cancellation for both sources through `AbortSignal`. Home owns
session/revision application through a common operation context, including typed
history updates and OCR extraction-to-solve transitions. A delayed result can be
committed only to its still-current origin operation; it cannot overwrite the
active session or a superseding revision.
