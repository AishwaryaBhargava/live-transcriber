// ===== Live Transcriber sidepanel (Tab / Pick a Tab / Mic) =====
// WS-first with chunked fallback, overlap, dedup, exports, settings.
// Robust offline queuing (works even when Wi-Fi toggle doesn't fire events):
//  - fast /health probes to infer connectivity
//  - queue trimmed on quota + retry
//  - fresh queue per session (cleared on each Start)
//  - drain queued chunks first on reconnection, then resume live posting
// Chronological insertion with timestamp badges.

import { dbInit, queueAdd, queueTake, queueRemove, queueCount } from '../lib/db.js';

/* ------------------ Settings & persistence ------------------ */
const LS_SETTINGS = 'twinmind_settings_v1';
const LS_TXT      = 'twinmind_transcript_v1';
const AUTO_RESTORE = false; // start with a fresh transcript on reload

const defaultSettings = {
  provider: 'Deepgram',
  preferWS: false,
  segSec: 10,
  overlapMs: 1200,
  tsCadenceSec: 8,
  debug: false,
  source: 'tab', // 'tab' | 'pick' | 'mic'
};
const settings = Object.assign({}, defaultSettings, loadSettings());
function loadSettings(){ try{ return JSON.parse(localStorage.getItem(LS_SETTINGS)||'{}'); }catch{return {};} }
function saveSettings(){ localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }

/* ------------------ UI wiring ------------------ */
const qs = (s)=>document.querySelector(s);
const setProvider = qs('#set-provider');
const setWS       = qs('#set-ws');
const setSeg      = qs('#set-seg');
const setOvl      = qs('#set-ovl');
const setTs       = qs('#set-ts');
const chkDebug    = qs('#chk-debug');

const setSourceTab  = qs('#set-source-tab');
const setSourcePick = qs('#set-source-pick');
const setSourceMic  = qs('#set-source-mic');

setProvider.value = settings.provider;
setWS.checked     = settings.preferWS;
setSeg.value      = settings.segSec;
setOvl.value      = settings.overlapMs;
setTs.value       = settings.tsCadenceSec;
chkDebug.checked  = settings.debug;

if (settings.source === 'tab')  setSourceTab.checked  = true;
if (settings.source === 'pick') setSourcePick.checked = true;
if (settings.source === 'mic')  setSourceMic.checked  = true;

for (const [el, key, coerce] of [
  [setProvider, 'provider', String],
  [setWS,       'preferWS', v=>!!v],
  [setSeg,      'segSec',   v=>Math.max(5, Math.min(60, Number(v)||10))],
  [setOvl,      'overlapMs',v=>Math.max(0, Math.min(3000, Number(v)||1200))],
  [setTs,       'tsCadenceSec', v=>Math.max(3, Math.min(20, Number(v)||8))],
  [chkDebug,    'debug',    v=>!!v],
]) {
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', ()=>{
    settings[key] = coerce(el.type === 'checkbox' ? el.checked : el.value);
    saveSettings();
    if (key === 'debug') {
      document.querySelectorAll('.partial').forEach(n => n.style.display = settings.debug ? '' : 'none');
    }
  });
}
[setSourceTab, setSourcePick, setSourceMic].forEach(r=>{
  r.addEventListener('change', ()=>{
    if (setSourceTab.checked)  settings.source = 'tab';
    if (setSourcePick.checked) settings.source = 'pick';
    if (setSourceMic.checked)  settings.source = 'mic';
    saveSettings();
  });
});

/* ------------------ Config ------------------ */
const BACKEND_URL = 'https://live-transcriber-0md8.onrender.com';

// Use websocket URL derived from BACKEND_URL
function wsUrl(){
  const u = new URL(BACKEND_URL);
  u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
  u.pathname = '/realtime';
  u.search = '?enc=webm';
  return u.toString();
}

// Timeouts tuned to treat “router connected, internet down” as offline quickly:
const UPLOAD_TIMEOUT_MS = 4000;    // POST /transcribe timeout
const HEALTH_TIMEOUT_MS = 2000;    // GET /health timeout
const HEALTH_EVERY_MS   = 3500;    // probe cadence

