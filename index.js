const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

let shuttingDown = false;

// ============================================================
// منع السيرفر من الانهيار بسبب أخطاء Puppeteer غير المتوقعة
// ============================================================
process.on('unhandledRejection', (reason) => {
  if (shuttingDown) return;
  console.error('[WARN] Unhandled Rejection:', reason?.message || reason);
  if (isDeadBrowserError(reason)) {
    recoverFromDeadBrowser(reason?.message || reason);
  }
});

process.on('uncaughtException', (error) => {
  if (shuttingDown) return;
  console.error('[WARN] Uncaught Exception:', error?.message || error);
  if (isDeadBrowserError(error)) {
    recoverFromDeadBrowser(error?.message || error);
  }
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
const INIT_TIMEOUT_MS = 180000; // 3 دقائق كحد أقصى لانتظار QR أو ready بدلاً من 90 ثانية
const BROWSER_RECYCLE_MS = 24 * 60 * 60 * 1000;
const BROWSER_RSS_CHECK_MS = 10 * 60 * 1000;
const BROWSER_RSS_LIMIT_MB = 1400;
const LOCK_PATH = path.join(__dirname, '.massar-whatsapp.lock');
let initTimer = null;

// كاش Chrome المؤقت فقط. IndexedDB فيه الجلسة، ومسحه بيفرض مزامنة كاملة أو تسجيل خروج.
const DISPOSABLE_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'Service Worker/CacheStorage',
];

function pruneBrowserCaches() {
  const profile = path.join(AUTH_PATH, 'session-whatsapp-session', 'Default');
  for (const dir of DISPOSABLE_CACHE_DIRS) {
    fs.rmSync(path.join(profile, dir), { recursive: true, force: true });
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function takeSingleInstanceLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const existing = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (pidAlive(existing) && existing !== process.pid) {
      console.error(`[LOCK] WhatsApp is already running as pid ${existing}. Exiting without opening Chrome.`);
      process.exit(0);
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseSingleInstanceLock() {
  try {
    if (Number(fs.readFileSync(LOCK_PATH, 'utf8')) === process.pid) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {
    // القفل انمسح أو العملية الثانية أخذته
  }
}

function listProcesses() {
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }

  const processes = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const commEnd = stat.lastIndexOf(')');
      if (commEnd === -1) continue;
      const rest = stat.slice(commEnd + 2).split(' ');
      const rssPages = Number(rest[21]);
      processes.push({
        pid: Number(entry),
        ppid: Number(rest[1]),
        rssMb: Number.isFinite(rssPages) ? (rssPages * 4096) / (1024 * 1024) : 0,
      });
    } catch {
      // العملية انتهت أثناء القراءة
    }
  }
  return processes;
}

function processTree(rootPid) {
  const processes = listProcesses();
  const children = new Map();
  for (const proc of processes) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }

  const tree = [];
  const stack = processes.filter((proc) => proc.pid === rootPid);
  const seen = new Set();
  while (stack.length) {
    const proc = stack.pop();
    if (!proc || seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    tree.push(proc);
    for (const child of children.get(proc.pid) || []) stack.push(child);
  }
  return tree;
}

function killProcessTree(rootPid) {
  for (const proc of processTree(rootPid).reverse()) {
    try {
      process.kill(proc.pid, 'SIGKILL');
    } catch {
      // العملية انتهت
    }
  }
}

function browserPid(activeClient) {
  try {
    return activeClient?.pupBrowser?.process?.()?.pid || null;
  } catch {
    return null;
  }
}

function createClient() {
  const newClient = new Client({
    authStrategy: new LocalAuth({ clientId: "whatsapp-session" }),
    authTimeoutMs: 180000, // منع خطأ المهلة 30000ms في سيرفرات الـ VPS
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // يمنع تعليق المتصفح في سيرفرات لينكس
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--mute-audio',
        '--disk-cache-size=33554432',
        '--media-cache-size=1',
        '--disable-features=Translate,BackForwardCache,MediaRouter',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ],
      timeout: 180000,
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
    watchPage(newClient);
    // الإرسال لا يحتاج الظهور "متصل". هذا يخفف تحديثات الحالة ولا يوقف مزامنة واتساب ويب.
    newClient.sendPresenceUnavailable().catch((err) => {
      console.log('[PRESENCE] Could not set unavailable:', err?.message);
    });
  });

  newClient.on('call', async (call) => {
    try {
      await call.reject();
    } catch (err) {
      console.log('[CALL] Reject skipped:', err?.message);
    }
  });

  newClient.on('auth_failure', (msg) => {
    console.error('[ERROR] Auth failure (session rejected):', msg);
    clearInitTimeout();
    recoverSession(true); // فشل حقيقي في المصادقة: مسح الجلسة لطلب QR جديد
  });

  newClient.on('disconnected', (reason) => {
    console.log('[WARN] Client disconnected (will reconnect preserving session):', reason);
    clearInitTimeout();
    recoverSession(false); // انقطاع مؤقت: لا تمسح الجلسة المخزنة!
  });

  return newClient;
}

// Chrome يقدر يقتل الصفحة ويترك كائن الجلسة حيّاً. client.info يبقى موجوداً
// فيظهر واتساب "متصل" بينما كل إرسال يرمي: Attempted to use detached Frame.
const DEAD_BROWSER_PATTERN = /detached Frame|Target closed|Session closed|Execution context was destroyed|Protocol error|page has been closed|browser has disconnected|Page crashed/i;

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.message || error.error || '');
}

