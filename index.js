const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// ============================================================
// منع السيرفر من الانهيار بسبب أخطاء Puppeteer غير المتوقعة
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (error) => {
  console.error('[WARN] Uncaught Exception:', error?.message || error);
});

// ============================================================
// Express Setup
// ============================================================
const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============================================================
// WhatsApp Client — Factory Pattern
// ============================================================
let client = null;
let lastQrData = null;
let isRecovering = false; // قفل لمنع استعادة متعددة في نفس الوقت

const AUTH_PATH = path.join(__dirname, '.wwebjs_auth');
const INIT_TIMEOUT_MS = 90000; // 90 ثانية كحد أقصى لانتظار QR أو ready
let initTimer = null;

function createClient() {
  const newClient = new Client({
    authStrategy: new LocalAuth({ clientId: "whatsapp-session" }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
      timeout: 60000,
    },
    webVersionCache: {
      type: 'local',
    },
  });

  newClient.on('loading_screen', (percent, message) => {
    console.log(`[LOADING] ${percent}% - ${message}`);
  });

  newClient.on('qr', (qr) => {
    console.log('[QR] New QR code received. Scan it with your WhatsApp app.');
    qrcodeTerminal.generate(qr, { small: true });
    lastQrData = qr;
    // QR ظهر — لغي التايم آوت
    clearInitTimeout();
  });

  newClient.on('authenticated', () => {
    console.log('[AUTH] Client authenticated successfully.');
  });

  newClient.on('ready', () => {
    console.log('[OK] WhatsApp client is ready and connected!');
    lastQrData = null;
    isRecovering = false;
    clearInitTimeout();
  });

  newClient.on('auth_failure', (msg) => {
    console.error('[ERROR] Auth failure:', msg);
    clearInitTimeout();
    recoverSession();
  });

  newClient.on('disconnected', (reason) => {
    console.log('[WARN] Client disconnected:', reason);
    clearInitTimeout();
    recoverSession();
  });

  return newClient;
}

function clearInitTimeout() {
  if (initTimer) {
    clearTimeout(initTimer);
    initTimer = null;
  }
}

function startInitTimeout() {
  clearInitTimeout();
  initTimer = setTimeout(() => {
    console.error('[TIMEOUT] client.initialize() took too long (90s). Recovering...');
    recoverSession();
  }, INIT_TIMEOUT_MS);
}

async function recoverSession() {
  // منع تشغيل عمليات استعادة متعددة بنفس الوقت
  if (isRecovering) {
    console.log('[RECOVER] Recovery already in progress, skipping...');
    return;
  }
  isRecovering = true;
  lastQrData = null;
  clearInitTimeout();

  console.log('[RECOVER] Starting session recovery...');

  // محاولة تدمير العميل القديم بأمان
  if (client) {
    try {
      await client.destroy();
      console.log('[RECOVER] Old client destroyed.');
    } catch (err) {
      // هذا طبيعي — المتصفح ربما أُغلق قبل ما نوصل هون
      console.log('[RECOVER] Destroy skipped (already closed):', err?.message);
    }
    client = null;
  }

  // مسح مجلد الجلسة التالفة
  if (fs.existsSync(AUTH_PATH)) {
    try {
      fs.rmSync(AUTH_PATH, { recursive: true, force: true });
      console.log('[RECOVER] Auth directory deleted.');
    } catch (err) {
      console.error('[RECOVER] Error deleting auth directory:', err?.message);
    }
  }

  // إنشاء عميل جديد بالكامل بعد 3 ثوانٍ
  console.log('[RECOVER] Reinitializing new client in 3 seconds...');
  setTimeout(() => {
    try {
      client = createClient();
      console.log('[RECOVER] New client created. Calling initialize()...');
      startInitTimeout();
      client.initialize().catch(err => {
        console.error('[RECOVER] Initialize failed:', err?.message);
        clearInitTimeout();
        isRecovering = false;
      });
    } catch (err) {
      console.error('[RECOVER] Create client failed:', err?.message);
      isRecovering = false;
    }
  }, 3000);
}

