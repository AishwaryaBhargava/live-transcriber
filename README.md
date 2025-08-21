# Live Transcriber — Chrome Side Panel

Real-time tab/mic transcription with **Deepgram Realtime** + a robust **chunked fallback**. Works even **offline**: audio segments are queued locally and flushed **first** when you reconnect. Click timestamp badges to **seek** your tab’s video/audio.

Backend: **Render (Free)** → `https://live-transcriber-0md8.onrender.com`

---

## 🔗 Quick Links

* **Repo:** [https://github.com/AishwaryaBhargava/live-transcriber](https://github.com/AishwaryaBhargava/live-transcriber)
* **Latest Release (v1.0.0):** [https://github.com/AishwaryaBhargava/live-transcriber/releases/tag/v1.0.0](https://github.com/AishwaryaBhargava/live-transcriber/releases/tag/v1.0.0)
* **Direct ZIP (Load Unpacked):**
  `https://github.com/AishwaryaBhargava/live-transcriber/releases/download/v1.0.0/Live-Transcriber.zip`
* **Chrome Web Store:** *Pending review* <!-- TODO: replace with public listing URL after approval -->
* **Privacy Policy (Gist):**
  Pretty: [https://gist.github.com/AishwaryaBhargava/cb5aa314e3ffea817a7a5b28a813381c](https://gist.github.com/AishwaryaBhargava/cb5aa314e3ffea817a7a5b28a813381c)
  Raw: [https://gist.github.com/AishwaryaBhargava/cb5aa314e3ffea817a7a5b28a813381c/raw/](https://gist.github.com/AishwaryaBhargava/cb5aa314e3ffea817a7a5b28a813381c/raw/)
* **Issues / Support:** [https://github.com/AishwaryaBhargava/live-transcriber/issues](https://github.com/AishwaryaBhargava/live-transcriber/issues)

---

## ✨ Features

* **Side Panel UI** — always available, minimal click friction
* **WS-first** Deepgram streaming with **automatic fallback** to chunked uploads
* **Offline-first queue** (IndexedDB): keeps recording, then **flush-first** on reconnect
* **Chronological render buffer**: late offline lines appear **before** newer online lines
* **Word-level dedup** across overlapping segments
* **Timestamp badges** + click-to-seek the tab’s `<video>/<audio>`
* **Exports**: TXT / SRT / JSON
* **Settings**: Source (Tab / Pick Tab / Mic), segment length, overlap, timestamp cadence

---

## 🧩 Install (Developer Mode)

**Option A — from GitHub Release (recommended)**

1. Download **Live-Transcriber.zip** from the release above.
2. Unzip it — you’ll see a `dist/` folder.
3. Chrome → `chrome://extensions` → enable **Developer mode**.
4. Click **Load unpacked** → select the unzipped **dist** folder.

**Option B — build locally**

```bash
git clone https://github.com/AishwaryaBhargava/live-transcriber.git
cd live-transcriber
npm ci
npm run build:extension   # builds to /dist
npm run zip               # creates Live-Transcriber.zip in /dist
```

Then load `/dist` as unpacked (same as Option A).

---

## 🚀 Quick Start

1. Open any page with audio/video (e.g., YouTube).
2. Open the side panel → choose **Source** (Tab / Pick Tab / Mic) → click **Start**.

   * For **Pick Tab**, choose **Chrome Tab** and tick **Share tab audio** in the picker.
3. Watch lines appear with timestamps.
4. Click a timestamp to **seek** the tab’s media element.
5. Turn **Wi-Fi off at OS level** for \~15–20s → chunks queue.
6. Turn Wi-Fi on → queued text appears **first** (deduped, in time order), then live resumes.

> If the WS path is temporarily unavailable (cold start etc.), the app automatically uses the chunked fallback and later switches back to WS.

---

## 🧪 Reviewer Test Plan (same steps we used)

1. Install from release ZIP (Load Unpacked).
2. Open side panel → **Source: Tab** → Start on a YouTube tab.
3. Confirm live transcript. Click a timestamp → tab seeks.
4. Turn **Wi-Fi off** (not just DevTools throttling) for \~15–20s → “queued N”.
5. Turn Wi-Fi on → toast “Back online — flushing…”, queued lines render **before** new ones.
6. Try **Exports**: TXT/SRT/JSON.
7. Switch to **Mic** and **Pick Tab** briefly to confirm those sources work.

---

## 🔧 Backend

**Public endpoint (Render):** `https://live-transcriber-0md8.onrender.com`

* `GET /health` — ready check
* `POST /transcribe` — chunked fallback (Deepgram prerecorded)
* `WS /realtime` — Deepgram passthrough

**Environment (Render):**

* `DEEPGRAM_API_KEY` — required
* `DG_MODEL` — default `nova-2`
* `ALLOWED_ORIGINS` — include:

  * `chrome-extension://*`
  * `http://localhost`, `http://127.0.0.1`
  * (any other dev origin you use)

> Render Free can cold-start; first request may be slower. The extension detects timeouts and queues gracefully.

---

## 🔒 Privacy

* Audio is captured locally and sent only to **your** backend.
* Offline segments live in IndexedDB **temporarily** and are deleted after they post.
* No server-side transcript storage.

Full policy: see **Privacy Policy** link above.

---

## 🛡️ Permissions (what & why)

* **`tabCapture`** – capture current tab audio (when Source = Tab).
* **`scripting`** – inject a tiny snippet to **seek** the page’s media element when you click a timestamp.
* **`activeTab`** – limit actions to the tab the user interacts with.
* **`sidePanel`** – provide the side panel UI.
* **`tabs`** – detect the active tab and target the right page for seeking.
* **Host permissions** – **none by default**. If a site blocks seeking, users can grant per-site access manually.

> Settings/transcripts are stored with **localStorage/IndexedDB**; Chrome `storage` permission isn’t required for that, but if present, it’s only for local settings persistence.

---

## ⏱ Exports

* **TXT** — `[mm:ss] text…`
* **SRT** — numbered cues (next line’s start minus 200ms, min 1s)
* **JSON** — `[{ t, text }]`

---

## 🧰 Troubleshooting

* **No tab audio captured** → Use **Pick Tab** and tick **Share tab audio**. Some sites restrict `tabCapture`.
* **Timestamp seek fails** → The page might lack a media element or scripting access; seeking is optional.
* **“Connected — queued N”** with no lines → you’re offline or Render cold-started. Chunks are **queued** and will flush automatically.
* **“Failed to queue chunk”** → Clear extension storage (IndexedDB quota): open the extension’s service worker DevTools → Application → Clear storage → Clear site data.
* **CORS** → If you self-host, set `ALLOWED_ORIGINS` to include `chrome-extension://*` plus dev origins.

---

## 🧑‍💻 Development

```bash
# lint & format
npm run lint
npm run format
npm run check

# local backend (optional if you self-host)
npm run start:server
```

---

## 🗒️ Changelog

**v1.0.0**

* WS-first Deepgram + chunked fallback
* Offline queue + **flush-first** replay
* Chronological render buffer and dedup
* Timestamp seek & exports (TXT/SRT/JSON)
* Side panel UX + settings persistence

---

### Maintainer

Open an issue: [https://github.com/AishwaryaBhargava/live-transcriber/issues](https://github.com/AishwaryaBhargava/live-transcriber/issues)