function isDeadBrowserError(error) {
  return DEAD_BROWSER_PATTERN.test(errorText(error));
}

function isClientUsable() {
  if (!client || !client.info || !client.pupPage) return false;
  try {
    if (typeof client.pupPage.isClosed === 'function' && client.pupPage.isClosed()) {
      return false;
    }
    const frame = typeof client.pupPage.mainFrame === 'function'
      ? client.pupPage.mainFrame()
      : null;
    return Boolean(frame) && frame.detached !== true;
  } catch (err) {
    return false;
  }
}

function recoverFromDeadBrowser(reason) {
  console.error('[RECOVER] Browser frame is dead:', reason);
  recoverSession(false);
}

function watchPage(activeClient) {
  const page = activeClient.pupPage;
  if (!page || page.__massarGuard) return;
  page.__massarGuard = true;

  page.on('error', (err) => {
    if (client !== activeClient || isRecovering) return;
    recoverFromDeadBrowser(err?.message || 'page crashed');
  });

  page.on('close', () => {
    if (client !== activeClient || isRecovering) return;
    recoverFromDeadBrowser('page closed');
  });
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
    console.error('[TIMEOUT] client.initialize() took too long. Retrying without deleting session...');
    recoverSession(false); // لا تمسح الجلسة المخزنة!
  }, INIT_TIMEOUT_MS);
}

