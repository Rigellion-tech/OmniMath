# Mathematical verification calibration

## 1. Existing fixture audit

This benchmark was built from the current working tree without provider calls, new dependencies, commits, hover edits, verifier redesign, or changes to production acceptance policy. The audit preceded implementation. Existing working-tree changes were preserved.

| Source | Finding and use |
|---|---|
| `server/solverBenchmarkSuite.js` | 20 advanced-math input/answer cases. Three independently checked polynomial inputs seed algebra, derivative, primitive, integral and root mutations. The suite includes OCR, series, multivariable and difficult improper-integral examples; its answer strings are not automatically mathematical truth. |
| `tests/mathVerification.test.mjs` | Snapshotted 57 table-driven reference claims, plus four explicitly sourced assumption/singularity controls. These are existing mathematical assertions, not newly generated model labels. They provide inherited reference coverage, not independent production validation. |
| `tests/fastSolvePipeline.test.mjs`, `tests/stokesRegression.test.mjs` | 46 statically extractable candidate objects, including typed/OCR paths, intentional validator failures, correct answers, malformed notation and difficult integral/vector examples. Lexically resolved constants and caller problem arguments preserve available context. |
| `logs/failed-solves/*.json` (ignored files) | 13 actual saved diagnostic solutions, all for the same logarithmic/arctangent improper integral. Snapshots preserve only mathematical input, steps, final answer, source filename, selected normalization stage and SHA-256. No prompts, credentials, provider metadata or runtime transport are replayed. |
| `tests/fixtures/validation/live-symbol-provenance-replay.json` | Two reconstructed live excerpt candidates, explicitly distinguished from full provider captures. |
| `tests/fixtures/orchestration/terra-differential-quality-repair.json` | One reconstructed observed candidate and one explicitly synthetic control. |
| `tests/fixtures/validation/historical-unexplained-symbol-audit.json` | Historical scope/provenance classifications; useful audit context, not mathematical ground truth. |
| OCR screenshot/input tests, semantic/hover tests, local rules, telemetry | Inspected. Screenshot and OCR payload cases mostly provide inputs; semantic tests mostly provide renderer fragments. No new whole-solution objects were extracted from the inspected semantic files. Local-rule solutions overlap the existing polynomial regression fixtures. Telemetry has no mathematical oracle. `src/data/` currently contains concepts and shortcuts, not a stored solve corpus. |

Only the math-only snapshots in `tests/fixtures/verification/` are needed for normal benchmark runs. Regenerating those snapshots requires the original diagnostic logs; a fresh checkout can run the checked-in snapshots without them. Source hashes record the audited working-tree versions, not Git HEAD.

## 2. Benchmark design

Implementation: `scripts/verification-benchmark/{corpus,oracle,evaluate}.mjs`; CLI: `scripts/benchmarkMathVerification.mjs`; gates: `tests/mathVerificationBenchmark.test.mjs`.

Each schema-v1 case stores `id`, `name`, `problem`, `claim`, `assumptions`, `options`, `category`, `origin`, provenance where applicable, `mutationType`, `groundTruth`, `expectedStatus`, `expectedAllowedStates`, and `supportedFalse`. A claim contains its kind and complete expression fields; realistic candidate solutions are separately retained in `solution-fields.json`. Ground-truth statuses are `mathematically_correct`, `mathematically_incorrect`, `domain_invalid`, and `unsupported_ambiguous`. Unknown exact truth is retained explicitly.

Correct claims allow VERIFIED, NUMERICALLY_SUPPORTED or INCONCLUSIVE, never CONTRADICTED. Known false claims permit inconclusive or numerical support, never VERIFIED. Unsupported structures ordinarily require INCONCLUSIVE; two inherited approximate-value controls can also receive numerical support because exact truth was not established. A numerical-support result for a false claim is counted against numerical-support precision.

Ground truth does not come from an LLM call or the verifier under test. The independent dense rational coefficient oracle uses BigInt fractions, coefficient convolution, differentiation, antiderivative coefficients, endpoint evaluation, and exact root substitution. It imports none of the verifier parser, AST, arithmetic, differentiator, normalizer or domain code. Generated certificates store expected, actual and difference coefficient vectors; tests recompute them. Transcendental/domain references inherit explicit pre-existing regression assertions. Metamorphic cases link to correct parent references and preserve a nonzero rational residual: adding delta to a derivative/identity, or delta*x to a primitive. Inherited references are weaker evidence than an independently adjudicated holdout and are reported separately.

