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
const express = require('express');

// --- YOUR CONFIGURATION ---
const ADMIN_JID = process.env.ADMIN_JID;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const STORAGE_DIR = path.join(__dirname, 'storage');
const CSV_FILE = path.join(__dirname, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const missingConfig = [
    ['ADMIN_JID', ADMIN_JID],
    ['EMAIL_USER', EMAIL_USER],
    ['EMAIL_PASS', EMAIL_PASS]
].filter(([, value]) => !value).map(([key]) => key);

if (missingConfig.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingConfig.join(', ')}`);
    process.exit(1);
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

let products = [];
let userCarts = {};
let userStates = {};

// CSV columns: ID,Category,Name,Size,Finish,SingleOrDoubleSided,UnitsPerProduct,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee
const DEFAULT_CSV = [
    'ID,Category,Name,Size,Finish,SingleOrDoubleSided,UnitsPerProduct,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee',
    '1,Banners,Vinyl Banner,Custom,Matt,Single,1,sqm,180.00,,150.00,250.00,no,,0.00',
    '2,Banners,Pull-Up Banner (2m),850x2000mm,Satin,Single,1,fixed,,850.00,850.00,0.00,no,,0.00',
    '3,Banners,Mesh Banner,Custom,Matt,Single,1,sqm,200.00,,200.00,0.00,no,,0.00',
    '4,Signs,Aluminium Composite Sign,Custom,Gloss,Single,1,sqm,350.00,,300.00,350.00,yes,120.00,450.00',
    '5,Signs,Corflute Sign,Custom,Matt,Single,1,sqm,220.00,,200.00,350.00,yes,80.00,350.00',
    '6,Signs,Pavement / A-Frame Sign,600x900mm,Gloss,Double,1,fixed,,650.00,650.00,0.00,no,,0.00',
    '7,Stickers,Cut Vinyl Stickers,Custom,Matt,Single,1,sqm,280.00,,120.00,0.00,no,,0.00',
    '8,Stickers,Printed Vinyl Stickers,Custom,Gloss,Single,1,sqm,320.00,,150.00,0.00,no,,0.00',
    '9,Stickers,Frosted Window Vinyl,Custom,Frosted,Single,1,sqm,350.00,,150.00,0.00,no,,0.00',
    '10,Clothing,Custom T-Shirt (Print),S-XXL,Standard,Single,1,fixed,,85.00,85.00,0.00,no,,0.00',
    '11,Clothing,Custom Hoodie (Print),S-XXL,Standard,Single,1,fixed,,150.00,150.00,0.00,no,,0.00',
    '12,Print,Business Cards (100),90x50mm,Matt/Gloss,Double,100,fixed,,250.00,250.00,0.00,no,,0.00',
    '13,Print,A5 Flyers (100),A5,Gloss,Double,100,fixed,,350.00,350.00,0.00,no,,0.00',
    '14,Print,A4 Poster,A4,Gloss,Single,1,fixed,,25.00,25.00,0.00,no,,0.00',
    '15,Vehicle Branding,Full Vehicle Wrap,Custom,Gloss,Single,1,sqm,450.00,,500.00,500.00,no,,0.00',
    '16,Vehicle Branding,Car Decal / Door Sticker,Custom,Gloss,Single,1,sqm,380.00,,300.00,0.00,no,,0.00'
].join('\n');

function loadProducts() {
    const results = [];
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, DEFAULT_CSV);
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

function getCategories() {
    return [...new Set(products.map(p => p.Category))];
}

// Calculate sqm price from mm dimensions, applying the minimum price floor
function calcSqmPrice(product, lengthMm, breadthMm) {
    const sqm = (lengthMm / 1000) * (breadthMm / 1000);
    const price = sqm * parseFloat(product.PricePerSqm || 0);
    return Math.max(price, parseFloat(product.MinPrice || 0));
}

// Parse dimensions with explicit separators: 1200x600, 1200X600, 1200,600, 1200*600
function parseDimensions(text) {
    const match = text.match(/(\d+(?:\.\d+)?)\s*[xX,*]\s*(\d+(?:\.\d+)?)/);
    if (match) {
        return { length: parseFloat(match[1]), breadth: parseFloat(match[2]) };
    }
    return null;
}

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
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const text = rawText.toLowerCase();

        // Admin: upload new CSV via document message
        if (jid === ADMIN_JID && msg.message.documentMessage) {
            const doc = msg.message.documentMessage;
            if (doc.fileName.endsWith('.csv')) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                fs.writeFileSync(CSV_FILE, buffer);
                loadProducts();
                return sock.sendMessage(jid, { text: "📦 Products updated!" });
            }
        }

        const userState = userStates[jid] || { step: 'idle' };

        // Cancel / escape from any mid-flow state
        if (text === 'cancel' || text === 'menu' || text === 'hello' || text === 'hi') {
            if (userState.step !== 'idle') {
                userStates[jid] = { step: 'idle' };
            }
            if (text === 'cancel') {
                return sock.sendMessage(jid, { text: "❌ Cancelled. Type *menu* to start over." });
            }
            // Fall through to show menu below
        }

        // ── State: awaiting_dimensions ──────────────────────────────────────
        if (userState.step === 'awaiting_dimensions') {
            const dims = parseDimensions(rawText);
            if (!dims) {
                return sock.sendMessage(jid, {
                    text: "❓ I couldn't read those dimensions.\nPlease send *length x breadth in mm* (e.g. _1200x600_).\nAccepted separators: x, X, comma, *\n\nType *cancel* to go back."
                });
            }
            const product = userState.pendingProduct;
            const sqmPrice = calcSqmPrice(product, dims.length, dims.breadth);
            const designFee = parseFloat(product.DesignFee || 0);
            const sqm = (dims.length / 1000) * (dims.breadth / 1000);

            let reply = `📐 *${product.Name}*\n`;
            reply += `Size: ${dims.length}mm × ${dims.breadth}mm (${sqm.toFixed(2)} m²)\n`;
            reply += `Material: R${sqmPrice.toFixed(2)}\n`;
            if (designFee > 0) reply += `Design/Layout Fee: R${designFee.toFixed(2)}\n`;

            const pendingItem = {
                name: product.Name,
                dimensions: `${dims.length}×${dims.breadth}mm`,
                sqmPrice,
                designFee,
                polesCost: 0,
                poles: 0,
                installationFee: 0,
                qty: 1
            };

            if (product.PolesAvailable === 'yes') {
                userStates[jid] = { step: 'awaiting_poles', pendingProduct: product, pendingItem };
                reply += `\nWould you like to add *poles*?\nPrice per pole: R${parseFloat(product.PolePrice).toFixed(2)}\nReply *yes* or *no*`;
                return sock.sendMessage(jid, { text: reply });
            } else if (parseFloat(product.InstallationFee) > 0) {
                userStates[jid] = { step: 'awaiting_installation', pendingProduct: product, pendingItem };
                reply += `\nWould you like *installation*? R${parseFloat(product.InstallationFee).toFixed(2)}\nReply *yes* or *no*`;
                return sock.sendMessage(jid, { text: reply });
            } else {
                const total = sqmPrice + designFee;
                pendingItem.total = total;
                if (!userCarts[jid]) userCarts[jid] = [];
                userCarts[jid].push(pendingItem);
                userStates[jid] = { step: 'idle' };
                reply += `\n*Total: R${total.toFixed(2)}*\n✅ Added to cart! Type *cart* to view or *checkout* to order.`;
                return sock.sendMessage(jid, { text: reply });
            }
        }

        // ── State: awaiting_poles ───────────────────────────────────────────
        if (userState.step === 'awaiting_poles') {
            if (text === 'yes') {
                userStates[jid] = { ...userState, step: 'awaiting_pole_count' };
                return sock.sendMessage(jid, {
                    text: `How many poles do you need?\nPrice per pole: R${parseFloat(userState.pendingProduct.PolePrice).toFixed(2)}\n\nType *cancel* to go back.`
                });
            } else if (text === 'no') {
                const instFee = parseFloat(userState.pendingProduct.InstallationFee);
                if (instFee > 0) {
                    userStates[jid] = { ...userState, step: 'awaiting_installation' };
                    return sock.sendMessage(jid, {
                        text: `Would you like *installation*? R${instFee.toFixed(2)}\nReply *yes* or *no*`
                    });
                }
                const item = userState.pendingItem;
                item.total = item.sqmPrice + item.designFee;
                if (!userCarts[jid]) userCarts[jid] = [];
                userCarts[jid].push(item);
                userStates[jid] = { step: 'idle' };
                return sock.sendMessage(jid, {
                    text: `✅ Added to cart! *Total: R${item.total.toFixed(2)}*\nType *cart* to view or *checkout* to order.`
                });
            } else {
                return sock.sendMessage(jid, { text: "Please reply *yes* or *no*." });
            }
        }

        // ── State: awaiting_pole_count ──────────────────────────────────────
        if (userState.step === 'awaiting_pole_count') {
            const count = parseInt(text);
            if (isNaN(count) || count < 1) {
                return sock.sendMessage(jid, { text: "Please enter a valid number of poles (e.g. _2_)." });
            }
            const polePrice = parseFloat(userState.pendingProduct.PolePrice);
            const polesCost = count * polePrice;
            const updatedItem = { ...userState.pendingItem, polesCost, poles: count };
            const instFee = parseFloat(userState.pendingProduct.InstallationFee);

            if (instFee > 0) {
                userStates[jid] = { ...userState, step: 'awaiting_installation', pendingItem: updatedItem };
                return sock.sendMessage(jid, {
                    text: `${count} pole(s) added: R${polesCost.toFixed(2)}\n\nWould you like *installation*? R${instFee.toFixed(2)}\nReply *yes* or *no*`
                });
            }
            const total = updatedItem.sqmPrice + updatedItem.designFee + polesCost;
            updatedItem.total = total;
            if (!userCarts[jid]) userCarts[jid] = [];
            userCarts[jid].push(updatedItem);
            userStates[jid] = { step: 'idle' };
            return sock.sendMessage(jid, {
                text: `✅ Added to cart! *Total: R${total.toFixed(2)}*\nType *cart* to view or *checkout* to order.`
            });
        }

        // ── State: awaiting_installation ────────────────────────────────────
        if (userState.step === 'awaiting_installation') {
            if (text === 'yes' || text === 'no') {
                const item = userState.pendingItem;
                item.installationFee = text === 'yes' ? parseFloat(userState.pendingProduct.InstallationFee) : 0;
                item.total = item.sqmPrice + item.designFee + item.polesCost + item.installationFee;
                if (!userCarts[jid]) userCarts[jid] = [];
                userCarts[jid].push(item);
                userStates[jid] = { step: 'idle' };
                return sock.sendMessage(jid, {
                    text: `✅ Added to cart! *Total: R${item.total.toFixed(2)}*\nType *cart* to view or *checkout* to order.`
                });
            }
            return sock.sendMessage(jid, { text: "Please reply *yes* or *no*." });
        }

        // ── Main menu / category browsing ───────────────────────────────────
        if (text === 'hello' || text === 'hi' || text === 'menu') {
            const categories = getCategories();
            let reply = "*Welcome! 👋 Our Product Categories:*\n\n";
            categories.forEach((cat, i) => { reply += `${i + 1}. ${cat}\n`; });
            reply += "\nType *products [category]* to browse a category\ne.g. _products Signs_\n\nType *buy [ID]* to order a specific item.";
            return sock.sendMessage(jid, { text: reply });
        }

        if (text.startsWith('products ')) {
            const catName = rawText.substring(9).trim();
            const catProducts = products.filter(p => p.Category.toLowerCase() === catName.toLowerCase());
            if (catProducts.length === 0) {
                return sock.sendMessage(jid, { text: `❓ Category "${catName}" not found. Type *menu* to see categories.` });
            }
            let reply = `*${catName} Products:*\n\n`;
            catProducts.forEach(p => {
                if (p.PriceType === 'sqm') {
                    reply += `*ID ${p.ID}*: ${p.Name}\n`;
                    if (p.Size) reply += `  📏 Size: ${p.Size}\n`;
                    if (p.Finish) reply += `  ✨ Finish: ${p.Finish}\n`;
                    if (p.SingleOrDoubleSided) reply += `  ↔️ Sides: ${p.SingleOrDoubleSided}\n`;
                    if (p.UnitsPerProduct) reply += `  📦 Units per product: ${p.UnitsPerProduct}\n`;
                    reply += `  📐 R${parseFloat(p.PricePerSqm).toFixed(2)}/m² (min R${parseFloat(p.MinPrice).toFixed(2)})\n`;
                    if (parseFloat(p.DesignFee) > 0) reply += `  🎨 Design fee: R${parseFloat(p.DesignFee).toFixed(2)}\n`;
                    if (p.PolesAvailable === 'yes') reply += `  🪧 Poles: R${parseFloat(p.PolePrice).toFixed(2)}/pole\n`;
                    if (parseFloat(p.InstallationFee) > 0) reply += `  🔧 Installation: R${parseFloat(p.InstallationFee).toFixed(2)}\n`;
                } else {
                    const fixedPrice = parseFloat(p.FixedPrice) || 0;
                    reply += `*ID ${p.ID}*: ${p.Name} — R${fixedPrice.toFixed(2)}\n`;
                    if (p.Size) reply += `  📏 Size: ${p.Size}\n`;
                    if (p.Finish) reply += `  ✨ Finish: ${p.Finish}\n`;
                    if (p.SingleOrDoubleSided) reply += `  ↔️ Sides: ${p.SingleOrDoubleSided}\n`;
                    if (p.UnitsPerProduct) reply += `  📦 Units per product: ${p.UnitsPerProduct}\n`;
                }
                reply += '\n';
            });
            reply += `Type *buy [ID]* to order.\ne.g. _buy ${catProducts[0].ID}_`;
            return sock.sendMessage(jid, { text: reply });
        }

        // ── Buy command ─────────────────────────────────────────────────────
        if (text.startsWith('buy ')) {
            const parts = text.split(' ');
            const id = parts[1];
            const product = products.find(p => p.ID === id);
            if (!product) {
                return sock.sendMessage(jid, { text: `❓ Product ID *${id}* not found. Type *menu* to browse.` });
            }
            if (product.PriceType === 'sqm') {
                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                return sock.sendMessage(jid, {
                    text: `📐 *${product.Name}*\nPlease send the *length x breadth in mm*\ne.g. _1200x600_\nAccepted separators: x, X, comma, *\n\nType *cancel* to go back.`
                });
            }
            // Fixed price product
            const price = parseFloat(product.FixedPrice);
            const qty = parseInt(parts[2]) || 1;
            if (!userCarts[jid]) userCarts[jid] = [];
            userCarts[jid].push({
                name: product.Name,
                sqmPrice: price,
                designFee: 0,
                polesCost: 0,
                poles: 0,
                installationFee: 0,
                total: price * qty,
                qty
            });
            return sock.sendMessage(jid, {
                text: `✅ Added ${qty} × *${product.Name}* @ R${price.toFixed(2)} each.\nType *cart* to view or *checkout* to order.`
            });
        }

        // ── Cart ────────────────────────────────────────────────────────────
        if (text === 'cart') {
            const cart = userCarts[jid];
            if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: "🛒 Your cart is empty." });
            let reply = "*🛒 Your Cart:*\n\n";
            let grandTotal = 0;
            cart.forEach((item, i) => {
                reply += `${i + 1}. ${item.name}`;
                if (item.dimensions) reply += ` (${item.dimensions})`;
                if (item.qty > 1) reply += ` ×${item.qty}`;
                reply += ` — R${item.total.toFixed(2)}\n`;
                grandTotal += item.total;
            });
            reply += `\n*Total: R${grandTotal.toFixed(2)}*\nType *checkout* to place order or *clear* to empty cart.`;
            return sock.sendMessage(jid, { text: reply });
        }

        // ── Clear cart ──────────────────────────────────────────────────────
        if (text === 'clear') {
            delete userCarts[jid];
            userStates[jid] = { step: 'idle' };
            return sock.sendMessage(jid, { text: "🗑️ Cart cleared. Type *menu* to start over." });
        }

        // ── Checkout ────────────────────────────────────────────────────────
        if (text === 'checkout') {
            const cart = userCarts[jid];
            if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: "🛒 Your cart is empty." });
            let grandTotal = 0;
            let summary = "*📋 Order Summary:*\n\n";
            cart.forEach((item, i) => {
                summary += `${i + 1}. *${item.name}*`;
                if (item.dimensions) summary += ` (${item.dimensions})`;
                if (item.qty > 1) summary += ` ×${item.qty}`;
                summary += '\n';
                summary += `   Material: R${(item.sqmPrice * (item.qty || 1)).toFixed(2)}\n`;
                if (item.designFee > 0) summary += `   Design/Layout Fee: R${item.designFee.toFixed(2)}\n`;
                if (item.polesCost > 0) summary += `   Poles (×${item.poles}): R${item.polesCost.toFixed(2)}\n`;
                if (item.installationFee > 0) summary += `   Installation: R${item.installationFee.toFixed(2)}\n`;
                summary += `   *Item Total: R${item.total.toFixed(2)}*\n\n`;
                grandTotal += item.total;
            });
            summary += `*GRAND TOTAL: R${grandTotal.toFixed(2)}*`;
            await sock.sendMessage(jid, { text: summary });
            delete userCarts[jid];
            userStates[jid] = { step: 'idle' };
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