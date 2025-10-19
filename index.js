import fetch from 'node-fetch';
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import QRCode from 'qrcode';
import makeWASocket, { useSingleFileAuthState, Browsers } from '@whiskeysockets/baileys';

const app = express();
app.use(bodyParser.json());

// ===== קונפיג כללי =====
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;               // סיסמת API פנימית
const WEBAPP_URL = process.env.APPS_WEBAPP_URL;    // כתובת ה-WebApp של Apps Script (/exec)
const WEBAPP_KEY = process.env.APPS_WEBAPP_KEY;    // אותו WEBAPP_KEY ששמת בסקריפט
const AUTH_FILE = './AUTH_STATE.json';             // יישמר בקונטיינר (רצוי Volume בהמשך)

let sock = null;
let lastQR = null;

const now = () => new Date().toISOString().replace('T',' ').slice(0,19);

// ===== Health (ללא מפתח) =====
app.get('/health', (_req, res) => res.json({ ok: true, ready: !!sock }));

// ===== אבטחת API בסיסית (מגן על שאר הראוטים) =====
function requireApiKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!API_KEY || k !== API_KEY) return res.status(401).json({ ok:false, error:'Unauthorized' });
  next();
}
app.use(requireApiKey);

// ===== כתיבה לשיטס דרך WebApp =====
async function writeGroups(rows) {
  const r = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: WEBAPP_KEY, action: 'writeGroups', rows })
  });
  return await r.json();
}

async function appendLog(row) {
  try {
    await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: WEBAPP_KEY, action: 'appendLog', row })
    });
  } catch (e) {
    console.error('appendLog failed:', e?.message || e);
  }
}

// ===== WhatsApp (Baileys) =====
async function startSession() {
  const { state, saveCreds } = useSingleFileAuthState(AUTH_FILE);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop')
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ qr }) => { if (qr) lastQR = qr; });
  return sock;
}

async function fetchGroups() {
  if (!sock) throw new Error('Session not started');
  const map = await sock.groupFetchAllParticipating();
  return Object.values(map).map(g => ({
    id: g.id,
    subject: g.subject,
    participantsCount: g.participants?.length || 0,
    isAdmin: !!g.participants?.find(p => p.id === sock?.user?.id && p.admin)
  }));
}

// ===== Endpoints =====
app.post('/session/create', async (_req, res) => {
  try {
    await startSession();
    // ייתכן שה-QR מגיע רק אחרי עדכון ראשון — נסה להביא שוב אם לא הגיע מיד
    let qrDataUrl = null;
    if (lastQR) {
      qrDataUrl = await QRCode.toDataURL(lastQR, { width: 320 });
    } else {
      await new Promise(r => setTimeout(r, 1200));
      if (lastQR) qrDataUrl = await QRCode.toDataURL(lastQR, { width: 320 });
    }
    await appendLog([now(),'default','system','session.create','-','OK','']);
    res.json({ ok: true, qr: qrDataUrl });
  } catch (e) {
    await appendLog([now(),'default','system','session.create','-','ERR',String(e)]);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.post('/groups/sync', async (_req, res) => {
  try {
    const groups = await fetchGroups();
    await writeGroups(groups.map(g => ({ ...g, primarySession: 'default', inviteLink: '' })));
    await appendLog([now(),'default','user','groups.sync','-','OK',`count=${groups.length}`]);
    res.json({ ok: true, count: groups.length });
  } catch (e) {
    await appendLog([now(),'default','user','groups.sync','-','ERR',String(e)]);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.listen(PORT, () => console.log('WISPRA server listening on port', PORT));
