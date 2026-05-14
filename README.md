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
OPENAI_MODEL=gpt-5.5
VITE_CLERK_PUBLISHABLE_KEY=pk_test_or_pk_live...
CLERK_SECRET_KEY=sk_test_or_sk_live...
CLERK_JWT_KEY=
CLERK_AUTHORIZED_PARTIES=http://localhost:5173,http://127.0.0.1:5173
CLERK_TIER_CLAIM=omnimath_tier
PORT=8787
DEV_API_TARGET=http://127.0.0.1:8787
USAGE_KV_REST_API_URL=
USAGE_KV_REST_API_TOKEN=
USAGE_IDENTITY_HMAC_SECRET=change_me_for_signed_user_tiers
```

## Environment Variables

| Variable | Required | Default | Used by | Description |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes | None | Backend only | Secret key used by `server/openai.js` to call the OpenAI Responses API. |
| `OPENAI_MODEL` | No | `gpt-5.5` | Backend only | Model used for text and image math explanations. Change this if your account uses a different enabled model. |
| `VITE_CLERK_PUBLISHABLE_KEY` | For auth | None | Frontend | Clerk publishable key used by `@clerk/react`. This is intentionally browser-visible. |
| `CLERK_SECRET_KEY` | For auth | None | Backend only | Clerk secret key used to verify session tokens sent from the frontend. |
| `CLERK_JWT_KEY` | No | None | Backend only | Optional Clerk JWT public key for networkless token verification. |
| `CLERK_AUTHORIZED_PARTIES` | Recommended | None | Backend only | Comma-separated allowed frontend origins for Clerk token verification, such as `http://localhost:5173,https://your-app.vercel.app`. |
| `CLERK_TIER_CLAIM` | No | `omnimath_tier` | Backend only | Session token claim used to promote a logged-in user from `free` to `pro` usage limits when the claim value is `pro`. |
| `PORT` | No | `8787` | Backend only | Port for the local API server. |
| `DEV_API_TARGET` | No | `http://127.0.0.1:8787` | Vite dev server only | Local API target for the Vite `/api/*` proxy. Do not set this on Vercel. |
| `USAGE_KV_REST_API_URL` | Production | None | Backend only | Redis-compatible REST URL for durable daily usage counters. `KV_REST_API_URL` and `UPSTASH_REDIS_REST_URL` are also supported. |
| `USAGE_KV_REST_API_TOKEN` | Production | None | Backend only | Token for the usage counter store. `KV_REST_API_TOKEN` and `UPSTASH_REDIS_REST_TOKEN` are also supported. |
| `USAGE_IDENTITY_HMAC_SECRET` | Recommended | None | Backend only | Secret used to verify signed logged-in user tier headers and to hash anonymous identifiers. |
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

server/
  app.js                    Shared API handlers used locally and on Vercel
  env.js                    Loads .env.local and .env for the backend
  index.js                  Local Node HTTP server
  mathExplanationSchema.js  Structured response schema for math explanations
  multipart.js              Image upload parsing helpers
  openai.js                 Server-only OpenAI Responses API integration
  usageIdentity.js          Server-side anonymous/user identity resolution for quotas
  usageLimits.js            Daily usage limit enforcement and counter storage

db/
  migrations/               Optional SQL schema for relational usage-counter storage

scripts/
  dev.js                    Starts the API server and Vite together

src/
  api/mathClient.js         Browser API client for /api/explain and /api/explain-image
  components/auth/          Clerk auth controls and protected route wrapper
  components/layout/        Shared authenticated page shell
  components/math/          Math rendering, state, and explanation UI
  data/demoProblem.js       Demo fallback content
  lib/auth.jsx              Optional Clerk provider and auth-token bridge
  pages/                    Route-level screens
  App.jsx                   Router setup
