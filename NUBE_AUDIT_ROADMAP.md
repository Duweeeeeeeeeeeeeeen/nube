# Nube Audit Roadmap

Questa checklist tiene traccia dei blocchi emersi dall'audit. Ogni volta che completiamo un'implementazione, aggiorniamo la spunta.

## Phase 1 - Stabilize the Product

- [x] Finalize Settings/Profile/Connections UI.
- [x] Harden basic security: restricted CORS, secure cookies, security headers.
- [x] Add trusted-origin checks for mutating API requests.
- [x] Make Ask Nube more intelligent and central.
- [x] Finish the audio capture and voice note experience.
- [x] Polish Gmail and Google Calendar imports.
- [x] Make voice-note tasks playable inside the task list.

## Phase 2 - Real Multi-Device Sync

- [x] Connect a real cloud database.
- [x] Add user ownership to captures and files.
- [x] Protect R2 file access by user.
- [x] Build a real multi-device sync flow.
- [x] Load the cloud vault after Google sign-in and merge it into the local vault.
- [x] Connect the browser extension through account login instead of manual tokens.

## Phase 3 - Launch Readiness

- [x] Add real Billing/Upgrade flow.
- [x] Define Free, Personal, and Pro limits for billing and upgrade UI.
- [x] Improve responsive layout for smaller laptops, tablets, and mobile.
- [x] Add real notifications and reminders.
- [x] Add email forwarding with a production domain.
- [x] Prepare production deployment.

## Phase 4 - Launch Hardening

- [x] Split production bundles into focused vendor chunks.
- [x] Add a deploy preflight command for server syntax, env, and health checks.
- [x] Add responsive preview page for phone, tablet, laptop, and desktop checks.
- [ ] Run full browser smoke tests for core flows.
- [ ] Finalize production domain/OAuth/R2/database checklist.
- [ ] Add Stripe webhook after the rest is stable.

## Ongoing Polish

- [x] Improve onboarding and empty states.
- [x] Improve loading states and error messages.
- [x] Improve privacy controls and account deletion/export.
- [x] Encrypt private captures locally with PIN-derived AES-GCM payloads.
- [x] Re-encrypt private captures when changing PIN and decrypt them when removing PIN.
- [x] Keep UI copy consistent and only in English.
- [x] Reduce noisy and duplicate tags across imports and browser captures.
- [x] Run build/security checks after meaningful changes.
- [x] Clarify pricing copy so paid features do not imply production sync/enforcement before Stripe and cloud DB are connected.
- [x] Center top navigation icons and improve responsive preview scaling.
- [x] Add large-device modal to responsive preview for focused viewport QA.
- [x] Improve task/list capture formatting for shopping, packing, checklist, and dated prompts.
- [x] Stop inventing default Medium priority when the user or integration did not provide one.
- [x] Add clearer missing-detail guidance around task date, time window, and priority.
- [x] Add Private Vault session auto-lock after inactivity.
