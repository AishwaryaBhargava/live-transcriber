// ===== Live Transcriber sidepanel (fallback recorder + offline queue + flush-first) =====
import { dbInit, queueAdd, queueTake, queueRemove, queueCount } from '../lib/db.js';

/* --------------------------- Settings / constants --------------------------- */
const LS_SETTINGS = 'twinmind_settings_v1';
const LS_TXT = 'twinmind_transcript_v1';

// Fresh start after reload/update
const AUTO_RESTORE = false;

// Default settings
const defaultSettings = {
  provider: 'Deepgram',
  preferWS: false,            // we keep WS code but default to fallback-only
  segSec: 10,
  overlapMs: 1200,
  tsCadenceSec: 8,
  debug: true,                // force ON so you always see posting/enqueue lines
  source: 'tab',              // 'tab' | 'pick' | 'mic'
};
const settings = Object.assign({}, defaultSettings, safeLoad(LS_SETTINGS, {}));

// Backend
const BACKEND_URL = 'https://live-transcriber-0md8.onrender.com';
const UPLOAD_TIMEOUT_MS = 15000;

// Dedup
const DEDUP_MAX_TAIL_WORDS = 30;
const DEDUP_MIN_MATCH_WORDS = 3;

// Queue
const QUEUE_MAX_ITEMS = 200;
const QUEUE_FLUSH_BATCH = 5;

/* ----------------------------- UI references ------------------------------- */
const qs = (s) => document.querySelector(s);

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

const setProvider = qs('#set-provider');
const setWS       = qs('#set-ws');
const setSeg      = qs('#set-seg');
const setOvl      = qs('#set-ovl');
const setTs       = qs('#set-ts');
const chkDebug    = qs('#chk-debug');

const setSourceTab  = qs('#set-source-tab');
const setSourcePick = qs('#set-source-pick');
const setSourceMic  = qs('#set-source-mic');

const toastEl = qs('#toast');

/* ------------------------------ Small helpers ------------------------------ */
function safeLoad(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }

let toastT = null;
function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.className = ''), 1800);
}
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}
function nowPerf() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

/* ------------------------------- Status/Conn -------------------------------- */
let offlineQueueCount = 0;
let _connBase = 'Disconnected';
function setStatus(t) { elStatus.textContent = t; }
function setConn(t) { _connBase = t; renderConn(); }
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

/* --------------------------------- Timer ----------------------------------- */
let tInt = null, elapsed = 0;
function startTimer() {
  stopTimer();
  elapsed = 0;
  elTimer.textContent = formatTime(elapsed);
  tInt = setInterval(() => { elapsed += 1; elTimer.textContent = formatTime(elapsed); }, 1000);
}
function stopTimer() { if (tInt) clearInterval(tInt); tInt = null; }

/* ------------------------------ Capture helpers ---------------------------- */
async function startTabCapture() {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      const err = chrome.runtime.lastError;
      if (err || !stream) { reject(new Error(err?.message || 'Failed to capture tab audio')); return; }
      resolve(stream);
    });
  });
}
async function startPickerCapture() {
  const ds = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
  const at = ds.getAudioTracks();
  if (!at.length) { ds.getVideoTracks().forEach((t) => t.stop()); throw new Error('No audio. Pick “Chrome Tab” and tick “Share tab audio”.'); }
  ds.getVideoTracks().forEach((t) => t.stop());
  return new MediaStream([at[0]]);
}
async function startMicCapture() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  const at = s.getAudioTracks();
  if (!at.length) throw new Error('No microphone detected');
  return new MediaStream([at[0]]);
}
async function getMediaTime() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { const v = document.querySelector('video,audio'); return v ? v.currentTime : null; },
    });
    return typeof res?.result === 'number' ? res.result : null;
  } catch { return null; }
}
function currentSourceLabel() {
  return settings.source === 'mic' ? 'Mic' : settings.source === 'pick' ? 'Picked Tab' : 'Tab';
}

/* ------------------------------- Transcript -------------------------------- */
const entries = []; // sorted {t, text}
let lastStamp = -Infinity;

// Always-visible logger lines (not hidden behind debug)
function logLine(txt) {
  const d = document.createElement('div');
  d.className = 'partial';
  d.textContent = txt;
  elTranscript.appendChild(d);
  elTranscript.scrollTop = elTranscript.scrollHeight;
}