```

## Backend API

### Daily Usage Limits

Usage limits are enforced server-side before OpenAI is called. The browser can show friendly limit messages, but it is not trusted for quota decisions.

| User type | Text explanations | Image uploads |
| --- | ---: | ---: |
| Anonymous | 3 per day | 1 per day |
| Free signed-in user | 10 per day | 3 per day |
| Pro signed-in user | 100 per day | 25 per day |

Counters reset daily at UTC midnight. In local development, counters are stored in `.data/usage-limits.json`, which is ignored by git. In production, configure a durable Redis-compatible REST store such as Vercel KV or Upstash with `USAGE_KV_REST_API_URL` and `USAGE_KV_REST_API_TOKEN` (or the supported Vercel/Upstash aliases). If production is missing a durable usage store, explanation routes fail closed instead of silently bypassing limits.

Logged-in user tiers must be supplied by trusted server-side auth middleware or an upstream gateway. OmniMath only accepts `free` or `pro` tier headers when they are signed:

```text
x-omnimath-user-id: user_123
x-omnimath-user-tier: free
x-omnimath-user-signature: HMAC_SHA256("user_123:free", USAGE_IDENTITY_HMAC_SECRET)
```

Unsigned or invalid tier headers are treated as anonymous. Anonymous identities are keyed from a salted hash of IP address and user agent, not from browser-controlled counters.

With Clerk enabled, signed-in requests send the Clerk session token to the backend. The backend verifies that token with `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`, then uses the verified Clerk `sub` user id as the usage identity. Logged-in users default to the `free` tier. To grant `pro` limits, add a Clerk custom session token claim matching `CLERK_TIER_CLAIM` with the value `pro`.

### Clerk Authentication

OmniMath uses Clerk for Google sign-in while keeping the home solver available in signed-out demo mode.

1. Create a Clerk application.
2. Enable Google as a social connection in the Clerk Dashboard.
3. Add `VITE_CLERK_PUBLISHABLE_KEY` to the frontend environment.
4. Add `CLERK_SECRET_KEY` to the backend environment.
5. Set `CLERK_AUTHORIZED_PARTIES` to the frontend origins that should be allowed to send session tokens.
6. Optional: add a custom session token claim such as `{ "omnimath_tier": "{{user.public_metadata.omnimath_tier}}" }` for pro usage limits.

The `/account` and `/history` routes are protected. Signed-out users can still use `/` with anonymous daily limits.

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
    "tier": "anonymous",
    "limit": 3,
    "used": 1,
    "remaining": 2,
    "resetsAt": "2026-05-15T00:00:00.000Z"
  }
}
```

For compatibility, each `steps[]` item includes legacy `chunks[]` entries with `short`, `medium`, and `deep` fields used by the current hover sidebar.

### `POST /api/explain-image`

Accepts multipart form data:

- `image`: uploaded image file.
- `prompt`: optional text prompt to guide the explanation.

The backend converts the image to a data URL and sends it to OpenAI. The upload limit is 10 MB.

## Deployment

The production frontend calls same-origin `/api/*` routes. On Vercel, these routes are handled by the files in `api/`, while the Vite frontend is built into `dist/`.

### Vercel

This repo includes `vercel.json` with the Vite framework, `npm install`, `npm run build`, `dist/` output, and extended function duration for the AI endpoints.

1. Import the repository in Vercel.
2. Set these Environment Variables in the Vercel project settings:

   ```env
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_MODEL=gpt-5.5
   VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   CLERK_SECRET_KEY=your_clerk_secret_key
   CLERK_AUTHORIZED_PARTIES=https://your-project.vercel.app
   CLERK_TIER_CLAIM=omnimath_tier
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

5. Deploy. After deployment, verify:

   ```text
   https://your-project.vercel.app/api/health
   ```

6. Test Google sign-in, typed prompts, and image uploads from the deployed UI.

### Generic Node Deployment

If deploying outside Vercel, serve `dist/` and route `/api/*` to the Node backend.

1. Set server environment variables on the host:

   ```env
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_MODEL=gpt-5.5
   VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   CLERK_SECRET_KEY=your_clerk_secret_key
   CLERK_AUTHORIZED_PARTIES=https://your-frontend-domain.example
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
- Model error from OpenAI: update `OPENAI_MODEL` to a model enabled for your account.

## Security Notes

- Keep `.env.local` and all secret-bearing `.env*` files out of git.
- Never add `OPENAI_API_KEY` to frontend code.
- Never rename `OPENAI_API_KEY` to `VITE_OPENAI_API_KEY`.
- Only `VITE_CLERK_PUBLISHABLE_KEY` belongs in browser-visible env. Keep `CLERK_SECRET_KEY` and `CLERK_JWT_KEY` server-side.
- Route all AI requests through `server/openai.js` so the browser only talks to local `/api/*` endpoints.
- Keep usage limits in server routes. Do not rely on client-side counters for enforcement.
