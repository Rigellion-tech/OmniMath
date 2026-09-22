# Mathematical trust boundary

## Recovery and finalization (2026-09-04)

The interrupted implementation was recovered from the working tree. Ignoring
end-of-line differences, the only tracked implementation changes were
`server/app.js` and the added HTTP parity test in
`tests/failedSolveDiagnostics.test.mjs`. The new files were this document,
`server/solveCandidateLifecycle.js`, `server/solveCandidateStructure.js`,
`server/solveAcceptancePolicy.js`, the four modules under `server/verification/`,
`tests/mathVerification.test.mjs`, `tests/solveCandidateLifecycle.test.mjs`, and
`tests/helpers/noExternalNetwork.mjs`. The other 140 tracked modifications,
including `server/failedSolveDiagnostics.js` and all frontend/hover files, differed
from HEAD only in line endings and were preserved.

Recovery found one concrete resource defect in the new normal-form kernel:
recursively embedding serialized function atoms in monomial keys caused exponential
JSON escaping. Seven nested calls in a 36-character expression produced a
306,055-character key. A guarded 24-level probe exceeded 1 MB before completion.
`canonicalDifference` now shares collision-free atom IDs across both expressions,
preserving exact atom equality without recursively embedding those strings.
The same 24-level probe now verifies with a largest serialized key of 54 characters.
Two regression tests cover equivalent nested arguments and distinct nested functions.
Only `server/verification/expression.js`, `tests/mathVerification.test.mjs`, and
this document were edited during recovery. No acceptance or hover changes were made.

## Pre-implementation audit retained from the interrupted task (2026-09-04)

This retained audit describes the solve paths before the trust-boundary changes.
The current behavior is documented under "Implemented boundary" and in the recovery
section above.

### Typed solve

`ProblemInput` → `mathClient.explainProblem` → `POST /api/explain` →
`handleExplainRequest` in `server/app.js`. The route authenticates/throttles, checks
AI enablement, validates/canonicalizes input, checks its user-scoped memory cache,
builds the prompt, resolves the solver role, deduplicates and reserves usage.
`createLocalRuleExplanation` can generate a local candidate first.

Otherwise `createMathExplanation` calls the provider. `parseJsonResponse` rejects
truncation, extracts a complete JSON object, parses JSON, then calls
`assertFastSolveResponse`. Only after this assertion is there a usable parsed
candidate. It recovers declared LaTeX control characters, sanitizes strings,
requires a title/problem/final answer/nonempty steps, and checks step field types.
Anchors and IDs are normalized. The declared provider JSON schema is stricter than
these local assertions. The assertion currently does **not** call the old strict
generated-LaTeX or mathematical quality validators.

A retryable parse/schema/generation failure permits one compact retry on the
same role, inside `createMathExplanation`. Compact normalization takes the last
step as the final answer. Conversion calls the fast assertion again, creates the
rich step/chunk/line representation, prepares display LaTeX and annotates it.
The route applies local explanation rules, checks nonempty math steps and a final
answer in `acceptStructurallyParsedSolve`, annotates again, settles usage, caches,
saves best-effort, and returns. Cache hits bypass generation. Frontend normalization
spreads result metadata and selects steps; it does not verify mathematics.

No mathematical check gates acceptance. `numericCheck` is provider text, not an
independent check. `classifySolveFailure` always returns
`response_generation_failure`; therefore the route's later quality-repair branch
is unreachable in the current flow. Exhausted compact retries, malformed structure,
configuration/auth/usage/transport failures return errors, not a mathematical
abstention. There is no active mathematical escalation.

### Reviewed/direct OCR solve

`ImageUpload` → `extractImageProblem` → `POST /api/extract-image-problem` authenticates,
validates upload size/type/signature, reserves usage, then calls extraction only.
`assertImageExtractionResponse` requires extraction fields and still calls
`assertGeneratedLatexFields`. Text spacing cleanup, display segmentation and
`validateExtraction` produce confidence/integrity/review warnings. These assess
extraction usability, not solution correctness. The frontend chooses direct,
reviewed, edited or solve-anyway submission and preserves canonical text/LaTeX.

