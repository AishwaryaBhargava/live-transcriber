// ===== TwinMind sidepanel (Source: Tab / Pick a Tab / Microphone)
// WS-first with chunked fallback, auto-switch both ways, retry/backoff,
// overlapped segments, dedup, exports, settings,
// offline buffering with timeout + time-anchored segments + offline-first queue
// + chronological render buffer (orders offline + online lines)
// + fresh start on reload (autosave off by default) =====

import { dbInit, queueAdd, queueTake, queueRemove, queueCount } from '../lib/db.js';

// ----- Defaults & settings persistence -----
const LS_SETTINGS = 'twinmind_settings_v1';
const LS_TXT = 'twinmind_transcript_v1';

// 👉 fresh start after reload/update; set to true if you want autosave/restore
const AUTO_RESTORE = false;

const defaultSettings = {
  provider: 'Deepgram',
  preferWS: false, // try WS first; fallback to chunked if not ready in time
  segSec: 10, // chunk length (shorten to 6s for faster tests)
  overlapMs: 1200, // chunk overlap
  tsCadenceSec: 8, // timestamp badge every N seconds
  debug: false,
  source: 'tab', // 'tab' | 'pick' | 'mic'
};
const settings = Object.assign({}, defaultSettings, loadSettings());
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
  } catch {
    return {};
  }
}
function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
}

// ----- Wiring settings UI -----
const qs = (s) => document.querySelector(s);
const setProvider = qs('#set-provider');
const setWS = qs('#set-ws');
const setSeg = qs('#set-seg');
const setOvl = qs('#set-ovl');
const setTs = qs('#set-ts');
const chkDebug = qs('#chk-debug');

const setSourceTab = qs('#set-source-tab');
const setSourcePick = qs('#set-source-pick');
const setSourceMic = qs('#set-source-mic');

setProvider.value = settings.provider;
setWS.checked = settings.preferWS;
setSeg.value = settings.segSec;
setOvl.value = settings.overlapMs;
setTs.value = settings.tsCadenceSec;
chkDebug.checked = settings.debug;

if (settings.source === 'tab') setSourceTab.checked = true;
if (settings.source === 'pick') setSourcePick.checked = true;
if (settings.source === 'mic') setSourceMic.checked = true;

for (const [el, key, coerce] of [
  [setProvider, 'provider', String],
  [setWS, 'preferWS', (v) => !!v],
  [setSeg, 'segSec', (v) => Math.max(5, Math.min(60, Number(v) || 10))],
  [setOvl, 'overlapMs', (v) => Math.max(0, Math.min(3000, Number(v) || 1200))],
  [setTs, 'tsCadenceSec', (v) => Math.max(3, Math.min(20, Number(v) || 8))],
  [chkDebug, 'debug', (v) => !!v],
]) {
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
    settings[key] = coerce(el.type === 'checkbox' ? el.checked : el.value);
    saveSettings();
    if (key === 'debug') {
      document
        .querySelectorAll('.partial')
        .forEach((n) => (n.style.display = settings.debug ? '' : 'none'));
    }
  });
}

[setSourceTab, setSourcePick, setSourceMic].forEach((r) => {
  r.addEventListener('change', () => {
    if (setSourceTab.checked) settings.source = 'tab';
    if (setSourcePick.checked) settings.source = 'pick';
    if (setSourceMic.checked) settings.source = 'mic';
    saveSettings();
  });
});

// ----- Config -----
const BACKEND_URL = 'https://live-transcriber-0md8.onrender.com';

function wsUrl() {
  const u = new URL(BACKEND_URL);
  // upgrade http(s) -> ws(s)
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
  u.pathname = '/realtime';
  u.search = '?enc=webm';
  return u.toString();
}

const UPLOAD_TIMEOUT_MS = 3000; // detect Wi-Fi off quickly

// dedup tuning
const DEDUP_MAX_TAIL_WORDS = 30;
const DEDUP_MIN_MATCH_WORDS = 3;

// offline queue tuning
const QUEUE_MAX_ITEMS = 120;
const QUEUE_FLUSH_BATCH = 4;
let offlineQueueCount = 0;

// chronological render buffer tuning
const REORDER_SECS = 8; // hold live lines to allow earlier offline lines to catch up
const MAX_WAIT_MS = 7000;
const MAX_BUF = 200;