let tailTokens = [];
const cleanTok = (w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').toLowerCase();
function mergeAndDedup(rawText) {
  const txt = (rawText || '').trim(); if (!txt) return '';
  const newTokens = txt.split(/\s+/);
  const tailSlice = tailTokens.slice(-DEDUP_MAX_TAIL_WORDS);
  const tailClean = tailSlice.map(cleanTok).filter(Boolean);
  const newClean  = newTokens.map(cleanTok).filter(Boolean);
  let overlap = 0;
  const maxK = Math.min(16, tailClean.length, newClean.length);
  for (let k = maxK; k >= 2; k--) {
    const a = tailClean.slice(tailClean.length - k).join(' ');
    const b = newClean.slice(0, k).join(' ');
    const chars = b.replace(/\s+/g, '').length;
    if (a === b && (k >= DEDUP_MIN_MATCH_WORDS || chars >= 12)) { overlap = k; break; }
  }
  if (overlap >= newTokens.length) return '';
  const outTokens = newTokens.slice(overlap);
  tailTokens = [...tailSlice, ...outTokens].slice(-DEDUP_MAX_TAIL_WORDS);
  return outTokens.join(' ');
}

function insertTranscriptLine(text, atSeconds) {
  if (!text || !text.trim()) return;
  const t = typeof atSeconds === 'number' ? atSeconds : elapsed;

  let stampThis = false;
  if (t < lastStamp) stampThis = true;
  else if (!isFinite(lastStamp) || t - lastStamp >= settings.tsCadenceSec) { stampThis = true; lastStamp = t; }

  const div = document.createElement('div');
  div.className = 'line';
  div.dataset.t = String(t);

  if (stampThis) {
    const b = document.createElement('button');
    b.className = 'ts';
    b.textContent = `[${formatTime(t)}]`;
    b.dataset.t = String(Math.floor(t));
    div.appendChild(b);
    div.appendChild(document.createTextNode(' '));
  }
  div.appendChild(document.createTextNode(text));

  const lines = Array.from(elTranscript.querySelectorAll('.line'));
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    const lt = Number(lines[i].dataset.t || 0);
    if (t < lt) { elTranscript.insertBefore(div, lines[i]); inserted = true; break; }
  }
  if (!inserted) elTranscript.appendChild(div);
  elTranscript.scrollTop = elTranscript.scrollHeight;

  let idx = entries.findIndex((e) => t < e.t);
  if (idx === -1) idx = entries.length;
  entries.splice(idx, 0, { t, text });
  persist();
}

elTranscript.addEventListener('click', async (e) => {
  const b = e.target.closest('.ts'); if (!b) return;
  const sec = Number(b.dataset.t);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => { const v = document.querySelector('video,audio'); if (v) { v.currentTime = s; v.play?.(); } },
      args: [sec],
    });
  } catch { toast('Seek failed: allow site access', 'warn'); }
});