`solveExtractedProblem` → `POST /api/solve-extracted-problem` authenticates and
canonicalizes reviewed input, prefers canonical math input, builds a prompt with
display text and math, and uses the same text `createMathExplanation`/fast/compact
assertions/conversion as typed solving. The route reserves image usage, supports
local generation and deduplication, and adds extraction/canonical provenance.
It writes the cache but does not read that cache before generation.

This route additionally maintains a candidate ledger and detailed orchestration
telemetry. `classifySolveCandidate` used parse success plus a final answer for
acceptance, whereas the route assertion also required nonempty math steps;
`decideSolveFailureAction` accepted a parsed result without checking even that
completeness. `fallbackEligible` was hardcoded false. Its retained-candidate fallback,
quality-repair and fresh-escalation machinery survives, but production parse failures
exit as generation failures before those paths. Ordinary candidates are accepted
on structure. No old mathematical validator is called here.

### Older direct-image endpoint

`POST /api/explain-image` remains reachable through the API client/backend wrappers.
It validates the multipart upload, checks its image cache, then sends image and
prompt together to `createMathExplanation`. `assertImageSolveResponse` checks
extracted text/LaTeX, image step fields and final answer, maps steps to the fast
shape, and `convertImageSolveToMathExplanation` removes a duplicate problem step.
Image generation explicitly disables compact retry. Local adjustments and the
same route structural assertion precede annotation; extraction scoring runs after
the solve. There is no independent guarantee that the extracted problem matches
the pixels. Its quality repair branch is disabled by the same failure classifier.

### Surviving validation and policy inconsistencies

- `solutionValidation.js` exports executable legacy validators, including
  expression-specific heuristics. Tests call them; no production solve module
  imports them. They are retained, not reactivated.
- `mathValidationAnalysis.js` has a custom numerical parser, finite-difference
  derivative checks, quadrature, sign and identity heuristics. Legacy tests and
  benchmark tooling call it. Production `app.js` only imports
  `createMethodFingerprint` for failure/repair diagnostics. This is not an active
  acceptance check.
- That parser converts constants to binary64 and contains lossy rewrites (including
  a hyperbolic-function name rewrite). It is unsuitable as a symbolic proof parser.
- Symbol inventories still run for debug logging. They do not gate solve acceptance.
- Strict solve LaTeX helper functions and old step-repair helpers remain in
  `mathExplanationSchema.js` without calls from the current fast/compact assertions.
  Extraction retains strict checks. Rendering/conversion can still fail, but a
  successful render proves no mathematical statement.
- Solver complexity classification mentions repair/escalation tiers, but
  `chooseSolverRoleForProblem` always selects the solver role first.
- Candidate selection telemetry says `passed`/`clean_candidate` for structural
  acceptance, not mathematical proof. Legacy error/UI wording still mentions
  mathematical validation even though no such gate currently runs.
- No solution/provider schema has typed assumptions, domains, proof obligations,
  operation semantics or structured equation transformations. They hold LaTeX and
  prose. Canonical input preserves source text and extraction provenance; it has
  no dedicated assumption field. Step math is duplicated in `math`, lines, chunks,
  and sometimes source `latex`; these are presentation representations, not an AST.

## Minimal architecture chosen before implementation

Keep generation and its existing compact retry unchanged. Extract the existing
route structural assertion into a shared boundary. Assess each finalized normalized
candidate with a pure deterministic verifier, then pass the resulting evidence to
a separate explicit acceptance policy. All three solve routes use this boundary
after local adjustments and before their final annotation/cache/save. Cache returns
also refresh evidence. No provider, rendering, OCR or routing code belongs inside
the verifier.

The initial policy is **evidence only**: structurally invalid candidates remain
errors; structurally valid candidates retain current acceptance, even if checks
are inconclusive or contradicted. Evidence records that acceptance is not a
correctness endorsement. Enforcing contradictions requires a subsequent policy
task with audited claim interpretation. No extra provider calls are introduced.