// ----- DOM refs -----
const elStatus = qs('#status');
const elConn = qs('#conn');
const elTimer = qs('#timer');
const elTranscript = qs('#transcript');

const btnStart = qs('#btn-start');
const btnPause = qs('#btn-pause');
const btnResume = qs('#btn-resume');
const btnStop = qs('#btn-stop');
const btnCopy = qs('#btn-copy');
const btnDownload = qs('#btn-download');
const btnExportSrt = qs('#btn-export-srt');
const btnExportJson = qs('#btn-export-json');
const btnClear = qs('#btn-clear');

// ----- Toasts -----
const toastEl = qs('#toast');
let toastT = null;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.className = ''), 1800);
}

// ----- Status helpers -----
let _connBase = 'Disconnected';
function setStatus(t) {
  elStatus.textContent = t;
}
function setConn(t) {
  _connBase = t;
  renderConn();
}
function renderConn() {
  const suffix = offlineQueueCount > 0 ? ` — queued ${offlineQueueCount}` : '';
  const net = navigator.onLine ? '' : ' (offline)';
  elConn.textContent = `${_connBase}${suffix}${net}`;
}
function setButtons({ start, pause, resume, stop, exportable, canClear }) {
  btnStart.disabled = !start;
  btnPause.disabled = !pause;
  btnResume.disabled = !resume;
  btnStop.disabled = !stop;
  btnCopy.disabled = !exportable;
  btnDownload.disabled = !exportable;
  btnExportSrt.disabled = !exportable;
  btnExportJson.disabled = !exportable;
  btnClear.disabled = !canClear;
}
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}
function currentSourceLabel() {
  return settings.source === 'mic' ? 'Mic' : settings.source === 'pick' ? 'Picked Tab' : 'Tab';
}

// ----- Transcript store (+ ordered insertion) -----
const entries = []; // always sorted by t ascending: {t, text}
let lastStamp = -Infinity;

// create + insert a line DOM at the correct chronological spot
function insertTranscriptLine(text, atSeconds) {
  if (!text || !text.trim()) return;
  const t = typeof atSeconds === 'number' ? atSeconds : elapsed;

  // figure out timestamp badge rules
  let stampThis = false;
  if (t < lastStamp) {
    stampThis = true; // backfill → force badge, don't move lastStamp
  } else if (!isFinite(lastStamp) || t - lastStamp >= settings.tsCadenceSec) {
    stampThis = true;
    lastStamp = t;
  }

  // make the DOM node
  const div = document.createElement('div');
  div.className = 'line';
  div.dataset.t = String(t);
  if (settings.debug) div.style.display = '';

  if (stampThis) {
    const b = document.createElement('button');
    b.className = 'ts';
    b.textContent = `[${formatTime(t)}]`;
    b.dataset.t = String(Math.floor(t));
    div.appendChild(b);
    div.appendChild(document.createTextNode(' '));
  }
  div.appendChild(document.createTextNode(text));

  // insert DOM in chronological order among .line nodes
  const lines = Array.from(elTranscript.querySelectorAll('.line'));
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    const lt = Number(lines[i].dataset.t || 0);
    if (t < lt) {
      elTranscript.insertBefore(div, lines[i]);
      inserted = true;
      break;
    }
  }
  if (!inserted) elTranscript.appendChild(div);
  elTranscript.scrollTop = elTranscript.scrollHeight;

  // insert into entries (kept sorted)
  let idx = entries.findIndex((e) => t < e.t);
  if (idx === -1) idx = entries.length;
  entries.splice(idx, 0, { t, text });
  persist();

  setButtons({
    start: false,
    pause: recording || wsMode,
    resume: !recording && !wsMode && stream,
    stop: !!stream,
    exportable: entries.length > 0,
    canClear: entries.length > 0,
  });
}

function dbg(msg) {
  if (!settings.debug) return;
  const d = document.createElement('div');
  d.className = 'partial';
  d.textContent = msg;
  d.style.display = '';
  elTranscript.appendChild(d);
  elTranscript.scrollTop = elTranscript.scrollHeight;
}

// click timestamp badge to seek
elTranscript.addEventListener('click', async (e) => {
  const b = e.target.closest('.ts');
  if (!b) return;
  const sec = Number(b.dataset.t);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => {
        const v = document.querySelector('video,audio');
        if (v) {
          v.currentTime = s;
          v.play?.();
        }
      },
      args: [sec],
    });
  } catch {
    toast('Seek failed: allow site access', 'warn');
  }
});

