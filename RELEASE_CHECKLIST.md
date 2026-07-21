# Nube Release Checklist

This checklist is for the first public release. Stripe is intentionally separate and can be completed after the product flow is stable.

## 1. Production Environment

- [ ] Choose the final production domain.
- [ ] Set `APP_URL=https://your-domain.com`.
- [ ] Set `NUBE_ALLOWED_ORIGINS=https://your-domain.com`.
- [ ] Set `NUBE_SECURE_COOKIES=true`.
- [ ] Set `GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback`.
- [ ] Run `npm run preflight:prod` against the production server.

## 2. Google OAuth

- [ ] Add the production redirect URI in Google Cloud.
- [ ] Enable Google Calendar API.
- [ ] Enable Gmail API.
- [ ] Confirm the app is in the right Google OAuth publishing state or tester list.
- [ ] Test sign-in, logout, and refresh.

## 3. Cloud Database

- [ ] Create the production Postgres database.
- [ ] Set `NUBE_CLOUD_DATABASE_URL`.
- [ ] Keep `NUBE_CLOUD_DATABASE_SSL=true`.
- [ ] Start the server once and confirm schema creation succeeds.
- [ ] Sign in on two devices and confirm captures sync.

## 4. Cloudflare R2 Files

- [ ] Keep the bucket private.
- [ ] Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`.
- [ ] Upload image, PDF, and audio files.
- [ ] Confirm another account cannot download those files through `/api/file`.
- [ ] Confirm local fallback still works when R2 is temporarily unavailable.

## 5. Email Forwarding

- [ ] Set `NUBE_PUBLIC_DOMAIN`.
- [ ] Set `NUBE_INBOUND_EMAIL_ADDRESS`, usually `inbox@your-domain.com`.
- [ ] Set `NUBE_INBOUND_EMAIL_SECRET`.
- [ ] Configure inbound mail routing to `POST /api/integrations/email/inbound`.
- [ ] Forward a receipt, a booking, and a plain email.

## 6. Product Smoke Test

- [ ] Text capture.
- [ ] Task capture with date, time window, repeat days, star, and completion.
- [ ] Checklist capture, for example grocery or packing list.
- [ ] Audio-only voice note.
- [ ] Smart voice note with transcript.
- [ ] Image upload.
- [ ] PDF upload.
- [ ] Place capture with map/photo.
- [ ] Gmail preview and selective import.
- [ ] Google Calendar import and duplicate skip.
- [ ] Browser extension capture: note, page, selection, screenshot.
- [ ] Private PIN: lock, unlock, delete locked item, remove PIN.
- [ ] Export JSON, Markdown, CSV, and ICS.

## 7. Legal And Trust

- [ ] Publish Privacy Policy.
- [ ] Publish Terms of Service.
- [ ] State clearly that Nube is not a password manager.
- [ ] Explain how Gmail/Calendar scopes are used.
- [ ] Explain local vault, cloud sync, R2 files, AI processing, and deletion.

## 8. Final Command

Run locally before deploy:

```bash
npm run build
npm run preflight
```

Run against production after deploy:

```bash
NUBE_PREFLIGHT_URL=https://your-domain.com npm run preflight:prod
```
