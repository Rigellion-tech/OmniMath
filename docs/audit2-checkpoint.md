# Audit #2 durable checkpoint — 2026-09-28

Audit only. No application fixes, commits, pushes, or authorized live-provider tests. The extensive pre-existing dirty working tree, including progressive solve and UI hardening, is the audit baseline; HEAD is not that baseline.

## Completed inspection

- Repository status, project instructions, package commands, browser configuration, historical Sep 11 reconstruction and next-session handoff.
- Semantic boundary trace: source ranges → canonical semantic nodes → grammar/layout-validated annotations → KaTeX → authoritative DOM measurement → targeted text fallback → snapshot rejection → pointer resolution.
- Inspected annotation work budget, scripted-base rejection, runtime DOM annotation, rejection accounting, worker preparation entry, inspector and geometry diagnostics.
- Backend and frontend lifecycle investigations were delegated but no completed reports survived the runtime transition. They are pending, not completed coverage.

## Confirmed evidence so far

- Node probe: `J^2`, `J^*`, `J^{-1}` each reject the base `J` annotation with `tex-layout-changed`; `u_i'` similarly rejects base `u`. This confirms serialization-level unsupported ownership, not yet the complete browser symptom.
- Repeated `x_i` family (180 terms plus `=0`) produces 363 semantic nodes; serializer accepts 361 annotations in one validation attempt. Source identity/serialization alone does not reproduce the reported 691 DOM owners or 499 rejections.
- Node timings from one run: 9/30/100/180 terms produce 21/63/203/363 nodes; serialization approximately 7/21/55/94 ms. These are individual Node measurements, not browser performance guarantees.
- `MathChunk.jsx:1742-1756` filters text matches by available ownership before indexing with an occurrence index calculated across all semantic leaves. This is a concrete suspicious identity boundary; wrong browser target still needs reproduction.
- `MathChunk.jsx:2943` can add `data-semantic-id` to existing DOM after rendering. A live owner is therefore not proof of accepted serializer annotation.
- `MathChunk.jsx:3930` combines freshly rejected prepared targets with supplied rejected targets without deduplication. A rejection count is not necessarily a count of distinct failed semantic IDs.

## Delegated results collected

- `/root/verification`: surviving report `docs/audit2-verification-evidence.md`. Reported Node 22.22.3, npm test 1,270 pass / 21 skip / 0 fail; lint and build pass; typecheck fails at `src/lib/solutionState.js:148:39` (missing inferred extractionValidation property). No browsers or live provider calls. Original `/tmp` logs no longer exist after runtime transition; these results are recorded agent evidence, not newly rerun results.
- `/root/backend_audit`: no result/report available in current runtime.
- `/root/lifecycle_audit`: no result/report available in current runtime.
- Agent inventory after resume contains only root, despite previous environment listing the three agents. Their unfinished work cannot be treated as delivered evidence.

## Repeated-subscript browser probe status

`scripts/audit2-semantic-probe.mjs` survives. It intercepts all `/api/*` requests and uses fixture math; no provider calls. Initial launch failed because libnspr4 was unavailable on the default library path. Restart used the existing `.cache/pw-deps/root/usr/lib/x86_64-linux-gnu` library directory. The restarted process, Vite process, and `/tmp/omnimath-audit2-semantic.jsonl` did not survive the runtime transition. No completed browser result was recovered. Reuse this probe; do not rebuild its infrastructure.

## Remaining investigation, in order

1. Finish repeated-subscript browser ownership reproduction; distinguish serializer owners, fallback owners, unique rejected IDs, clipping, and pointer misassignment.
2. Complete scripted-base browser trace and compare annotation rejection to fallback painted ownership.
3. Final-answer schema, multiline systems, structural versus evidence-only mathematical validation, candidate retention.
4. Routing/retries/escalation/provider-model attribution, timeout and abort composition, usage reconciliation.
5. OCR canonical review, auth adapters, duplicate/request identity; typed versus image parity.
6. Follow-up/pin/provenance and solve-version lifecycle; worker cancellation; stationary-pointer reconciliation.
7. Persistence schema/migrations, fallback, history/session ownership, blocking versus nondurable work; security boundaries.
8. Test skip/oracle/fixture/browser gaps; confirm available verification results where useful.
9. Remaining scaling: distributed versus dense math, scripts, matrix/nested notation; role vocabulary and UI-hardening correctness boundaries.
10. Synthesize full architecture map, invariants, independent historical incident ledger, supported bug constellations, Audit #1 comparison limitations, P0–P3 roadmap, first implementation phase and confidence/blind spots.

## Exact continuation

Reuse existing probe with Vite on 4175, auth disabled and DEV_API_TARGET pointing to unavailable localhost port; set LD_LIBRARY_PATH to the existing cached browser libraries. Run `node scripts/audit2-semantic-probe.mjs repeated180 scripts`, retaining output in a durable audit artifact. Resume backend reads at `server/app.js`, `server/solverRouting.js`, `server/openai.js`, `server/mathExplanationSchema.js`, `server/solveAcceptancePolicy.js`; lifecycle reads at `Home.jsx`, `ExplanationPanel.jsx`, canonicalProblem/solutionState/followupLifecycle/explanationProvenance and semanticRenderClient.

The authoritative Sep 2 checklist was not identified in the inspected historical handoff. Do not invent resolved Audit #1 items. Preserve every supplied September incident independently unless new evidence connects it.