// ============================================================
// أول تشغيل
// ============================================================
client = createClient();
console.log('[STARTUP] Client created. Calling initialize()...');
startInitTimeout();
client.initialize().catch(err => {
  console.error('[STARTUP] Initial client.initialize() failed:', err?.message);
  clearInitTimeout();
  recoverSession();
});

// ============================================================
// API Routes
// ============================================================

// serve QR as png
app.get('/qr', async (req, res) => {
  if (!lastQrData) {
    return res.send('<h3>No QR available — client may be already authenticated or initializing. Check server logs.</h3>');
  }
  try {
    const dataUrl = await qrcode.toDataURL(lastQrData);
    const html = `
      <html>
        <head><title>WhatsApp QR</title></head>
        <body style="font-family:Arial; text-align:center; padding:20px;">
          <h2>Scan this QR with WhatsApp (Web)</h2>
          <img src="${dataUrl}" />
          <p>If you already scanned, refresh this page.</p>
        </body>
      </html>
    `;
    res.send(html);
  } catch (e) {
    res.status(500).send('Error generating QR');
  }
});

// simple health and send endpoint example
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    ready: client && client.info ? true : false,
    hasQr: !!lastQrData,
  });
});

app.get('/qr-image', async (req, res) => {
  if (!lastQrData) {
    return res.json({ ok: false, error: 'No QR available right now.' });
  }

  try {
    const qrDataUrl = await qrcode.toDataURL(lastQrData);
    res.json({ ok: true, qrDataUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Failed to generate QR image.' });
  }
});

function normalizeWhatsAppId(to) {
  if (!to) return null;
  const trimmed = String(to).trim();
  if (trimmed.endsWith('@c.us')) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, '');
  return digits ? `${digits}@c.us` : null;
}

// Queue system to prevent WhatsApp Ban from burst sending
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const { numberId, message, resolve, reject } = messageQueue.shift();
    try {
      const msg = await client.sendMessage(numberId, message, { sendSeen: false });
      resolve({ ok: true, id: msg ? (msg.id ? msg.id._serialized : null) : null, to: numberId });
    } catch (err) {
      reject({ ok: false, error: err?.message || 'Unknown send failure' });
    }

    // تأخير إجباري بين كل رسالة ورسالة (1.5 ثانية) لحماية الرقم من الحظر
    if (messageQueue.length > 0) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  isProcessingQueue = false;
}

// simple endpoint to send message (POST: {"to":"phone@c.us","message":"hello"})
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ ok: false, error: 'to and message required' });

  if (!client || !client.info) {
    return res.status(503).json({ ok: false, error: 'WhatsApp client is not connected yet (ready=false).' });
  }

  const chatId = normalizeWhatsAppId(to);
  if (!chatId) {
    return res.status(400).json({ ok: false, error: 'Invalid phone/chat id format.' });
  }

  try {
    const numberId = await client.getNumberId(chatId);
    if (!numberId || !numberId._serialized) {
      return res.status(404).json({ ok: false, error: 'This number is not registered on WhatsApp.' });
    }

    // إرسال الرسالة عبر الطابور (Queue) لتجنب الحظر
    try {
      const result = await new Promise((resolve, reject) => {
        messageQueue.push({ numberId: numberId._serialized, message, resolve, reject });
        processQueue(); // تشغيل الطابور إذا كان متوقفاً
      });
      res.json(result);
    } catch (queueErr) {
      res.status(500).json(queueErr);
    }

  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'Unknown send failure' });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (client) {
      try {
        await client.logout();
      } catch (err) {
        console.log('Logout warning:', err.message);
      }
    }

    // استعادة الجلسة (ستقوم بإنشاء عميل جديد)
    await recoverSession();

    res.json({ ok: true, message: 'Disconnected. Reinitializing for new QR...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Disconnect failed' });
  }
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log('Express server listening on port', PORT);
});
