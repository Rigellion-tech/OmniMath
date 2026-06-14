# OmniMath

OmniMath is a React and Vite math explanation app with a local Node backend and Vercel API functions for OpenAI API calls. The frontend lets users enter a math prompt or upload an image, and the backend returns a structured explanation that the UI renders as worked steps, concepts, practice, and follow-up guidance.

The OpenAI API key is used only by the backend. Do not expose it through Vite variables or client-side code.

## Prerequisites

- Node.js 20.9 or newer.
- npm.
- An OpenAI API key with access to the configured model.

## Local Setup

Install dependencies:

1. Clone the repository using the project's Git URL.
2. Navigate to the project directory.
3. Install dependencies:

```powershell
npm install
```

4. Create an `.env.local` file and set the required environment variables.


Create a local environment file:

```powershell
Copy-Item .env.example .env.local
```

On macOS or Linux:

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_IMAGE_EXTRACTION_MODEL=gpt-4.1
OPENAI_EXTRACTION_REVIEW_MODEL=gpt-4.1-mini
OPENAI_SOLVER_MODEL=gpt-4.1
OPENAI_HOVER_MODEL=gpt-4.1-mini
OPENAI_PINNED_MODEL=gpt-4.1-mini
OCR_REVIEW_CONFIDENCE_THRESHOLD=35
OPENAI_MAX_OUTPUT_TOKENS=8000
OPENAI_IMAGE_TOKEN_ESTIMATE=1700
OPENAI_INPUT_COST_PER_1M_TOKENS=5
OPENAI_OUTPUT_COST_PER_1M_TOKENS=30
AI_ENABLED=true
AI_RATE_LIMIT_PER_MINUTE=10
AI_RATE_LIMIT_PER_HOUR=100
DAILY_SPEND_LIMIT_USD=2
MONTHLY_SPEND_LIMIT_USD=50
DAILY_AI_LIMIT=50
DAILY_TOKEN_LIMIT=200000
MONTHLY_AI_LIMIT=1000
MONTHLY_TOKEN_LIMIT=2000000
FREE_DAILY_USER_LIMIT=25
FREE_MONTHLY_USER_LIMIT=750
LOGGED_IN_DAILY_USER_LIMIT=100
LOGGED_IN_MONTHLY_USER_LIMIT=3000
VITE_AUTH_MODE=
VITE_CLERK_PUBLISHABLE_KEY=pk_test_or_pk_live...
CLERK_SECRET_KEY=sk_test_or_sk_live...
CLERK_JWT_KEY=
CLERK_AUTHORIZED_PARTIES=http://localhost:5173,http://127.0.0.1:5173
CLERK_TIER_CLAIM=omnimath_tier
DATABASE_URL=
DATABASE_SSL=
DATABASE_POOL_MAX=3
PORT=8787
DEV_API_TARGET=http://127.0.0.1:8787
DEV_CLIENT_ORIGIN=http://localhost:5173
USAGE_KV_REST_API_URL=
USAGE_KV_REST_API_TOKEN=
USAGE_IDENTITY_HMAC_SECRET=change_me_for_signed_user_tiers
```

## Environment Variables

| Variable | Required | Default | Used by | Description |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes | None | Backend only | Secret key used by `server/openai.js` to call the OpenAI Responses API. |
| `OPENAI_IMAGE_EXTRACTION_MODEL` | No | `gpt-4.1` | Backend only | Strong vision model used to extract clean LaTeX from uploaded images. |
| `OPENAI_EXTRACTION_REVIEW_MODEL` | No | `gpt-4.1-mini` | Backend only | Mini model reserved for future ambiguous OCR review paths. Heuristic review runs first and usually avoids this call. |
| `OPENAI_SOLVER_MODEL` | No | `gpt-4.1` | Backend only | Strong model used for full text and image solution generation. |
| `OPENAI_HOVER_MODEL` | No | `gpt-4.1-mini` | Backend only | Cheaper model used for lightweight hover explanations. |
| `OPENAI_PINNED_MODEL` | No | `gpt-4.1-mini` | Backend only | Cheaper model used for pinned explanations and pinned mini-chat. |
| `OCR_REVIEW_CONFIDENCE_THRESHOLD` | No | `35` | Backend only | Browser OCR confidence below this value requires review before solving. Substantial OCR spacing cleanup also shows review suggested. |
| `OPENAI_MODEL` | No | None | Backend only | Legacy fallback for solver and image extraction model selection when path-specific variables are unset. |
| `OPENAI_LAZY_MODEL` | No | None | Backend only | Legacy fallback for hover and pinned model selection when path-specific variables are unset. |
| `OPENAI_MAX_OUTPUT_TOKENS` | No | `8000` | Backend only | Maximum model output tokens per explanation. Also used for token-budget reservation before calling OpenAI. |
| `OPENAI_IMAGE_TOKEN_ESTIMATE` | No | `1700` | Backend only | Conservative token estimate reserved for image inputs before OpenAI is called. |
| `OPENAI_INPUT_COST_PER_1M_TOKENS` | No | `5` | Backend only | Input-token price used for server-side estimated cost logging and spend reports. |
| `OPENAI_OUTPUT_COST_PER_1M_TOKENS` | No | `30` | Backend only | Output-token price used for server-side estimated cost logging and spend reports. |
| `AI_ENABLED` | No | `true` | Backend only | Set to `false` to immediately disable all AI endpoints after auth and rate-limit checks. |
| `AI_RATE_LIMIT_PER_MINUTE` | No | `10` | Backend only | Per-user and per-IP AI endpoint limit per minute. |
| `AI_RATE_LIMIT_PER_HOUR` | No | `100` | Backend only | Per-user and per-IP AI endpoint limit per hour. |
| `DAILY_SPEND_LIMIT_USD` | No | `2` | Backend only | Hard global daily AI spend cap. Requests are rejected before OpenAI when projected spend would exceed this value. |
| `MONTHLY_SPEND_LIMIT_USD` | No | `50` | Backend only | Hard global monthly AI spend cap. Requests are rejected before OpenAI when projected spend would exceed this value. |
| `DAILY_AI_LIMIT` | No | Tier default | Backend only | Daily AI request limit override for all verified users. Local development uses `50` in `.env.example`. |
| `DAILY_TOKEN_LIMIT` | No | `100000` | Backend only | Daily AI token budget enforced per user and globally before OpenAI calls. Local development uses `200000` in `.env.example`. |
| `MONTHLY_AI_LIMIT` | No | Tier default | Backend only | Monthly AI request limit override for all verified users. Local development uses `1000` in `.env.example`. |
| `MONTHLY_TOKEN_LIMIT` | No | `2000000` | Backend only | Monthly AI token budget enforced per user and globally before OpenAI calls. |
| `FREE_DAILY_USER_LIMIT` | No | `25` | Backend only | Daily AI request limit for verified Clerk users on the `free` tier. |
| `FREE_MONTHLY_USER_LIMIT` | No | `750` | Backend only | Monthly AI request limit for verified Clerk users on the `free` tier. |
| `LOGGED_IN_DAILY_USER_LIMIT` | No | `100` | Backend only | Daily AI request limit for verified non-free Clerk users. `DAILY_USER_LIMIT` remains supported as a fallback alias. |
| `LOGGED_IN_MONTHLY_USER_LIMIT` | No | `3000` | Backend only | Monthly AI request limit for verified non-free Clerk users. `MONTHLY_USER_LIMIT` remains supported as a fallback alias. |
| `VITE_AUTH_MODE` | No | None | Frontend | Set to `mock` for local UI testing without Clerk. Do not use this in production. |
| `VITE_CLERK_PUBLISHABLE_KEY` | For auth | None | Frontend | Clerk publishable key used by `@clerk/react`. This is intentionally browser-visible. |
| `CLERK_SECRET_KEY` | For auth | None | Backend only | Clerk secret key used to verify session tokens sent from the frontend. |
| `CLERK_JWT_KEY` | No | None | Backend only | Optional Clerk JWT public key for networkless token verification. |
| `CLERK_AUTHORIZED_PARTIES` | Recommended | None | Backend only | Comma-separated allowed frontend origins for Clerk token verification, such as `http://localhost:5173,https://your-app.vercel.app`. |
| `CLERK_TIER_CLAIM` | No | `omnimath_tier` | Backend only | Session token claim used to promote a logged-in user from `free` to `pro` usage limits when the claim value is `pro`. |
| `DATABASE_URL` | For persistence | None | Backend only | Postgres connection string for app user records and saved explanation history. |
| `DATABASE_SSL` | No | Auto | Backend only | Set `false` for local Postgres if needed, or `true` to force SSL. |
| `DATABASE_POOL_MAX` | No | `3` | Backend only | Maximum Postgres connections per server instance. |

