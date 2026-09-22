# AGENTS.md

## Project Overview

OmniMath is an AI math tutor web app. It supports typed math input, image upload, step-by-step explanations, hoverable math tokens, selectable solution steps, and a pinned explanation sidebar.

The frontend is a Vite + React app. The backend is a minimal local Node HTTP server that keeps OpenAI API calls and API keys server-side.

## Core Rules

- Preserve the existing OmniMath UI style unless the user explicitly asks for a redesign.
- Keep the dark theme, teal accent, polished AI tutor feel, and current interaction patterns intact.
- Do not remove current working functionality, including typed input, image upload, recent problems, export, loading/error/status states, hover explanations, right-click pinning, and the explanation sidebar.
- Use environment variables only. Never hardcode API keys, model secrets, endpoint secrets, or credentials.
- Frontend code must never expose API keys. Do not add `VITE_OPENAI_API_KEY` or any other client-visible secret.
- Add clean loading, error, empty, and success states for new user-facing async flows.
- Prefer small focused commits with a clear purpose.
- Document any new environment variables in `.env.example`. If `.env.example` is missing, create it before adding new env-dependent behavior.

## Existing Environment Variables

See `.env.example` for the maintained configuration template. It covers OpenAI keys and model routing, Clerk auth, optional Postgres persistence, usage-counter storage, local development ports, and diagnostic flags.

Do not read server-only values directly from browser code.

## Project Structure

- `src/pages/`: route-level screens.
- `src/components/math/`: math tutor UI, input, upload, explanation, export, and step/token components.
- `src/api/mathClient.js`: frontend API client for local `/api/*` routes.
- `src/data/`: demo problem data.
- `src/components/auth/`: Clerk sign-in/sign-out controls and protected route wrapper.
- `server/`: backend API routes, env loading, multipart parsing, schema, and OpenAI integration.
- `db/migrations/`: optional database schema for durable usage-counter storage.
- `scripts/`: local development helpers.

## UI Guidelines

- Match existing component conventions before introducing new abstractions.
- Keep spacing, typography, shadows, and motion subtle and consistent with the current dark teal design system.
- Use existing math rendering helpers for LaTeX content.
- Make interactive elements keyboard-accessible where practical.
- Avoid visual noise, oversized decorative elements, and unrelated marketing-page patterns.
- Preserve hoverable token behavior and pinned explanation behavior when editing solution step components.

## Backend and API Guidelines

- Keep all OpenAI calls in the backend.
- Prefer routing frontend AI requests through `/api/explain` and `/api/explain-image`.
- Verify Clerk session tokens on the backend before using Clerk user ids for usage tracking.
- Keep user profile and history data behind verified Clerk sessions.
- Validate request input on the server before calling external APIs.
- Return user-safe error messages from API routes.
- Keep payload limits and file validation in place for uploads.
- Enforce explanation and image upload usage limits on the server. Never trust frontend-only counters or unsigned tier headers.

## Verification

Before finishing code changes, run the available checks that apply to the change:

```powershell
npm run lint
npm run typecheck
npm run build
```

There is currently no test script. If a test script is added later, run it before finishing relevant changes.

Use `npm install` only when dependencies are missing or `package.json` / `package-lock.json` changes require it.

## Local Development

Start the frontend and backend together:

```powershell
npm run dev
```

Or run them separately:

```powershell
npm run dev:server
npm run dev:client
```

The frontend should call same-origin `/api/*` paths in production. In development, Vite proxies `/api/*` to the local backend.

# Adaptive Model and Reasoning Policy

Model usage must be optimized for both engineering quality and usage efficiency.

Do not use the strongest or highest-reasoning model merely because it is
currently selected.

Choose or recommend the cheapest model and reasoning effort that can safely
perform the current work.

If the Codex environment supports spawning/delegating work to agents using
different models or reasoning levels, perform these transitions automatically.

