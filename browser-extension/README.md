# Nube Capture Extension

Local Chrome/Edge extension for saving browser context into Nube.

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:
   `browser-extension`

## Connect it to Nube

1. Open Nube.
2. Sign in with Google.
3. Open the Nube extension popup.
4. Keep `Connection` set to `Account session`.
5. Keep the endpoint as:
   `http://127.0.0.1:5174/api/integrations/webhook/capture`

The fallback token mode is only for local development or external automations. The production path is account session: install the extension, sign in to Nube, and capture into the same profile.

## What it can save

- Free notes without any page URL
- Notes with image/file attachments
- Visible-page screenshots
- Current page, when you choose Page or enable current page context
- Selected text
- Readable page text for article-style captures
- Quick category templates, due presets, priority, and star
- Recent captures and offline queue
- Links from the right-click menu
- Images from the right-click menu

Nube will classify the capture through the same webhook pipeline used by external automations.
