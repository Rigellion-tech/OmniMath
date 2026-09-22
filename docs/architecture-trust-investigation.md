# Architecture reconciliation: mathematical trust slice

Date: 2026-09-14. This note covers only the mathematical evidence,
acceptance, retry, delivery, UI, cache, and persistence slice of the wider bug
constellation. It does not infer that a live provider returned a wrong answer.
The reproduced answer is an injected mocked-provider fixture.

## Conclusion

The coexistence of contradiction evidence and delivery is reproducible, but it
is not an unexplained split-brain state. It is the explicitly documented
`evidence_only` policy: structural usability authorizes delivery, while
verification remains non-authoritative evidence and never establishes
whole-solution correctness. The verifier and acceptance policy therefore own
different concepts by design.

This slice falsifies a universal “every symptom is one divergent source of
truth” explanation. It does expose one dangerous product boundary: the client
preserves `verification` and `candidateAcceptance`, but no frontend code reads
either. UI readiness is derived only from renderable steps, so contradiction
evidence is delivered and persisted without any user-visible trust state. That
is a missing consumer/explicit presentation policy, rather than a second backend
correctness decision.

## Focused deterministic reproduction

Commands run from the repository root:

```bash
node --import ./tests/helpers/noExternalNetwork.mjs --test --test-name-pattern='common mathematical evidence through HTTP solve routes' tests/failedSolveDiagnostics.test.mjs
node --import ./tests/helpers/noExternalNetwork.mjs --test tests/solveCandidateLifecycle.test.mjs
```

Results:

- HTTP suite: 2 pass, 0 fail. The name pattern selects the containing suite, so
  it also ran the adjacent invalid-provider-response parity test.
- Candidate lifecycle: 24 pass, 0 fail.
- The preload rejects non-loopback socket connections while leaving mocked
  `globalThis.fetch` usable (`tests/helpers/noExternalNetwork.mjs:1-14`). No
  external provider call was made.

The injected fixture is `tests/failedSolveDiagnostics.test.mjs:837-865`. It
submits `\\int_0^1 (2*x+1)\\,dx`; mocked provider JSON claims `3` in both the
last step and `finalAnswerLatex` (`:840-847`). The observed transition is:

| Stage | Typed | OCR | Typed cache hit |
| --- | --- | --- | --- |
| HTTP result | 200 | 200 | 200 |
| acceptance | `accepted=true`, `mode=evidence_only` | same | same (re-finalized) |
| final check | `contradicted`, `exactIntegral=2` | same | same |
| provider calls after stage | 1 | 2 | still 2 |

The assertions are at `tests/failedSolveDiagnostics.test.mjs:849-864`. One
qualification matters: the helper sends `solveDecision: "direct"`
(`tests/failedSolveDiagnostics.test.mjs:922-977`) with high-confidence evidence
and no structural review issue. Despite the test title saying “reviewed OCR,”
this run proves typed/direct-OCR/cache convergence, not a user-confirmed
`edited` or `anyway` review transition.

The lifecycle test independently proves that all four evidence states,
including `contradicted`, receive the same evidence-only acceptance without
repair or escalation (`tests/solveCandidateLifecycle.test.mjs:11-15`). It also
proves the final-root contradiction case remains accepted (`:46-50`), provider
supplied verification is overwritten (`:92-96`), metadata survives annotation,
JSON, and frontend normalization (`:114-119`), and fast/image schemas converge
on the same checks (`:120-126`).

## End-to-end ownership and transitions

### 1. Candidate production and parsing

`handleExplainRequest` owns the shared typed/OCR-derived solve after the OCR
adapter supplies canonical input (`server/app.js:2261-2289` and
`:2960-2999`). It resolves routing, cache identity, deduplication, and the
provider call (`server/app.js:2304-2385`).