// timer
let tInt = null,
  elapsed = 0;
function startTimer() {
  stopTimer();
  elapsed = 0;
  elTimer.textContent = formatTime(elapsed);
  tInt = setInterval(() => {
    elapsed += 1;
    elTimer.textContent = formatTime(elapsed);
  }, 1000);
}
function stopTimer() {
  if (tInt) clearInterval(tInt);
  tInt = null;
}

// ----- Capture helpers (Tab / Picker / Mic) -----
function startTabCapture() {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      const err = chrome.runtime.lastError;
      if (err || !stream) {
        reject(new Error(err?.message || 'Failed to capture tab audio'));
        return;
      }
      resolve(stream);
    });
  });
}
async function startPickerCapture() {
  const ds = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
  const at = ds.getAudioTracks();
  if (!at.length) {
    ds.getVideoTracks().forEach((t) => t.stop());
    throw new Error('No audio. Pick “Chrome Tab” and tick “Share tab audio”.');
  }
  ds.getVideoTracks().forEach((t) => t.stop());
  return new MediaStream([at[0]]);
}
async function startMicCapture() {
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  const at = s.getAudioTracks();
  if (!at.length) {
    throw new Error('No microphone detected');
  }
  return new MediaStream([at[0]]);
}

async function getMediaTime() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const v = document.querySelector('video,audio');
        return v ? v.currentTime : null;
      },
    });
    return typeof res?.result === 'number' ? res.result : null;
  } catch {
    return null;
  }
}

