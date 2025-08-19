// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { WebSocketServer, WebSocket: WS } = require('ws'); // alias to avoid no-redeclare
const { createClient } = require('@deepgram/sdk');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

/* ------------------------- CORS (allowlist by prefix) ------------------------ */
/*
  Set ALLOWED_ORIGINS to a space- or comma-separated list of prefixes.
  Examples:
    ALLOWED_ORIGINS=chrome-extension:// http://localhost http://127.0.0.1
    ALLOWED_ORIGINS=chrome-extension://<YOUR_EXTENSION_ID>
  If unset or empty, all origins are allowed (dev-friendly).
*/
const rawAllow = process.env.ALLOWED_ORIGINS || '';
const allowPrefixes = rawAllow.split(/[, \t\r\n]+/).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server requests have no 'origin'
      if (!origin) return cb(null, true);

      // No allowlist configured -> allow all
      if (allowPrefixes.length === 0) return cb(null, true);

      // Prefix match (so 'chrome-extension://' works for any extension in dev)
      const ok = allowPrefixes.some((p) => origin.startsWith(p));
      return ok ? cb(null, true) : cb(new Error('Not allowed by CORS'));
    },
    credentials: false,
  })
);

/* --------------------------- Deepgram configuration -------------------------- */
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('WARNING: DEEPGRAM_API_KEY not set; transcription will fail.');
}
const dg = createClient(process.env.DEEPGRAM_API_KEY);
const DG_MODEL = process.env.DG_MODEL || 'nova-2';

/* --------------------------------- Health ----------------------------------- */
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    provider: 'deepgram',
    model: DG_MODEL,
  })
);

/* ---------------------- Chunked fallback: POST /transcribe ------------------- */
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ error: 'DEEPGRAM_API_KEY not set' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing file "audio"' });
    }

    const mime = req.file.mimetype || 'audio/webm';
    const { result } = await dg.listen.prerecorded.transcribeFile(req.file.buffer, {
      model: DG_MODEL,
      smart_format: true,
      diarize: false,
      language: 'en',
      mimetype: mime,
    });

    const text =
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';

    return res.json({ text, seq: Number(req.body?.seq || 0) });
  } catch (err) {
    console.error('Deepgram prerecorded error:', err?.response?.data || err);
    return res.status(502).json({ error: 'deepgram_failed', detail: String(err) });
  }
});

/* ----------------------------- Start HTTP server ----------------------------- */
const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Live Transcriber backend listening on http://localhost:${PORT}`);
});

/* ---------------- Realtime WS relay: ws://<host>/realtime -------------------- */
const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (client) => {
  if (!process.env.DEEPGRAM_API_KEY) {
    try {
      client.close(1011, 'DEEPGRAM_API_KEY not set');
    } catch {}
    return;
  }

  // Build Deepgram WS URL
  const dgUrl =
    'wss://api.deepgram.com/v1/listen' +
    `?model=${encodeURIComponent(DG_MODEL)}` +
    '&encoding=linear16' + // raw PCM, little-endian
    '&sample_rate=48000' +
    '&channels=1' +
    '&smart_format=true' +
    '&interim_results=true';

  // Connect to Deepgram using the WS alias
  const dgWS = new WS(dgUrl, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  dgWS.on('open', () => {
    // Explicit start/config message (some gateways prefer an explicit start)
    const startMsg = {
      type: 'start',
      encoding: 'linear16',
      sample_rate: 48000,
      channels: 1,
      interim_results: true,
      smart_format: true,
      model: DG_MODEL,
    };
    try {
      dgWS.send(JSON.stringify(startMsg));
    } catch {}

    // Notify browser bridge
    try {
      client.send(JSON.stringify({ type: 'ready' }));
    } catch {}
  });

  // Forward transcripts from Deepgram -> browser
  dgWS.on('message', (data, isBinary) => {
    try {
      client.send(data, { binary: isBinary === true });
    } catch {}
  });

  dgWS.on('close', (code, reason) => {
    try {
      client.close(code, reason?.toString?.() || '');
    } catch {}
  });

  dgWS.on('error', (err) => {
    console.error('DG WS error:', err);
    try {
      client.close(1011, 'Deepgram error');
    } catch {}
  });

  // Browser -> Deepgram
  client.on('message', (msg, isBinary) => {
    if (typeof msg === 'string' && !isBinary) {
      // Optional control messages (e.g., {"type":"close"})
      try {
        const m = JSON.parse(msg);
        if (m?.type === 'close') dgWS.close();
      } catch {}
      return;
    }
    // Binary is PCM Int16LE 48k mono (or raw ArrayBuffer from MediaRecorder chunks)
    if (Buffer.isBuffer(msg) || msg instanceof ArrayBuffer) {
      if (dgWS.readyState === WS.OPEN) {
        try {
          dgWS.send(msg, { binary: true });
        } catch {}
      }
    }
  });

  client.on('close', () => {
    try {
      dgWS.close();
    } catch {}
  });
});