OCR/image extraction and full solving can use stronger models through `OPENAI_IMAGE_EXTRACTION_MODEL` and `OPENAI_SOLVER_MODEL`, while hover, pinned explanations, and pinned mini-chat can stay on cheaper mini models. OCR review is exception-based: OmniMath validates rendered LaTeX, delimiter balance, truncation, and explicit uncertainty markers before considering extra review, which reduces false low-confidence warnings and avoids unnecessary model calls.
| `PORT` | No | `8787` | Backend only | Port for the local API server. |
| `DEV_API_TARGET` | No | `http://127.0.0.1:8787` | Vite dev server only | Local API target for the Vite `/api/*` proxy. Do not set this on Vercel. |
| `DEV_CLIENT_ORIGIN` | No | `http://localhost:5173` | Backend only | Local frontend origin used to redirect accidental non-API requests to the API server back to Vite. |
| `USAGE_KV_REST_API_URL` | Production | None | Backend only | Redis-compatible REST URL for durable daily usage counters. `KV_REST_API_URL` and `UPSTASH_REDIS_REST_URL` are also supported. |
| `USAGE_KV_REST_API_TOKEN` | Production | None | Backend only | Token for the usage counter store. `KV_REST_API_TOKEN` and `UPSTASH_REDIS_REST_TOKEN` are also supported. |
| `USAGE_IDENTITY_HMAC_SECRET` | Recommended | None | Backend only | Secret used to hash verified Clerk user identifiers before storing quota keys. |
| `USAGE_LOCAL_STORE_PATH` | No | `.data/usage-limits.json` | Backend only | Optional local development path for file-backed counters. Do not use this as the production store. |

