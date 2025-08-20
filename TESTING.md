# TESTING

This document describes how to verify the Chrome side-panel extension end-to-end, including realtime (WS), fallback uploading, offline queueing, chronological rendering, seeking, and exports.

> Repo: [https://github.com/AishwaryaBhargava/live-transcriber](https://github.com/AishwaryaBhargava/live-transcriber)
> > Release ZIP: [https://github.com/AishwaryaBhargava/live-transcriber/releases/tag/v1.0.0](https://github.com/AishwaryaBhargava/live-transcriber/releases/tag/v1.0.0)
> > > Backend (Render): `https://live-transcriber-0md8.onrender.com`
> > > > Issues: [https://github.com/AishwaryaBhargava/live-transcriber/issues](https://github.com/AishwaryaBhargava/live-transcriber/issues)

---

## 0) Prerequisites

* Chrome 119+ (or any Chromium that supports side panel + `tabCapture`)
* Download **Live-Transcriber.zip** from the latest release and **Load unpacked** (unzip → `chrome://extensions` → Developer Mode → Load unpacked → select the unzipped folder that contains `manifest.json`)
* Backend is live at `https://live-transcriber-0md8.onrender.com` with `DEEPGRAM_API_KEY` set
* A tab with audio (e.g., YouTube) for “Tab” tests; a microphone for “Mic” tests

---

## 1) Smoke test (Side Panel + Start/Stop)

1. Open any page with audio (YouTube recommended).
2. Open the **side panel** → choose **Source: Tab** → click **Start**.
3. Expect:

   * Status shows **Streaming** (WS) or **Recording (fallback)**.
   * Transcript lines start appearing with timestamps.
4. Click **Stop**. Expect capture to stop and status to show **Stopped**.

✅ Pass if lines appear while audio plays; no errors in the panel.

---

## 2) Realtime (WS) path

1. With the same tab, click **Start**.
2. Expect transcript to start within a couple seconds.
3. Watch the debug footer (optional): if WS is connected, it shows **Connected (WS)**.

✅ Pass if lines arrive continuously without fallback messages.

> Note: If Render cold-starts, the app may briefly use fallback and later switch to WS automatically.

---

## 3) Fallback (chunked) path

1. In **Settings**, leave defaults; just click **Start**.
2. If WS is not immediately ready, you’ll see **WS unavailable → fallback** toast and status **Recording (fallback)**.
3. Expect lines to continue appearing every few seconds (segment-based).

✅ Pass if transcription continues via fallback without user intervention.

---

## 4) Offline queue (OS Wi-Fi off)

This test verifies the IndexedDB queue and **flush-first** behavior using a real network outage (not just DevTools throttling).

1. Start transcription on a playing YouTube video.
2. **Turn off Wi-Fi at the OS level** (or unplug ethernet) for \~15–20 seconds while audio continues.
3. Expect:

   * Connection label shows **queued N (offline)**.
   * Debug lines show **📥 enqueue (offline or backlog present)**.
   * No new transcript lines render during the outage (they are **queued**).
4. Turn Wi-Fi **on**.
5. Expect:

   * Toast **Back online — flushing queued chunks**.
   * **Queued lines render first**, in correct chronological order (older timestamps), followed by live lines.
   * The queued count drops back to 0.

✅ Pass if previously spoken audio during the outage is transcribed and appears **before** new online text (ordered by timestamp).

---

## 5) Chronological render buffer (ordering)

1. Repeat the offline test but start speaking *right before* going offline and *continue* into the offline window.
2. After reconnection, confirm that earlier, queued lines slot **before** later live lines (by timestamp), with **no duplicated overlaps**.

✅ Pass if the sequence reads naturally without repeated phrases.

---

## 6) Seeking via timestamp badges

1. While capturing **Tab** audio on a video page, click a timestamp badge in the transcript.
2. Expect the page’s `<video>` to seek and resume playback from that time.

✅ Pass if seeking works; if not, seeking is optional and may be blocked by site permissions—no failure if capture/transcription still works.

---

## 7) Sources (Pick Tab / Mic)

### A) Pick a Tab

1. Choose **Source: Pick Tab** → Start.
2. Chrome shows a picker — choose **Chrome Tab** and tick **Share tab audio**.
3. Expect transcription similar to “Tab”.

### B) Microphone

1. Choose **Source: Mic** → Start.
2. Approve microphone permission.
3. Speak and confirm live transcription.

✅ Pass if both sources work.

---

## 8) Exports

1. Generate at least a dozen lines.
2. Click **Export TXT** — expect a file with `[mm:ss]` prefixed lines.
3. Click **Export SRT** — expect valid SRT with numbered cues.
4. Click **Export JSON** — expect an array of `{ t, text }`.

✅ Pass if all three export files download and contain expected content.

---

## 9) Error handling & CORS

* If you self-host, ensure backend has:

  * `ALLOWED_ORIGINS` including `chrome-extension://*`, `http://localhost`, `http://127.0.0.1`
* If backend is unreachable, the app queues segments and retries; upon recovery, queued text flushes.

✅ Pass if no unhandled errors are shown; queued items eventually post when online.

---

## 10) Troubleshooting

* **No audio captured** → Use **Pick Tab** and tick **Share tab audio** (some pages block `tabCapture`).
* **Timestamp seek fails** → Page may not allow injection; seeking is optional.
* **“Failed to queue chunk”** → Clear extension storage (IndexedDB) via the extension’s service worker DevTools → Application → Clear storage → Clear site data.
* **Still no transcripts after reconnect** → Wait a few seconds for Render to warm; watch the side-panel debug lines (enable “Debug” in Settings to see queue/flush logs).

---

## 11) Acceptance criteria checklist

* [ ] Realtime WS transcription works (when available)
* [ ] Fallback chunked posting works automatically
* [ ] Offline queue captures audio during outages
* [ ] Queued text flushes **first** after reconnect, then live resumes
* [ ] Chronological order preserved; no duplicated overlaps
* [ ] Timestamp badges seek the tab (when allowed)
* [ ] Exports: TXT, SRT, JSON are correct
* [ ] Mic and Pick Tab sources function
* [ ] No unhandled errors in UI; CORS configured on backend

---

## Appendix: Dev tips

* Enable **Debug** in Settings to see segment/queue logs.
* **Reset state** (fresh run): click **Clear** in the panel; or toggle the setting that controls auto-restore (by default, the panel starts fresh each load).

---