// Dedup tuning
const DEDUP_MAX_TAIL_WORDS = 30;
const DEDUP_MIN_MATCH_WORDS = 3;

// Queue tuning
const QUEUE_MAX_ITEMS  = 200;      // upper bound on items
const QUEUE_FLUSH_BATCH = 6;       // flush N per tick
const MAX_QUEUE_BYTES  = 25 * 1024 * 1024; // ~25MB soft cap (trim oldest if exceeded)

// Reordering window (lets earlier offline lines land before newer online ones)
const REORDER_SECS = 8;
const MAX_WAIT_MS  = 7000;
const MAX_BUF      = 200;

/* ------------------ DOM refs ------------------ */
const elStatus     = qs('#status');
const elConn       = qs('#conn');
const elTimer      = qs('#timer');
const elTranscript = qs('#transcript');

const btnStart = qs('#btn-start');
const btnPause = qs('#btn-pause');
const btnResume= qs('#btn-resume');
const btnStop  = qs('#btn-stop');
const btnCopy  = qs('#btn-copy');
const btnDownload = qs('#btn-download');
const btnExportSrt = qs('#btn-export-srt');
const btnExportJson= qs('#btn-export-json');
const btnClear = qs('#btn-clear');

/* ------------------ Toasts ------------------ */
const toastEl = qs('#toast');
let toastT = null;
function toast(msg, kind='ok'){
  toastEl.textContent = msg;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastT);
  toastT = setTimeout(()=> toastEl.className = '', 1800);
}

/* ------------------ Status helpers ------------------ */
let _connBase = 'Disconnected';
function setStatus(t){ elStatus.textContent = t; }
function setConn(t){ _connBase = t; renderConn(); }
let offlineQueueCount = 0;
let approxQueueBytes  = 0;
function renderConn(){
  const suffix = offlineQueueCount > 0 ? ` — queued ${offlineQueueCount}` : '';
  elConn.textContent = `${_connBase}${suffix}${netLikelyDown ? ' (offline)' : ''}`;
}
function setButtons({start,pause,resume,stop,exportable,canClear}){
  btnStart.disabled = !start;
  btnPause.disabled = !pause;
  btnResume.disabled= !resume;
  btnStop.disabled  = !stop;
  btnCopy.disabled  = !exportable;
  btnDownload.disabled = !exportable;
  btnExportSrt.disabled= !exportable;
  btnExportJson.disabled=!exportable;
  btnClear.disabled = !canClear;
}
function formatTime(sec){
  sec=Math.max(0,Math.floor(sec));
  const m=String(Math.floor(sec/60)).padStart(2,'0');
  const s=String(sec%60).padStart(2,'0');
  return `${m}:${s}`;
}
function currentSourceLabel(){
  return settings.source === 'mic' ? 'Mic'
       : settings.source === 'pick' ? 'Picked Tab'
       : 'Tab';
}

/* ------------------ Transcript store (ordered insert) ------------------ */
const entries = []; // sorted by time: {t, text}
let lastStamp = -Infinity;

function insertTranscriptLine(text, atSeconds){
  if(!text || !text.trim()) return;
  const t = typeof atSeconds === 'number' ? atSeconds : elapsed;

  let stampThis = false;
  if (t < lastStamp) {
    stampThis = true; // backfill
  } else if (!isFinite(lastStamp) || t - lastStamp >= settings.tsCadenceSec) {
    stampThis = true;
    lastStamp = t;
  }

  const div = document.createElement('div');
  div.className = 'line';
  div.dataset.t = String(t);
  if (stampThis) {
    const b = document.createElement('button');
    b.className='ts'; b.textContent=`[${formatTime(t)}]`;
    b.dataset.t = String(Math.floor(t));
    div.appendChild(b); div.appendChild(document.createTextNode(' '));
  }
  div.appendChild(document.createTextNode(text));

  // place in chronological DOM order
  const lines = Array.from(elTranscript.querySelectorAll('.line'));
  let inserted = false;
  for (let i=0;i<lines.length;i++){
    const lt = Number(lines[i].dataset.t || 0);
    if (t < lt) { elTranscript.insertBefore(div, lines[i]); inserted = true; break; }
  }
  if (!inserted) elTranscript.appendChild(div);
  elTranscript.scrollTop = elTranscript.scrollHeight;

  // entries[] (sorted)
  let idx = entries.findIndex(e => t < e.t);
  if (idx === -1) idx = entries.length;
  entries.splice(idx, 0, { t, text });
  persist();

  setButtons({
    start:false,
    pause:recording || wsMode,
    resume:(!recording && !wsMode) && !!stream,
    stop:!!stream,
    exportable:entries.length>0,
    canClear:entries.length>0
  });
}