Do not prefix server secrets with `VITE_`. Vite exposes `VITE_*` variables to browser code.

## Run Locally

Start the backend and frontend together:

```powershell
npm run dev
```

The app will be available at:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`
- Health check: `http://localhost:8787/api/health`

You can also run the two processes separately:

```powershell
npm run dev:server
npm run dev:client
```

In development, Vite proxies `/api/*` requests to the backend on port `8787`.

### Local Mock Auth

For UI testing without Clerk, set this in `.env.local` and restart the dev server:

```env
VITE_AUTH_MODE=mock
```

Mock auth skips the Clerk provider and protected-route gates in local development, then renders a fake user:

```json
{
  "id": "dev-user",
  "email": "dev@omnimath.local",
  "name": "Dev User"
}
```

Do not set `VITE_AUTH_MODE=mock` in production. Normal mode still uses Clerk exactly as before.

## Available Commands

```powershell
npm run dev        # Start frontend and backend for local development
npm run dev:client # Start only the Vite frontend
npm run dev:server # Start only the Node API server
npm run lint       # Run ESLint
npm run typecheck  # Run JavaScript type checking
npm run build      # Build the frontend into dist/
npm run preview    # Preview the built frontend
npm start          # Start the Node API server
```

`npm run preview` serves the built frontend only. API calls still need a running backend and production routing for `/api/*`.

## Project Structure

```text
api/
  health.js                 Vercel function for GET /api/health
  explain.js                Vercel function for POST /api/explain
  explain-image.js          Vercel function for POST /api/explain-image
  me.js                     Vercel function for protected user profile sync
  history.js                Vercel function for protected saved explanation history

server/
  app.js                    Shared API handlers used locally and on Vercel
  db.js                     Postgres connection helper for persistent user data
  env.js                    Loads .env.local and .env for the backend
  index.js                  Local Node HTTP server
  mathExplanationSchema.js  Structured response schema for math explanations
  multipart.js              Image upload parsing helpers
  openai.js                 Server-only OpenAI Responses API integration
  usageIdentity.js          Server-side Clerk identity resolution for quotas
  usageLimits.js            Request/token usage limit enforcement and counter storage
  userData.js               User profile and saved explanation persistence

db/
  migrations/               SQL schema for usage counters, user profiles, and history

scripts/
  dev.js                    Starts the API server and Vite together

src/
  api/mathClient.js         Browser API client for /api/explain and /api/explain-image
  components/auth/          Clerk auth controls and protected route wrapper
  components/layout/        Shared authenticated page shell
  components/math/          Math rendering, state, and explanation UI
  lib/auth.jsx              Optional Clerk provider and auth-token bridge
  pages/                    Route-level screens
  App.jsx                   Router setup
```

