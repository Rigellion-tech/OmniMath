# OmniMath

OmniMath is an AI math tutor web app for typed math prompts and uploaded problem images. It renders structured, step-by-step explanations with selectable solution steps, hoverable math tokens, pinned explanations, recent problems, export controls, and authenticated account/history views.

The app uses a Vite + React frontend and a small Node HTTP backend. OpenAI calls, usage limits, Clerk token verification, and optional persistence stay server-side so API keys and backend secrets are never exposed to browser code.

## Screenshots

Screenshots are not committed yet. Suggested release assets:

- Main solving workspace with a typed problem.
- Image upload flow after extraction review.
- Hover or pinned explanation sidebar.
- Account/history view for signed-in users.

## Features

- Typed math input with example prompts and recent problem history.
- Image upload flow for extracting and solving math problems from screenshots.
- Structured AI explanations with summaries, worked steps, concepts, practice prompts, and final answers.
- Hoverable math tokens and right-click pinned explanations.
- Follow-up questions from pinned explanation context.
- Compare-methods view for alternative solution approaches.
- Export support for rendered explanations.
- Clerk-based authentication with optional mock auth for local UI testing.
- Server-enforced request, token, and spend limits.
- Optional Postgres persistence for user profiles, sessions, and saved explanations.
- Optional Redis-compatible REST usage store for production quota counters.

## Architecture

```text
src/                 React app, route screens, math UI, auth bridge, and API clients
api/                 Vercel serverless entrypoints for /api/* routes
server/              Shared Node API handlers, OpenAI integration, validation, auth, and usage limits
db/migrations/       Optional Postgres schema for usage, profiles, sessions, and history
scripts/             Local development, layout regression, and diagnostic helpers
tests/               Node test suite and Playwright layout regression spec
```

Local development runs the Vite frontend and Node backend as separate processes. Production builds the frontend to `dist/` and serves `/api/*` through the Vercel functions in `api/`, which reuse the shared backend handlers in `server/app.js`.

## Technologies

- React 18
- Vite 6
- Tailwind CSS
- KaTeX
- Clerk
- Node.js 20+
- OpenAI Responses API
- Postgres via `pg`
- Vercel or Upstash-style Redis REST APIs for durable usage counters
- Node test runner
- Playwright for layout regression checks

## Prerequisites

- Node.js 20.9 or newer
- npm
- An OpenAI API key
- Optional: Clerk application keys for real authentication
- Optional: Postgres database for profile/history persistence
- Optional: Redis-compatible REST store for production usage counters

## Installation

```bash
npm install
```

## Environment Setup

Create a local environment file:

```bash
cp .env.example .env.local
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

At minimum, set:

```env
OPENAI_API_KEY=your_openai_api_key
```

For Clerk-backed auth, also set:

```env
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
CLERK_SECRET_KEY=your_clerk_secret_key
CLERK_AUTHORIZED_PARTIES=http://localhost:5173,http://127.0.0.1:5173
```

For production usage limits, configure a durable usage store:

```env
USAGE_KV_REST_API_URL=your_redis_rest_url
USAGE_KV_REST_API_TOKEN=your_redis_rest_token
USAGE_IDENTITY_HMAC_SECRET=your_random_hmac_secret
```

Optional Postgres persistence uses:

```env
DATABASE_URL=your_postgres_connection_string
DATABASE_SSL=true
DATABASE_POOL_MAX=3
```

Run the migrations when using Postgres:

```bash
psql "$DATABASE_URL" -f db/migrations/001_usage_limits.sql
psql "$DATABASE_URL" -f db/migrations/002_user_profiles_and_history.sql
psql "$DATABASE_URL" -f db/migrations/003_user_sessions.sql
```

Do not create `VITE_OPENAI_API_KEY` or any other `VITE_*` server secret. Vite exposes `VITE_*` variables to browser code.

## Environment Variables

The complete local template is in `.env.example`. Important groups:

| Group | Variables |
| --- | --- |
| OpenAI secrets | `OPENAI_API_KEY`, optional `OPENAI_ORG_ID`, optional `OPENAI_PROJECT_ID` |
| Model routing | Preferred `OMNIMATH_*_MODEL` role overrides and legacy-compatible `OPENAI_*_MODEL` role overrides |
| Reasoning models | `OMNIMATH_SOLVER_REASONING_EFFORT`, `OMNIMATH_REPAIR_REASONING_EFFORT`, `OMNIMATH_ESCALATION_REASONING_EFFORT`, `OMNIMATH_PREMIUM_ESCALATION_REASONING_EFFORT` |
| Output and timeout limits | `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_SOLVE_MAX_OUTPUT_TOKENS`, `OPENAI_LAZY_MAX_OUTPUT_TOKENS`, `OPENAI_IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS`, role-specific `OMNIMATH_OPENAI_*_TIMEOUT_MS` variables |
| Usage limits | `AI_ENABLED`, `AI_RATE_LIMIT_PER_MINUTE`, `AI_RATE_LIMIT_PER_HOUR`, `DAILY_AI_LIMIT`, `MONTHLY_AI_LIMIT`, `DAILY_TOKEN_LIMIT`, `MONTHLY_TOKEN_LIMIT`, `DAILY_SPEND_LIMIT_USD`, `MONTHLY_SPEND_LIMIT_USD` |
| Auth | `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `CLERK_AUTHORIZED_PARTIES`, `CLERK_TIER_CLAIM` |
| Persistence | `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_POOL_MAX` |
| Development | `PORT`, `VITE_PORT`, `DEV_API_TARGET`, `DEV_CLIENT_ORIGIN`, `VITE_AUTH_MODE` |
| Diagnostics | `OMNIMATH_DEBUG_SOLVE`, `OMNIMATH_CAPTURE_FAILED_SOLVES`, `VITE_DEBUG_*` flags |