function dbg(msg){
  if(!settings.debug) return;
  const d=document.createElement('div'); d.className='partial'; d.textContent=msg;
  d.style.display=''; elTranscript.appendChild(d); elTranscript.scrollTop=elTranscript.scrollHeight;
}

/* Click timestamp badge to seek current tab media */
elTranscript.addEventListener('click', async (e)=>{
  const b = e.target.closest('.ts'); if(!b) return;
  const sec = Number(b.dataset.t);
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); if(!tab) return;
  try{
    await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:(s)=>{ const v=document.querySelector('video,audio'); if(v){ v.currentTime=s; v.play?.(); } },
      args:[sec]
    });
  }catch{ toast('Seek failed: allow site access', 'warn'); }
});

/* ------------------ Timer ------------------ */
let tInt=null, elapsed=0;
function startTimer(){ stopTimer(); elapsed=0; elTimer.textContent=formatTime(elapsed);
  tInt=setInterval(()=>{ elapsed+=1; elTimer.textContent=formatTime(elapsed); },1000);
}
function stopTimer(){ if(tInt) clearInterval(tInt); tInt=null; }

/* ------------------ Capture helpers ------------------ */
function startTabCapture(){
  return new Promise((resolve,reject)=>{
    chrome.tabCapture.capture({audio:true,video:false},(stream)=>{
      const err=chrome.runtime.lastError;
      if(err||!stream){ reject(new Error(err?.message||'Failed to capture tab audio')); return; }
      resolve(stream);
    });
  });
}
async function startPickerCapture(){
  const ds = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:1}, audio:true});
  const at = ds.getAudioTracks();
  if(!at.length){ ds.getVideoTracks().forEach(t=>t.stop()); throw new Error('No audio. Pick “Chrome Tab” and tick “Share tab audio”.'); }
  ds.getVideoTracks().forEach(t=>t.stop());
  return new MediaStream([at[0]]);
}
async function startMicCapture(){
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
    video: false
  });
  const at = s.getAudioTracks(); if(!at.length) throw new Error('No microphone detected');
  return new MediaStream([at[0]]);
}
async function getMediaTime(){
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab) return null;
    const [res]=await chrome.scripting.executeScript({
      target:{tabId:tab.id}, func:()=>{ const v=document.querySelector('video,audio'); return v? v.currentTime:null; }
    });
    return typeof res?.result==='number'?res.result:null;
  }catch{return null;}
}

/* ------------------ Dedup ------------------ */
let tailTokens = [];
const cleanTok = (w)=> w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g,'').toLowerCase();
function mergeAndDedup(rawText){
  const txt = (rawText||'').trim(); if(!txt) return '';
  const newTokens = txt.split(/\s+/);
  const tailSlice = tailTokens.slice(-DEDUP_MAX_TAIL_WORDS);
  const tailClean = tailSlice.map(cleanTok).filter(Boolean);
  const newClean  = newTokens.map(cleanTok).filter(Boolean);
  let overlap = 0;
  const maxK = Math.min(16, tailClean.length, newClean.length);
  for (let k=maxK;k>=2;k--){
    const a = tailClean.slice(tailClean.length-k).join(' ');
    const b = newClean.slice(0,k).join(' ');
    const chars = b.replace(/\s+/g,'').length;
    if (a===b && (k>=DEDUP_MIN_MATCH_WORDS || chars>=12)) { overlap=k; break; }
  }
  if (overlap >= newTokens.length) return '';
  const outTokens = newTokens.slice(overlap);
  tailTokens = [...tailSlice, ...outTokens].slice(-DEDUP_MAX_TAIL_WORDS);
  return outTokens.join(' ');
}