function persist() { try { localStorage.setItem(LS_TXT, JSON.stringify(entries)); } catch {} }
function restore() {
  try {
    const raw = localStorage.getItem(LS_TXT); if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      elTranscript.textContent = ''; entries.length = 0; lastStamp = -Infinity; tailTokens.length = 0;
      for (const e of arr) insertTranscriptLine(e.text, e.t);
    }
  } catch {}
}
function toTxt() { return entries.map((e) => `[${formatTime(Math.floor(e.t || 0))}] ${e.text}`).join('\n'); }
function toSrt() {
  const pad = (n, d = 2) => String(n).padStart(d, '0');
  const fmt = (sec) => {
    const ms = Math.max(0, Math.floor(sec * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), ms3 = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms3).padStart(3, '0')}`;
  };
  let out = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i], b = entries[i + 1];
    const start = a.t || 0;
    const end = b ? Math.max(start + 1, (b.t || start + 3) - 0.2) : start + 3;
    out.push(`${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${a.text}\n`);
  }
  return out.join('\n');
}
function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------- Offline queue ------------------------------ */
await dbInit().catch(() => {});

async function refreshQueueCount() {
  try { offlineQueueCount = await queueCount(); } catch { offlineQueueCount = 0; }
  renderConn();
}

async function queueAddSafe(obj, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try { return await queueAdd(obj); }
    catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 120)); }
  }
}

async function enqueueChunk(blob, seq, t) {
  try {
    const cnt = await queueCount().catch(() => 0);
    if (cnt >= QUEUE_MAX_ITEMS) {
      const olds = await queueTake(Math.min(20, cnt));
      await queueRemove(olds.map((o) => o.id)).catch(() => {});
    }
    await queueAddSafe({ blob, mime: blob.type || 'audio/webm', seq, t });
    await refreshQueueCount();
    logLine('📥 enqueue (offline or backlog present)');
    startFlushLoop();
  } catch {
    toast('Failed to queue chunk', 'err');
    logLine('❌ failed to queue chunk');
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPLOAD_TIMEOUT_MS) {
  const ctrl = new AbortController(); const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

async function postWithRetry(formData, tries = 2, delay = 300) {
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetchWithTimeout(`${BACKEND_URL}/transcribe`, { method: 'POST', body: formData }, UPLOAD_TIMEOUT_MS);
      if (resp.ok) return await resp.json();
      if (resp.status < 500) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay * Math.pow(3, i)));
    }
  }
}

/* Flush loop */
let flushTimer = null;
async function flushQueueOnce() {
  if (!navigator.onLine) return false;
  const items = await queueTake(QUEUE_FLUSH_BATCH).catch(() => []); if (!items.length) return false;

  for (const it of items) {
    const fd = new FormData();
    fd.append('audio', it.blob, `queued-${it.seq}-${it.id}.webm`);
    fd.append('seq', String(it.seq));
    try {
      logLine(`⬆️ posting queued #${it.seq}`);
      const data = await postWithRetry(fd);
      const raw = (data?.text || '').trim();
      if (raw) {
        const when = typeof it.t === 'number' ? it.t : ((await getMediaTime()) ?? elapsed);
        queueRender(raw, when);
      }
      await queueRemove([it.id]);
    } catch {
      // put it back by doing nothing (we didn't remove it).
      break;
    }
  }
  await refreshQueueCount();
  return true;
}
function startFlushLoop() {
  if (flushTimer) return;
  (async () => { try { await flushQueueOnce(); } catch {} })();
  flushTimer = setInterval(async () => {
    try {
      const had = await flushQueueOnce();
      if (!had) { clearInterval(flushTimer); flushTimer = null; }
    } catch {}
  }, 2500);
}
async function drainQueueFully() {
  if (!navigator.onLine) return;
  try {
    while (await queueCount() > 0 && navigator.onLine) {
      const had = await flushQueueOnce();
      if (!had) break;
    }
  } finally {
    await refreshQueueCount();
  }
}
window.addEventListener('online', () => { renderConn(); if (offlineQueueCount > 0) toast('Back online — flushing queued chunks', 'ok'); drainQueueFully().then(startFlushLoop).catch(startFlushLoop); });
window.addEventListener('offline', () => { renderConn(); toast('You are offline. Chunks will be queued', 'warn'); });

/* ----------------------------- Recording engine ----------------------------- */
let stream = null;
let recording = false;

const ACTIVE = new Set();
let segIndex = 0, allowOverlap = true;

function makeRecOpts() {
  const list = [
    { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160000 },
    { mimeType: 'audio/webm',             audioBitsPerSecond: 160000 },
    { audioBitsPerSecond: 160000 },
  ];
  return list.find(o => { try { return o.mimeType ? MediaRecorder.isTypeSupported(o.mimeType) : true; } catch { return false; } }) || {};
}
function stopRecorder(R) {
  if (!R) return;
  try { if (R.mr && R.mr.state !== 'inactive') R.mr.stop(); } catch {}
  if (R.stopT)  { clearTimeout(R.stopT);  R.stopT  = null; }
  if (R.spawnT) { clearTimeout(R.spawnT); R.spawnT = null; }
}
function abortAll() { for (const R of Array.from(ACTIVE)) stopRecorder(R); ACTIVE.clear(); }