// ----- Dedup (word-level) -----
let tailTokens = [];
const cleanTok = (w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').toLowerCase();
function mergeAndDedup(rawText) {
  const txt = (rawText || '').trim();
  if (!txt) return '';
  const newTokens = txt.split(/\s+/);
  const tailSlice = tailTokens.slice(-DEDUP_MAX_TAIL_WORDS);
  const tailClean = tailSlice.map(cleanTok).filter(Boolean);
  const newClean = newTokens.map(cleanTok).filter(Boolean);
  let overlap = 0;
  const maxK = Math.min(16, tailClean.length, newClean.length);
  for (let k = maxK; k >= 2; k--) {
    const a = tailClean.slice(tailClean.length - k).join(' ');
    const b = newClean.slice(0, k).join(' ');
    const chars = b.replace(/\s+/g, '').length;
    if (a === b && (k >= DEDUP_MIN_MATCH_WORDS || chars >= 12)) {
      overlap = k;
      break;
    }
  }
  if (overlap >= newTokens.length) return '';
  const outTokens = newTokens.slice(overlap);
  tailTokens = [...tailSlice, ...outTokens].slice(-DEDUP_MAX_TAIL_WORDS);
  return outTokens.join(' ');
}

// ----- Autosave / export -----
function persist() {
  try {
    localStorage.setItem(LS_TXT, JSON.stringify(entries));
  } catch {}
}
function restore() {
  try {
    const raw = localStorage.getItem(LS_TXT);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      elTranscript.textContent = '';
      entries.length = 0;
      lastStamp = -Infinity;
      tailTokens.length = 0;
      for (const e of arr) {
        insertTranscriptLine(e.text, e.t);
      }
    }
  } catch {}
}
function toTxt() {
  return entries.map((e) => `[${formatTime(Math.floor(e.t || 0))}] ${e.text}`).join('\n');
}
function toSrt() {
  const pad = (n, d = 2) => String(n).padStart(d, '0');
  const fmt = (sec) => {
    const ms = Math.max(0, Math.floor(sec * 1000));
    const h = Math.floor(ms / 3600000),
      m = Math.floor((ms % 3600000) / 60000),
      s = Math.floor((ms % 60000) / 1000),
      ms3 = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms3).padStart(3, '0')}`;
  };
  let out = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i],
      b = entries[i + 1];
    const start = a.t || 0;
    const end = b ? Math.max(start + 1, (b.t || start + 3) - 0.2) : start + 3;
    out.push(`${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${a.text}\n`);
  }
  return out.join('\n');
}
function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ====== Offline queue helpers ======
await dbInit().catch(() => {
  /* ignore */
});

async function refreshQueueCount() {
  try {
    offlineQueueCount = await queueCount();
  } catch {
    offlineQueueCount = 0;
  }
  renderConn();
}

async function enqueueChunk(blob, seq, t) {
  try {
    const cnt = await queueCount().catch(() => 0);
    if (cnt >= QUEUE_MAX_ITEMS) {
      const olds = await queueTake(Math.min(10, cnt));
      await queueRemove(olds.map((o) => o.id)).catch(() => {});
    }
    await queueAdd({ blob, mime: blob.type || 'audio/webm', seq, t });
    await refreshQueueCount();
    toast(`Offline: queued ${offlineQueueCount}`, 'warn');
    startFlushLoop();
  } catch {
    toast('Failed to queue chunk', 'err');
  }
}

async function flushQueueOnce() {
  if (!navigator.onLine) return false;
  const items = await queueTake(QUEUE_FLUSH_BATCH).catch(() => []);
  if (!items.length) return false;

  for (const it of items) {
    const fd = new FormData();
    fd.append('audio', it.blob, `queued-${it.seq}-${it.id}.webm`);
    fd.append('seq', String(it.seq));
    try {
      const data = await postWithRetry(fd);
      const raw = (data?.text || '').trim();
      if (raw) {
        const when = typeof it.t === 'number' ? it.t : ((await getMediaTime()) ?? elapsed);
        queueRender(raw, when); // <- render buffer
      }
      await queueRemove([it.id]);
    } catch {
      break;
    }
  }
  await refreshQueueCount();
  return true;
}

let flushTimer = null;
function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(async () => {
    try {
      if (!navigator.onLine) return;
      const had = await flushQueueOnce();
      if (!had) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
    } catch {}
  }, 5000);
}

// ---- Flush-first mode: drain queued chunks completely, then resume normal posting
let flushMode = false;
async function drainQueueFully() {
  if (!navigator.onLine) return;
  flushMode = true;
  try {
    while (await queueCount() > 0 && navigator.onLine) {
      const had = await flushQueueOnce();
      if (!had) break;
    }
  } finally {
    flushMode = false;
    await refreshQueueCount();
  }
}

window.addEventListener('online', () => {
  renderConn();
  if (offlineQueueCount > 0) toast('Back online — flushing queued chunks', 'ok');
  // Drain first so offline text appears before new online segments
  drainQueueFully().then(() => startFlushLoop()).catch(() => startFlushLoop());
});
window.addEventListener('offline', () => {
  renderConn();
  toast('You are offline. Chunks will be queued', 'warn');
});

// ===== fetch with timeout =====
async function fetchWithTimeout(url, options = {}, timeoutMs = UPLOAD_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// ===== Streaming (WS) path =====
let ws = null,
  wsMode = false,
  wsOpen = false;
let wsRecorder = null;
let wsProbeInterval = null;

function clearWsProbe() {
  if (wsProbeInterval) {
    clearInterval(wsProbeInterval);
    wsProbeInterval = null;
  }
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    try {
      ws = new WebSocket(wsUrl());
      ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error('WS connect timeout'));
      }, 1500);
      ws.onopen = () => {
        clearTimeout(to);
        wsOpen = true;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(to);
        reject(new Error('WS error'));
      };
      ws.onclose = () => {
        wsOpen = false;
        if (wsMode) onWsDropped();
      };
      ws.onmessage = (evt) => {
        if (typeof evt.data !== 'string') return;
        try {
          const msg = JSON.parse(evt.data);
          const alt = msg?.channel?.alternatives?.[0];
          const text = (alt?.transcript || '').trim();
          const isFinal = msg?.is_final === true || msg?.type === 'UtteranceEnd';
          if (text && isFinal) {
            const secP = getMediaTime().catch(() => null);
            Promise.resolve(secP).then((s) => {
              queueRender(text, s ?? elapsed); // <- render buffer
            });
          }
        } catch {}
      };
    } catch (e) {
      reject(e);
    }
  });
}

function wsStartSending(stream) {
  try {
    wsRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 160000,
    });
  } catch {
    wsRecorder = new MediaRecorder(stream, {});
  }
  wsRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0 && ws && wsOpen) {
      e.data.arrayBuffer().then((buf) => {
        try {
          ws.send(buf);
        } catch {}
      });
    }
  };
  wsRecorder.start(300); // ~300ms frames
}

function wsStop() {
  try {
    wsRecorder && wsRecorder.state !== 'inactive' && wsRecorder.stop();
  } catch {}
  wsRecorder = null;
  try {
    ws && ws.readyState === WebSocket.OPEN && ws.close();
  } catch {}
  ws = null;
  wsOpen = false;
  wsMode = false;
}

function onWsDropped() {
  wsMode = false;
  try {
    wsRecorder && wsRecorder.state !== 'inactive' && wsRecorder.stop();
  } catch {}
  wsRecorder = null;
  if (stream) {
    if (!recording) {
      recording = true;
      setConn('WS dropped → fallback');
      setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
      startRecorder();
      setButtons({
        start: false,
        pause: true,
        resume: false,
        stop: true,
        exportable: entries.length > 0,
        canClear: true,
      });
      toast('WebSocket dropped — using fallback', 'warn');
    }
    if (settings.preferWS) startWsProbe();
  }
}

function startWsProbe() {
  clearWsProbe();
  wsProbeInterval = setInterval(async () => {
    if (!settings.preferWS) {
      clearWsProbe();
      return;
    }
    if (wsMode || !stream) return;

    // If we still have backlog, delay switching to WS so offline text renders first.
    try {
      if (await queueCount() > 0) return;
    } catch {}

    try {
      await wsConnect();
      wsMode = true;
      setConn('Reconnected (WS)');
      setStatus(`Streaming (${settings.provider}) — ${currentSourceLabel()}`);
      wsStartSending(stream);
      if (recording) {
        recording = false;
        abortAll();
      }
      setButtons({
        start: false,
        pause: true,
        resume: false,
        stop: true,
        exportable: entries.length > 0,
        canClear: true,
      });
      toast('Switched back to WebSocket streaming', 'ok');
      clearWsProbe();
    } catch {
      /* keep probing */
    }
  }, 12000);
}

// ===== Chunked fallback path (overlapped segments + retry/backoff + offline-first + time-anchor) =====
const ACTIVE = new Set();
let segIndex = 0,
  allowOverlap = true;

function makeRecOpts() {
  const list = [
    { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160000 },
    { mimeType: 'audio/webm', audioBitsPerSecond: 160000 },
    { audioBitsPerSecond: 160000 },
  ];
  return (
    list.find((o) => {
      try {
        return o.mimeType ? MediaRecorder.isTypeSupported(o.mimeType) : true;
      } catch {
        return false;
      }
    }) || {}
  );
}
function stopRecorder(R) {
  if (!R) return;
  try {
    if (R.mr && R.mr.state !== 'inactive') R.mr.stop();
  } catch {}
  if (R.stopT) {
    clearTimeout(R.stopT);
    R.stopT = null;
  }
  if (R.spawnT) {
    clearTimeout(R.spawnT);
    R.spawnT = null;
  }
}
function abortAll() {
  for (const R of Array.from(ACTIVE)) stopRecorder(R);
  ACTIVE.clear();
}

async function postWithRetry(formData, tries = 2, delay = 300) {
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetchWithTimeout(
        `${BACKEND_URL}/transcribe`,
        { method: 'POST', body: formData },
        UPLOAD_TIMEOUT_MS
      );
      if (resp.ok) return await resp.json();
      if (resp.status < 500) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay * Math.pow(3, i))); // 300, 900
    }
  }
}

function startRecorder() {
  if (!recording || !stream) return;

  if (!allowOverlap) {
    for (const R of Array.from(ACTIVE)) stopRecorder(R);
  }

  // Create a segment record + time anchor (when it STARTS)
  const R = { idx: ++segIndex, chunks: [], mr: null, stopT: null, spawnT: null, t: null };
  getMediaTime()
    .then((s) => {
      R.t = typeof s === 'number' ? s : elapsed;
    })
    .catch(() => {
      R.t = elapsed;
    });

  const opts = makeRecOpts();
  try {
    R.mr = new MediaRecorder(stream, opts);
  } catch (e) {
    if (allowOverlap) {
      allowOverlap = false;
      dbg('⚠️ overlap not supported; switching to no-overlap');
      abortAll();
      if (recording) startRecorder();
      return;
    } else {
      setStatus(`MediaRecorder error: ${e.message}`);
      return;
    }
  }

  R.mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) R.chunks.push(e.data);
  };
  R.mr.onerror = (e) => setStatus(`Recorder error: ${e.error?.name || e.name}`);
  R.mr.onstop = async () => {
    ACTIVE.delete(R);
    const blob = R.chunks.length
      ? new Blob(R.chunks, { type: R.chunks[0]?.type || 'audio/webm' })
      : null;
    R.chunks = [];
    if (blob) {
      // flush-first: while offline or while we still have backlog or during draining, enqueue
      if (!navigator.onLine || flushMode || offlineQueueCount > 0) {
        dbg('📥 enqueue (offline or flushing/backlog present)');
        await enqueueChunk(blob, R.idx, typeof R.t === 'number' ? R.t : null);
        if (navigator.onLine) startFlushLoop();
      } else {
        const fd = new FormData();
        fd.append('audio', blob, `seg-${R.idx}-${Date.now()}.webm`);
        fd.append('seq', String(R.idx));
        try {
          dbg(`[${formatTime(elapsed)}] ⬆️ posting seg #${R.idx}`);
          const data = await postWithRetry(fd);
          const raw = (data?.text || '').trim();
          if (raw) {
            const when = typeof R.t === 'number' ? R.t : ((await getMediaTime()) ?? elapsed);
            queueRender(raw, when); // <- render buffer
          } else {
            dbg('…all overlap (deduped)');
          }
        } catch {
          dbg('❌ upload failed; queued');
          await enqueueChunk(blob, R.idx, typeof R.t === 'number' ? R.t : null);
          startFlushLoop();
        }
      }
    }
    if (recording && !allowOverlap) {
      startRecorder();
    }
  };

  R.mr.start();
  ACTIVE.add(R);
  dbg(`[${formatTime(elapsed)}] 🎬 segment #${R.idx} started`);
  R.stopT = setTimeout(() => stopRecorder(R), settings.segSec * 1000);
  if (allowOverlap) {
    R.spawnT = setTimeout(
      () => {
        if (recording) startRecorder();
      },
      Math.max(0, settings.segSec * 1000 - settings.overlapMs)
    );
  }
}

