const baileys = require('@whiskeysockets/baileys');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage 
} = baileys;
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');
const path = require('path');
const express = require('express'); // Added for Health Check

// Browser fingerprints to rotate through on connection failures
const BROWSER_FINGERPRINTS = [
    ['Mac OS', 'Chrome', '1.0.0'],
    ['Windows', 'Firefox', '1.0.0'],
    ['Linux', 'Safari', '1.0.0'],
];

// --- YOUR CONFIGURATION ---
const ADMIN_JID = process.env.ADMIN_JID;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const STORAGE_DIR = path.join(__dirname, 'storage');
const CSV_FILE = path.join(STORAGE_DIR, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

let products = [];
let userCarts = {};
let latestQR = null;
let retryCount = 0;
const MAX_RETRIES = 10;

// Compute exponential backoff delay, capped at 60s
function getRetryDelay(count) {
    return Math.min(5000 * Math.pow(2, count - 1), 60000);
}

function loadProducts() {
    const results = [];
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, 'ID,Name,Price\n1,Demo Item,10.00');
    }
    fs.createReadStream(CSV_FILE)
        .pipe(csv())
        .on('data', (d) => results.push(d))
        .on('end', () => {
            products = results;
            console.log('✅ Inventory Loaded');
        });
}
loadProducts();

