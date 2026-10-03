# Audit 2 test coverage continuation — 2026-09-28

Audit only. No application files were changed. This continues the verification evidence in `audit2-verification-evidence.md`; it does not replace that historical report.

## Fresh Node verification

The Node suite was run with external network access disabled by the repository guard and `OPENAI_API_KEY` unset:

```sh
env -u OPENAI_API_KEY NODE_OPTIONS=--import=./tests/helpers/noExternalNetwork.mjs npm test
```

The first run ended `1269 passed, 1 failed, 21 skipped` (1,291 tests). Its output was not retained to a file and the tool truncated the failure details, so the failing case and exact error are unrecoverable from this run. Do not treat it as a fully green first run or infer the failure identity. A separately captured retry ended `1270 passed, 0 failed, 21 skipped` (1,291 tests; 64 suites; ~22.4 s). Retry output is in `/tmp/omnimath-audit2-tests-resume.log` for this runtime only.

Fresh typecheck reproduces the earlier failure:

```text
src/lib/solutionState.js(148,39): error TS2339: Property 'extractionValidation' does not exist on type '{}'.
```

No browser suite was run in this phase; it is pending the root semantic probe and explicit clearance.

## Skip inventory

TAP reports 21 skipped subtests:

- 17 in `tests/fastSolvePipeline.test.mjs`: wrapper stripping; three perfect-square repairs; filler-step removal; dead-term simplification; regression-integral final-answer preservation; image extracted fields; empty intermediate steps; duplicate final-answer canonicalization; malformed command remnants; unmatched LaTeX; detached multiline answer fragments; same-line arrows; prose mixed with math; multiple unrelated answer equations; compact final-answer contract.
- 4 in `tests/openaiJson.test.mjs`: compact trailing-step answer contract; compact retry feedback for answer structure; exact multi-fragment retry feedback; distinction between answer structure and malformed LaTeX.
- `tests/failedSolveDiagnostics.test.mjs` also contains a `describe.skip` legacy suite. TAP reports that skipped suite separately; its scenarios are not included as subtests in the 21 count. Its old routing/validator/provider orchestration cases are therefore not passing evidence. Similar current coverage may exist elsewhere, but the disabled suite itself contributes none.

The main concentration is generated solution repair and final-answer structure. These are relevant gaps because the labels describe behaviors an operator could reasonably mistake as active regression protection. A follow-up should either re-enable/adapt them or explicitly maintain a reason and replacement pointer; no changes were made in this audit.

## What the test oracles establish

The Node suite has substantial deterministic assertions around parsing, normalization, routing, telemetry, semantic trees, and controlled HTTP/provider transports. It can establish that given fixtures follow the implemented policies. The external-network guard strengthens the claim that this Node run did not contact a live provider. It still cannot independently establish mathematical correctness of generated solutions: many “valid” and “invalid” response fixtures encode expected outcomes authored against the same acceptance contract.

Several checks should be read as structural or implementation-consistency evidence rather than independent behavioral proof:

- `tests/primaryComposerSerialization.test.mjs` reads `Home.jsx` and `ExplanationPanel.jsx` source to check for expected wiring. It can catch a missing string/API name, but not prove that the rendered composer dispatches the right user input in an actual session.
- `tests/mathPipelinePreservation.test.mjs` reads CSS and asserts textual properties; useful for guarding declared styles, but not a computed-style or cross-browser visual oracle.
- Annotation tests that assert emitted LaTeX contains expected substrings or `data-semantic-id` attributes prove serializer output shape. They do not prove that KaTeX paints those attributes over the intended visible glyph, that the measured hitbox covers it, or that production pointer resolution returns the intended occurrence. Browser tests are needed for that chain.
- `tests/semanticTexOwnership.layoutRegression.spec.mjs` is a stronger end-to-end browser case: it checks target glyph rectangles, hitbox overlap, selected ID/LaTeX/role/source range, hover dispatch, and pin identity. Its expected target ID is independently selected from the fixture's semantic tree, but browser and Node planners are both the same implementation, so the planner equality assertion is a consistency check, not a second parser oracle. Geometry assertions narrow the false-confidence risk substantially.
- `tests/uiHardening.layoutRegression.spec.mjs` checks focused DOM/CSS outcomes, contrast, responsive visibility, and ownership attributes. Its stress case's `data-semantic-id` count and worker instrumentation show population/activity, not by themselves the correctness of every node's glyph ownership. Its hover check does test an actual interaction for one chosen target.

Across the package, the number of tests is not a measure of independent oracle diversity. Fixtures and expectations are predominantly hand-authored, internal module outputs are often compared to other internal outputs, and no real provider-generation corpus or human-verified answer set was established by this review.

## Browser follow-up status

Root completed the repeated-subscript semantic browser probe and explicitly cleared this focused run. The requested specs completed serially against the existing Vite server on port 4175 with `mockAuth=1`, auth disabled, and no backend. Performance specs were excluded. Full output is captured in `/tmp/omnimath-audit2-browser-focused.log` for this runtime. No application code was changed.

Exact command:

```sh
LD_LIBRARY_PATH=.cache/pw-deps/root/usr/lib/x86_64-linux-gnu node node_modules/playwright/cli.js test --workers=1 --retries=0 tests/uiHardening.layoutRegression.spec.mjs tests/semanticTexOwnership.layoutRegression.spec.mjs tests/hoverLifecycle.layoutRegression.spec.mjs tests/provenanceFollowup.layoutRegression.spec.mjs tests/pinnedLens.layoutRegression.spec.mjs
```

Outcome: `23 passed (1.8m)`, 0 failed, with retries disabled. Per spec: `uiHardening` 7 passed; `semanticTexOwnership` 1 passed; `hoverLifecycle` 6 passed; `provenanceFollowup` 2 passed; `pinnedLens` 7 passed. The pinned sidebar reflow case emitted metrics showing 8 math chunk renders, 20 `getBoundingClientRect` calls, 18 geometry translations, 4 pointer resolves with 0 pointer-layout reads, and 16 ResizeObserver callbacks. The 300+ semantic-node hardening case passed its settling and responsive stable-owner assertions. Playwright emitted only a Node color-environment warning.

Evidence limits: these are real browser layout and interaction checks against the local Vite UI, but auth was mocked and there was no backend/provider. The provider-failure follow-up assertion establishes local state restoration for its controlled fixture, not live provider behavior. Semantic ownership tests exercise the current semantic planner and renderer together; their geometry and interaction assertions improve coverage, but they do not independently validate the parser against a separate oracle. The stress metrics establish activity and responsiveness under the specified fixture, not correctness for every possible semantic node or browser engine.
