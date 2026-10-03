# Audit #2 — semantic evidence

Audit-only results from the current dirty checkout. No application fix. Probe: `scripts/audit2-semantic-probe.mjs`; recovered observations: `audit2-semantic-observations.json`. Provider requests are intercepted. The browser exercises the actual React/KaTeX/geometry code, but provider content is a fixture.

## Confirmed current defect: repeated scripted bases acquire another occurrence's identity (P1)

Fixture: `J^2+J^*+J^{-1}+u_i'+u''+u_i^j+T_{ij}^{kl}`.

The painted J inside the third power (`J^{-1}`, source 8–14) has the DOM semantic ID ending `base.J.4-5`, belonging to the second power (`J^*`, source 4–7). The inspector reports that wrong identity as accepted `semantic-dom` geometry at x=491.75–505.75. The intended third base (`base.J.8-9`) is rejected for no geometry; its fallback reports one available candidate but expected occurrence 2. The second power's aggregate also incorporates the misplaced child's geometry. This is direct browser evidence of wrong occurrence ownership, not merely missing hitboxes.

Root-cause chain:

1. `texAnnotationGrammar.js:138-156` validates parsed structure and both inline/display layout. Adding a wrapper around the base in `J^2` changes KaTeX layout: unwrapped HTML height `0.8141em`, wrapped height `0.8873em`; script top changes `-3.063em` → `-3.1362em`. Both direct and grouped wrappers change placement. Rejecting this wrapper protects the displayed mathematics.
2. `semanticMathRenderer.js:593-615` rejects the individual base with `tex-layout-changed`, retaining safe parent/exponent annotations.
3. `MathChunk.jsx:1557-1559` does not exclude layout-changed nodes from targeted fallback. `:1673-1684` computes each occurrence index among all source leaves with the same text.
4. `:1742-1756` filters rendered matches by already assigned/claimed ownership, then applies that original occurrence index to the shorter list. With three J bases, the first claims J1. The second uses index 1 into [J2,J3], choosing J3. The third uses index 2 into the remaining list and fails.
5. `:1823-1846` annotates the selected DOM and labels the fallback deterministic. `:2943-2950` writes a semantic ID onto the glyph span. A subsequent measurement sees a direct owner and labels it `semantic-dom`, obscuring its fallback origin.

Affected invariants: distinguish repeated occurrences; authoritative owner belongs to the exact source range; aggregate geometry contains only its own descendants. Impact: wrong hover/pin target and potentially incorrectly grounded follow-up. The captured probe checks owner/geometry and production resolver for the first J; it does not claim a captured provider request at the third J. DOM/geometry ownership is already demonstrably wrong.

Important distinction: `ownedPrimitiveRects=[]` alone is not proof of absent painted glyphs. This collection is used for structural residual ink; ordinary leaves can have valid `paintedRects` without entries there. The first J and `u_i'` base do have painted rectangles after fallback in this run. The historical “live owner, no painted primitive” symptom is not identical to every serializer rejection.

## Historical 363-node / 691-owner / 499-rejection incident: unresolved

Two completed browser cases have **not** reproduced the reported settled failure:

| Case | Nodes | HTML owners / unique IDs | Rejection records / unique IDs | First-term resolver |
|---|---:|---:|---:|---|
| 180 identical `x_i` terms plus `=0` | 363 | 361 / 361 | 3 / 2 | Correct first term |
| `x_{0}+…+x_{179}=0` | 363 | 361 / 361 | 3 / 2 | Correct first term |

Serializer-only tests accept 361 eligible annotations in one validation attempt for both families. This does not support ambiguous source ranges or KaTeX duplicating accepted wrappers as the cause in these fixtures. `texAnnotationGrammar.js:154-158` explicitly requires each accepted owner exactly once in its HTML-tree check. Whole-page counts can still include overlays or multiple renders; measurement correctly starts within `.katex-html`.

Runtime fallback can add multiple DOM elements for one ID (`annotateMeasuredElements` iterates elements), so owner multiplicity is possible outside serializer guarantees. It may legitimately represent a composite token covering several painted pieces, but requires proof that all pieces belong to that occurrence. Direct owner count alone is insufficient.

`MathChunk.jsx:4138-4145` prepares a rejected list; `:3930-3942` appends it to newly rejected prepared targets without ID deduplication. The same chunk appears twice even in these otherwise working cases. Therefore 499 records cannot be interpreted as 499 distinct failed nodes. This diagnostic defect explains possible count inflation, not the historical wrong first target or the exact count.

Remaining hypothesis: a pre-worker legacy geometry pass, a different explicit-parts shape, or subsequent reconciliation may produce the historical duplication. The saved probe snapshots are settled (12 seconds after visible step) and retain the latest warning per chunk, so they do not rule out a transient earlier failure. The original expression/transport payload and intermediate DOM trace are unavailable. Preserve the incident independently.

Backend-annotated Node shape checked: `annotateMathExplanation` creates one chunk with 361 parts for `a_{0}+…+a_{179}=0`, in about 58 ms on that run; parser/serializer still has 363 nodes/361 accepted annotations. Browser completion of this shape is tracked separately; no inference from this Node result to DOM correctness.

**Completed follow-on browser run:** that backend-annotated shape has 363 nodes, 361 distinct HTML owners, no duplicate owner IDs, correct first-term selection, and three rejection records for two distinct structural/chunk IDs. It therefore also does not reproduce the historical 691-owner failure. Recovered evidence is in `audit2-semantic-additional-observations.json`.

### Related failure reproduced with dense superscripts

`J^2+…+J^2=0` (100 powers) yields 503 nodes. Node serializer probes show a sharp coverage limit:

| Powers | Nodes | Accepted annotations | Validation attempts | Work-budget unsupported nodes |
|---|---:|---:|---:|---:|
| 10 | 53 | 31 | 67 | 0 |
| 30 | 153 | 53 | 160 | 41 |
| 100 | 503 | 50 | 160 | 325 |

In the browser 100-power run, the authoritative pass initially counts 50 owners, reports 535 rejection records / 422 unique rejected IDs, and fallback mutates the DOM to 162 owners / 143 distinct IDs. The first base resolves to the whole first power. The saved fallback explicitly maps the second J base using expected occurrence 1 into 99 remaining candidates. This reproduces ownership degradation and runtime owner multiplicity under local density. It does **not** reproduce the exact subscript source, 691-owner count, or wrong-later-operator symptom; those remain historical/unresolved.

The first mapped fallback targets inherit zero-size metadata and do not uniformly rebuild painted geometry (`MathChunk.jsx:1824-1846`, unlike the radical path's explicit metadata call). Later passes can recover some glyph geometry but retain assigned identities. This is a separate fragility from the occurrence-index error. Rejection counts include intentionally hidden syntax and unsupported structural nodes, so neither 535 nor 422 is a count of lost painted symbols.

The 160-validation work cap bounds work but can sacrifice many otherwise valid annotations after repeated layout-sensitive bases fail. One expression can exhaust it; separate small chunks each receive a separate budget. This is an evidence-backed local-density mechanism, independent of total page node count.

## Confirmed performance weakness: synchronous pre-worker geometry on pointer entry (P1)

Recovered measurements (single runs, development build, Chromium, 1440×1100):

| Case | Step visible | Max event-loop delay | Pre-worker geometry | Authoritative geometry | Query calls | Client-rect calls |
|---|---:|---:|---:|---:|---:|---:|
| Identical `x_i` ×180 | 771 ms | 1,271.8 ms | 1,236.6 ms | 153.8 ms | 50,148 | 38,891 |
| Numbered `x_i` ×180 | 765 ms | 354 ms | 320.4 ms | 146.3 ms | 18,428 | 7,227 |
| Mixed scripts, 35 nodes | 607 ms | 91.9 ms | Not observed | 24.4 + 14.6 ms | 145 | 416 |

The slow measurement is phase `pointer-boundary-enter`, result `canonical-katex-dom`, before worker completion. The enter handler takes 1,241.9 ms / 324.9 ms and returns `no-target`. Worker serialization itself reports about 141.6 / 141.1 ms. This localizes the long stall to the main-thread legacy geometry path, not worker serialization or KaTeX DOM rendering (maximum 40.2 / 33.6 ms).

Code connection: the scheduled measurement effect waits for `semanticRenderReady` (`MathChunk.jsx:6150`), but pointer entry directly calls `measureSemanticTargets` (`:5985`). Missing authoritative annotation falls through to the legacy structural/text matching path (`:4320` onward). Repeated texts increase candidate matching work. `mathGeometryScheduler.js:58-67` checks its frame budget only after a whole callback finishes; it cannot preempt one large chunk.

These measurements establish a realistic blocking path and show that total node count alone does not predict cost. They do not establish an asymptotic growth law or a production-device timing guarantee. Distributed/matrix/nested stress remains separately recorded rather than presumed equivalent.

Completed follow-on samples:

| Case | Visible step | Max event-loop delay | Geometry observations |
|---|---:|---:|---|
| Backend-annotated numbered subscripts ×180 | 931 ms | 397 ms | Pre-worker 347.5 ms; authoritative 136.9 ms |
| 20 steps ×9 subscript terms (420 total semantic nodes) | 945 ms | 362.3 ms | 22 passes; worst 23 ms, most 3–7 ms; first step owner correct |
| 100 repeated powers (503 nodes) | 690 ms | 1,816.3 ms | Pre-worker 428.9 ms; authoritative 380.1 ms; worker 1,165.4 ms |
| 3×3 repeated-symbol matrix | 681 ms | 118.5 ms | 19.9 + 6.3 ms; first sampled owner correct |
| Nested fraction/radical/double integral | 663 ms | 129.5 ms | 33.5 + 22.6 ms; sampled x owner correct |

These are one-run measurements with different warm-up/layout histories. Matrix and nested probes verify only sampled owners, not complete glyph coverage. “Visible step” is a visible step-heading boundary, not a first-interactive guarantee. The dense pointer probes enter through the real pointer handler as the newly rendered solution appears beneath the pointer left by composer submission.

## Pointer reconciliation and test limits

The completed dense probes each recorded `pointerResolvedAfterMeasurement: 1`; authoritative measurement calls `resolvePointerAfterMeasureRef.current(phase)` after publishing geometry (`MathChunk.jsx:4284`). This is positive evidence that the new mechanism executes. It is not exhaustive proof for every stationary-pointer/scroll/removal race; detailed lifecycle inspection is in the lifecycle evidence report.

Coverage diagnostics can omit primitive/pointer/dispatch evidence: production `auditSemanticCoverage` invocation supplies tree/serialization/DOM/targets, but no `visiblePrimitives`, `pointerResolutions`, or `hoverDispatches` (`MathChunk.jsx:4215-4222`). A “covered” node therefore does not establish correct end-to-end hover grounding. The browser fixture `visibleTextRect` preferentially chooses painted rectangles that already overlap a hitbox, which can miss uncovered glyph fragments within a composite target.

Safe layout validation and preserved half-open source ranges are substantial protections. They coexist with legacy text matching and runtime DOM annotation; those paths remain correctness-sensitive and should not be mistaken for immutable source identity.