// ----- Session state -----
let stream = null;
let recording = false;

function resetSessionKeepTranscript() {
  lastStamp = -Infinity;
  tailTokens.length = 0;
  segIndex = 0;
  allowOverlap = true;
}

// ---------- Render buffer (orders lines by time, then dedups at render) ----------
let renderBuf = []; // [{t, text, at}]
let renderTimer = null;
let maxTSeen = -Infinity;

function queueRender(rawText, t) {
  const text = (rawText || '').trim();
  if (!text) return;
  const when = typeof t === 'number' ? t : elapsed;
  maxTSeen = Math.max(maxTSeen, when);
  renderBuf.push({ t: when, text, at: performance.now() });
  if (renderBuf.length > MAX_BUF) {
    // emergency flush oldest by arrival
    renderBuf.sort((a, b) => a.at - b.at);
    const drop = renderBuf.shift();
    const merged = mergeAndDedup(drop.text);
    if (merged) insertTranscriptLine(merged, drop.t);
  }
  ensureRenderTimer();
}
function ensureRenderTimer() {
  if (!renderTimer) renderTimer = setInterval(flushRenderable, 700);
}
function stopRenderTimer() {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
}
function flushRenderable() {
  if (renderBuf.length === 0) {
    stopRenderTimer();
    return;
  }
  // Stable sort by time, then by arrival
  renderBuf.sort((a, b) => (a.t === b.t ? a.at - b.at : a.t - b.t));

  const out = [];
  const now = performance.now();
  const horizon = maxTSeen - REORDER_SECS;
  const remain = [];
  for (const item of renderBuf) {
    if (item.t <= horizon || now - item.at > MAX_WAIT_MS) out.push(item);
    else remain.push(item);
  }
  renderBuf = remain;

  for (const it of out) {
    const merged = mergeAndDedup(it.text);
    if (merged) insertTranscriptLine(merged, it.t);
  }
  if (renderBuf.length === 0) stopRenderTimer();
}

