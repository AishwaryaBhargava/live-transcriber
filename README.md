# Live Transcriber — Chrome Side Panel

Real-time tab/mic transcription with **Deepgram Realtime** + **chunked fallback**. Works even **offline**: audio chunks are queued locally and flushed first when you reconnect. Click timestamps to seek your tab’s video/audio.

> Backend: https://live-transcriber-0md8.onrender.com (Render Free)

---

## ✨ Features

- Chrome **Side Panel** UI — works on any page
- **WebSocket streaming** (Deepgram) with **automatic fallback** to chunked uploads
- **Offline mode**: queues audio in IndexedDB, **flush-first** on reconnect
- **Time-anchored** lines + click-to-seek in the active tab
- **Exports**: TXT / SRT / JSON
- Settings: source (Tab / Pick a Tab / Mic), segment length, overlap, timestamp cadence
- Built for flaky networks (backoff, retry, queue drain)

---

## 🧩 Install (Developer mode)

**Option A — from GitHub Release (recommended)**
1. Download the ZIP from the latest release: **Releases → Assets → `Live-Transcriber.zip`**.
2. Unzip it somewhere you keep dev extensions.
3. Open **chrome://extensions** → toggle **Developer mode** (top right).
4. Click **Load unpacked** → select the unzipped folder (the folder that contains `manifest.json`).
5. Pin the extension and open the **side panel**.

**Option B — build locally**
```bash
# from repo root
npm run zip
# unzip dist/Live-Transcriber.zip and Load unpacked as above
````

---

## 🚀 Quick start

1. Open a tab with media (YouTube, Meet, etc.) or pick **Mic** in Settings.
2. Open the **side panel** → click **Start**.
3. If using **Pick a Tab**, choose “Chrome Tab” and tick **Share tab audio**.
4. Watch live transcript appear. Go offline—text is queued. Reconnect—offline text posts **first**, then live.

---

## 🔧 Backend (Render) notes

The extension talks to:

```
https://live-transcriber-0md8.onrender.com
```

Environment on Render (already set up):

* `DEEPGRAM_API_KEY` — required
* `DG_MODEL` — `nova-2` (or your preferred)
* `ALLOWED_ORIGINS` — must include:

  * `chrome-extension://*`
  * `http://localhost` `http://127.0.0.1`
  * (and any future site where you host a dev page)

The backend exposes:

* `GET /health` — health info
* `POST /transcribe` — chunked fallback
* `WS /realtime` — Deepgram passthrough

> **Free tier note:** Render Free may cold start; first request can be slow. The extension has a tuned timeout to detect this and queue gracefully.

---

## 🛠 Permissions used (why)

* `tabCapture` — capture the current tab’s audio (primary mode)
* `scripting` — inject a tiny script to **seek** the tab when you click a timestamp
* `storage` — save settings + transcript (optional)
* `sidePanel` — the UI lives in the side panel
* `activeTab` — access the active tab for seeking and capture prompts

---

## ⏱️ Exports

* **TXT** — `[mm:ss] your text`
* **SRT** — numbered cues, \~3s default last line
* **JSON** — `[{ t, text }, …]`

---

## 🧰 Troubleshooting

* **No audio / “No audio. Pick ‘Chrome Tab’…”**
  Use **Pick a Tab** and tick **Share tab audio** (Chrome dialog). Some sites block tabCapture.

* **Shows “Connected — queued N” but no lines appear**
  You’re offline or Render is cold-starting. Chunks are being **queued**. They will post automatically (flush-first) once the server responds.

* **“Failed to queue chunk”**
  Browser is out of IndexedDB quota for the extension. Fix: **chrome://extensions** → this extension → **Service worker section → Inspect views** → Application → Clear storage → Clear site data. Then restart transcription.

* **CORS**
  If you self-host, set `ALLOWED_ORIGINS` on the backend to include `chrome-extension://*` and (for local testing) `http://localhost`, `http://127.0.0.1`.

* **Timestamps out of order**
  The UI holds recent lines briefly to let earlier offline lines arrive, then renders chronologically. This is normal.

---

## 🔒 Privacy

* Audio is captured locally and sent only to **your** backend.
* Offline chunks live in IndexedDB temporarily and are deleted after successful posting.
* The extension does not store transcripts server-side.

---

## 🧑‍💻 Development

```bash
# Lint & format
npm run lint
npm run format
npm run check

# Start backend locally (if needed)
npm run start:server
```

---

## 📝 License

ISC

---

## 🙏 Credits

* Deepgram SDK / API for speech-to-text.
