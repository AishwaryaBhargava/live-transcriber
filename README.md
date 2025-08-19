# TwinMind Tab Transcriber

Chrome side-panel extension that **transcribes the current tab, a picked tab, or your microphone** in near-realtime using **Deepgram**.  
It auto-switches between **Realtime (WebSocket)** and **Fallback (chunked uploads)**, and has an **offline queue** that buffers audio locally and flushes when you’re back online. Exports to **.txt**, **.srt**, and **.json**.

---

## ✨ Features

- **Sources:** Active Tab, “Pick a Tab” (Chrome picker), or Microphone
- **Realtime (WS)** + **Fallback (chunked)** with automatic switching both ways
- **Offline-first queue** (IndexedDB) with time anchors; auto-flush on reconnect
- **Word-level de-dup** across overlapped chunks
- **Timestamp badges** every N seconds (click to seek the page’s video/audio)
- **Light/Dark theme** toggle; compact UI; settings modal & export sheet
- **Exports:** Copy, `.txt`, `.srt`, `.json`
- **Autosave/restore** transcript and **persisted settings**

---

## 🧱 Project Layout

```
repo/
  backend/
    server.js            # Express + Deepgram (WS relay + chunked)
    package.json
    .env.example
  extension/
    manifest.json
    sidepanel/
      index.html
      panel.css
      main.js
    lib/
      db.js              # IndexedDB queue helpers (idb)
    background/
      sw.js
```

**Backend**
- `POST /transcribe` — accepts audio chunks (webm/opus) → `{ text, seq }`
- `WS /realtime` — streams audio to Deepgram; relays back interim/final transcripts

**Side-panel**
- Captures audio via `tabCapture`, `getDisplayMedia` (picker), or `getUserMedia` (mic)
- Prefers WS; falls back to chunked; can later switch back to WS
- Queues while offline; flushes in order when online; adds timestamp badges
- Dedups overlap; autosaves to `localStorage`

---

## 🔧 Prerequisites

- **Node 18+**
- **Chrome 120+**
- **Deepgram API key** (free tier available)

---

## 🚀 Setup

### 1) Backend

```bash
cd backend
npm install
cp .env.example .env  # put your key
```

Edit `.env`:

```
PORT=8080
DEEPGRAM_API_KEY=YOUR_DEEPGRAM_KEY
# Optional:
# DG_MODEL=nova-2
```

Run:

```bash
npm start
# or
node server.js
```

Verify health: http://localhost:8080/health → `{"ok":true}`

### 2) Extension

1. Open `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Pin the side-panel icon (optional).
4. Open a normal site (YouTube, etc.), open the **side panel**.

> If you see “Access requested”, click it to allow the extension on that site.

---

## 🧪 Using It

1. Click **⚙ Settings** → choose **Source** (Tab / Pick / Mic), adjust segment length, overlap, timestamp cadence, WS preference, etc.
2. **Start**.  
   - Status shows **Streaming (Deepgram)** for WS, or **Recording (fallback)** for chunked.
3. **Pause**, **Resume**, **Stop** as needed.
4. **Timestamps** appear every N seconds; click to seek the page’s video/audio (where allowed).
5. **Export** via the download icon → `.txt`, `.srt`, `.json` or **Copy**.

---

## 🌐 Offline Behavior

- When the network drops, uploads time out quickly and chunks are **queued** in IndexedDB with their start-time anchor.
- A toast shows the queued count; the **Connection** label shows “queued N”.
- On reconnect, the queue **flushes automatically**.  
- Online and queued segments might interleave; timestamps keep reading order sensible.

> Audio played entirely while offline can’t be re-captured after reconnect — we rely on chunks recorded during the outage.

---

## ⚙ Settings (⚙ modal)

- **Provider**: Deepgram
- **Prefer realtime (WS)**: try WS first
- **Segment length** (default 10s)
- **Overlap** (default 1200ms)
- **Timestamp cadence** (default 8s)
- **Debug logs**
- **Source**: Tab / Pick / Mic

All settings persist.

---

## 🔐 Permissions

- `tabCapture`, `activeTab`, `sidePanel`, `tabs`, `scripting`, `storage`
- Host permissions: `<all_urls>` (narrow if you wish)

---

## 🧰 Dev Scripts (backend)

```json
{
  "name": "twinmind-backend",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  }
}
```

---

## 📦 Pack the Extension (optional)

In `chrome://extensions` → **Pack extension** → choose `extension/`.

---

## 🧯 Troubleshooting

- **No side panel/permission toast**: allow the extension on that site.
- **Picker gives no audio**: you must choose **Chrome Tab** and tick **Share tab audio**.
- **Nothing after offline/online**: ensure backend is running; queue flushes only when online and server reachable.
- **CORS**: backend is permissive for dev; harden for prod if needed.

---

## 🔒 Privacy

Only audio → Deepgram for transcription; no extra tracking. Clear transcript with **Clear**.