/* ------------------ Autosave / export ------------------ */
function persist(){ try{ localStorage.setItem(LS_TXT, JSON.stringify(entries)); }catch{} }
function restore(){
  try{
    const raw = localStorage.getItem(LS_TXT); if(!raw) return;
    const arr = JSON.parse(raw);
    if(Array.isArray(arr)){
      elTranscript.textContent=''; entries.length=0; lastStamp=-Infinity; tailTokens.length=0;
      for(const e of arr){ insertTranscriptLine(e.text, e.t); }
    }
  }catch{}
}
function toTxt(){ return entries.map(e => `[${formatTime(Math.floor(e.t||0))}] ${e.text}`).join('\n'); }
function toSrt(){
  const pad=(n,d=2)=>String(n).padStart(d,'0');
  const fmt=(sec)=>{ const ms=Math.max(0,Math.floor(sec*1000));
    const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000),
          s=Math.floor((ms%60000)/1000), ms3=ms%1000;
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms3).padStart(3,'0')}`;
  };
  let out=[]; for(let i=0;i<entries.length;i++){
    const a=entries[i], b=entries[i+1]; const start=a.t||0; const end=b? Math.max(start+1,(b.t||start+3)-0.2): start+3;
    out.push(`${i+1}\n${fmt(start)} --> ${fmt(end)}\n${a.text}\n`);
  } return out.join('\n');
}
function download(name, text, mime='text/plain'){
  const blob = new Blob([text], {type: mime}); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}

/* ------------------ Offline queue ------------------ */
await dbInit().catch(()=>{});
async function refreshQueueCount(){
  try{ offlineQueueCount = await queueCount(); }catch{ offlineQueueCount = 0; }
  renderConn();
}

async function trimQueueIfNeeded(extraBytes){
  // soft cap by item count
  try{
    let cnt = await queueCount().catch(()=>0);
    if (cnt >= QUEUE_MAX_ITEMS) {
      const olds = await queueTake(Math.min(20, cnt));
      await queueRemove(olds.map(o=>o.id)).catch(()=>{});
      cnt -= olds.length;
    }
  }catch{}

  // rough byte cap
  if (approxQueueBytes + (extraBytes||0) > MAX_QUEUE_BYTES) {
    const batch = await queueTake(10).catch(()=>[]);
    if (batch.length) {
      await queueRemove(batch.map(b=>b.id)).catch(()=>{});
      approxQueueBytes = Math.max(0, approxQueueBytes - batch.reduce((s,b)=> s + (b?.blob?.size||0), 0));
    }
  }
}

async function enqueueChunk(blob, seq, t){
  try{
    await trimQueueIfNeeded(blob.size||0);
    await queueAdd({ blob, mime: blob.type || 'audio/webm', seq, t });
    approxQueueBytes += (blob.size||0);
    await refreshQueueCount();
    startFlushLoop(); // make sure flusher is running
    toast(`Offline: queued ${offlineQueueCount}`, 'warn');
  }catch{
    toast('Failed to queue chunk', 'err');
  }
}

async function flushQueueOnce(){
  if (netLikelyDown) return false;
  const items = await queueTake(QUEUE_FLUSH_BATCH).catch(()=>[]);
  if (!items.length) return false;

  for (const it of items) {
    const fd = new FormData();
    fd.append('audio', it.blob, `queued-${it.seq}-${it.id}.webm`);
    fd.append('seq', String(it.seq));
    try{
      const data = await postWithRetry(fd);
      approxQueueBytes = Math.max(0, approxQueueBytes - (it.blob?.size||0));
      await queueRemove([it.id]).catch(()=>{});
      const raw = (data?.text || '').trim();
      if (raw) {
        const when = typeof it.t === 'number' ? it.t : ((await getMediaTime()) ?? elapsed);
        queueRender(raw, when);
      }
      lastSuccessAt = Date.now();
      netLikelyDown = false;
    }catch{
      // put back (we took, not removed; next tick we'll get again)
      break;
    }
  }
  await refreshQueueCount();
  return true;
}

let flushTimer=null;
function startFlushLoop(){
  if (flushTimer) return;
  flushTimer = setInterval(async ()=>{
    try{ await flushQueueOnce(); }catch{}
    if (offlineQueueCount === 0) { clearInterval(flushTimer); flushTimer=null; }
  }, 1500);
}

/* ------------------ Connectivity probing ------------------ */
let netLikelyDown = false;
let lastSuccessAt = 0;
let healthTimer = null;

async function healthProbe(){
  try{
    const r = await fetchWithTimeout(`${BACKEND_URL}/health`, {}, HEALTH_TIMEOUT_MS);
    if (r.ok) { netLikelyDown = false; lastSuccessAt = Date.now(); renderConn(); return; }
    netLikelyDown = true; renderConn();
  }catch{
    netLikelyDown = true; renderConn();
  }
}
function startHealthProbes(){
  stopHealthProbes();
  healthTimer = setInterval(healthProbe, HEALTH_EVERY_MS);
  // kick immediately
  healthProbe().catch(()=>{});
}
function stopHealthProbes(){ if(healthTimer){ clearInterval(healthTimer); healthTimer=null; } }

/* ------------------ fetch with timeout ------------------ */
async function fetchWithTimeout(url, options={}, timeoutMs=UPLOAD_TIMEOUT_MS){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{ return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally{ clearTimeout(id); }
}

/* ------------------ WebSocket streaming ------------------ */
let ws=null, wsMode=false, wsOpen=false;
let wsRecorder=null;
let wsProbeInterval=null;

function clearWsProbe(){ if(wsProbeInterval){ clearInterval(wsProbeInterval); wsProbeInterval=null; } }

function wsConnect(){
  return new Promise((resolve,reject)=>{
    try{
      ws = new WebSocket(wsUrl()); ws.binaryType='arraybuffer';
      const to = setTimeout(()=>{ try{ws.close();}catch{}; reject(new Error('WS connect timeout')); },1500);
      ws.onopen = ()=>{ clearTimeout(to); wsOpen=true; resolve(); };
      ws.onerror= ()=>{ clearTimeout(to); reject(new Error('WS error')); };
      ws.onclose= ()=>{ wsOpen=false; if(wsMode) onWsDropped(); };
      ws.onmessage=(evt)=>{
        if (typeof evt.data !== 'string') return;
        try{
          const msg = JSON.parse(evt.data);
          const alt = msg?.channel?.alternatives?.[0];
          const text = (alt?.transcript || '').trim();
          const isFinal = msg?.is_final === true || msg?.type === 'UtteranceEnd';
          if (text && isFinal) {
            const secP = getMediaTime().catch(()=>null);
            Promise.resolve(secP).then(s => queueRender(text, s ?? elapsed));
          }
        }catch{}
      };
    }catch(e){ reject(e); }
  });
}
function wsStartSending(stream){
  try{
    wsRecorder = new MediaRecorder(stream, { mimeType:'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
  }catch{ wsRecorder = new MediaRecorder(stream, {}); }
  wsRecorder.ondataavailable = (e)=>{
    if (e.data && e.data.size>0 && ws && wsOpen) {
      e.data.arrayBuffer().then(buf=>{ try{ ws.send(buf); }catch{} });
    }
  };
  wsRecorder.start(300);
}
function wsStop(){
  try{ wsRecorder && wsRecorder.state!=='inactive' && wsRecorder.stop(); }catch{}
  wsRecorder=null;
  try{ ws && ws.readyState===WebSocket.OPEN && ws.close(); }catch{}
  ws=null; wsOpen=false; wsMode=false;
}
function onWsDropped(){
  wsMode=false;
  try{ wsRecorder && wsRecorder.state!=='inactive' && wsRecorder.stop(); }catch{}
  wsRecorder=null;
  if (stream){
    if (!recording){
      recording=true;
      setConn('WS dropped → fallback');
      setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
      startRecorder();
      setButtons({start:false,pause:true,resume:false,stop:true,exportable:entries.length>0,canClear:true});
      toast('WebSocket dropped — using fallback', 'warn');
    }
    if (settings.preferWS) startWsProbe();
  }
}
function startWsProbe(){
  clearWsProbe();
  wsProbeInterval = setInterval(async ()=>{
    if (!settings.preferWS) { clearWsProbe(); return; }
    if (wsMode || !stream) return;
    if (await queueCount().catch(()=>0) > 0) return; // drain queued first
    try{
      await wsConnect(); wsMode=true; setConn('Reconnected (WS)');
      setStatus(`Streaming (${settings.provider}) — ${currentSourceLabel()}`);
      wsStartSending(stream);
      if (recording){ recording=false; abortAll(); }
      setButtons({start:false,pause:true,resume:false,stop:true,exportable:entries.length>0,canClear:true});
      toast('Switched back to WebSocket streaming', 'ok');
      clearWsProbe();
    }catch{}
  }, 12000);
}

/* ------------------ Chunked fallback path ------------------ */
const ACTIVE=new Set();
let segIndex=0, allowOverlap=true;

function makeRecOpts(){
  const list = [
    { mimeType:'audio/webm;codecs=opus', audioBitsPerSecond: 128000 },
    { mimeType:'audio/webm',            audioBitsPerSecond: 128000 },
    {                                  audioBitsPerSecond: 128000 },
  ];
  return list.find(o=>{ try{ return o.mimeType ? MediaRecorder.isTypeSupported(o.mimeType) : true; }catch{return false;} }) || {};
}
function stopRecorder(R){
  if(!R) return;
  try{ if(R.mr && R.mr.state!=='inactive') R.mr.stop(); }catch{}
  if(R.stopT){ clearTimeout(R.stopT); R.stopT=null; }
  if(R.spawnT){ clearTimeout(R.spawnT); R.spawnT=null; }
}
function abortAll(){ for (const R of Array.from(ACTIVE)) stopRecorder(R); ACTIVE.clear(); }

async function postWithRetry(formData, tries=2, delay=300){
  for (let i=0;i<tries;i++){
    try{
      const resp = await fetchWithTimeout(`${BACKEND_URL}/transcribe`, { method:'POST', body: formData }, UPLOAD_TIMEOUT_MS);
      if (resp.ok) {
        netLikelyDown = false; lastSuccessAt = Date.now();
        return await resp.json();
      }
      if (resp.status < 500) throw new Error(`HTTP ${resp.status}`);
      // 5xx → transient
    }catch(e){
      if (i === tries-1) throw e;
      await new Promise(r=>setTimeout(r, delay*Math.pow(3,i)));
    }
  }
}

function startRecorder(){
  if(!recording || !stream) return;

  if(!allowOverlap){ for (const R of Array.from(ACTIVE)) stopRecorder(R); }

  const R = { idx: ++segIndex, chunks: [], mr:null, stopT:null, spawnT:null, t:null };
  getMediaTime().then(s => { R.t = (typeof s === 'number') ? s : elapsed; }).catch(()=>{ R.t = elapsed; });

  const opts = makeRecOpts();
  try{ R.mr = new MediaRecorder(stream, opts); }
  catch(e){
    if (allowOverlap) {
      allowOverlap = false; dbg('⚠️ overlap not supported; switching to no-overlap');
      abortAll(); if(recording) startRecorder(); return;
    } else { setStatus(`MediaRecorder error: ${e.message}`); return; }
  }

  R.mr.ondataavailable = (e)=>{ if(e.data && e.data.size>0) R.chunks.push(e.data); };
  R.mr.onerror = (e)=> setStatus(`Recorder error: ${e.error?.name||e.name}`);
  R.mr.onstop = async ()=>{
    ACTIVE.delete(R);
    const blob = R.chunks.length ? new Blob(R.chunks, {type:(R.chunks[0]?.type || 'audio/webm')}) : null;
    R.chunks = [];
    if (blob){
      // If our health probe says "down" or we still have backlog → enqueue
      if (netLikelyDown || offlineQueueCount > 0) {
        dbg('📥 enqueue (offline or backlog present)');
        await enqueueChunk(blob, R.idx, (typeof R.t==='number') ? R.t : null);
        startFlushLoop();
      } else {
        const fd = new FormData();
        fd.append('audio', blob, `seg-${R.idx}-${Date.now()}.webm`);
        fd.append('seq', String(R.idx));
        try{
          dbg(`[${formatTime(elapsed)}] ⬆️ posting seg #${R.idx}`);
          const data = await postWithRetry(fd);
          const raw  = (data?.text || '').trim();
          if (raw){
            const when = (typeof R.t==='number') ? R.t : ((await getMediaTime()) ?? elapsed);
            queueRender(raw, when);
          } else { dbg('…all overlap (deduped)'); }
        }catch{
          dbg('❌ upload failed; queued');
          await enqueueChunk(blob, R.idx, (typeof R.t==='number') ? R.t : null);
          startFlushLoop();
        }
      }
    }
    if (recording && !allowOverlap) startRecorder();
  };

  R.mr.start(); ACTIVE.add(R);
  dbg(`[${formatTime(elapsed)}] 🎬 segment #${R.idx} started`);
  R.stopT  = setTimeout(()=> stopRecorder(R), settings.segSec * 1000);
  if(allowOverlap){
    R.spawnT = setTimeout(()=>{ if(recording) startRecorder(); },
                           Math.max(0, settings.segSec*1000 - settings.overlapMs));
  }
}