async function startBot(fingerprintIndex = 0) {
    const browser = BROWSER_FINGERPRINTS[fingerprintIndex % BROWSER_FINGERPRINTS.length];
    console.log(`🔄 Initializing WhatsApp Engine... (attempt ${retryCount + 1}, browser: ${browser[0]} / ${browser[1]})`);
    try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser,
        qrTimeout: 120000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚠️ QR Code generated. Visit /qr to scan it.');
            console.log('⏰ QR code generated at', new Date().toLocaleTimeString(), '— expires in 2 minutes');
            try {
                latestQR = await qrcodeImg.toBuffer(qr, { type: 'png' });
                console.log('✅ QR code stored in memory — fetch it at /qr');
            } catch (qrErr) {
                console.error('❌ Failed to generate QR buffer:', qrErr);
            }

            if (EMAIL_USER && EMAIL_PASS) {
                const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
                try {
                    await qrcodeImg.toFile(qrPath, qr);
                    transporter.sendMail({
                        from: EMAIL_USER, to: EMAIL_USER,
                        subject: 'WhatsApp Bot Login',
                        text: 'Scan the attached QR code, or visit /qr on the bot server.',
                        attachments: [{ filename: 'bot-qr.png', path: qrPath }]
                    }, (mailErr) => {
                        if (mailErr) console.error('❌ Failed to send QR email:', mailErr.message);
                        else console.log('📧 QR code emailed successfully.');
                    });
                } catch (mailFileErr) {
                    console.error('❌ Failed to write QR file for email:', mailFileErr);
                }
            }
        }
        
        if (connection === 'close') {
            const err = lastDisconnect?.error;
            const statusCode = (err instanceof Boom) ? err.output.statusCode : 0;
            console.error(`🔌 Connection closed. Status: ${statusCode}. Reason: ${err?.message || 'unknown'}`);
            console.error('🔍 Full error details:', JSON.stringify(err, Object.getOwnPropertyNames(err || {}), 2));
            retryCount++;
            if (statusCode === 408) {
                console.log('⏰ QR code expired — generating new one');
            }
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('🗑️  Auth invalidated — clearing auth state and restarting...');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                retryCount = 0;
                startBot(0);
            } else if (retryCount < MAX_RETRIES) {
                const delay = getRetryDelay(retryCount);
                const nextFingerprint = retryCount % BROWSER_FINGERPRINTS.length;
                const nextBrowser = BROWSER_FINGERPRINTS[nextFingerprint];
                console.log(`🔁 Retrying in ${delay / 1000}s with browser fingerprint [${nextBrowser[0]} / ${nextBrowser[1]}]... (${retryCount}/${MAX_RETRIES})`);
                setTimeout(() => startBot(nextFingerprint), delay);
            } else {
                console.error(`🛑 Max retries (${MAX_RETRIES}) reached. Bot stopped. Restart the service to try again.`);
            }
        } else if (connection === 'open') {
            retryCount = 0;
            latestQR = null;
            console.log('🚀 BOT IS CONNECTED AND LIVE!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        // Wrap the entire handler so a single malformed/undecryptable message
        // (e.g. "failed to decrypt message") can never bubble up as an
        // uncaught error and tear down the WhatsApp connection.
        try {
            if (!Array.isArray(messages) || messages.length === 0) return;
            const msg = messages[0];
            if (!msg || !msg.message || !msg.key || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            if (!jid) return;

            const text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ""
            ).toLowerCase().trim();

            if (jid === ADMIN_JID && msg.message.documentMessage) {
                try {
                    const doc = msg.message.documentMessage;
                    if (doc?.fileName && doc.fileName.endsWith('.csv')) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        fs.writeFileSync(CSV_FILE, buffer);
                        loadProducts();
                        await sock.sendMessage(jid, { text: "📦 Products updated!" });
                        return;
                    }
                } catch (docErr) {
                    console.error('❌ Failed to process incoming document message:', docErr);
                }
            }

            if (text === 'hello' || text === 'menu') {
                let menu = "*Our Catalog:*\n\n";
                products.forEach(p => menu += `*ID ${p.ID}*: ${p.Name} - ${p.Price}\n`);
                await sock.sendMessage(jid, { text: menu });
            } else if (text.startsWith('buy ')) {
                const parts = text.split(' ');
                const id = parts[1];
                const qty = parseInt(parts[2]) || 1;
                const product = products.find(p => p.ID === id);
                if (product) {
                    if (!userCarts[jid]) userCarts[jid] = [];
                    userCarts[jid].push({ ...product, qty });
                    await sock.sendMessage(jid, { text: `✅ Added ${qty} x ${product.Name}.` });
                }
            } else if (text === 'checkout') {
                const cart = userCarts[jid];
                if (!cart || cart.length === 0) {
                    await sock.sendMessage(jid, { text: "Cart empty." });
                    return;
                }
                let total = 0;
                let summary = "*Order Review:*\n";
                cart.forEach(i => {
                    const sub = parseFloat(i.Price) * i.qty;
                    total += sub;
                    summary += `- ${i.Name} (x${i.qty}): ${sub.toFixed(2)}\n`;
                });
                summary += `\n*Total: ${total.toFixed(2)}*`;
                await sock.sendMessage(jid, { text: summary });
                delete userCarts[jid];
            }
        } catch (err) {
            console.error('❌ Error handling incoming message (connection kept alive):', err);
        }
    });
    } catch (err) {
        console.error('❌ Fatal error in startBot():', err);
        console.error('🔍 Full error details:', JSON.stringify(err, Object.getOwnPropertyNames(err || {}), 2));
        retryCount++;
        if (retryCount < MAX_RETRIES) {
            const delay = getRetryDelay(retryCount);
            const nextFingerprint = retryCount % BROWSER_FINGERPRINTS.length;
            const nextBrowser = BROWSER_FINGERPRINTS[nextFingerprint];
            console.log(`🔁 Retrying in ${delay / 1000}s with browser fingerprint [${nextBrowser[0]} / ${nextBrowser[1]}]... (${retryCount}/${MAX_RETRIES})`);
            setTimeout(() => startBot(nextFingerprint), delay);
        } else {
            console.error(`🛑 Max retries (${MAX_RETRIES}) reached after fatal error. Restart the service to try again.`);
        }
    }
}

// --- WEB SERVER FOR RAILWAY HEALTH CHECK + QR CODE ---
const app = express();
const PORT = process.env.PORT || 3000;

// Railway sits behind a load balancer/proxy that sets X-Forwarded-For headers.
// This must be set before any middleware (e.g. express-rate-limit) that reads
// those headers, otherwise express-rate-limit throws a ValidationError and
// crashes request handling.
app.set('trust proxy', 1);

app.get('/', (req, res) => res.send('Bot is running!'));

app.get('/qr', (req, res) => {
    if (!latestQR) {
        return res.status(404).send('No QR code available yet. The bot may already be connected, or it has not started yet. Check the logs.');
    }
    res.setHeader('Content-Type', 'image/png');
    res.send(latestQR);
});

app.listen(PORT, () => {
    console.log(`📡 Web server listening on port ${PORT}`);
    console.log(`🔗 QR code will be available at /qr once the bot starts`);
    console.log('📦 Baileys version:', baileys.version || require('./node_modules/@whiskeysockets/baileys/package.json').version || 'unknown');
    startBot(0); // Start the bot after the server is up
});