## Backend API

### AI Usage Limits

All AI endpoints require a verified Clerk session. Requests without a valid bearer token are rejected before request parsing, quota accounting, cache lookup, or any OpenAI call. The browser can show friendly limit messages, but it is not trusted for auth, quotas, token accounting, tiering, or rate limits.

Server-side controls are enforced in this order:

1. Clerk token verification.
2. Per-user and per-IP minute/hour rate limiting.
3. `AI_ENABLED=false` emergency shutdown.
4. Input validation and duplicate/cache detection.
5. Daily/monthly request quota plus per-user token, global token, and global spend reservation.
6. OpenAI call, followed by actual token/cost settlement and estimated cost logging.

Default per-user limits:

| Control | Default |
| --- | ---: |
| Requests per minute | 10 |
| Requests per hour | 100 |
| Free-tier requests per day | 25 |
| Free-tier requests per month | 750 |
| Non-free logged-in requests per day | 100 |
| Non-free logged-in requests per month | 3000 |
| Tokens per day | 100000 per user and globally |
| Tokens per month | 2000000 per user and globally |
| Global spend per day | $2 |
| Global spend per month | $50 |

Token and spend budgets reserve the estimated maximum request size before OpenAI is called, then settle to actual provider usage after the response. If projected spend would exceed the daily or monthly hard cap, the server returns `SPEND_LIMIT_EXCEEDED` with a clear budget message before any OpenAI call. Duplicate in-flight submissions share the first request instead of making another OpenAI call. Cached repeats do not call OpenAI.

Counters reset at UTC day/month boundaries. In local development, counters are stored in `.data/usage-limits.json`, which is ignored by git. In production, configure a durable Redis-compatible REST store such as Vercel KV or Upstash with `USAGE_KV_REST_API_URL` and `USAGE_KV_REST_API_TOKEN` (or the supported Vercel/Upstash aliases). If production is missing a durable usage store, AI routes fail closed instead of silently bypassing limits.

With Clerk enabled, signed-in requests send the Clerk session token to the backend. The backend verifies that token with `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`, then uses the verified Clerk `sub` user id as the usage identity. Logged-in users default to the `free` tier. To grant `pro` labels in returned usage metadata, add a Clerk custom session token claim matching `CLERK_TIER_CLAIM` with the value `pro`.

### Clerk Authentication

OmniMath uses Clerk for Google sign-in while keeping the home workspace available as a clean entry point.

1. Create a Clerk application.
2. Enable Google as a social connection in the Clerk Dashboard.
3. Add `VITE_CLERK_PUBLISHABLE_KEY` to the frontend environment.
4. Add `CLERK_SECRET_KEY` to the backend environment.
5. Set `CLERK_AUTHORIZED_PARTIES` to the frontend origins that should be allowed to send session tokens.
6. Optional: add a custom session token claim such as `{ "omnimath_tier": "{{user.public_metadata.omnimath_tier}}" }` for pro usage limits.

The `/account`, `/history`, `/sessions`, `/usage`, `/api/explain`, and `/api/explain-image` routes are protected. Signed-out users can still browse the home screen, but live AI routes require sign-in.

### User Data Persistence

Authenticated users are linked to persistent records in Postgres through their verified Clerk user id. The app stores:

- `app_users`: one row per Clerk user, including email, display name, image URL, tier, and last-seen timestamp.
- `user_explanations`: saved explanation results generated by authenticated users.

Run the migrations against the database configured by `DATABASE_URL`:

```powershell
psql "$env:DATABASE_URL" -f db/migrations/001_usage_limits.sql
psql "$env:DATABASE_URL" -f db/migrations/002_user_profiles_and_history.sql
```

If `DATABASE_URL` is not set, signed-in users can still use the solver, but protected profile/history persistence endpoints will report that storage is not configured and generated explanations will not be saved.

### `GET /api/health`

Returns a small status payload for deployment health checks.