If the environment does NOT permit changing the model/reasoning level of the
current agent, stop at natural phase boundaries and explicitly tell the user:

    SWITCH TO: <model>
    REASONING: <level>
    REASON: <one sentence>

Do not continue substantial work with an unnecessarily expensive model after
identifying that a cheaper model is appropriate.


# Model hierarchy

## GPT-6 Astra

### Astra High
Reserve for genuinely difficult work:

- major architecture design
- cross-system architectural changes
- difficult root-cause analysis where the failing layer is unknown
- subtle correctness or concurrency problems
- dangerous migrations/refactors
- difficult semantic/parser/rendering problems
- evaluating competing architectural approaches
- reviewing changes where a subtle mistake could create widespread regressions
- situations where Sol has already failed to resolve the problem

Do NOT use Astra High for:

- running tests
- waiting for commands
- ordinary implementation
- straightforward bug fixes
- writing routine tests
- formatting
- documentation
- repetitive edits
- mechanical refactors
- reading ordinary logs
- dependency installation
- simple file inspection

### Astra Medium
Use for:

- difficult architecture with reasonably clear boundaries
- complicated root-cause analysis
- planning large changes
- reviewing significant implementations
- difficult integration problems
- problems where Astra's stronger reasoning is useful but High is unnecessary

Prefer Astra Medium before escalating to Astra High.

### Astra Low
Use when Astra's capabilities are useful but extended reasoning is unnecessary:

- initial architecture inspection
- moderately difficult debugging
- codebase exploration involving several interacting systems
- reviewing an implementation for structural problems
- planning medium-sized changes

Prefer Astra Low/Medium over Astra High unless evidence justifies High.


# GPT-5.6 Sol

## Sol High
Use for:

- difficult implementation
- debugging a known subsystem
- implementing an architecture already designed
- nontrivial integration work
- fixing complex regressions
- parser/rendering work with an established design
- reviewing important implementation details

Use Sol High when substantial reasoning is needed but Astra is unnecessary.

## Sol Medium
This should be the DEFAULT OmniMath development model.

Use for:

- normal feature implementation
- ordinary debugging
- integration
- localized refactors
- API/backend/frontend changes
- implementing well-defined designs
- regression fixes
- normal code review
- writing meaningful tests

Do not escalate beyond Sol Medium merely because a task is large.
Escalate because the task is intellectually difficult or risky.


# GPT-5.6 Luna

Use Luna whenever work is primarily mechanical or well specified.

Examples:

- running test suites
- expanding existing regression tests
- straightforward test fixes
- formatting
- documentation
- comments
- repetitive edits
- mechanical refactors
- renaming
- cleanup
- log collection
- inspecting test output
- reproducing already-understood failures
- generating fixtures from an established pattern
- checking whether previously implemented behavior still works
- simple dependency/configuration changes

Luna must NOT independently redesign important OmniMath architecture.

If Luna encounters a failure requiring a significant design decision, stop and
escalate rather than inventing a workaround.


# Reasoning-effort policy

Reasoning effort must scale with difficulty.

Do not automatically use High reasoning because it is available.

Use approximately:

Low:
- mechanical or straightforward reasoning
- inspection
- simple debugging
- clearly specified changes

Medium:
- normal software engineering
- implementation
- integration
- moderate debugging
- most OmniMath development

High:
- difficult root-cause analysis
- architecture
- subtle correctness problems
- ambiguous failures
- high-risk changes

Use reasoning above High only when explicitly requested by the user or when
lower levels have demonstrably failed and the environment supports it.


# Automatic phase transitions

Large tasks should be divided into phases.

A typical difficult OmniMath task should follow:

PHASE 1 — Investigation
Astra Low/Medium or Sol High

PHASE 2 — Architecture
Astra Medium/High only when genuinely necessary

PHASE 3 — Core implementation
Sol Medium/High

PHASE 4 — Integration/debugging
Sol Medium