`createMathExplanation` owns provider transport, JSON extraction, schema
assertion, and the one compact retry for retryable response-generation failures
(`server/openai.js:1947-2054`, `:2063-2152`). `parseJsonResponse` extracts a
complete JSON object and calls the supplied structural schema assertion
(`server/openai.js:1364-1415`, `:1454-1540`). `assertFastSolveResponse` and the
conversion layer establish required fields and normalized/renderable solution
shape, not mathematical truth (`server/mathExplanationSchema.js:1220-1300`,
`:1474-1484`).

Provider request/response identity is retained only in non-enumerable
`_omniOpenAiDiagnostics` (`server/openai.js:98-105`, `:1513-1534`,
`:2161-2170`). It supports server diagnostics/usage, but is absent from JSON,
cache clones, client state, and persisted payload. The public solve `requestId`
is added later by `buildResponse` (`server/app.js:1999-2033`).

### 2. Candidate finalization and claim extraction

After provider conversion and local rules, the route first checks structure
(`server/app.js:2430-2460`). Only after provider/compact failure handling ends
does it call `finalizeSolveCandidate` (`server/app.js:2583-2587`). This ordering
is why contradiction evidence cannot enter the provider retry catch.

`finalizeSolveCandidate` is the authoritative owner of finalized evidence. It:

1. asserts structural/renderability usability;
2. calls `assessSolveCandidate`;
3. overwrites `result.verification` with a server assessment; and
4. writes `result.candidateAcceptance` from the explicit policy
   (`server/solveCandidateLifecycle.js:5-27`).

`verifySolution` owns claim interpretation. It examines up to 32 immutable
solution fields, recording `fieldPath`, `stepId`, source expression, and a local
`math-check-N` ID (`server/verification/solutionVerifier.js:11-24`, `:55-57`).
It links a supported final calculus/root claim to the canonical submitted
problem in the finalization context, rather than trusting provider-rewritten
problem text (`:39-46`). Prose, cross-step implications, and completeness are
explicitly outside coverage (`:58-65`).

For the fixture, the input parses as a definite integral and the final `3`
becomes its proposed right-hand value (`server/verification/solutionVerifier.js:41-43`).
The deterministic kernel integrates rational polynomials exactly and compares
the resulting rational value to the claim
(`server/verification/mathVerifier.js:138-154`). That produces
`state=contradicted`, `method=exact_polynomial_integration`, and
`exactIntegral="2"`.

### 3. Evidence/trust classification

There is no whole-solution trusted/correct classification. Individual checks
own `verified`, `numerically_supported`, `inconclusive`, or `contradicted`; the
summary only counts them, exposes `hasContradiction`, and always says
`solutionCorrectness: "not_established"`
(`server/verification/solutionVerifier.js:58-65`). This is a deliberate scope
guard against treating a bounded verifier as authoritative.

Provider `numericCheck` remains provider prose. It is part of candidate content,
not independent evidence, and does not influence the deterministic summary or
acceptance. Provider-created `verification` is not trusted because finalization
overwrites it (`server/solveCandidateLifecycle.js:13-26`).

### 4. Acceptance, retry, and repair eligibility

`decideCandidateAcceptance` owns acceptance. Its contract explicitly defines
acceptance as authorization to return a structurally usable result, not a claim
of correctness (`server/solveAcceptancePolicy.js:1-5`). A structurally usable
candidate is accepted for every verification outcome. Contradiction changes
only the reason to `structurally_usable_with_contradiction_evidence`; the output
still says `mathematicalCorrectness: "not_established"`,
`repairRequested: false`, and `escalationRequested: false` (`:6-15`).

Retry ownership is separate and earlier. The transport/parser triggers a bounded
compact retry only for retryable truncation/JSON/schema generation failures
(`server/openai.js:2019-2054`). The route’s remaining quality-repair scaffolding
cannot see final deterministic evidence because finalization occurs after that
try/catch (`server/app.js:2461-2587`). The explicit acceptance output also asks
for neither repair nor escalation. No contradiction-based retry owner currently
exists.

