const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');

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

const SESSION_FILE = './session.json';

// Use LocalAuth (recommended) — it will create a folder .wwebjs_auth for session
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "whatsapp-session" }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// store last qr to serve via web
let lastQrData = null;

client.on('qr', (qr) => {
  console.log('QR RECEIVED');
  console.log('\n=======================');
  console.log('📱 Scan this QR code:');
  console.log('=======================\n');

  // عرض الـ QR بشكل نصي داخل التيرمنال
  const qrcode = require('qrcode-terminal');
  qrcode.generate(qr, { small: true });

  console.log('\n(If you already scanned, wait until it says "WhatsApp client is ready!")\n');
  lastQrData = qr;
});

client.on('ready', () => {
  console.log('WhatsApp client is ready!');
  lastQrData = null;
});

client.on('auth_failure', (msg) => {
  console.error('AUTH FAILURE', msg);
});

client.on('disconnected', (reason) => {
  console.log('Client disconnected:', reason);
});

// start whatsapp client
client.initialize();

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
    ready: client.info ? true : false,
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

  if (!client.info) {
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
    try {
      await client.logout();
    } catch (err) {
      console.log('Logout warning:', err.message);
    }

    await client.destroy();
    lastQrData = null;

    setTimeout(() => {
      client.initialize().catch((error) => {
        console.error('Reinitialize error:', error);
      });
    }, 1500);

    res.json({ ok: true, message: 'Disconnected. Reinitializing for new QR...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Disconnect failed' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log('Express server listening on port', PORT);
});