### `POST /api/explain`

Accepts JSON:

```json
{
  "problem": "Solve 2x + 5 = 17",
  "history": []
}
```

Returns a structured math explanation rendered by the existing UI:

```json
{
  "title": "Solve Equation",
  "originalProblem": "Solve 2x + 5 = 17",
  "expression": "2x + 5 = 17",
  "finalAnswer": "x = 6",
  "explanations": {
    "beginner": "...",
    "intermediate": "...",
    "advanced": "..."
  },
  "steps": [
    {
      "id": "step-0",
      "label": "Isolate x",
      "math": "2x = 12",
      "summary": "...",
      "chunks": [
        {
          "id": "s0-c0",
          "display": "2x",
          "short": "Variable term",
          "medium": "...",
          "deep": "..."
        }
      ]
    }
  ],
  "tokens": [
    {
      "id": "s0-c0",
      "stepId": "step-0",
      "display": "2x",
      "label": "Variable term",
      "explanations": {
        "beginner": "...",
        "intermediate": "...",
        "advanced": "..."
      }
    }
  ],
  "usage": {
    "kind": "explanation",
    "tier": "free",
    "limit": 50,
    "used": 1,
    "remaining": 49,
    "resetsAt": "2026-05-15T00:00:00.000Z",
    "tokens": {
      "daily": {
        "limit": 100000,
        "used": 3200,
        "remaining": 96800
      }
    }
  }
}
```

For compatibility, each `steps[]` item includes legacy `chunks[]` entries with `short`, `medium`, and `deep` fields used by the current hover sidebar.

### `POST /api/explain-image`

Accepts multipart form data:

- `image`: uploaded image file.
- `prompt`: optional text prompt to guide the explanation.

The backend converts the image to a data URL and sends it to OpenAI. The upload limit is 10 MB.

### `GET` / `PUT /api/me`

Protected by Clerk. Creates or updates the authenticated user's `app_users` row and returns the stored profile.

### `GET /api/history`

Protected by Clerk. Returns the authenticated user's saved explanations ordered newest first.

## Deployment

The production frontend calls same-origin `/api/*` routes. On Vercel, these routes are handled by the files in `api/`, while the Vite frontend is built into `dist/`.

### Vercel

This repo includes `vercel.json` with the Vite framework, `npm install`, `npm run build`, `dist/` output, and extended function duration for the AI endpoints.

1. Import the repository in Vercel.
2. Set these Environment Variables in the Vercel project settings:

   ```env
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_IMAGE_EXTRACTION_MODEL=gpt-4.1
   OPENAI_EXTRACTION_REVIEW_MODEL=gpt-4.1-mini
   OPENAI_SOLVER_MODEL=gpt-4.1
   OPENAI_HOVER_MODEL=gpt-4.1-mini
   OPENAI_PINNED_MODEL=gpt-4.1-mini
   AI_ENABLED=true
   AI_RATE_LIMIT_PER_MINUTE=10
   AI_RATE_LIMIT_PER_HOUR=100
   DAILY_SPEND_LIMIT_USD=2
   MONTHLY_SPEND_LIMIT_USD=50
   FREE_DAILY_USER_LIMIT=25
   FREE_MONTHLY_USER_LIMIT=750
   LOGGED_IN_DAILY_USER_LIMIT=100
   LOGGED_IN_MONTHLY_USER_LIMIT=3000
   VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   CLERK_SECRET_KEY=your_clerk_secret_key
   CLERK_AUTHORIZED_PARTIES=https://your-project.vercel.app
   CLERK_TIER_CLAIM=omnimath_tier
   DATABASE_URL=your_postgres_connection_string
   USAGE_KV_REST_API_URL=your_vercel_kv_or_upstash_rest_url
   USAGE_KV_REST_API_TOKEN=your_vercel_kv_or_upstash_rest_token
   USAGE_IDENTITY_HMAC_SECRET=your_random_hmac_secret
   ```

   `PORT` and `DEV_API_TARGET` are only needed locally and do not need to be set on Vercel. Vercel KV's default `KV_REST_API_URL` and `KV_REST_API_TOKEN` variable names also work.

3. Use the default project settings from `vercel.json`:

   ```text
   Install Command: npm install
   Build Command: npm run build
   Output Directory: dist
   ```