The route has a second structural acceptance/ledger projection in
`classifySolveCandidate` (`server/app.js:949-1012`), and dormant repair/escalation
terminology remains. It calls the same `decideCandidateAcceptance`, so it is not
a competing current mathematical truth. It is duplicated lifecycle residue and
could become dangerous if a future policy change updates only one invocation.
The repository handoff likewise states that structural acceptance is required
and mathematical verification is evidence-only
(`docs/omnimath-next-session-handoff.md:3-11`).

### 5. Annotation, cache, delivery, UI, and persistence

After finalization, annotation spreads the full result before rewriting
presentation fields, preserving enumerable evidence metadata
(`src/lib/mathAnnotator.js:1698-1713`). A post-annotation assertion checks
renderability only (`server/app.js:2588-2593`). The evidence records the
pre-final-annotation source field; no test here establishes a semantic mutation
across annotation, although the lifecycle test establishes metadata survival.

Successful source-neutral results, including evidence and acceptance, are
cached (`server/app.js:2627-2636`). Cache identity is a hash of user, normalized
problem, reference, depth, type, and optional image hash
(`server/explanationCache.js:15-32`). On a hit, the route clones the cached
candidate and calls `finalizeSolveCandidate` again before delivery
(`server/app.js:2313-2339`). Thus cache is not an independent trust owner and
cannot preserve a stale/provider verdict: the current verifier/policy refreshes
both values.

`buildResponse` spreads the finalized result, adds route request/canonical/usage
metadata, and returns HTTP 200 (`server/app.js:1999-2033`, `:2694-2708`). The
frontend normalizer also spreads the raw/source object, so it preserves
`verification` and `candidateAcceptance` (`src/api/mathClient.js:145-225`). A
repository-wide search finds no frontend read of either field. The UI status
owner checks only whether renderable steps exist; if they do, it returns
`type=success`, `label="Explanation ready"`
(`src/lib/generationStatus.js:4-33`). Home then commits the normalized object and
that status to session state (`src/pages/Home.jsx:646-727`).

Persistence is best effort and outside delivery (`server/app.js:2658-2691`). If
configured/authenticated, it stores the entire result object as the explanation
payload (`server/userData.js:364-399`), so evidence/acceptance travel together.
A missing `app_users` table can prevent that copy from being durable, but it
cannot cause contradiction acceptance, retries, or the HTTP/UI delivery state.

## State and identity ownership table

| Concept | Owner | Identity/provenance | Effect |
| --- | --- | --- | --- |
| Provider candidate | provider parser/converter | hidden solve request ID, provider response ID/model diagnostics until JSON boundary | candidate content only |
| Structural usability | `solveCandidateStructure` | candidate fields; diagnostic request context | blocks malformed/non-renderable candidates |
| Claim interpretation | `solutionVerifier` | canonical problem context + field path + step ID | creates bounded claims |
| Mathematical evidence | `mathVerifier` | local `math-check-N`, source expression, input source | per-claim evidence only |
| Whole-solution correctness | deliberately unowned/unestablished | summary explicitly says `not_established` | no positive trust claim |
| Acceptance/delivery eligibility | `solveAcceptancePolicy` | structural assessment plus evidence summary reason | accepts usable structure |
| Compact retry | provider parser/orchestrator | same logical solve request, separate provider response | only response-generation failure |
| Contradiction repair/escalation | no current owner | none | explicitly false/no call |
| HTTP delivery | shared solve route | public route request ID + canonical input hash | returns finalized candidate |
| UI lifecycle/readiness | frontend generation status/Home operation owner | route request/session operation elsewhere; step presence here | “Explanation ready” when steps exist |
| Trust presentation | no frontend owner | metadata is preserved but unread | no visible contradiction state |
| Cache | shared solve route | user/problem/reference/depth/type hash | stores candidate, then re-finalizes hits |
| Persistence | background user-data writer | verified user + DB explanation ID | optional durable payload copy |

Verification check IDs are candidate-local positional IDs, not correlation IDs.
They do not carry the route request ID, provider response ID, cache key, session
ID, or persistence ID. Field paths and step IDs identify the claim source within
the candidate. This is enough for local attribution but insufficient to join an
individual check directly to provider/operation telemetry without the containing
response or log context.

