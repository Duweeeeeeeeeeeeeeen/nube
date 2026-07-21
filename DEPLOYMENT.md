# Nube Production Deployment

Nube can run as a single Node service. The server serves the built React app from `dist` and exposes API routes under `/api`.

## Build

```bash
npm ci
npm run build
npm run preflight
npm start
```

Default port: `8787`.

## Required Production Env

```env
APP_URL=https://your-domain.com
PORT=8787
NUBE_ALLOWED_ORIGINS=https://your-domain.com
NUBE_SECURE_COOKIES=true

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback
GOOGLE_CALLBACK_URL=https://your-domain.com/api/auth/google/callback
SESSION_SECRET=

AI_PROVIDER=google
GEMINI_API_KEY=
AI_MODEL=gemini-2.5-flash-lite
```

## Recommended Env

```env
NUBE_CLOUD_DATABASE_PROVIDER=postgres
NUBE_CLOUD_DATABASE_URL=
NUBE_CLOUD_DATABASE_SSL=true

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=

STRIPE_SECRET_KEY=
STRIPE_PERSONAL_PRICE_ID=
STRIPE_PRO_PRICE_ID=
STRIPE_SUCCESS_URL=https://your-domain.com/?billing=success
STRIPE_CANCEL_URL=https://your-domain.com/?billing=cancelled

NUBE_PUBLIC_DOMAIN=your-domain.com
NUBE_INBOUND_EMAIL_ADDRESS=inbox@your-domain.com
NUBE_INBOUND_EMAIL_SECRET=
```

## Healthcheck

Use:

```txt
GET /api/health
```

The response reports AI, object storage, cloud database, Google, and integration readiness.

For a local or production preflight, run:

```bash
NUBE_PREFLIGHT_URL=https://your-domain.com npm run preflight
```

Without `NUBE_PREFLIGHT_URL`, the command checks `http://127.0.0.1:8787`.

For launch-blocking production checks, run:

```bash
NUBE_PREFLIGHT_URL=https://your-domain.com npm run preflight:prod
```

This fails when HTTPS, secure cookies, production origins, AI keys, Google OAuth, R2, Postgres, or email forwarding are not configured.

## Google OAuth

Add this authorized redirect URI in Google Cloud:

```txt
https://your-domain.com/api/auth/google/callback
```

Enable:

- Google Calendar API
- Gmail API

## Browser Extension

For production, update the extension endpoint from local development to:

```txt
https://your-domain.com/api/integrations/webhook/capture
```

The preferred auth mode is `Account session`. The token mode remains only as a fallback for local development and external automations.

## Deployment Checklist

- Complete `RELEASE_CHECKLIST.md`.
- Build passes with `npm run build`.
- Preflight passes with `npm run preflight`.
- Production preflight passes with `npm run preflight:prod`.
- `/api/health` returns `ok: true`.
- `APP_URL` is HTTPS.
- `NUBE_SECURE_COOKIES=true`.
- `NUBE_ALLOWED_ORIGINS` contains only production domains.
- Google OAuth redirect URI matches production.
- R2 bucket is private unless using a controlled public/custom domain.
- Postgres URL is set before expecting multi-device sync.
- Stripe keys are set before showing paid checkout publicly.

## Manual Smoke Test

Before publishing a public build, verify:

- Sign in with Google, refresh, and confirm profile stays signed in.
- Create a text capture, a dated reminder, an image upload, and an audio-only voice note.
- Import Google Calendar once, then import again and confirm duplicates are skipped.
- Preview Gmail with filters, deselect at least one email, import, then delete the import batch from Data & Privacy.
- Capture a page from the browser extension while signed in.
- Export JSON, Markdown, CSV, and ICS from Data & Privacy.
- Open Inbox, Collections, Settings, Help, and Upgrade on a laptop-width viewport and a phone-width viewport.