async function recoverSession(forceClean = false) {
  // منع تشغيل عمليات استعادة متعددة بنفس الوقت
  if (shuttingDown || isRecovering) {
    console.log('[RECOVER] Recovery already in progress, skipping...');
    return;
  }
  isRecovering = true;
  lastQrData = null;
  clearInitTimeout();

  console.log(`[RECOVER] Starting session recovery (forceClean=${forceClean})...`);

  // destroy() أحياناً يترك Chrome شغال. نقتل شجرته حتى ما تتراكم النسخ مع الأشهر.
  const orphanPid = browserPid(client);
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
  killProcessTree(orphanPid);

  // مسح مجلد الجلسة فقط إذا طُلب صراحة (عند تسجيل الخروج المتعمد أو auth_failure)
  if (forceClean && fs.existsSync(AUTH_PATH)) {
    try {
      fs.rmSync(AUTH_PATH, { recursive: true, force: true });
      console.log('[RECOVER] Auth directory deleted because forceClean=true.');
    } catch (err) {
      console.error('[RECOVER] Error deleting auth directory:', err?.message);
    }
  }

  pruneBrowserCaches();

  // إعادة المحاولة بالاحتفاظ بالجلسة المخزنة
  console.log('[RECOVER] Reinitializing client in 3 seconds...');
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal}. Closing Chrome before exit.`);
  clearInitTimeout();
  const orphanPid = browserPid(client);
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.log('[SHUTDOWN] Destroy skipped:', err?.message);
    }
    client = null;
  }
  killProcessTree(orphanPid);
  releaseSingleInstanceLock();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

// ============================================================
// أول تشغيل
// ============================================================
takeSingleInstanceLock();
pruneBrowserCaches();
client = createClient();
console.log('[STARTUP] Client created. Calling initialize()...');
startInitTimeout();
client.initialize().catch(err => {
  console.error('[STARTUP] Initial client.initialize() failed:', err?.message);
  clearInitTimeout();
  recoverSession();
});

// إذا ماتت صفحة Chrome بدون حدث disconnected، لا ننتظر مستخدماً ليكتشف العطل.
setInterval(() => {
  if (isRecovering || !client || !client.info || isClientUsable()) return;
  recoverFromDeadBrowser('watchdog found a detached browser frame');
}, 30000);

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
  const usable = isClientUsable();
  if (client && client.info && !usable) {
    recoverFromDeadBrowser('status check found a detached browser frame');
  }
  res.json({
    status: 'ok',
    ready: usable,
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
      const failure = { ok: false, error: err?.message || 'Unknown send failure' };
      if (isDeadBrowserError(err)) {
        while (messageQueue.length > 0) {
          messageQueue.shift().reject(failure);
        }
        isProcessingQueue = false;
        recoverFromDeadBrowser(failure.error);
        reject(failure);
        return;
      }
      reject(failure);
    }

    // تأخير إجباري بين كل رسالة ورسالة (1.5 ثانية) لحماية الرقم من الحظر
    if (messageQueue.length > 0) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  isProcessingQueue = false;
}

// Chrome يسرّب ذاكرة مع بقاء واتساب ويب مفتوحاً. الاستبدال يبقي الجلسة ويعيد بناء المتصفح خلال ثوانٍ.
function scheduleRecycle(delayMs) {
  setTimeout(() => {
    const busy = isProcessingQueue || messageQueue.length > 0;
    if (shuttingDown || isRecovering || busy || !client || !client.info) {
      console.log('[RECYCLE] Browser recycle postponed.');
      scheduleRecycle(busy ? 15 * 60 * 1000 : BROWSER_RECYCLE_MS);
      return;
    }
    console.log('[RECYCLE] Recycling the browser to release leaked memory. Session is kept.');
    recoverSession(false);
    scheduleRecycle(BROWSER_RECYCLE_MS);
  }, delayMs);
}

scheduleRecycle(BROWSER_RECYCLE_MS);

setInterval(() => {
  if (shuttingDown || isRecovering || isProcessingQueue || messageQueue.length > 0 || !client || !client.info) return;
  const rssMb = processTree(browserPid(client)).reduce((sum, proc) => sum + proc.rssMb, 0);
  if (rssMb < BROWSER_RSS_LIMIT_MB) return;
  console.error(`[RECYCLE] Chrome is using ${Math.round(rssMb)}MB. Recycling without deleting the session.`);
  recoverSession(false);
}, BROWSER_RSS_CHECK_MS);

// simple endpoint to send message (POST: {"to":"phone@c.us","message":"hello"})
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ ok: false, error: 'to and message required' });

  if (!isClientUsable()) {
    if (client && client.info) {
      recoverFromDeadBrowser('send requested while the browser frame is detached');
    }
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
      if (isDeadBrowserError(queueErr)) recoverFromDeadBrowser(queueErr?.error || queueErr);
      res.status(500).json(queueErr);
    }

  } catch (err) {
    if (isDeadBrowserError(err)) recoverFromDeadBrowser(err?.message || err);
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

    // استعادة الجلسة ومسحها بالكامل لطلب كود QR جديد عند تسجيل الخروج المتعمد
    await recoverSession(true);

    res.json({ ok: true, message: 'Disconnected. Reinitializing for new QR...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Disconnect failed' });
  }
});

const PORT = process.env.PORT || 4002;
app.listen(PORT, () => {
  console.log('Express server listening on port', PORT);
});