PHASE 5 — Regression tests
Luna or Sol Medium

PHASE 6 — Test execution / cleanup / documentation
Luna

PHASE 7 — Final architectural review, when warranted
Sol High or Astra Low/Medium

Do not keep Astra active through phases 3–6 merely because Astra performed
phases 1–2.


# Automatic delegation

When multi-agent/model delegation is available:

1. Keep difficult reasoning with the appropriate strong model.
2. Delegate independent mechanical work to cheaper agents.
3. Delegate test execution and routine regression creation to Luna where safe.
4. Delegate ordinary implementation to Sol rather than Astra where safe.
5. Run independent tasks in parallel only when they do not risk conflicting
   modifications.
6. Do not have multiple agents modify the same subsystem simultaneously unless
   coordination is explicit.
7. The parent agent remains responsible for reviewing delegated results before
   accepting them.

Do not delegate work merely to create more agents. Delegation must either save
expensive model usage, reduce latency, or provide useful independent review.


# Escalation policy

Escalate only when there is evidence that the current model is insufficient.

Examples of evidence:

- repeated unsuccessful fixes
- unclear root cause across multiple architectural layers
- contradictory test evidence
- a change would alter a core architectural invariant
- parser/semantic behavior cannot be safely reasoned about locally
- a proposed fix creates substantial regression risk

Preferred escalation path:

Luna
→ Sol Medium
→ Sol High
→ Astra Low
→ Astra Medium
→ Astra High

Skipping levels is allowed when the task is obviously architectural or
high-risk.

Do not escalate simply because a test failed.


# De-escalation policy

De-escalation is equally important.

Once difficult reasoning is complete, immediately reconsider whether the
remaining work requires the current model.

Examples:

Architecture decided:
Astra → Sol

Implementation complete:
Sol → Luna for tests/cleanup

Difficult regression isolated and understood:
Astra/Sol High → Sol Medium

Only routine tests remain:
Sol → Luna

Do not consume Astra on mechanical follow-through.


# Context preservation

When changing models or delegating:

- preserve the existing implementation
- preserve established architectural decisions
- inspect the current working tree
- do not redo completed investigation
- do not revert another agent's work without evidence that it is incorrect
- communicate relevant root causes, invariants, changed files, and remaining
  work to the next agent
- reuse existing tests and diagnostics

Changing models must not cause the project to restart intellectually from zero.


# Usage-limit awareness

When usage information is available, account for it.

If an expensive model's short-term allowance is becoming constrained while
substantial mechanical work remains, prefer moving that work to Sol or Luna.

Do NOT sacrifice correctness merely to conserve usage.

Architecture and correctness take priority over token savings.

Mechanical work does not.


# User notification when automatic switching is unavailable

If you cannot automatically change the active model/reasoning level, notify
the user at a natural transition BEFORE doing substantial work that should use
another model.

Use exactly this concise format:

MODEL TRANSITION RECOMMENDED
SWITCH TO: <model>
REASONING: <level>
REASON: <why this phase is better suited to that configuration>
NEXT PHASE: <what will be done>

Then wait for the user to switch models before continuing if the difference in
expected usage is substantial.

Do not interrupt the user for tiny tasks or insignificant savings.


# OmniMath-specific priority

For OmniMath:

Correctness and architectural integrity outrank model-cost optimization.

Never use a cheaper model to make an uncertain architectural decision merely
to save usage.

However, once an architecture or root cause has been established, aggressively
move routine implementation, testing, fixture creation, cleanup, and
documentation to cheaper appropriate models.

The objective is:

strong models think,
Sol engineers,
Luna handles mechanical work,

while preserving one continuous engineering context.


# Existing project constraints

Continue obeying all other OmniMath project instructions.

Do not call external/provider model APIs during tests unless the user explicitly
authorizes it.

Do not commit unless the user explicitly asks for a commit.

Do not broaden task scope merely because a stronger model is active.