Use a small bounded expression parser and exact rational/polynomial kernel; no
mature algebra package exists in dependencies (KaTeX is the renderer). Do not reuse
legacy heuristic validators for proof. The adapter interprets only complete,
supported notation. A variable equation is not automatically a universal identity.
Unsupported or ambiguous claims carry explicit inconclusive evidence.

## Implemented boundary

- `server/solveCandidateStructure.js`: the previous route assertion, extracted
  without strengthening the production structural contract; a nonthrowing inspector
  also serves the old candidate ledger.
- `server/solveCandidateLifecycle.js`: `assessSolveCandidate` separates structural
  status, verification and acceptance; `finalizeSolveCandidate` attaches fresh
  server-generated `verification` and `candidateAcceptance` metadata. It preserves
  steps, render fields and hidden usage diagnostics. Provider-supplied evidence is
  overwritten, never trusted.
- `server/solveAcceptancePolicy.js`: the version-one evidence-only decision. It
  rejects unusable structure and accepts usable structure with an explicit
  `mathematicalCorrectness: "not_established"`. Contradictions are recorded, but do
  not trigger extra calls, repair, escalation or abstention in this release.
- `server/verification/expression.js`: bounded parsing, exact rational arithmetic,
  formal rational-function normal forms, and rule-based differentiation.
- `server/verification/domain.js`: structured assumption handling, original-AST
  domain obligations, guarded numerical evaluation, and quadrature eligibility.
- `server/verification/mathVerifier.js`: pure per-claim verification. No imports
  from providers, routes, legacy validators, DOM or renderers.
- `server/verification/solutionVerifier.js`: conservative interpretation of full
  source fields into claims. Evidence includes field paths, step IDs and source
  expressions for future UI consumers. No hover integration was added.
- `server/app.js`: typed, reviewed OCR and direct-image finalization, plus typed and
  direct-image cache returns, now use the common boundary. The ledger and failure
  decision share its structural floor; their inconsistent acceptance of empty-step
  objects is removed. Generation, compact retries, routing and OCR behavior remain
  as audited. Legacy dormant recovery code is documented, not reactivated or removed.

The existing conversion already performs annotation while preparing normalized
steps. Verification runs after that conversion and local adjustments, before the
route's final annotation/cache/save. This avoids changing renderer semantics while
establishing an independent correctness boundary. The evidence captures the exact
pre-final-annotation field it examined; it does not reference generated DOM nodes.

The OCR ledger still selects on structure before finalization; fresh verification
evidence is attached to the final candidate, not used to choose a generation attempt.
The unchanged failed-solve diagnostic writer can retain result metadata in its
normalized-result snapshot, but contradictions do not trigger failure capture or
a new telemetry stream. None of the production routes currently supplies structured
assumptions to the verifier; domain information in display prose remains unparsed.

### Evidence contract and exact state semantics

Each check has an ID, `fieldPath`, `stepId`, original `expression`, interpreted
`kind`, `state`, `method`, and `reason`. Checks retain structured caller assumptions;
domain obligations include the relevant expression, requirement and whether it was
discharged. Calculus checks include the differentiated expression, generated
derivative and variable. Numerical checks include sample bindings, exclusions,
precision, tolerance, residuals and roundoff estimates. Rational counterexamples
also include exact fraction values. Original canonical math and display text are
retained; prose assumptions are explicitly marked unparsed.

| State | Meaning |
| --- | --- |
| `verified` | This specific interpreted claim follows from supported exact operations, with all required domain obligations discharged in the stated scalar-real setting. It is not a proof of the entire solution, OCR fidelity, an implication between steps, or completeness of a root set. |
| `numerically_supported` | Stable floating-point evaluations agree within recorded tolerances. Variable equivalence requires at least five distinct valid points and variation of every free variable. Constant evaluation and converged quadrature are separate methods, not symbolic proofs. |
| `inconclusive` | The kernel cannot establish the claim: unsupported/ambiguous notation or assumptions, unresolved domain restrictions, insufficient samples, instability, exhausted limits, or noncertified integral disagreement. This is neither mathematical failure nor a rejection request. |
| `contradicted` | A supported interpretation has affirmative contrary evidence: unequal exact values, an exact rational counterexample, a definite rational domain violation for a root, or a stable numerical counterexample beyond conservative residual/error margins. The method distinguishes exact evidence from nonrigorous floating-point evidence. |