/* ------------------ Session state ------------------ */
let stream=null;
let recording=false;

function resetSessionKeepTranscript(){
  lastStamp=-Infinity; tailTokens.length=0; segIndex=0; allowOverlap=true;
}

/* ------------------ Render buffer ------------------ */
let renderBuf=[]; // {t, text, at}
let renderTimer=null;
let maxTSeen=-Infinity;

function queueRender(rawText, t){
  const text = (rawText||'').trim(); if(!text) return;
  const when = typeof t==='number' ? t : elapsed;
  maxTSeen = Math.max(maxTSeen, when);
  renderBuf.push({ t: when, text, at: performance.now() });
  if (renderBuf.length > MAX_BUF) {
    renderBuf.sort((a,b)=>a.at-b.at);
    const drop = renderBuf.shift();
    const merged = mergeAndDedup(drop.text);
    if (merged) insertTranscriptLine(merged, drop.t);
  }
  if (!renderTimer) renderTimer = setInterval(flushRenderable, 700);
}
function flushRenderable(){
  if (renderBuf.length===0) { clearInterval(renderTimer); renderTimer=null; return; }
  renderBuf.sort((a,b)=> a.t===b.t ? a.at-b.at : a.t-b.t);
  const out=[], now=performance.now(), horizon=maxTSeen-REORDER_SECS, remain=[];
  for (const it of renderBuf){ if (it.t<=horizon || now-it.at>MAX_WAIT_MS) out.push(it); else remain.push(it); }
  renderBuf = remain;
  for (const it of out){
    const merged = mergeAndDedup(it.text);
    if (merged) insertTranscriptLine(merged, it.t);
  }
  if (renderBuf.length===0) { clearInterval(renderTimer); renderTimer=null; }
}