Model routing is role-specific. Solver resolution is `OMNIMATH_SOLVER_MODEL` > `OPENAI_SOLVER_MODEL` > role default. Repair resolution is `OMNIMATH_REPAIR_MODEL` > `OPENAI_REPAIR_MODEL` > explicitly configured solver role model > role default. Escalation resolution is `OMNIMATH_ESCALATION_MODEL` > `OPENAI_ESCALATION_MODEL` > role default, and premium escalation checks premium role variables before escalation variables. `OPENAI_MODEL` is retained only as a documented legacy value and does not silently override solver, repair, escalation, or image extraction defaults.

Current role defaults are `gpt-5.6-luna` for the initial solver, `gpt-5.6-terra` for repair, `gpt-5.6-sol` for escalation and premium escalation, `gpt-4.1` for image extraction, and `gpt-4.1-mini` for extraction review, hover, and pinned explanations.

OpenAI request deadlines are also role-specific. Defaults are 60 seconds for image extraction, extraction review, and the initial solver; 120 seconds for repair; 180 seconds for escalation and premium escalation; and 30 seconds for hover and pinned explanations. Initial compact retries inherit the solver deadline, while compact retries inside another resolved role inherit that role's deadline. Configured deadlines are clamped to 5–300 seconds; missing, zero, negative, and nonnumeric values use the role default. The legacy blanket `OPENAI_REQUEST_TIMEOUT_MS` is not used for request deadlines.

## Running Locally

Start the frontend and backend together:

```bash
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`
- Health check: `http://localhost:8787/api/health`

You can also run each process separately:

```bash
npm run dev:server
npm run dev:client
```

For local UI testing without Clerk, set `VITE_AUTH_MODE=mock` in `.env.local` or open the app with `?mockAuth=1`.

## Testing

Run the main automated checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Run layout regression checks when changing math rendering, hover targets, or responsive layout:

```bash
npm run test:layout
```

The layout test requires a Playwright Chromium browser. Set `OMNIMATH_E2E_BROWSER_PATH` if you need to point Playwright at an existing browser binary.

## Development Notes

- Frontend API clients call same-origin `/api/*` paths.
- Vite proxies `/api/*` to `DEV_API_TARGET` in development.
- Backend handlers validate input before OpenAI calls.
- Clerk session tokens are verified server-side before user ids are used for profiles, history, or usage tracking.
- Usage counters are local file-backed in development and fail closed in production unless a durable store is configured.
- Failed-solve diagnostics are opt-in with `OMNIMATH_CAPTURE_FAILED_SOLVES=1` and write to `logs/failed-solves/`, which is ignored by git.

## Limitations

- AI-generated math explanations can be incorrect and should be reviewed for high-stakes use.
- Image extraction quality depends on screenshot clarity and notation complexity.
- The local backend is intended for development, not as a hardened production server.
- Production quota enforcement requires a configured durable usage store.
- Profile and history persistence require Postgres; without `DATABASE_URL`, those endpoints report unavailable storage.
- No screenshots or hosted demo URL are included in this repository yet.

## Future Work

- Add release screenshots or an animated demo.
- Add CI that runs install, tests, lint, typecheck, build, and layout regression checks.
- Document deployment steps for providers beyond Vercel if the project needs them.

## License

OmniMath is licensed under the [MIT License](LICENSE).