Mutations include sign flips, missing terms/factors, coefficient and exponent changes, reciprocal swaps, invalid cancellation, omitted chain factors, primitive contamination, logarithmic coefficient errors, wrong endpoints, sign reversals, dropped integral factors, small exact perturbations, and invalid/sign-changed/nearby rational roots. Domain controls cover forbidden cancellation points, logarithm/square-root domains, poles, assumptions and branches. Mutations that preserve truth are labeled correct: sign reversal and factor dropping on zero integrals do not create false claims.

No random text mutations, seeds, timestamps, network calls or locale-dependent generation decisions are used. Fixed coefficient sets, explicit sample grids, stable source order and JSON-safe rational strings make runs reproducible. A complete repeat-run test compares all evidence, samples, exclusions and extraction results.

## 3. Corpus

There are **229 claim cases**, separate from the **63 realistic/regression extraction candidates**. Whole provider candidates are not assigned mathematical truth merely because they are stored or were accepted/rejected historically.

| Composition | Cases |
|---|---:|
| existing_verifier_reference | 61 |
| fixture_derived_exact_oracle | 115 |
| fixture_derived_reference_certificate | 27 |
| synthetic_exact_oracle | 26 |

Of the 229 claims, 61 are inherited verifier references, 142 are fixture-derived mutations/controls, and 26 are synthetic oracle cases. No complete provider capture is treated as a ground-truthed solution. In the extraction audit, 13 candidates are actual diagnostic captures, three are reconstructed live excerpts, 46 are integration/regression fixtures, and one is an existing synthetic control.

| Ground truth | Cases |
|---|---:|
| domain_invalid | 9 |
| mathematically_correct | 66 |
| mathematically_incorrect | 142 |
| unsupported_ambiguous | 12 |

The domain-reasoning category contains 22 cases, including six correct controls. There are 146 supported intentionally false cases in the recall denominator. Unsupported domain-wide equivalences and unestablished exact approximations are kept out of that denominator as specified by the case metadata before evaluation.

## 4. Results

V = verified; N = numerically_supported; I = inconclusive; C = contradicted. CP = contradiction precision; CR = contradiction recall; FCR = false contradiction rate; VP = verified precision; NP = numerical-support precision. Fractions expose exact denominators; “—” means undefined, not 100%.

| Category | Total | V | N | I | C | CP | CR | FCR | VP | NP |
|---|---:|---:|---:|---:|---:|---|---|---|---|---|
| algebra | 35 | 11 | 0 | 5 | 19 | 19/19 | 19/19 | 0/11 | 11/11 | — |
| numerical_comparison | 9 | 1 | 3 | 2 | 3 | 3/3 | 3/6 | 0/2 | 1/1 | 1/3 |
| derivative | 43 | 11 | 3 | 3 | 26 | 26/26 | 26/30 | 0/12 | 11/11 | 0/3 |
| antiderivative | 32 | 9 | 3 | 0 | 20 | 20/20 | 20/23 | 0/9 | 9/9 | 0/3 |
| definite_integral | 69 | 21 | 1 | 4 | 43 | 43/43 | 43/43 | 0/21 | 21/21 | 0/1 |
| root_substitution | 19 | 5 | 0 | 0 | 14 | 14/14 | 14/14 | 0/5 | 5/5 | — |
| domain_reasoning | 22 | 5 | 1 | 6 | 10 | 10/10 | 10/11 | 0/6 | 5/5 | 1/1 |
| Overall | 229 | 63 | 11 | 20 | 135 | 135/135 | 135/146 | 0/66 | 63/63 | 2/11 |

**Contradiction precision: 135/135 (100%). False contradiction rate: 0/66. Verified precision: 63/63 (100%).** Supported-false contradiction recall is 135/146 (92.47%); this is secondary. Overall inconclusive rate is 20/229 (8.73%), with per-category numerators shown in column I. Inconclusive results are not failures.

Numerical-support precision is **2/11 (18.18%)** under the requested conservative all-reported-support denominator: two known correct claims, seven known incorrect tiny perturbations, and two controls whose exact truth is unestablished. Restricting that denominator to known truth gives 2/9; this does not replace the requested metric. The two unestablished controls are a finite decimal for pi and a Gaussian-integral approximation inherited from previous tests. These are not automatically labeled exact equalities. All counts concern claims, not complete solution correctness.

Category reflects the mathematical task, while method reflects the actual evidence procedure. Both breakdowns and per-case results are saved in `math-verification-calibration-results.json`. Method precision alone cannot measure method recall: a method selected only when a counterexample exists has a selection-dependent denominator. Use category-level CR above.

