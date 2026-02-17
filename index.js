const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');
const path = require('path');
const express = require('express'); // Added for Health Check

// --- YOUR CONFIGURATION ---
const ADMIN_JID = '2721870306@s.whatsapp.net';
const EMAIL_USER = 'garethrn@gmail.com';
const EMAIL_PASS = 'cxxs awqa nnpa iylu'; 

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

async function startBot() {
    console.log('🔄 Initializing WhatsApp Engine...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ['Mac OS', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚠️ QR Code generated. Sending to email...');
            const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
            await qrcodeImg.toFile(qrPath, qr);
            
            transporter.sendMail({
                from: EMAIL_USER, to: EMAIL_USER,
                subject: 'WhatsApp Bot Login',
                text: 'Scan the attached QR code.',
                attachments: [{ filename: 'bot-qr.png', path: qrPath }]
            });
        }
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                startBot();
            } else {
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'open') {
            console.log('🚀 BOT IS CONNECTED AND LIVE!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        if (jid === ADMIN_JID && msg.message.documentMessage) {
            const doc = msg.message.documentMessage;
            if (doc.fileName.endsWith('.csv')) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                fs.writeFileSync(CSV_FILE, buffer);
                loadProducts();
                return sock.sendMessage(jid, { text: "📦 Products updated!" });
            }
        }

        if (text === 'hello' || text === 'menu') {
            let menu = "*Our Catalog:*\n\n";
            products.forEach(p => menu += `*ID ${p.ID}*: ${p.Name} - $${p.Price}\n`);
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
            if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: "Cart empty." });
            let total = 0;
            let summary = "*Order Review:*\n";
            cart.forEach(i => {
                const sub = parseFloat(i.Price) * i.qty;
                total += sub;
                summary += `- ${i.Name} (x${i.qty}): $${sub.toFixed(2)}\n`;
            });
            summary += `\n*Total: $${total.toFixed(2)}*`;
            await sock.sendMessage(jid, { text: summary });
            delete userCarts[jid];
        }
    });
}

// --- DUMMY WEB SERVER FOR RAILWAY HEALTH CHECK ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => {
    console.log(`📡 Health check server listening on port ${PORT}`);
    startBot(); // Start the bot after the server is up
});