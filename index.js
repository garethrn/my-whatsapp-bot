const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');

// --- YOUR CONFIGURATION ---
const ADMIN_JID = '2721870306@s.whatsapp.net';
const EMAIL_USER = 'garethrn@gmail.com';
const EMAIL_PASS = 'cxxs awqa nnpa iylu'; 
const CSV_FILE = './products.csv';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

let products = [];
let userCarts = {};

function loadProducts() {
    const results = [];
    if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, 'ID,Name,Price\n1,Demo Item,10.00');
    fs.createReadStream(CSV_FILE).pipe(csv()).on('data', (d) => results.push(d)).on('end', () => {
        products = results;
        console.log('✅ Inventory Loaded');
    });
}
loadProducts();

async function startBot() {
    // Railway Volume should be mounted to /app to save 'auth_info' folder
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚠️ QR Code generated. Sending to email...');
            const path = './bot-qr.png';
            await qrcodeImg.toFile(path, qr);
            transporter.sendMail({
                from: EMAIL_USER,
                to: EMAIL_USER,
                subject: 'WhatsApp Bot Login',
                text: 'Scan the attached QR code.',
                attachments: [{ filename: 'bot-qr.png', path: path }]
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('🚀 Bot Connected!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

        // 1. ADMIN: CSV Update (Check if admin sends a document)
        if (jid === ADMIN_JID && msg.message.documentMessage) {
            const doc = msg.message.documentMessage;
            if (doc.fileName.endsWith('.csv')) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                fs.writeFileSync(CSV_FILE, buffer);
                loadProducts();
                return sock.sendMessage(jid, { text: "📦 Success! Products updated from CSV." });
            }
        }

        // 2. USER: Menu
        if (text === 'hello' || text === 'menu') {
            let menu = "*Our Catalog:*\n\n";
            products.forEach(p => menu += `*ID ${p.ID}*: ${p.Name} - $${p.Price}\n`);
            menu += "\nReply: *Buy [ID] [Qty]*\nExample: *Buy 1 5*";
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
                await sock.sendMessage(jid, { text: `✅ Added ${qty} x ${product.Name} to cart.\nReply *Checkout* to finish.` });
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
            delete userCarts[jid];
        }
    });
}

startBot();