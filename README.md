# Nube

AI-native personal knowledge management system built with React, Vite, Zustand, Framer Motion, Recharts, and a small Node API.

## Run

```bash
npm install
npm run dev:full
```

Frontend: `http://127.0.0.1:5174/`
API: `http://127.0.0.1:8787/`

## AI Provider

Copy `.env.example` to `.env` and add your key when ready:

```bash
AI_PROVIDER=google
GEMINI_API_KEY=...
AI_MODEL=gemini-2.0-flash-lite
```

Google Gemini is the recommended low-cost/free-tier way to test Nube classification. You can also use OpenRouter to test multiple models:

```bash
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
AI_MODEL=google/gemini-2.5-flash
```

Or keep using OpenAI:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
GOOGLE_MAPS_API_KEY=...
```

Without an API key, `/api/classify` uses the local fallback classifier.
Without a Google Maps key, place cards use a generic image fallback instead of verified Google Places details.

Optional cost guards:

```bash
NUBE_MAX_CAPTURE_CHARS=4000
NUBE_MAX_AI_FILE_CHARS=6000
NUBE_MAX_STORED_EXTRACTED_CHARS=20000
```

These limits keep long notes, PDFs, and OCR text from sending excessive content to OpenAI. File uploads can still be up to 12 MB, but only the first configured characters are sent for classification.

## Current Features

- Persistent universal inbox
- AI classification endpoint with OpenAI-ready structured output
- Local fallback classification
- Daily-life categories: Actionable, Ideas, Expenses, Places, Documents, People, Study, Work, Health, Home, Travel, Journal, and Links
- File capture for text-like files (`txt`, `md`, `json`, `csv`, `log`)
- Server-side ingestion for PDFs and images through `POST /api/ingest`
- PDF text extraction with `pdf-parse`
- Image OCR with `tesseract.js`
- Browser voice capture when SpeechRecognition is available
- Today view with actionable task progress
- Collections view for automatic category buckets
- Daily Digest view with open actions, patterns, and review prompts
- Editable due dates and priorities for actionable captures
- `.ics` calendar export for one task or all open tasks
- Semantic-style local search
- SQLite-backed search through `GET /api/search?q=...`
- Dynamic idea graph from saved captures
- Focus mode with autosave and send-to-inbox
- JSON export/import for the local brain
- Backend JSON vault sync through `GET /api/brain` and `PUT /api/brain`
- SQLite local persistence at `server/data/nube.sqlite`
- Settings screen with API health, AI provider, storage status, and vault operations
- Capture detail modal for full text, metadata, suggested actions, and task controls
- Full capture editing from the detail modal
- Debounced auto-sync from browser state to SQLite, configurable in Settings
- Browser reminder notifications for actionable captures with due dates

## Product Direction

Nube is designed as a catch-all personal inbox: write, speak, upload, or forward anything, then let the app classify it into useful life contexts. The user should not have to decide where something belongs before capturing it.

The current MVP covers the core loop:

- Capture anything in one inbox.
- Let AI suggest type, metadata, people, places, priority, and next action.
- Review what matters today.
- Search in natural language.
- Revisit automatic collections and a daily digest.

Future expansion points include share-sheet/mobile capture, email forwarding, richer personal memory, calendar integrations, context reminders, and recurring expense/project detection.

## Backend Vault

The lightweight backend vault stores data in SQLite at:

```text
server/data/nube.sqlite
```

It also writes a compatibility snapshot to `server/data/brain.json`.

Use the sidebar controls:

- `Save vault`: writes the current browser brain to the backend file.
- `Load vault`: loads the backend file into the browser brain.

## File Ingestion

The upload button sends files to `POST /api/ingest`.

Supported server-side paths:

- PDF: extracts embedded text.
- Text-like files: reads UTF-8 content.
- Images: runs OCR with Tesseract.

The server then classifies the extracted text through OpenAI when configured, or through the local fallback.

## Verify

```bash
npm run build
npm run lint
```