function startRecorder() {
  if (!recording || !stream) return;

  if (!allowOverlap) for (const R of Array.from(ACTIVE)) stopRecorder(R);

  const R = { idx: ++segIndex, chunks: [], mr: null, stopT: null, spawnT: null, t: null };
  getMediaTime().then((s) => { R.t = typeof s === 'number' ? s : elapsed; }).catch(() => { R.t = elapsed; });

  const opts = makeRecOpts();
  try { R.mr = new MediaRecorder(stream, opts); }
  catch (e) {
    if (allowOverlap) { allowOverlap = false; logLine('⚠️ overlap not supported; switching to no-overlap'); abortAll(); if (recording) startRecorder(); return; }
    setStatus(`MediaRecorder error: ${e.message}`); return;
  }

  R.mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) R.chunks.push(e.data); };
  R.mr.onerror = (e) => setStatus(`Recorder error: ${e.error?.name || e.name}`);
  R.mr.onstop = async () => {
    ACTIVE.delete(R);
    const blob = R.chunks.length ? new Blob(R.chunks, { type: R.chunks[0]?.type || 'audio/webm' }) : null;
    R.chunks = [];
    if (blob) {
      // If offline OR backlog exists, enqueue. Otherwise post directly.
      const haveBacklog = (await queueCount().catch(() => 0)) > 0;
      if (!navigator.onLine || haveBacklog) {
        await enqueueChunk(blob, R.idx, typeof R.t === 'number' ? R.t : null);
        if (navigator.onLine) startFlushLoop();
      } else {
        const fd = new FormData();
        fd.append('audio', blob, `seg-${R.idx}-${Date.now()}.webm`);
        fd.append('seq', String(R.idx));
        try {
          logLine(`⬆️ posting seg #${R.idx}`);
          const data = await postWithRetry(fd);
          const raw = (data?.text || '').trim();
          if (raw) {
            const when = typeof R.t === 'number' ? R.t : ((await getMediaTime()) ?? elapsed);
            queueRender(raw, when);
          } else {
            logLine('…all overlap (deduped)');
          }
        } catch {
          logLine('❌ upload failed; queued');
          await enqueueChunk(blob, R.idx, typeof R.t === 'number' ? R.t : null);
          startFlushLoop();
        }
      }
    }
    if (recording && !allowOverlap) startRecorder();
  };

  R.mr.start();
  ACTIVE.add(R);
  logLine(`[${formatTime(elapsed)}] 🎬 segment #${R.idx} started`);
  R.stopT  = setTimeout(() => stopRecorder(R), settings.segSec * 1000);
  if (allowOverlap) {
    R.spawnT = setTimeout(() => { if (recording) startRecorder(); }, Math.max(0, settings.segSec * 1000 - settings.overlapMs));
  }
}

/* ------------------------ Render buffer & ordering -------------------------- */
let renderBuf = []; // [{t, text, at}]
let renderTimer = null;
let maxTSeen = -Infinity;
const REORDER_SECS = 8;
const MAX_WAIT_MS  = 7000;
const MAX_BUF      = 200;

function queueRender(rawText, t) {
  const text = (rawText || '').trim(); if (!text) return;
  const when = typeof t === 'number' ? t : elapsed;
  maxTSeen = Math.max(maxTSeen, when);
  renderBuf.push({ t: when, text, at: nowPerf() });
  if (renderBuf.length > MAX_BUF) {
    renderBuf.sort((a, b) => a.at - b.at);
    const drop = renderBuf.shift();
    const merged = mergeAndDedup(drop.text);
    if (merged) insertTranscriptLine(merged, drop.t);
  }
  ensureRenderTimer();
}
function ensureRenderTimer() { if (!renderTimer) renderTimer = setInterval(flushRenderable, 700); }
function stopRenderTimer() { if (renderTimer) { clearInterval(renderTimer); renderTimer = null; } }
function flushRenderable() {
  if (renderBuf.length === 0) { stopRenderTimer(); return; }
  renderBuf.sort((a, b) => (a.t === b.t ? a.at - b.at : a.t - b.t));

  const out = [];
  const now = nowPerf();
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

/* --------------------------- Fresh start / clearing ------------------------- */
function clearTranscriptStateAndUI() {
  stopRenderTimer();
  elTranscript.textContent = '';
  entries.length = 0; lastStamp = -Infinity; tailTokens.length = 0;
  renderBuf = []; maxTSeen = -Infinity;
  persist();
  setButtons({ start: true, pause: false, resume: false, stop: !!stream, exportable: false, canClear: false });
}
async function clearQueuedBacklog() {
  try {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    let remaining = await queueCount().catch(() => 0);
    while (remaining > 0) {
      const batch = await queueTake(Math.min(50, remaining)).catch(() => []);
      if (!batch.length) break;
      await queueRemove(batch.map(b => b.id)).catch(() => {});
      remaining -= batch.length;
    }
  } catch {}
  offlineQueueCount = 0; renderConn();
}
async function startFresh() {
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
  stream = null; recording = false;
  abortAll(); stopTimer();
  clearTranscriptStateAndUI();
  await clearQueuedBacklog();
  try { localStorage.removeItem(LS_TXT); } catch {}
}

/* --------------------------- Wire settings controls ------------------------- */
setProvider.value = settings.provider;
setWS.checked     = settings.preferWS;
setSeg.value      = settings.segSec;
setOvl.value      = settings.overlapMs;
setTs.value       = settings.tsCadenceSec;
chkDebug.checked  = settings.debug;

if (settings.source === 'tab')  setSourceTab.checked = true;
if (settings.source === 'pick') setSourcePick.checked = true;
if (settings.source === 'mic')  setSourceMic.checked = true;

for (const [el, key, coerce] of [
  [setProvider, 'provider', String],
  [setWS,       'preferWS', (v) => !!v],
  [setSeg,      'segSec',   (v) => Math.max(5, Math.min(60, Number(v) || 10))],
  [setOvl,      'overlapMs',(v) => Math.max(0, Math.min(3000, Number(v) || 1200))],
  [setTs,       'tsCadenceSec', (v) => Math.max(3, Math.min(20, Number(v) || 8))],
  [chkDebug,    'debug',    (v) => !!v],
]) {
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
    settings[key] = coerce(el.type === 'checkbox' ? el.checked : el.value);
    saveSettings();
  });
}
[setSourceTab, setSourcePick, setSourceMic].forEach((r) => {
  r.addEventListener('change', () => {
    if (setSourceTab.checked)  settings.source = 'tab';
    if (setSourcePick.checked) settings.source = 'pick';
    if (setSourceMic.checked)  settings.source = 'mic';
    saveSettings();
  });
});