There is deliberately no whole-solution `verified` flag. `summary` counts check
states, records contradictions and says `solutionCorrectness: "not_established"`.
Coverage explicitly excludes prose, cross-step implications and solution-set
completeness. A correct equation-solving step with free variables is not assumed
to be an identity; a failed identity probe yields inconclusive interpretation,
not a mathematical contradiction. An independently proven identity can still be
recorded. Final single-variable assignments are checked against the submitted
original equation, not a provider-rewritten problem. Matching labels on explicit
integral assignments are supported. Named derivatives require a prior unambiguous
function definition and record that definition's source.

### Exact methods

Finite decimal literals are exact BigInt fractions. The kernel proves parsed
reflexivity or a zero rational-function difference using polynomial addition,
multiplication and bounded integer powers. Function calls are opaque atoms, with
canonicalized arguments; no logarithm, root or inverse-function identities are
invented. Cross-multiplication/cancellation is usable as proof only after checking
domain obligations on both original expressions. Constant expressions are compared
exactly before any floating-point tolerance is considered. Small rational
counterexamples remain contradictions even below numerical tolerance.

Derivatives use sum, product, quotient, integer-power and chain rules. Supported
outer derivatives are sin, cos, tan, exp, ln, sqrt, atan, asin and acos, subject to
domain/differentiability restrictions. Antiderivatives use exactly this same
operation and comparison path; additive constants independent of the variable
vanish under differentiation. No finite-difference derivative is treated as proof.
Rational polynomial definite integrals with rational finite bounds are integrated
exactly. Root checks substitute into the original equation and check its domain;
they do not assert that every root has been found.

### Numerical methods and domain protections

Sampling is fixed and reproducible, with independent coordinate permutations for
up to four free variables. Duplicate bindings do not increase evidence. At least
five valid distinct values of each variable are required for equivalence support.
Singularities, near-zero denominators, obvious real-domain violations, large trig
arguments, overflow and poorly conditioned results are excluded and recorded.
Binary64 evaluation propagates conservative roundoff estimates, including loss of
significance through square roots. Default comparison tolerances are absolute
`1e-10` plus relative `1e-9`; numerical contradictions require much larger residuals
and two stable variable samples (one suffices for a constant calculation). An exact
rational counterexample needs only one valid point; a matching point never proves
variable equivalence.

Non-polynomial finite integrals can use adaptive Simpson quadrature at two distinct
initial partitions (13 and 29), tolerances `1e-10` and `1e-12`, with compensated
summation and a 20,000-evaluation budget. Only a restricted class of globally
continuous expressions is eligible; arbitrary variable denominators, domain-bound
functions and improper bounds are excluded. Agreement is numerical support. A
disagreement is inconclusive with review evidence because these error estimates
are not certified bounds. This is **binary64, not arbitrary/high-precision
arithmetic**, and cannot guarantee detection of narrow features or oscillation.

All symbolic proofs require explicit original-expression obligations for nonzero
denominators, nonpositive powers, positive bases of noninteger powers, square-root
arguments, logarithm arguments and inverse-function ranges. The kernel uses real
principal functions only. No branch-sensitive cancellation/rewrite is used to
increase coverage. Structured assumptions support single-symbol relations
`>`, `>=`, `<`, `<=`, `!=`, `=` against rational constants; unsupported, over-budget
or inconsistent assumptions are inconclusive. No provider-added assumptions are
promoted to trusted problem assumptions. Natural-language domain information is
preserved for future interpretation, not silently treated as understood.

## Limitations and next step

