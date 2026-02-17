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

// --- YOUR CONFIGURATION ---
const ADMIN_JID = '2721870306@s.whatsapp.net';
const EMAIL_USER = 'garethrn@gmail.com';
const EMAIL_PASS = 'cxxs awqa nnpa iylu'; 

const STORAGE_DIR = path.join(__dirname, 'storage');
const CSV_FILE = path.join(STORAGE_DIR, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');

// Ensure storage directories exist
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

let products = [];
let userCarts = {};

// Load CSV Data
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
        browser: ['Mac OS', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚠️ QR Code generated. Sending to email...');
            const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
            await qrcodeImg.toFile(qrPath, qr);
            
            transporter.sendMail({
                from: EMAIL_USER,
                to: EMAIL_USER,
                subject: 'WhatsApp Bot Login',
                text: 'Your WhatsApp Bot needs a login. Scan the attached QR code.',
                attachments: [{ filename: 'bot-qr.png', path: qrPath }]
            }, (err) => {
                if (err) console.log('❌ Email error:', err.message);
                else console.log('✉️ QR Email sent to ' + EMAIL_USER);
            });
        }
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
            console.log(`❌ Connection closed. Status: ${statusCode}`);

            // If session is invalid or logged out, clear the auth folder
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('🚫 Session invalid. Clearing auth_info...');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                startBot();
            } else {
                console.log('⏳ Attempting to reconnect in 5 seconds...');
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

        // 1. ADMIN: Update CSV
        if (jid === ADMIN_JID && msg.message.documentMessage) {
            const doc = msg.message.documentMessage;
            if (doc.fileName.endsWith('.csv')) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                fs.writeFileSync(CSV_FILE, buffer);
                loadProducts();
                return sock.sendMessage(jid, { text: "📦 Success! Products updated from your CSV file." });
            }
        }

        // 2. USER: Menu
        if (text === 'hello' || text === 'menu') {
            let menu = "*Our Product Catalog:*\n\n";
            products.forEach(p => {
                menu += `*ID ${p.ID}*: ${p.Name} - $${p.Price}\n`;
            });
            menu += "\nReply with: *Buy [ID] [Qty]*\ne.g., *Buy 1 5*";
            await sock.sendMessage(jid, { text: menu });
        }

        // 3. USER: Add to Cart
        else if (text.startsWith('buy ')) {
            const parts = text.split(' ');
            const id = parts[1];
            const qty = parseInt(parts[2]) || 1;
            const product = products.find(p => p.ID === id);
            
            if (product) {
                if (!userCarts[jid]) userCarts[jid] = [];
                userCarts[jid].push({ ...product, qty });
                await sock.sendMessage(jid, { text: `✅ Added ${qty} x ${product.Name}.\nReply *Checkout* to see total.` });
            } else {
                await sock.sendMessage(jid, { text: "❌ Product ID not found. Type *Menu* to see list." });
            }
        }

        // 4. USER: Checkout
        else if (text === 'checkout') {
            const cart = userCarts[jid];
            if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: "Your cart is empty." });
            
            let total = 0;
            let summary = "*Order Review:*\n------------------\n";
            cart.forEach(item => {
                const sub = parseFloat(item.Price) * item.qty;
                total += sub;
                summary += `${item.Name} (x${item.qty}): $${sub.toFixed(2)}\n`;
            });
            summary += `------------------\n*Total: $${total.toFixed(2)}*`;
            
            await sock.sendMessage(jid, { text: summary });
            delete userCarts[jid]; // Clear cart after review
        }
    });
}

startBot();