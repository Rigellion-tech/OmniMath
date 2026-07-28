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