Unsupported structures include general TeX, macros/environments, equation chains,
sets of roots, inequalities, matrices/vectors, multivariable calculus, special
functions, complex branches, implicit/partial derivatives, variable-exponent
differentiation, improper integrals and general symbolic integration. Function
arguments and fractions require explicit groups. TeX solution fields require braces
around signed or multi-digit exponents and integral bounds; they are never silently reinterpreted as
plain-infix powers. The explicit `verifyMathClaim` expression API uses ordinary
infix exponent syntax. Ambiguous juxtaposition such as
`f(x)` is not interpreted as multiplication. Bare `log` is unsupported because its
base is ambiguous. `e` and `pi` denote real constants; variables are case-sensitive
single letters. Natural-language task/assumption extraction is not implemented.
Only complete supported expressions or statements are analyzed; nothing is rescued
from a convenient substring of unsupported prose or TeX.

Final-answer linkage supports explicit calculus inputs and a single constant root
assignment against an original equation. A bare arithmetic input and bare answer
are not yet linked automatically. Intermediate variable equalities retain only
exact identity proofs; other outcomes become inconclusive because an equation may
be a constraint. The first 32 fields are examined in step order, followed by the
final answer, so a sufficiently long solution can leave its final answer outside
coverage; this is reported explicitly.

Bounds include 2,400 input characters, 400 tokens, nesting depth 40, 128 normal-form
terms, 12,000 algebra operations, symbolic powers of magnitude at most 12, bounded
BigInt size and 32 candidate fields. Differentiation permits 800 node visits;
polynomial integration caps degree at 24; rational numerators and denominators
are capped at 300 decimal digits. There is **no explicit wall-clock deadline** or
whole-request CPU budget. Verification is synchronous and also runs on cache hits;
up to 32 fields can each perform symbolic work or 20,000 quadrature evaluations.
Resource exhaustion cannot establish an exact proof. A bounded numerical fallback
can still produce support or contrary evidence; otherwise the check is inconclusive.
No such outcome requests provider retries. Some valid domain facts are beyond the small
sign analysis, and function atoms may miss equivalent argument forms. These are
expected inconclusive cases, not reasons to expand heuristic validators.

False-positive risks are concentrated in interpretation and numerical evidence:
finite samples can miss counterexamples, floating-point error estimates are not
interval certificates, and numerical quadrature can miss narrow features. No
numerical agreement is labeled verified. Exact checks depend on the small parser
and arithmetic implementation being correct; tests are evidence about that code,
not a universal guarantee of mathematical correctness. Cross-step reasoning,
prose claims, extraction fidelity and root-set completeness remain unverified.

The next task should audit claim extraction and evidence on a deterministic corpus
of stored solve fixtures, then design an explicit policy version that consumes
well-scoped exact contradictions. Keep unsupported and inconclusive claims
acceptable. Decide repair/escalation/abstention behavior only after that audit;
do not revive the legacy heuristic validator or use another model as verifier.
Broader symbolic/high-precision capabilities should receive a separate dependency
assessment before adding a library.

## Verification runs

Tests added: 85 kernel tests in `tests/mathVerification.test.mjs`, 21 lifecycle and
preservation tests in `tests/solveCandidateLifecycle.test.mjs`, and one typed/OCR
HTTP/cache parity test in `tests/failedSolveDiagnostics.test.mjs`: 107 new tests
(105 recovered, two added for the symbolic resource defect).
They cover all four evidence states, incorrect algebra/calculus, exact discrepancies
below floating-point tolerance, large integers, cancellation, branch sensitivity,
one-point agreement, duplicate points, poles, near-singular/unstable evaluations,
extraneous roots, quadrature limitations, assumption and resource limits, ambiguous
TeX scripts, nested function resource use and atom separation, provenance, metadata
preservation, and acceptance without extra calls.

Executed during recovery from the repository root in bash:

```bash
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/mathVerification.test.mjs
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/solveCandidateLifecycle.test.mjs
node --import ./tests/helpers/noExternalNetwork.mjs --test --test-name-pattern='common mathematical evidence through HTTP solve routes' tests/failedSolveDiagnostics.test.mjs
NODE_OPTIONS='--import /mnt/c/Users/Baku/Desktop/OmniMath/tests/helpers/noExternalNetwork.mjs' npm test
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/semanticTexAnnotationSafety.test.mjs
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/semanticMathRenderer.test.mjs
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/mathPipelinePreservation.test.mjs
NODE_OPTIONS='--import /mnt/c/Users/Baku/Desktop/OmniMath/tests/helpers/noExternalNetwork.mjs' npm run typecheck
NODE_OPTIONS='--import /mnt/c/Users/Baku/Desktop/OmniMath/tests/helpers/noExternalNetwork.mjs' npm run lint
NODE_OPTIONS='--import /mnt/c/Users/Baku/Desktop/OmniMath/tests/helpers/noExternalNetwork.mjs' npm run build
NODE_OPTIONS='--import /mnt/c/Users/Baku/Desktop/OmniMath/tests/helpers/noExternalNetwork.mjs' npm run test:layout
```

The offline preload blocks real non-loopback socket connections while allowing
mock provider responses and local browser fixtures. No external model calls were
made; no dependencies/environment variables were added; no commit was created.
The live-provider image diagnostic/benchmark scripts were deliberately not run.

| Check | Result |
| --- | --- |
| Focused mathematical verifier | 85 pass, 0 fail, 0 skip |
| Focused candidate lifecycle | 21 pass, 0 fail, 0 skip |
| Focused typed/OCR/cache HTTP parity | 1 pass, 0 fail, 0 skip |
| Complete unit suite | 761 tests: 740 pass, 0 fail, 21 pre-existing skips; 633 original passing tests plus 107 new passing tests |
| Grammar-safe annotation | 17 pass, 0 fail, 0 skip |
| Semantic renderer | 13 pass, 0 fail, 0 skip |
| Math pipeline preservation | 14 pass, 0 fail, 0 skip; preservation subsets total 44 passes and are also in the unit suite |
| Typecheck | Exit 0; repository-configured frontend scope, excludes server modules |
| Lint | Exit 0 |
| Build | Exit 0; production output generated, informational output suppressed by the existing Vite configuration |
| Complete recovery browser/layout run | 37 pass, 0 fail, 0 skip; 7.3 minutes, existing configuration with three workers |

The previous `/tmp/omnimath-trust-*.log` files did not survive. The incoming document
reported the initial browser run as 36 pass / 1 fail / 0 skip (radical/radicand
tooltip timeout after successful geometry assertions), then an isolated radical
repeat as 3 pass / 0 fail / 0 skip. The surviving
`test-artifacts/playwright-trust-radical-recheck/.last-run.json` corroborates the
isolated run's passed status.

The supposedly final run's surviving
`test-artifacts/playwright-trust-final/.last-run.json` actually records failure.
Its trace identifies a different tooltip visibility timeout in
`aggregate semantic hover and quick tooltip stay stable at viewport edges`, at
`tests/layoutRegression.spec.mjs:1799`. Full totals for that run cannot be recovered
from these artifacts, so it was not treated as a green final gate.

One complete browser suite was run during recovery. All 37 tests passed, including
both previously failing tooltip cases, the radical/radicand zero-DOM-read assertion,
cached-pointer geometry and zero-layout-read checks, scroll translation, and
grammar-sensitive TeX ownership. Neither timeout reproduced. Those browser solves
are mocked, so the new backend candidate lifecycle is not executed there. No hover
source, browser test, wait duration, or assertion was changed. The resource fix is
confined to the server verifier and was covered by the final focused and unit runs.

Recovery logs are retained under `/tmp/omnimath-recovery-*.log`, with separate logs
for verification, lifecycle, HTTP parity, units, grammar, renderer, preservation,
typecheck, lint, build, and layout. The guarded
symbolic reproduction and corrected result are in
`/tmp/omnimath-recovery-symbolic-{before,after}.log`. The final browser status is in
`test-artifacts/playwright-results/.last-run.json`; the prior final-run failure
trace was preserved. Passing software tests do not prove that every interpreted
claim, generated step, or complete solution is mathematically correct.