## Legitimate and dangerous plurality

Legitimate separations:

- provider claim/prose versus server-generated deterministic evidence;
- per-claim evidence versus whole-solution correctness;
- mathematical evidence versus acceptance/delivery policy;
- structural/schema validity versus mathematical validity;
- logical solve request ID versus provider response ID versus persistence ID;
- cache storage versus fresh evidence recomputation on every hit.

Potentially dangerous duplication/gaps:

- `accepted` and log event `final_accepted_payload` can be misread as
  mathematically endorsed unless consumers also honor
  `mathematicalCorrectness=not_established`;
- `classifySolveCandidate` and finalization both project acceptance, although
  they currently share the same policy and only finalization attaches current
  evidence;
- legacy validator/repair/escalation code and terminology survive but are not
  active production trust owners;
- the UI has a delivery-readiness state but no trust-evidence presentation
  state, so preserved contradiction evidence is silent;
- per-check evidence lacks a first-class operation/candidate correlation
  envelope and relies on containment.

## Exact divergence point and architectural judgment

The observable coexistence starts at `server/solveCandidateLifecycle.js:24-26`:
the same assessment obtains contradiction evidence and passes it to acceptance.
The policy then deliberately returns `action="accept"` at
`server/solveAcceptancePolicy.js:7-15`. There is no later overwrite to a second
correctness truth. Delivery follows that decision.

The user-visible information gap occurs at `src/lib/generationStatus.js:4-33`:
status derives from steps/save warning and ignores the preserved evidence. This
does not make “Explanation ready” mathematically false—the explanation is ready
for display—but it leaves no visible distinction between unexamined,
inconclusive, supported, and contradicted answers.

Therefore this slice supports the wider classification **B: a partially shared
mechanism with independent defects**, rather than A. The trust behavior itself
is an intentional policy boundary, not reconstruction from defaults or
divergent ownership. It is a falsifier of a single universal shared defect.

## Narrow invariant and smallest justified milestone

Do not collapse evidence, correctness, and delivery into one state. The narrow
invariant is:

> Every finalized/delivered candidate carries one fresh server-generated
> evidence assessment and one explicit versioned acceptance decision; every
> consumer that presents mathematical trust must derive it from that pair and
> must never interpret structural `accepted` as mathematical correctness.

The smallest justified next milestone is an architecture/policy contract before
any complete-solution holdout: version and name the acceptance meaning, define a
separate user-visible trust projection with an explicit owner, and decide how
that projection handles exact versus numerical contradictions without changing
delivery or repair policy yet. Remove or quarantine duplicated dormant
acceptance projections only after call-site audit. Do not revive the retired
heuristic validator architecture.

Tests accompanying that later fix should cover:

1. typed, explicit reviewed (`edited`/`anyway`), direct OCR, deduplicated, and
   cache-hit paths all carry the same evidence/acceptance contract;
2. provider-supplied verification is overwritten and cache evidence is
   recomputed;
3. the trust projection distinguishes contradiction, inconclusive, and no
   coverage while `accepted` retains its documented delivery meaning;
4. UI session normalization/persistence round trips preserve the projection;
5. false or numerical-only contradictions do not silently become rejection,
   retry, repair, or a correctness assertion.

## Unproven

- No live provider answer was tested or accused of being wrong.
- The route reproduction did not exercise an explicit user-confirmed OCR review
  action; it used allowed direct OCR.
- The verifier’s contradiction is not independently proven beyond this small
  kernel and fixture; this session did not audit false-contradiction rates.
- No complete-solution trust holdout was started.
- No browser assertion proves how users interpret “Explanation ready.”
- No semantic before/after proof was made for the final annotation pass.
- This slice does not explain OCR review divergence, hover model attribution, or
  repeated canonical solve IDs; it only shows that mathematical coexistence has
  a different, explicit cause.