// ----- Autosave restore on load -----
setConn('Disconnected');
setStatus('Idle');
setButtons({
  start: true,
  pause: false,
  resume: false,
  stop: false,
  exportable: entries.length > 0,
  canClear: entries.length > 0,
});

if (AUTO_RESTORE) {
  restore();
} else {
  // fresh start: ensure previous autosave is cleared
  try {
    localStorage.removeItem(LS_TXT);
  } catch {}
}

document
  .querySelectorAll('.partial')
  .forEach((n) => (n.style.display = settings.debug ? '' : 'none'));
refreshQueueCount().then(() => {
  if (offlineQueueCount > 0) startFlushLoop();
});

// ----- UI actions -----
btnStart.addEventListener('click', async () => {
  try {
    setStatus('Starting…');
    setButtons({
      start: false,
      pause: false,
      resume: false,
      stop: false,
      exportable: entries.length > 0,
      canClear: entries.length > 0,
    });
    resetSessionKeepTranscript();
    clearWsProbe();

    try {
      if (settings.source === 'tab') {
        try {
          stream = await startTabCapture();
        } catch {
          setStatus('Picker: choose this tab & tick “Share tab audio”');
          stream = await startPickerCapture();
        }
      } else if (settings.source === 'pick') {
        stream = await startPickerCapture();
      } else {
        stream = await startMicCapture();
      }
    } catch (e) {
      setStatus(`Capture error: ${e.message}`);
      setButtons({
        start: true,
        pause: false,
        resume: false,
        stop: false,
        exportable: entries.length > 0,
        canClear: entries.length > 0,
      });
      return;
    }

    startTimer();
    setButtons({
      start: false,
      pause: true,
      resume: false,
      stop: true,
      exportable: entries.length > 0,
      canClear: true,
    });

    if (settings.preferWS) {
      setConn('Connecting (WS)…');
      try {
        await wsConnect();
        wsMode = true;
        setConn('Connected (WS)');
        setStatus(`Streaming (${settings.provider}) — ${currentSourceLabel()}`);
        wsStartSending(stream);
        toast(`Streaming ${currentSourceLabel()}`, 'ok');
        return;
      } catch {
        setConn('WS unavailable → fallback');
        toast('WS not ready, using fallback', 'warn');
        startWsProbe();
      }
    }

    recording = true;
    setConn('Connected');
    setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
    startRecorder();
    if (offlineQueueCount > 0) startFlushLoop();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    setButtons({
      start: true,
      pause: false,
      resume: false,
      stop: false,
      exportable: entries.length > 0,
      canClear: entries.length > 0,
    });
  }
});

