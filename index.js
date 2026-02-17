const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');

// --- CONFIGURATION ---
const ADMIN_JID = '2721870306@s.whatsapp.net';
const EMAIL_USER = 'garethrn@gmail.com';
const EMAIL_PASS = 'cxxs awqa nnpa iylu'; 

// Paths aligned for Railway Volume mounted at /app/storage
const STORAGE_DIR = './storage';
const CSV_FILE = `${STORAGE_DIR}/products.csv`;
const AUTH_DIR = `${STORAGE_DIR}/auth_info`;

// Create storage folder if missing
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
    fs.createReadStream(CSV_FILE).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        products = results;
        console.log('✅ Inventory Loaded');
    });
}
loadProducts();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }) // This removes the messy logs
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚠️ NEW QR CODE RECEIVED. Sending to email...');
            const path = `${STORAGE_DIR}/bot-qr.png`;
            await qrcodeImg.toFile(path, qr);
            
            const mailOptions = {
                from: EMAIL_USER,
                to: EMAIL_USER,
                subject: 'WhatsApp Bot Login',
                text: 'A new login is required. Please scan the attached QR code with your WhatsApp Business app.',
                attachments: [{ filename: 'bot-qr.png', path: path }]
            };

            transporter.sendMail(mailOptions, (err, info) => {
                if (err) console.log('❌ Email failed:', err.message);
                else console.log('✉️ Email sent successfully!');
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('🔄 Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('🚀 BOT IS CONNECTED AND LIVE!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        // Admin: Update CSV
        if (jid === ADMIN_JID && msg.message.documentMessage) {
            const doc = msg.message.documentMessage;
            if (doc.fileName.endsWith('.csv')) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                fs.writeFileSync(CSV_FILE, buffer);
                loadProducts();
                return sock.sendMessage(jid, { text: "📦 Success! Products updated from CSV." });
            }
        }

        // User Commands
        if (text === 'hello' || text === 'menu') {
            let menu = "*Our Catalog:*\n\n";
            products.forEach(p => menu += `*ID ${p.ID}*: ${p.Name} - $${p.Price}\n`);
            menu += "\nReply: *Buy [ID] [Qty]*";
            await sock.sendMessage(jid, { text: menu });
        } else if (text.startsWith('buy ')) {
            const parts = text.split(' ');
            const id = parts[1];
            const qty = parseInt(parts[2]) || 1;
            const product = products.find(p => p.ID === id);
            if (product) {
                if (!userCarts[jid]) userCarts[jid] = [];
                userCarts[jid].push({ ...product, qty });
                await sock.sendMessage(jid, { text: `✅ Added ${qty} x ${product.Name}.\nReply *Checkout* to finish.` });
            }
        } else if (text === 'checkout') {
            const cart = userCarts[jid];
            if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: "Cart empty." });
            let total = 0;
            let summary = "*Order Review:*\n";
            cart.forEach(item => {
                const sub = parseFloat(item.Price) * item.qty;
                total += sub;
                summary += `- ${item.Name} (x${item.qty}): $${sub.toFixed(2)}\n`;
            });
            summary += `\n*Total: $${total.toFixed(2)}*`;
            await sock.sendMessage(jid, { text: summary });
            delete userCarts[jid];
        }
    });
}

startBot();