/* ------------------ Fresh start helpers ------------------ */
async function clearQueuedBacklog(){
  try{
    if (flushTimer){ clearInterval(flushTimer); flushTimer=null; }
    // drain entire store
    let batch;
    do {
      batch = await queueTake(50).catch(()=>[]);
      if (batch.length) await queueRemove(batch.map(b=>b.id)).catch(()=>{});
    } while (batch.length);
    approxQueueBytes = 0;
  }catch{}
  offlineQueueCount = 0; renderConn();
}
function clearTranscriptStateAndUI(){
  if (renderTimer){ clearInterval(renderTimer); renderTimer=null; }
  elTranscript.textContent=''; entries.length=0; lastStamp=-Infinity; tailTokens.length=0;
  renderBuf=[]; maxTSeen=-Infinity; persist();
  setButtons({start:true,pause:false,resume:false,stop:!!stream,exportable:false,canClear:false});
}
async function startFresh(){
  clearWsProbe(); if (wsMode) wsStop(); recording=false; abortAll();
  try{ if(stream) stream.getTracks().forEach(t=>t.stop()); }catch{}; stream=null; stopTimer();
  clearTranscriptStateAndUI();
  await clearQueuedBacklog();
  try{ localStorage.removeItem(LS_TXT); }catch{}
}

