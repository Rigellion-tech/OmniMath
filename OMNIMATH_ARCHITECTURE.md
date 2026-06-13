# OmniMath Architecture

This document is a beginner-friendly map of the OmniMath repo. It explains how the app is put together, where data moves, and where to make common changes safely.

## 1. What The App Does

OmniMath is an AI math tutor web app.

Users can:

- Sign in with Clerk.
- Start or restore math sessions.
- Type a math problem.
- Upload an image of a math problem.
- Get a structured explanation with steps.
- Click math tokens or steps to open floating explanation windows.
- Pin explanation windows.
- Export the current explanation.

The frontend is a Vite + React app. The backend is a small Node HTTP API server. OpenAI calls, API keys, auth checks, usage limits, caching, local rules, and database work all stay on the server.

## 2. Main User Flow

High-level flow:

```text
User opens app
  |
  v
ProtectedRoute checks Clerk auth
  |
  +-- not signed in --> /sign-in
  |
  +-- signed in -----> Home page
                       |
                       v
                 Load sessions + usage
                       |
                       v
        User types problem or uploads image
                       |
                       v
            Frontend calls /api/explain
            or /api/explain-image
                       |
                       v
      Backend authenticates, validates, checks limits
                       |
                       v
        Cache/local rule/demo/live AI explanation
                       |
                       v
          Frontend renders problem + step cards
                       |
                       v
       User clicks tokens/steps for floating windows
```

## 3. Folder Structure

```text
api/
  Vercel-style API entry files. These forward requests into server/app.js.

db/migrations/
  SQL migrations for users, history, sessions, and related data.

scripts/
  Local development helpers. scripts/dev.js starts backend + Vite together.

server/
  Node backend: auth, validation, usage limits, OpenAI/demo/cache logic,
  database helpers, multipart parsing, prompts, and API routing.

src/
  React frontend app.

src/api/
  Browser-side API clients. These call same-origin /api/* routes.

src/components/auth/
  Clerk UI controls and route protection.

src/components/layout/
  Shared layout components, including the session sidebar.

src/components/math/
  Math tutor UI: input, upload, steps, tokens, floating explanations, export.

src/data/
  Demo problem data for the initial local UI.

src/lib/
  Shared frontend helpers and contexts.

src/pages/
  Route-level screens: Home, Account, History, AuthPage, PageNotFound.
```

Important files:

```text
src/pages/Home.jsx
  Main tutor screen. Owns session state, usage display, generation status,
  and wires together the sidebar, input, upload, board, export, and windows.

src/lib/HoverContext.jsx
  Shared state and handlers for hover tooltips and floating explanation windows.

src/components/math/ExplanationPanel.jsx
  Renders floating explanation windows on desktop and bottom sheets on mobile.

src/components/math/ProblemInput.jsx
  Text problem input and local conversation history UI.

src/components/math/ImageUpload.jsx
  Image upload button, preview, and client-side file validation.

src/components/math/ProblemBlock.jsx
  Current problem card and step cards.

server/app.js
  Main API router and endpoint handlers.

server/openai.js
  OpenAI Responses API integration.

server/usageLimits.js
  Daily/monthly usage limit tracking.

server/usageIdentity.js
  Clerk token verification and usage identity resolution.

server/userData.js
  Database reads/writes for users, history, and sessions.

server/localRules.js
  Local explanation dictionary for common math concepts.

server/explanationCache.js
  In-memory explanation cache.
```

## 4. Frontend Flow

The main frontend route is `/`, rendered by `src/pages/Home.jsx`.

The Home page:

1. Loads saved sessions with `fetchUserSessions`.
2. Loads usage with `fetchUsageSnapshot`.
3. Shows a sidebar with sessions.
4. Lets the user submit text through `ProblemInput`.
5. Lets the user upload an image through `ImageUpload`.
6. Shows generated math in `ProblemBlock`.
7. Shows hover/click explanations through `HoverProvider` and `ExplanationPanel`.
8. Autosaves session changes back to `/api/sessions`.

Text problem flow:

```text
ProblemInput
  |
  v
src/api/mathClient.js -> explainProblem()
  |
  v
POST /api/explain
  |
  v
Home receives result
  |
  v
ProblemBlock renders steps
```

Image problem flow:

```text
ImageUpload
  |
  v
src/api/mathClient.js -> explainImageProblem()
  |
  v
POST /api/explain-image
  |
  v
Home receives result
  |
  v
ProblemBlock renders steps
```

## 5. Backend/API Flow

The local backend starts from `server/index.js`. It creates an HTTP server using `handleApiRequest` from `server/app.js`.

API routes:

```text
GET  /api/health
POST /api/explain
POST /api/explain-image
GET  /api/me
PUT  /api/me
GET  /api/history
GET  /api/sessions
POST /api/sessions
PUT  /api/sessions?id=...
GET  /api/usage
```