/* --------------------------------- Init UI --------------------------------- */
setConn('Disconnected'); setStatus('Idle');
setButtons({ start: true, pause: false, resume: false, stop: false, exportable: entries.length > 0, canClear: entries.length > 0 });
if (AUTO_RESTORE) restore(); else try { localStorage.removeItem(LS_TXT); } catch {}
refreshQueueCount().then(() => { if (offlineQueueCount > 0) startFlushLoop(); });

/* --------------------------------- Actions --------------------------------- */
btnStart.addEventListener('click', async () => {
  try {
    setStatus('Starting…');
    setButtons({ start: false, pause: false, resume: false, stop: false, exportable: entries.length > 0, canClear: entries.length > 0 });

    await startFresh();   // wipe transcript + queue + timers

    try {
      if (settings.source === 'tab') {
        try { stream = await startTabCapture(); }
        catch { setStatus('Picker: choose this tab & tick “Share tab audio”'); stream = await startPickerCapture(); }
      } else if (settings.source === 'pick') { stream = await startPickerCapture(); }
      else { stream = await startMicCapture(); }
    } catch (e) {
      setStatus(`Capture error: ${e.message}`);
      setButtons({ start: true, pause: false, resume: false, stop: false, exportable: entries.length > 0, canClear: entries.length > 0 });
      return;
    }

    startTimer();
    setConn('Connected');
    setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
    recording = true;
    setButtons({ start: false, pause: true, resume: false, stop: true, exportable: entries.length > 0, canClear: true });
    startRecorder();
    if (offlineQueueCount > 0) startFlushLoop();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    setButtons({ start: true, pause: false, resume: false, stop: false, exportable: entries.length > 0, canClear: entries.length > 0 });
  }
});

btnPause.addEventListener('click', () => {
  if (!recording) return;
  recording = false; abortAll(); setStatus('Paused');
  setButtons({ start: false, pause: false, resume: true, stop: true, exportable: entries.length > 0, canClear: true });
});
btnResume.addEventListener('click', () => {
  if (recording) return;
  recording = true; startRecorder(); setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
  setButtons({ start: false, pause: true, resume: false, stop: true, exportable: entries.length > 0, canClear: true });
});
btnStop.addEventListener('click', () => {
  recording = false; abortAll();
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
  stream = null; stopTimer();
  setStatus('Stopped'); setConn('Disconnected'); toast('Stopped', 'ok');
  setButtons({ start: true, pause: false, resume: false, stop: false, exportable: entries.length > 0, canClear: entries.length > 0 });
});

btnCopy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(toTxt()); toast('Copied', 'ok'); } catch { toast('Copy failed', 'err'); } });
btnDownload.addEventListener('click', () => download(`transcript-${Date.now()}.txt`, toTxt()));
btnExportSrt.addEventListener('click', () => download(`transcript-${Date.now()}.srt`, toSrt(), 'text/srt'));
btnExportJson.addEventListener('click', () => download(`transcript-${Date.now()}.json`, JSON.stringify(entries, null, 2), 'application/json'));
btnClear.addEventListener('click', () => {
  elTranscript.textContent = ''; entries.length = 0; lastStamp = -Infinity; tailTokens.length = 0; persist();
  setButtons({ start: true, pause: false, resume: false, stop: !!stream, exportable: false, canClear: false });
});