/* ------------------ Initial state ------------------ */
setConn('Disconnected'); setStatus('Idle');
setButtons({start:true,pause:false,resume:false,stop:false,exportable:entries.length>0,canClear:entries.length>0});
if (AUTO_RESTORE) restore(); else { try{ localStorage.removeItem(LS_TXT); }catch{} }
document.querySelectorAll('.partial').forEach(n => n.style.display = settings.debug ? '' : 'none');
refreshQueueCount().then(()=>{ if (offlineQueueCount>0) startFlushLoop(); });

/* ------------------ UI actions ------------------ */
btnStart.addEventListener('click', async ()=>{
  try{
    setStatus('Starting…');
    setButtons({start:false,pause:false,resume:false,stop:false,exportable:entries.length>0,canClear:entries.length>0});
    await startFresh(); // 💥 completely fresh queue + transcript each session
    startHealthProbes();

    // Acquire audio
    try{
      if (settings.source === 'tab') {
        try{ stream = await startTabCapture(); }
        catch { setStatus('Picker: choose this tab & tick “Share tab audio”'); stream = await startPickerCapture(); }
      } else if (settings.source === 'pick') stream = await startPickerCapture();
      else stream = await startMicCapture();
    }catch(e){
      setStatus(`Capture error: ${e.message}`);
      setButtons({start:true,pause:false,resume:false,stop:false,exportable:entries.length>0,canClear:entries.length>0});
      stopHealthProbes();
      return;
    }

    startTimer();
    setButtons({start:false,pause:true,resume:false,stop:true,exportable:entries.length>0,canClear:true});

    if (settings.preferWS){
      setConn('Connecting (WS)…');
      try{
        await wsConnect(); wsMode=true; setConn('Connected (WS)');
        setStatus(`Streaming (${settings.provider}) — ${currentSourceLabel()}`);
        wsStartSending(stream); toast(`Streaming ${currentSourceLabel()}`, 'ok'); return;
      }catch{
        setConn('WS unavailable → fallback'); toast('WS not ready, using fallback', 'warn'); startWsProbe();
      }
    }

    recording=true; setConn('Connected');
    setStatus(`Recording (fallback) — ${currentSourceLabel()}`);
    startRecorder();
  }catch(err){
    setStatus(`Error: ${err.message}`);
    setButtons({start:true,pause:false,resume:false,stop:false,exportable:entries.length>0,canClear:entries.length>0});
    stopHealthProbes();
  }
});