In production/Vercel, files in `api/` forward those same routes into `server/app.js`.

AI-related routes do this:

```text
Request
  |
  v
Verify Clerk token
  |
  v
Throttle request
  |
  v
Validate JSON or multipart body
  |
  v
Check response cache
  |
  v
Check daily/monthly usage limits
  |
  v
Try local rule
  |
  +-- found --> return local explanation
  |
  +-- not found
       |
       +-- no OPENAI_API_KEY --> return demo explanation
       |
       +-- has OPENAI_API_KEY --> call OpenAI
```

## 6. Auth Flow

Clerk is used for authentication.

Frontend:

- `src/main.jsx` sets up Clerk when `VITE_CLERK_PUBLISHABLE_KEY` is configured.
- `src/components/auth/ProtectedRoute.jsx` blocks protected pages.
- `src/components/auth/AuthControls.jsx` shows sign-in/sign-out/account controls.
- `src/lib/auth.jsx` exposes `useAuthToken()`, which gives API clients a Clerk token.

Backend:

- `server/usageIdentity.js` verifies Bearer tokens using Clerk.
- `requireClerkIdentity(req)` is used for protected routes.
- AI endpoints require authentication.

Auth request flow:

```text
React gets Clerk token
  |
  v
Authorization: Bearer <token>
  |
  v
server/usageIdentity.js verifies token
  |
  v
Request is allowed or rejected
```

Do not put secret keys in frontend code. Only `VITE_CLERK_PUBLISHABLE_KEY` is safe for the browser.

## 7. Database/Session Flow

Database access lives in `server/db.js` and `server/userData.js`.

Tables are created by migrations in `db/migrations/`.

Main database concepts:

- `app_users`: one row per Clerk user.
- `user_explanations`: saved explanation history.
- `user_sessions`: persistent app sessions with JSON payloads.

Session payloads include:

- `title`
- `messages`
- `problems`
- `problem`
- `steps`
- `pinnedWindows`
- `createdAt`
- `updatedAt`

Session autosave flow:

```text
User changes session in Home.jsx
  |
  v
Session marked dirty
  |
  v
Short debounce timer
  |
  v
POST or PUT /api/sessions
  |
  v
server/userData.js writes user_sessions
```

If the session is new, the frontend creates it. If it already exists, the frontend updates it.

## 8. AI Explanation Flow

The backend builds AI prompts in `server/mathPrompt.js`.

The live AI call happens in `server/openai.js` using the OpenAI Responses API. The response must match the schema in `server/mathExplanationSchema.js`.

The expected explanation shape is:

```text
title
originalProblem
expression
finalAnswer
explanations
tokens
steps
  - id
  - label
  - math
  - summary
  - chunks
      - id
      - display
      - short
      - medium
      - deep
```

The frontend uses `steps[].chunks[]` to render clickable math tokens.

## 9. Cache, Usage Limits, Runtime Sources

OpenAI configuration:

- If `OPENAI_API_KEY` is missing, live AI solve requests fail with a server configuration error unless a real local rule can answer the specific input.
- The active workspace does not show sample problem cards, tutorial buttons, or fake fallback solutions.

Cache:

- `server/explanationCache.js` stores in-memory cached explanations.
- Cache keys include user id, problem text, selected reference/depth, explanation type, and image hash.
- Cache hits are logged on the server.
- Cache is in memory, so it resets when the server restarts.

Usage limits:

- Text explanations: 10/day, 300/month.
- Image explanations: 2/day, 30/month.
- Logic lives in `server/usageLimits.js`.
- `/api/usage` returns remaining usage for the UI.
- Limit errors return friendly JSON with code `USAGE_LIMIT_EXCEEDED`.

Runtime source logging:

The server logs whether an explanation came from:

- `local rule`
- `cached`
- `local fallback`
- `live AI call`

It may also log approximate/provider token usage. It must not log API keys or sensitive user data.

## 10. Floating Explanation Windows

Floating explanation state lives in `src/lib/HoverContext.jsx`.

Math tokens are rendered by `src/components/math/MathChunk.jsx`.

Steps are rendered by `src/components/math/MathStep.jsx`.

When a user clicks or right-clicks a token/step:

```text
MathChunk or MathStep
  |
  v
HoverContext creates explanation window state
  |
  v
ExplanationPanel renders window
```

Each window has:

- title
- display math
- explanation text
- beginner/intermediate/advanced toggle
- close button
- pin/unpin button
- drag handle

Desktop:

- Windows are draggable cards.
- Position is clamped inside the viewport.

Mobile:

- Windows render as bottom sheets.

Pinned windows:

- Pinned windows are stored in the session payload as `pinnedWindows`.
- They are restored when a session is restored.