## 5. Failures found

No mathematically correct benchmark claim became CONTRADICTED. No known incorrect/domain-invalid benchmark claim became VERIFIED. No generalized verifier defect was demonstrated; no production verifier fixes, extraction fixes, or expression-specific patches were made.

Seven nonzero rational perturbations of inherited transcendental identities/derivatives/primitives were numerically supported. The residuals are below numerical tolerance; no numerical result was promoted to symbolic proof. This is a measured limitation of numerical support, not grounds to weaken the precision gates or force contradiction. The new benchmark suite locks in the distinction.

The extraction audit contains two contradictions from intentionally bad existing integration fixtures. `tests/stokesRegression.test.mjs:67` proposes x=-35 for x+35^2=0; exact substitution disagrees. `tests/fastSolvePipeline.test.mjs:638` supplies a malformed multiline final field `I=2` followed by `\frac{1}{2}`; the math parser reads the whitespace-separated product as 1, which differs from the integral 1/2. That second field is not evidence about a well-formed production answer. Neither audited contradiction is a false contradiction of correct mathematics, and neither is included in the ground-truthed claim precision denominator.

The added tests cover all 229 corpus cases, deterministic replay, zero-defect precision gates without recall floors, independent rational certificates, neutral mutations, metamorphic parent validity, conservative metric denominators, recognized-but-inconclusive claims, duplicate display fields, field-budget truncation, and math-only diagnostic snapshots.

## 6. Claim extraction

A candidate field is each nonempty step `latex`, `math` or `equationLatex` and each final-answer field. An examined field is one selected by the existing production precedence/budget. A recognized claim reached a verifier evidence method, even if its result was inconclusive. A parsed constraint/definition deliberately suppressed by claim interpretation is skipped. Unexamined duplicate fields or fields beyond the budget are also skipped. Summary counts are mutually reconcilable: candidate fields = recognized + skipped; state counts refer to examined fields.

| Source | Candidates | Fields | Recognized | Skipped | V | N | I | C | Finals recognized |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| existing_integration_fixture | 46 | 125 | 16 | 109 | 14 | 0 | 109 | 2 | 14 |
| stored_provider_diagnostic | 13 | 125 | 0 | 125 | 0 | 0 | 125 | 0 | 0 |
| reconstructed_live_excerpt | 3 | 15 | 0 | 15 | 0 | 0 | 15 | 0 | 0 |
| existing_synthetic_control | 1 | 4 | 0 | 4 | 0 | 0 | 4 | 0 | 0 |
| Overall | 63 | 269 | 16 | 253 | 14 | 0 | 253 | 2 | 14 |

All 269 fields were examined. Seven integration fixtures lack independently recoverable original input in the stored object/call context; this is reported instead of inventing linkage. None of the static source steps was unresolved after lexical constant extraction. Recognition is 16/269 (5.95%); final recognition is 14/63 (22.22%). The two audit contradictions are explained above.

The 13 actual diagnostic captures contribute 125 fields, all skipped and inconclusive. They contain improper integrals, theta/substitution statements, TeX function powers and ungrouped arguments, multiple equalities, differentials, series, special functions and final answers containing full integral relations. The current grammar cannot establish their claims. Simpler skipped fixtures expose unbraced fraction forms, multiple-root answers using ±/“or”, calculus assignments, bare intermediate expressions, prose, and constraints whose universal-identity meaning cannot be assumed. Important final answers and transformations are therefore missed. These skips do not justify broadly rewriting extraction in this task.

## 7. Policy readiness

**No method is demonstrated ready to control production acceptance, repair, regeneration, escalation or abstention on this evidence alone.** A complete solution remains structurally accepted under the existing evidence-only policy, including when a check is contradicted. There is no policy wiring in this change.

| CONTRADICTED method | Observed precision | Readiness | Future repair / regeneration | Future escalation / abstention |
|---|---|---|---|---|
| `exact_domain_check` | 3/3 | B: promising, very sparse domain coverage | Needs independently labeled valid/invalid domain controls and real extracted claims | Not established |
| `exact_polynomial_integration` | 43/43 | B: promising exact evidence | Best candidates for a future repair/regeneration experiment after an independent realistic holdout | Not established from this corpus |
| `exact_rational_counterexample` | 55/55 | B: promising exact evidence | Best candidates for a future repair/regeneration experiment after an independent realistic holdout | Not established from this corpus |
| `exact_rational_evaluation` | 16/16 | B: promising exact evidence | Best candidates for a future repair/regeneration experiment after an independent realistic holdout | Not established from this corpus |
| `numerical_counterexample` | 17/17 | C: insufficient for automatic policy | Review-only evidence; forward-error estimates are not certified bounds | Not established |
| `solution_substitution` | 1/1 | B: promising, very sparse domain coverage | Needs independently labeled valid/invalid domain controls and real extracted claims | Not established |

