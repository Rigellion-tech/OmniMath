# Phase 6A progressive solve contract

This is an internal, transport-independent client contract. It does not stream
provider output or reveal a buffered full solution with timers.

## Event envelope and ordering

Every event has `type`, `requestId`, `attemptId`, `sessionId`,
`conversationId`, and a zero-based `sequence`. The first event is
`solve_started` at sequence 0. Subsequent sequences are contiguous.
Out-of-order/gapped events are rejected, not buffered. An identical repeated
event is an idempotent no-op; a conflicting repeat is rejected. Identity is
checked before sequence, so late events from another request, attempt, or
session cannot attach to the current solution. A retry uses a new request and
attempt ID. An active attempt can only be superseded by an explicit
`supersedesAttemptId` on the new start event; the old attempt is retained as a
cancelled previous version in reducer memory.

Event types are `solve_started`, `solution_metadata`, `step_started`,
`step_completed`, `final_answer`, `solve_completed`, `solve_failed`, and
`solve_cancelled`. `solution_metadata` cannot contain steps or draft fields.
`step_started` contains only stable step ID and index, never TeX text.
`step_completed` carries the next contiguous, unique step ID/index, a
structurally renderable complete step, and `validation.status: "accepted"`.
The producer of this event is responsible for actual per-step math/TeX
validation before setting that marker. The current full-response producer
uses the existing server-accepted complete result. The synthetic producer is
test-only. Phase 6B must add a strict, prefix-stable server validator; the
marker is not permission to publish raw provider fragments.

`final_answer` is accepted only after at least one completed step and no
active draft. `solve_completed` requires a final answer and no active draft.
Failed/cancelled/complete attempts are sealed. A failed or cancelled solve
retains its previously completed steps; no incomplete step enters
`problem.steps`. A new attempt never mutates a previous attempt's completed
step objects. The current full-response API adapts its one accepted object
to the event sequence synchronously, then commits once, preserving the
existing canonical UI path.

## State, rendering, and persistence

Reducer states are `idle`, `starting`, `generating`, `partial`, `complete`,
`failed`, and `cancelled`. `completedSteps` is authoritative;
`activeStepDraft` is transient identity only. Progressive steps enter the
existing `ProblemBlock` → `SolutionFlow` → `MathStep` → `MathChunk` renderer,
not a parallel semantic renderer. Annotation caches completed step references
by attempt and step ID, so appending a step does not re-annotate older steps.
The ordinary non-streaming renderer keeps its existing whole-solution
annotation path.

Session payloads retain completed steps, final answer, stable request/attempt
identity, terminal status, and failure reason. The save boundary strips
active drafts, transport buffers, queued events, and incomplete steps. An
active in-memory attempt is represented as interrupted/failed in a durable
snapshot because a reload cannot resume its transport. Current autosave does
not run during an active workflow; terminal partial results become eligible
for normal session save. No provider-side partial save is added in 6A.

Existing frozen provenance snapshots retain their captured evidence prefix,
occurrence ID, source range, assumptions, and target revision. A *new*
snapshot of the same early target after later steps arrive may have a new
solution revision because the existing provenance hash includes the evidence
list. Changing that policy needs an explicit future design; 6A does not
silently rewrite existing provenance.

## Deferred to Phase 6B

The provider transport, incremental JSON parser, strict per-step server
validator/converter, globally validated completion, stream deduplication,
usage settlement, and partial-provider persistence are not implemented here.
The existing full-response server and routing remain authoritative.