btnPause.addEventListener('click', () => {
  if (wsMode) {
    try {
      wsRecorder?.stop();
    } catch {}
    setStatus('Paused (WS)');
  } else {
    if (!recording) return;
    recording = false;
    abortAll();
    setStatus('Paused');
  }
  setButtons({
    start: false,
    pause: false,
    resume: true,
    stop: true,
    exportable: entries.length > 0,
    canClear: true,
  });
});
btnResume.addEventListener('click', () => {
  if (wsMode) {
    wsStartSending(stream);
    setStatus(`Streaming (${settings.provider}) — ${currentSourceLabel()}`);
  } else {
    if (recording) return;
    recording = true;
    startRecorder();
    setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
  }
  setButtons({
    start: false,
    pause: true,
    resume: false,
    stop: true,
    exportable: entries.length > 0,
    canClear: true,
  });
});
btnStop.addEventListener('click', () => {
  clearWsProbe();
  if (wsMode) wsStop();
  recording = false;
  abortAll();
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch {}
  stream = null;
  stopTimer();
  setStatus('Stopped');
  setConn('Disconnected');
  toast('Stopped', 'ok');
  setButtons({
    start: true,
    pause: false,
    resume: false,
    stop: false,
    exportable: entries.length > 0,
    canClear: entries.length > 0,
  });
});

btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(toTxt());
    toast('Copied', 'ok');
  } catch {
    toast('Copy failed', 'err');
  }
});
btnDownload.addEventListener('click', () => download(`transcript-${Date.now()}.txt`, toTxt()));
btnExportSrt.addEventListener('click', () =>
  download(`transcript-${Date.now()}.srt`, toSrt(), 'text/srt')
);
btnExportJson.addEventListener('click', () =>
  download(`transcript-${Date.now()}.json`, JSON.stringify(entries, null, 2), 'application/json')
);
btnClear.addEventListener('click', () => {
  elTranscript.textContent = '';
  entries.length = 0;
  lastStamp = -Infinity;
  tailTokens.length = 0;
  persist();
  setButtons({
    start: true,
    pause: false,
    resume: false,
    stop: !!stream,
    exportable: false,
    canClear: false,
  });
});
