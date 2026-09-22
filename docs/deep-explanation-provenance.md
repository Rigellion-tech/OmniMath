# Deep explanation provenance milestone

This corpus defines a deterministic contract for the question “Where did this
mathematical object come from?” It is intentionally compact and orthogonal:
each fixture stresses a different identity, dependency, context, or lifecycle
hazard. The fixture data is provider-neutral and contains no live responses.

## Observed architecture and investigation boundary

The current implementation routes a semantic hover target through its semantic
ID/source occurrence and selected step into the explanation client. Follow-ups
are built from the active explanation context and dispatched through the same
backend route. Existing semantic-rendering tests cover ownership, hitboxes,
token identity, and rendering safety; existing lazy hover/pin lifecycle tests
cover several stale-response transitions, while follow-up lifecycle coverage
was absent at investigation time. This milestone adds a corpus
contract for the missing cross-layer assertions. It does not change the
completed semantic-rendering system.

The motivating matrix incident cannot be classified as a provider failure
without a recorded live request/response or a deterministic replay. The
`matrix-inverse-adjugate-entry` fixture captures the required provenance path
(selected entry → adjugate/cofactor → minor/sign → arithmetic) so the incident
can be replayed with a controlled provider response. A future diagnostic must
record dispatch, request identity/context, response normalization, revision
discard, and state application before assigning blame.

## Corpus contract

Every entry in `tests/fixtures/provenanceStressCorpus.mjs` has `problem`,
ordered `steps`, a selected semantic `target`, expected `dependencies`,
`originalInputs`, scripted `followups`, and `hazards`. Dependency kinds are
`explicit`, `reconstructed`, `implicit`, `assumption`, `approximation`, or
`unknown`. `semanticId` and `sourceRange` identify an occurrence; surface text
is never sufficient as an oracle. `branch`, `dependsOn`, and `assumptions`
encode graph and domain context.

Fixtures cover: a 3×3 matrix inverse/adjugate entry derived through a 2×2 minor, repeated identical occurrences,
branching matrix multiplication, integration by parts, wrong premises, skipped
algebra, a meaningful 40-step long-distance chain, multibranch domain and
extraneous-root rejection, exact-to-decimal approximation, probability
variance, discrete sums/Gamma notation, and genuinely insufficient provenance.

## Derived failure taxonomy

The implementation should classify failures at the narrowest supported stage:

1. **Identity/ownership** — wrong semantic occurrence, aggregate-versus-leaf
   confusion, duplicate-token collision, or branch drift.
2. **Context assembly** — missing parent expression, source step, original
   inputs, assumptions, prior answer, or dependency edge.
3. **Derivation fidelity** — a fluent answer follows the wrong graph, invents a
   skipped step, loses an implicit rule, or fails to correct a false premise.
4. **Conversation resolution** — “this”, “that”, “why”, and introduced
   intermediates resolve to the wrong object after multiple turns or a switch.
5. **Lifecycle integrity** — dispatch omission, timeout/abort, malformed or
   empty response, duplicate submission, or a valid response incorrectly
   discarded.
6. **Revision/ownership race** — an old response overwrites a newer selection,
   pin, session, navigation state, or remounted component.
7. **Evidence boundary** — unsupported origin is stated confidently instead of
   marked uncertain or explicitly reconstructed; approximations omit precision
   rationale.
8. **Scale/branch degradation** — long-distance dependencies, branching
   graphs, nested notation, or domain assumptions are truncated or conflated.

## Layered test architecture and oracles

Layer 1 asserts deterministic target identity, step, parent, branch, and source
occurrence. Layer 2 walks expected dependency IDs and provenance kinds. Layer 3
uses controlled responses or structured claim predicates to check mathematical
relevance; it must not require one English sentence. Layer 4 drives scripted
multi-turn follow-ups and checks reference ownership. Layer 5 uses synthetic
delays, aborts, malformed/empty responses, retries, revisions, and remounts;
exact state transitions and stale-response non-application are the oracle.
Layer 6 combines duplicate text, deep/long context, ambiguous language,
switching, and delayed responses.

Required claims are represented by dependency IDs/relations and fixture
metadata; forbidden claims (for example, multiplication in the wrong-premise
fixture or fabricated derivation in the insufficient fixture) should be added
by the consuming tests as predicates. This keeps fixture truth separate from
provider wording.

## Coverage intent and limits

The corpus is not a raw-count benchmark and intentionally does not duplicate
every supported notation. It covers representative reasoning structures across
linear algebra, calculus, algebra, probability/statistics, discrete math, and
special notation. It does not yet provide live-provider quality scores, OCR
coverage, solver verification, or a full 40-step corpus; those belong to
separate milestones. A live suite, if added, must be small, explicitly invoked,
excluded from CI, use no production secrets in fixtures, and record model,
latency, token/cost, request context, pass/failure classification, and replay
artifacts. It was not run for this milestone.

Remaining risks include provider mathematical errors despite correct context,
unrepresented notation, context-window truncation beyond the 40-step fixture,
and UI-specific races not exercised by a headless deterministic harness.
