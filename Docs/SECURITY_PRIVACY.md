# Security & Privacy

## Data flow
- Audio is captured locally (tab/mic).
- During **online/WS**, raw audio frames are streamed to your backend’s WS, proxied to Deepgram, then only text returns to the extension.
- During **offline**, audio chunks are stored **locally** in IndexedDB and posted later to your backend over HTTPS.

## Retention
- **Extension**: queued audio is deleted immediately after successful posting (ack).
- **Backend**: no database persistence (pass-through); logs can be disabled or rotated at provider level.
- **Provider**: Deepgram retention governed by your account settings.

## Protection in transit
- HTTPS to Render.
- WSS for realtime.
- No third-party analytics or trackers in the extension.

## Scope & least privilege
- Only the **active tab** audio is captured (user-initiated).
- Background Service Worker performs transient network tasks; no broad content scripts injected.

## User controls
- Explicit **Start/Stop**.
- Source selection (Tab / Pick / Mic).
- Clear transcript (local only).
- Dark/Light modes, not security-relevant but avoids risky theming libs.

## Risks & mitigations
- **IndexedDB quota exceeded** → graceful drop to in-memory with warning; visible badge “Queued in memory”.
- **Render cold start** → automatic timeout → queue; backoff retries.
- **WS disconnect** → fallback to HTTP.