Category A is empty. Exact rational evaluation, rational counterexamples and polynomial integration are the strongest candidates for future actionable evidence, but their perfect observed precision is conditional on these selected claims and trusted interpretations. This finite, correlated, largely fixture-derived corpus does not establish a production error bound. The exact domain and assumption methods have only three and one contradictions respectively. Numerical quadrature does not produce contradictions; its disagreements remain inconclusive.

## 8. Regression status

All test commands used the existing network blocker. No external provider calls were made.

| Exact command | Result |
|---|---|
| `node scripts/benchmarkMathVerification.mjs /tmp/omnimath-verification-expanded.json` | 229 cases; zero allowed-state failures, zero false contradictions, zero false VERIFIED states. Full deterministic evidence JSON generated. |
| `node --import ./tests/helpers/noExternalNetwork.mjs --test tests/mathVerificationBenchmark.test.mjs tests/mathVerification.test.mjs tests/solveCandidateLifecycle.test.mjs` | 348 passed, 0 failed, 0 skipped. Includes 242 new benchmark tests and 106 existing verifier/lifecycle tests. |
| `NODE_OPTIONS='--import=./tests/helpers/noExternalNetwork.mjs' npm test` | 1,003 tests: 982 passed, 0 failed, 21 existing skips. |
| `npm run typecheck` | Passed, exit 0. |
| `npm run lint` | Passed, exit 0. |
| `npm run build` | Passed, exit 0; build artifacts generated. |
| Full browser/layout suite | Not rerun: no UI, hover or production-code changes; user explicitly exempted this task. Previous 37/37 status is not presented as a fresh run. |

The checked-in results are a compact report with all case states/reasons and detailed extraction records. To regenerate full samples, residuals, exclusions, claims and certificates, run the benchmark CLI with a JSON destination. To refresh source snapshots deliberately, use `node scripts/verification-benchmark/snapshot-sources.mjs`; original ignored diagnostic files are required for that separate maintenance action. No package scripts or dependencies changed. The checked-in serialized JSON was compared with a fresh run and matched exactly.

## 9. Limitations

- The actual provider captures all concern one difficult improper integral. They contribute extraction evidence but no independently labeled mathematical precision observations. There is no randomly sampled production holdout.
- Existing verifier reference assertions supply some labels; metamorphic transcendental cases inherit those assertions. They are not an independent adjudication of those references. No model supplied fresh benchmark labels.
- Several mutations share polynomial parents. Case count is not the number of independent mathematical families. The exact integration category is relatively overrepresented; positive domain and numerical controls remain sparse.
- `supportedFalse` is declared before observing current results. Recall is conditional on this scope and sample configuration, not all mathematical errors. Some corruption attempts are neutral and correctly counted among correct cases.
- Ground truth separates exact correctness from unknown approximate values. The conservative numerical precision denominator includes two unknown controls. Small false perturbations can receive numerical support; support is not proof.
- The verifier is bounded scalar-real mathematics. Complex branches, general piecewise functions, arbitrary functions, limits, series, multivariable/vector calculus, root-set completeness, and proofs involving cross-step implications are unsupported. Prose assumptions and OCR image fidelity are not verified.
- Domain discharge is deliberately incomplete. Correct cancellations with insufficient assumptions can remain inconclusive. Uncertified floating-point error estimates, isolated agreement, sample-grid aliasing, conditioning and near singularities limit numerical evidence. Quadrature is not certified and cannot justify contradiction on disagreement.
- Solution extraction precedence and the 32-field budget remain unchanged. Existing pure scalar equalities can be constraints rather than identities. Recognized fields do not establish overall solution correctness.
- The project typecheck does not cover benchmark MJS files. An additional ESLint recommended-rules check covered all six new MJS files (zero errors/warnings); Node execution, oracle tests and deterministic replay check their behavior.

## 10. Exactly one recommended next task

Build an independently adjudicated offline holdout of complete, realistic typed/OCR solutions across the supported categories, with field-level truth and original-input linkage, then rerun this unchanged calibration before proposing acceptance-policy wiring. Do not expand verifier scope as part of that data task. This task has not been started.