4. In Clerk, add the deployed origin to the allowed origins/redirect settings and enable Google sign-in.

5. Run the SQL migrations against the production database.

6. Deploy. After deployment, verify:

   ```text
   https://your-project.vercel.app/api/health
   ```

7. Test Google sign-in, typed prompts, image uploads, account profile sync, and saved history from the deployed UI.

### Generic Node Deployment

If deploying outside Vercel, serve `dist/` and route `/api/*` to the Node backend.

1. Set server environment variables on the host:

   ```env
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_IMAGE_EXTRACTION_MODEL=gpt-4.1
   OPENAI_EXTRACTION_REVIEW_MODEL=gpt-4.1-mini
   OPENAI_SOLVER_MODEL=gpt-4.1
   OPENAI_HOVER_MODEL=gpt-4.1-mini
   OPENAI_PINNED_MODEL=gpt-4.1-mini
   AI_ENABLED=true
   AI_RATE_LIMIT_PER_MINUTE=10
   AI_RATE_LIMIT_PER_HOUR=100
   DAILY_SPEND_LIMIT_USD=2
   MONTHLY_SPEND_LIMIT_USD=50
   FREE_DAILY_USER_LIMIT=25
   FREE_MONTHLY_USER_LIMIT=750
   LOGGED_IN_DAILY_USER_LIMIT=100
   LOGGED_IN_MONTHLY_USER_LIMIT=3000
   VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   CLERK_SECRET_KEY=your_clerk_secret_key
   CLERK_AUTHORIZED_PARTIES=https://your-frontend-domain.example
   DATABASE_URL=your_postgres_connection_string
   PORT=8787
   USAGE_KV_REST_API_URL=your_redis_rest_url
   USAGE_KV_REST_API_TOKEN=your_redis_rest_token
   USAGE_IDENTITY_HMAC_SECRET=your_random_hmac_secret
   ```

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Build the frontend:

   ```bash
   npm run build
   ```

4. Start the API server:

   ```bash
   npm start
   ```

5. Serve `dist/` from your static host, CDN, or web server.

6. Add routing so `/api/*` reaches the Node server. This can be done with a platform rewrite, reverse proxy, or gateway rule.

7. Configure a health check against `/api/health`.

For split-domain deployments, either proxy frontend `/api/*` requests back to the backend domain or add an explicit CORS strategy before deploying. The current frontend is intentionally written for same-origin API routing.

## Troubleshooting

- Missing API key: make sure `.env.local` contains `OPENAI_API_KEY`, then restart the backend.
- Port already in use: set a different `PORT` in `.env.local`.
- Frontend loads but AI calls fail: confirm the backend is running and `/api/health` responds.
- Image upload fails: keep uploads under 10 MB and use a browser-supported image format.
- Usage tracking unavailable in production: configure `USAGE_KV_REST_API_URL` and `USAGE_KV_REST_API_TOKEN`, or the equivalent Vercel KV / Upstash REST variables.
- Sign-in button is missing: set `VITE_CLERK_PUBLISHABLE_KEY` and restart the Vite dev server.
- Google sign-in is unavailable: enable Google in the Clerk Dashboard social connections.
- Logged-in users still receive anonymous limits: make sure the frontend sends a Clerk session token and the backend has `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`.
- Pro users still receive free limits: add a Clerk custom session token claim matching `CLERK_TIER_CLAIM` with value `pro`.
- Account/history persistence unavailable: set `DATABASE_URL` and run the migrations in `db/migrations/`.
- Model error from OpenAI: update the relevant path-specific model variable, such as `OPENAI_SOLVER_MODEL` or `OPENAI_IMAGE_EXTRACTION_MODEL`, to a model enabled for your account.

## Security Notes

- Keep `.env.local` and all secret-bearing `.env*` files out of git.
- Never add `OPENAI_API_KEY` to frontend code.
- Never rename `OPENAI_API_KEY` to `VITE_OPENAI_API_KEY`.
- Only `VITE_CLERK_PUBLISHABLE_KEY` belongs in browser-visible env. Keep `CLERK_SECRET_KEY` and `CLERK_JWT_KEY` server-side.
- Route all AI requests through `server/openai.js` so the browser only talks to local `/api/*` endpoints.
- Keep usage limits in server routes. Do not rely on client-side counters for enforcement.
