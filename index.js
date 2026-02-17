const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerm = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
const fs = require('fs');
const csv = require('csv-parser');
const nodemailer = require('nodemailer');

// --- CONFIGURATION ---
const ADMIN_NUMBER = '2721870306@c.us'; // Replace with your number (country code + number)
const EMAIL_USER = 'garethrn@gmail.com';
const EMAIL_PASS = 'cxxs awqa nnpa iylu'; // 16-character Google App Password
const CSV_FILE = './products.csv';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium', // Critical for Railway
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

let products = [];
let userCarts = {};

function loadProducts() {
    const results = [];
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, "ID,Name,Price\n1,Example Product,10.00");
    }
    fs.createReadStream(CSV_FILE)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            products = results;
            console.log('✅ Inventory updated.');
        });
}

loadProducts();

// --- QR & EMAIL LOGIC ---
client.on('qr', async (qr) => {
    qrcodeTerm.generate(qr, { small: true });
    const path = './bot-qr.png';
    await qrcodeImg.toFile(path, qr);
    
    const mailOptions = {
        from: EMAIL_USER,
        to: EMAIL_USER,
        subject: 'WhatsApp Bot: Action Required (Scan QR)',
        text: 'The bot needs a login. Please scan the attached QR code.',
        attachments: [{ filename: 'bot-qr.png', path: path }]
    };

    transporter.sendMail(mailOptions, (err) => {
        if (err) console.log('❌ Email error:', err);
        else console.log('✉️ QR Code emailed to you.');
    });
});

client.on('ready', () => console.log('🚀 Bot is online!'));

// --- CHAT LOGIC ---
client.on('message', async msg => {
    const userId = msg.from;
    const body = msg.body.toLowerCase();

    // 1. ADMIN: Update CSV via file upload
    if (userId === ADMIN_NUMBER && msg.hasMedia && msg.type === 'document') {
        const media = await msg.downloadMedia();
        if (media.filename && media.filename.endsWith('.csv')) {
            fs.writeFileSync(CSV_FILE, media.data, { encoding: 'base64' });
            loadProducts();
            return msg.reply('📦 Database updated successfully!');
        }
    }

    // 2. USER: Menu
    if (body === 'hello' || body === 'menu') {
        let text = "*Welcome to our Shop!*\n\n";
        products.forEach(p => {
            text += `*ID ${p.ID}*: ${p.Name} - $${p.Price}\n`;
        });
        text += "\nReply with: *Buy [ID] [Qty]*\nExample: *Buy 1 2*";
        client.sendMessage(userId, text);
    }

    // 3. USER: Add to Cart
    else if (body.startsWith('buy ')) {
        const parts = body.split(' ');
        const id = parts[1];
        const qty = parseInt(parts[2]) || 1;
        const item = products.find(p => p.ID === id);

        if (item) {
            if (!userCarts[userId]) userCarts[userId] = [];
            userCarts[userId].push({ ...item, qty });
            msg.reply(`✅ Added ${qty} x ${item.Name}. Reply *Checkout* to finish.`);
        }
    }

    // 4. USER: Checkout
    else if (body === 'checkout') {
        const cart = userCarts[userId];
        if (!cart || cart.length === 0) return msg.reply("Your cart is empty.");

        let total = 0;
        let summary = "*Order Review:*\n";
        cart.forEach(i => {
            const sub = parseFloat(i.Price) * i.qty;
            total += sub;
            summary += `- ${i.Name} (x${i.qty}): $${sub.toFixed(2)}\n`;
        });
        summary += `\n*Grand Total: $${total.toFixed(2)}*`;
        
        client.sendMessage(userId, summary);
        delete userCarts[userId];
    }
});

client.initialize();