## 11. How To Run Locally

Install dependencies:

```powershell
npm install
```

Start frontend and backend together:

```powershell
npm run dev
```

Run separately:

```powershell
npm run dev:server
npm run dev:client
```

Build:

```powershell
npm run build
```

Lint:

```powershell
npm run lint
```

Typecheck:

```powershell
npm run typecheck
```

Local ports:

- Backend defaults to `http://localhost:8787`.
- Vite defaults to `http://localhost:5173`.
- Vite proxies `/api/*` to the backend using `DEV_API_TARGET`.

## 12. Environment Variables

See `.env.example` for the current list.

Most important variables:

```text
OPENAI_API_KEY
  Server-only OpenAI key. If missing, live AI solve requests are unavailable.

OPENAI_MODEL
  Optional model override.

OPENAI_MAX_OUTPUT_TOKENS
  Hard cap for AI response size.

VITE_CLERK_PUBLISHABLE_KEY
  Browser-safe Clerk publishable key.

CLERK_SECRET_KEY
  Server-only Clerk secret key.

CLERK_JWT_KEY
  Optional Clerk JWT public key for networkless verification.

CLERK_AUTHORIZED_PARTIES
  Allowed frontend origins for Clerk token verification.

DATABASE_URL
  Optional Postgres connection string.

DATABASE_SSL
  Optional database SSL override.

DATABASE_POOL_MAX
  Optional database pool size.

PORT
  Backend server port.

DEV_API_TARGET
  Vite dev proxy target.

USAGE_KV_REST_API_URL
USAGE_KV_REST_API_TOKEN
  Production usage-counter REST store.

USAGE_IDENTITY_HMAC_SECRET
  Secret used for usage identity hashing/signing.
```

Never expose server secrets to frontend code. In Vite, only variables prefixed with `VITE_` are available in the browser.

## 13. Common Debugging Issues

Sign-in redirects immediately:

- Check `VITE_CLERK_PUBLISHABLE_KEY`.
- Check Clerk app settings.
- Check `CLERK_AUTHORIZED_PARTIES` includes local Vite origin.

API says auth is required:

- The frontend may not be sending a Clerk token.
- Check `useAuthToken()` and the API client call.
- Check `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`.

AI response invalid:

- Check `server/mathExplanationSchema.js`.
- Check prompt changes in `server/mathPrompt.js`.
- The model must return strict JSON matching the schema.

Usage limit reached:

- Check `/api/usage`.
- Local usage counters are stored under `.data/`.
- Production usage counters require a REST KV store.

Image upload fails:

- Allowed types: PNG, JPG/JPEG, WebP, GIF.
- Max size: 10 MB.
- Check `parseMultipartForm` and `requireImage` in `server/app.js`.

Sessions do not save:

- Check `DATABASE_URL`.
- Check migrations have been applied.
- Check `/api/sessions` network response.

Floating windows behave strangely:

- Check `src/lib/HoverContext.jsx`.
- Check `src/components/math/ExplanationPanel.jsx`.
- Verify window state is not being overwritten during session restore.

## 14. Where To Modify Things Safely

Add/change UI layout:

- Start in `src/pages/Home.jsx`.
- Reusable layout belongs in `src/components/layout/`.
- Preserve dark teal/glass styling from `src/index.css`.

Change math step rendering:

- `src/components/math/ProblemBlock.jsx`
- `src/components/math/MathStep.jsx`
- `src/components/math/MathChunk.jsx`

Change floating explanations:

- State/handlers: `src/lib/HoverContext.jsx`
- UI: `src/components/math/ExplanationPanel.jsx`

Change text input:

- `src/components/math/ProblemInput.jsx`

Change image upload:

- Frontend: `src/components/math/ImageUpload.jsx`
- Backend validation: `server/app.js`
- Multipart parser: `server/multipart.js`

Change API behavior:

- Route handlers: `server/app.js`
- Vercel entry wrappers: `api/`

Change OpenAI prompt/schema:

- Prompt: `server/mathPrompt.js`
- Schema: `server/mathExplanationSchema.js`
- API call: `server/openai.js`

Change usage limits:

- `server/usageLimits.js`

Change auth:

- Frontend: `src/lib/auth.jsx`, `src/components/auth/`
- Backend: `server/usageIdentity.js`

Change database/session storage:

- SQL: `db/migrations/`
- Query helpers: `server/userData.js`
- Connection: `server/db.js`

Change local explanations:

- Local rules: `server/localRules.js`

General advice:

- Keep OpenAI and secrets server-side.
- Keep frontend API calls going through `src/api/`.
- Run `npm run lint`, `npm run typecheck`, and `npm run build` before finishing.
- Prefer small edits around the existing flow instead of moving large parts of the app.