btnPause.addEventListener('click', ()=>{
  if (wsMode){ try{ wsRecorder?.stop(); }catch{}; setStatus('Paused (WS)'); }
  else { if(!recording) return; recording=false; abortAll(); setStatus('Paused'); }
  setButtons({start:false,pause:false,resume:true,stop:true,exportable:entries.length>0,canClear:true});
});
btnResume.addEventListener('click', ()=>{
  if (wsMode){ wsStartSending(stream); setStatus(`Streaming (${settings.provider}) — ${currentSourceLabel()}`); }
  else { if(recording) return; recording=true; startRecorder(); setStatus(`Recording (fallback) — ${currentSourceLabel()}`); }
  setButtons({start:false,pause:true,resume:false,stop:true,exportable:entries.length>0,canClear:true});
});
btnStop.addEventListener('click', ()=>{
  clearWsProbe(); if (wsMode) wsStop(); recording=false; abortAll();
  try{ if(stream) stream.getTracks().forEach(t=>t.stop()); }catch{}; stream=null; stopTimer();
  stopHealthProbes();
  setStatus('Stopped'); setConn('Disconnected'); toast('Stopped','ok');
  setButtons({start:true,pause:false,resume:false,stop:false,exportable:entries.length>0,canClear:entries.length>0});
});

btnCopy.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(toTxt()); toast('Copied','ok'); }catch{ toast('Copy failed','err'); } });
btnDownload.addEventListener('click', ()=> download(`transcript-${Date.now()}.txt`, toTxt()));
btnExportSrt.addEventListener('click', ()=> download(`transcript-${Date.now()}.srt`, toSrt(), 'text/srt'));
btnExportJson.addEventListener('click', ()=> download(`transcript-${Date.now()}.json`, JSON.stringify(entries,null,2), 'application/json'));
btnClear.addEventListener('click', ()=>{
  elTranscript.textContent=''; entries.length=0; lastStamp=-Infinity; tailTokens.length=0; persist();
  setButtons({start:true,pause:false,resume:false,stop:!!stream,exportable:false,canClear:false});
});
