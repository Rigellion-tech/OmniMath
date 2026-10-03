# Audit 2: Verification evidence

## Scope and environment

This audit inspected the test entry points and provider-test boundaries, then ran the package verification commands. No files were changed for this audit except this evidence report. No browser suite or live-provider smoke test was run.

Commands ran from `/mnt/c/Users/Baku/Desktop/OmniMath` on 2026-09-27 (America/Chicago):

- `node --version` → `v22.22.3`
- `npm --version` → `10.9.8`
- `npm test` → exit 0; 1,270 passed, 0 failed, 21 skipped (1,291 tests across 64 suites; about 19.1 seconds)
- `npm run lint` → exit 0 (`eslint . --quiet`)
- `npm run typecheck` → exit 2; `src/lib/solutionState.js:148:39`: `TS2339 Property 'extractionValidation' does not exist on type '{}'`
- `npm run build` → exit 0 (`vite build`)

Full command output is retained in `/tmp/omnimath-audit2-npm-test.log`, `/tmp/omnimath-audit2-lint.log`, `/tmp/omnimath-audit2-typecheck.log`, and `/tmp/omnimath-audit2-build.log`.

## Provider-call safety

`package.json` maps `npm test` to `node --test tests/*.test.mjs`; it does not include Playwright layout specs or explicitly invoked smoke/benchmark scripts. Inspection of provider-facing Node tests found fetch stubs in the OpenAI JSON, transport, streaming, progressive route, and recovery tests. The live benchmark test replaces `globalThis.fetch` with a stub that throws a synthetic `EAI_AGAIN`, and separate benchmark assertions test pre-fetch cost-cap skips. The progressive browser fixture, when explicitly run, points `OPENAI_RESPONSES_URL` at a local deterministic mock server and installs a fixture-only key. `scripts/smoke-progressive-provider.mjs`, `scripts/smoke-progressive-browser.mjs`, and the image endpoint helper are separate opt-in scripts, not part of `npm test`.

Based on those entry points and call sites, the executed Node suite had no path to a real OpenAI request; no provider API was called. Tests do use local HTTP servers and filesystem-backed usage fixtures in some cases. Avoid running the opt-in scripts without inspecting their target configuration: the provider smoke/benchmark and image helper can reach configured endpoints.

## Test architecture and coverage limits

- There is meaningful deterministic coverage at several layers: solver validation and routing, canonical input and OCR normalization, OpenAI response/stream framing and transport failures, progressive recovery/route/client behavior, semantic rendering/hitboxes, labels, and usage/auth boundaries. Several tests inject `fetch`, while fixtures such as `tests/fixtures/semanticRenderingCorpus.mjs` and `tests/fixtures/progressiveSolve.mjs` provide repeatable inputs.
- The pass count measures assertions against authored fixtures and controlled transports. It does not establish correctness for unseen provider generations, real provider timing/chunk behavior, or visual behavior in an actual browser. In particular, provider fixtures synthesize response events and solution content; their agreement with the implementation is not an independent oracle for mathematical truth.
- `npm test` does not run browser tests. `playwright.config.mjs` matches the `*.layoutRegression.spec.mjs` and `sessionIsolation.spec.mjs` families but explicitly ignores `progressiveProviderStreaming.layoutRegression.spec.mjs`. That file has a separate `playwright.provider-stream.config.mjs` using a local mock provider stack. `npm run test:layout` is the package entry point for the default browser suite; there is no corresponding package script for the provider-stream browser config.
- Twenty-one Node tests were skipped. The test output reports the count but does not make those cases part of the passing evidence; they should be reviewed against their skip conditions when relevant.
- The supplied `AGENTS.md` says there is currently no test script, but this checkout's `package.json` defines `test`, `test:layout`, and `test:explain-image`. The maintained instructions are stale on that point.

## Result

Lint and production build pass. The Node test suite passes with the fixture and browser limitations above. Type checking fails at the reported property access, so the verification set is not fully green. This is recorded as evidence only; no fix was attempted.
