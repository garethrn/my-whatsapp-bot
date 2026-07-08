const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    Browsers,
    normalizeMessageContent
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const crypto = require('crypto');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');
const path = require('path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');

// --- YOUR CONFIGURATION ---
const ADMIN_JID = process.env.ADMIN_JID;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const STORAGE_DIR = path.join(__dirname, 'storage');
const CSV_FILE = path.join(__dirname, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');
const LEARNED_RESPONSES_FILE = path.join(STORAGE_DIR, 'learned_responses.json');
const LEARNING_LEADS_FILE = path.join(STORAGE_DIR, 'learning_leads.json');
const MAX_HISTORY = 10;
const MAX_LEARNING_LEADS = 200;
const BUSINESS_NAME = 'Duzi Signs';
const MM_PER_METER = 1000;
// Guardrail for obviously invalid custom sizes (50m in mm).
const MAX_DIMENSION_MM = 50000;
// Minimum similarity score (0-1) for a stored learned reply to be reused.
const LEARNING_MATCH_THRESHOLD = 0.45;
const DIMENSION_FORMAT_EXAMPLE = '1200 x 600 mm';
const ARTWORK_DISCLAIMER = [
    'Artwork Disclaimer',
    '',
    `• ${BUSINESS_NAME} is not responsible for any errors in artwork, whether designed by us or supplied by the customer.`,
    '• Colours may vary due to different screens, software, materials, and printing processes.',
    '• If you require an exact colour match, please request a sample print before production. Sample prints must be viewed and approved in person. Please note that requesting a sample will delay your order.',
    '• Once artwork has been approved and printing has started, no reprints or refunds will be given for approved colours, layout, spelling, or design.',
    '• AI-generated artwork cannot always be edited, recreated, or printed in high quality, especially for large-format printing.',
    '• Customer-supplied artwork can only be edited if an editable file is provided.'
].join('\n');
const HUMAN_KEYWORDS = ['human', 'person', 'agent', 'consultant', 'staff', 'help me', 'call me', 'speak to someone', 'speak to a human', 'handover'];
const FRUSTRATION_KEYWORDS = ['frustrated', 'angry', 'upset', 'annoyed', 'not helping', 'complaint', 'terrible', 'useless', 'confused', 'speak to manager', 'scam', 'fraud'];
const DEFAULT_RESTART_DELAY_MS = 5000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;

const whatsappRuntime = {
    phase: 'booting',
    lastUpdatedAt: new Date().toISOString(),
    lastError: null
};
let botRestartTimer = null;
let activeSocketGeneration = 0;
// Current QR stored as a PNG data URI (base64); null when no QR is pending
let currentQrDataUri = null;

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

function setWhatsAppPhase(phase, lastError = null) {
    whatsappRuntime.phase = phase;
    whatsappRuntime.lastUpdatedAt = new Date().toISOString();
    whatsappRuntime.lastError = lastError ? String(lastError.message || lastError) : null;
    console.log(`ℹ️ WhatsApp status: ${phase}`);
    if (whatsappRuntime.lastError) {
        console.error('⚠️ WhatsApp status detail:', whatsappRuntime.lastError);
    }
}

function scheduleBotRestart(reason, delayMs = DEFAULT_RESTART_DELAY_MS) {
    if (botRestartTimer) return;

    setWhatsAppPhase('reconnecting', reason);
    console.log(`🔁 Restarting WhatsApp Engine in ${Math.round(delayMs / 1000)}s...`);
    botRestartTimer = setTimeout(() => {
        botRestartTimer = null;
        startBot();
    }, delayMs);
}

function clearBotRestartTimer() {
    if (!botRestartTimer) return;
    clearTimeout(botRestartTimer);
    botRestartTimer = null;
}

function extractDisconnectStatusCode(error) {
    if (!error) return 0;
    if (error instanceof Boom) return error.output.statusCode || 0;
    return error?.output?.statusCode || error?.data?.statusCode || 0;
}

function getRailwayQrUrl() {
    const rawHost = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
    if (!rawHost) return null;
    try {
        const hostWithProtocol = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
        const url = new URL(hostWithProtocol);
        return `${url.origin}/qr`;
    } catch (error) {
        console.warn('⚠️ Could not build Railway QR URL from RAILWAY_PUBLIC_DOMAIN / RAILWAY_STATIC_URL:', error?.message || error);
        return null;
    }
}

function validateConfig() {
    const missingConfig = [
        ['ADMIN_JID', ADMIN_JID],
        ['EMAIL_USER', EMAIL_USER],
        ['EMAIL_PASS', EMAIL_PASS]
    ].filter(([, value]) => !value).map(([key]) => key);

    if (missingConfig.length > 0) {
        console.error(`❌ Missing required environment variables: ${missingConfig.join(', ')}`);
        process.exit(1);
    }

    if (!ADMIN_JID.endsWith('@s.whatsapp.net')) {
        console.error('❌ ADMIN_JID must end with @s.whatsapp.net');
        process.exit(1);
    }

    const phonePart = ADMIN_JID.replace('@s.whatsapp.net', '');
    if (!/^\d+$/.test(phonePart)) {
        console.error('❌ ADMIN_JID must contain only digits before @s.whatsapp.net');
        process.exit(1);
    }

}

validateConfig();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

let products = [];
let userCarts = {};
let userStates = {};
let learnedResponses = loadJsonFile(LEARNED_RESPONSES_FILE, []);
let learningLeads = loadJsonFile(LEARNING_LEADS_FILE, []);
let handoverSessions = {};
let conversationHistory = {};
let userNames = {};
let fallbackCounts = {};

function loadJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`⚠️ Could not read ${path.basename(filePath)}:`, error.message);
        return fallbackValue;
    }
}

function saveJsonFile(filePath, value) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch (error) {
        console.error(`❌ Failed to write ${path.basename(filePath)}:`, error.message);
    }
}

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
        .pipe(csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim() }))
        .on('data', (d) => results.push(d))
        .on('end', () => {
            products = results;
            console.log('✅ Inventory Loaded');
        });
}
loadProducts();

// Ordered from most-specific to least-specific so the first matching entry wins
const PRODUCT_KEYWORD_MAP = [
    { keywords: ['business card', 'biz card', 'visiting card', 'business cards', 'biz cards'], ids: ['12'] },
    { keywords: ['a5 flyer', 'a5 leaflet', 'a5 flyers'], ids: ['13'] },
    { keywords: ['a4 flyer', 'a4 poster', 'a4 flyers'], ids: ['14'] },
    { keywords: ['flyer', 'leaflet', 'pamphlet'], ids: ['13'] },
    { keywords: ['poster'], ids: ['14'] },
    { keywords: ['pull-up banner', 'pull up banner', 'popup banner', 'retractable banner', 'roller banner'], ids: ['2'] },
    { keywords: ['mesh banner'], ids: ['3'] },
    { keywords: ['vinyl banner'], ids: ['1'] },
    { keywords: ['banner'], ids: ['1', '2', '3'] },
    { keywords: ['aluminium composite', 'acm sign', 'aluminium sign', 'alu composite'], ids: ['4'] },
    { keywords: ['corflute sign', 'corflute'], ids: ['5'] },
    { keywords: ['a-frame', 'pavement sign', 'sandwich board'], ids: ['6'] },
    { keywords: ['frosted window', 'frosted vinyl', 'window vinyl', 'frosted glass'], ids: ['9'] },
    { keywords: ['cut vinyl sticker', 'cut vinyl'], ids: ['7'] },
    { keywords: ['printed vinyl sticker', 'vinyl sticker'], ids: ['8'] },
    { keywords: ['sticker', 'label'], ids: ['7', '8', '9'] },
    { keywords: ['t-shirt', 'tshirt', 't shirt', 'shirt'], ids: ['10'] },
    { keywords: ['hoodie', 'hoody'], ids: ['11'] },
    { keywords: ['full vehicle wrap', 'vehicle wrap', 'car wrap', 'full wrap'], ids: ['15'] },
    { keywords: ['car decal', 'door sticker', 'door decal', 'vehicle decal'], ids: ['16'] },
    { keywords: ['decal'], ids: ['16'] },
];

function findProductsByKeyword(text) {
    const normalized = text.toLowerCase().replace(/-/g, ' ');
    for (const mapping of PRODUCT_KEYWORD_MAP) {
        for (const kw of mapping.keywords) {
            if (normalized.includes(kw)) {
                return mapping.ids.map((id) => products.find((p) => p.ID === id)).filter(Boolean);
            }
        }
    }
    return [];
}

function extractQuantityFromText(text) {
    const match = text.match(/\b(\d{1,6})\b/);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function calcFixedQuoteForQty(product, qty) {
    const unitsPerPack = parseInt(product.UnitsPerProduct, 10) || 1;
    const packPrice = toNumber(product.FixedPrice);
    const packs = Math.ceil(qty / unitsPerPack);
    return packs * packPrice;
}

function greetUser(jid) {
    const name = userNames[jid];
    return name ? `Hi ${name}! 👋` : 'Hi there! 👋';
}

function buildWelcomeText(jid) {
    return `${greetUser(jid)} Welcome to *${BUSINESS_NAME}* 🖨️\nHow can I help with your printing today – quotes, orders, or info?\n\nSend *menu* to browse our products, or just tell me what you need! 😊`;
}

function buildProductListText() {
    return [
        `Here's what we print at *${BUSINESS_NAME}*:`,
        '',
        '• Business Cards',
        '• Flyers & Leaflets',
        '• Posters',
        '• Banners (Vinyl, Pull-Up, Mesh)',
        '• Stickers & Labels',
        '• Signs (Aluminium, Corflute, A-Frame)',
        '• Clothing (T-Shirts, Hoodies)',
        '• Vehicle Branding & Decals',
        '',
        "Anything specific you're looking for? Type *menu* to browse our full catalogue or ask for a *quote*! 😊"
    ].join('\n');
}

function getCategories() {
    return [...new Set(products.map((p) => p.Category))];
}

function toNumber(value, fallback = 0) {
    const parsed = parseFloat(String(value ?? '').replace(/^[^\d.-]+/, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCurrency(value) {
    return `R${toNumber(value).toFixed(2)}`;
}

// Calculate sqm price from mm dimensions, applying the minimum price floor
function calcSqmPrice(product, lengthMm, heightMm) {
    const sqm = (lengthMm / MM_PER_METER) * (heightMm / MM_PER_METER);
    const price = sqm * toNumber(product.PricePerSqm);
    return Math.max(price, toNumber(product.MinPrice));
}

// Parse dimensions such as 1200x600, 1200mm x 600mm, length 1200 height 600
function parseDimensions(text) {
    const cleaned = text.replace(/mm/gi, ' ').replace(/\bby\b/gi, ' x ');
    const values = cleaned.match(/\d+(?:\.\d+)?/g);
    if (!values || values.length < 2) return null;
    if (values.length !== 2) return { error: 'invalid_count' };

    const length = parseFloat(values[0]);
    const height = parseFloat(values[1]);

    if (!Number.isFinite(length) || !Number.isFinite(height)) return null;
    if (length <= 0 || height <= 0) return { error: 'non_positive', length, height };
    if (length > MAX_DIMENSION_MM || height > MAX_DIMENSION_MM) return { error: 'too_large', length, height };

    return { length, height };
}

function buildMenuText() {
    const categories = getCategories();
    if (categories.length === 0) {
        return '⏳ The product catalogue is still loading. Please send *menu* again in a moment.';
    }

    let reply = '*Welcome! 👋 Our Product Categories:*\n\n';
    categories.forEach((cat, i) => {
        reply += `${i + 1}. ${cat}\n`;
    });
    reply += '\nType *products [category]* to browse a category\ne.g. _products Signs_';
    reply += '\nType *buy [ID]* to order an item';
    reply += '\nType *cart* to review your basket';
    reply += '\nType *human* if you would like a team member to take over.';
    return reply;
}

function buildHelpText() {
    return [
        '*How I can help:*',
        '',
        '- Send *menu* to see categories',
        '- Send *products Signs* (or another category) to browse',
        '- Send *buy [ID]* to start an order',
        '- For sqm products, send *length x height in mm* (example: _1200 x 600 mm_)',
        '- Send *cart* to see your basket',
        '- Send *checkout* to review your total and confirm the order',
        '- Send *human* any time if you want a person to take over'
    ].join('\n');
}

function buildCartText(cart) {
    let reply = '*🛒 Your Cart:*\n\n';
    let grandTotal = 0;

    cart.forEach((item, i) => {
        reply += `${i + 1}. ${item.name}`;
        if (item.dimensions) reply += ` (${item.dimensions})`;
        if (item.qty > 1) reply += ` ×${item.qty}`;
        reply += ` — ${formatCurrency(item.total)}\n`;
        grandTotal += item.total;
    });

    reply += `\n*Total: ${formatCurrency(grandTotal)}*\nType *checkout* to confirm or *clear* to empty the cart.`;
    return reply;
}

function buildOrderSummary(cart, options = {}) {
    const includeDisclaimer = options.includeDisclaimer || false;
    let grandTotal = 0;
    let summary = '*📋 Order Summary:*\n\n';

    cart.forEach((item, i) => {
        summary += `${i + 1}. *${item.name}*`;
        if (item.dimensions) summary += ` (${item.dimensions})`;
        if (item.qty > 1) summary += ` ×${item.qty}`;
        summary += '\n';
        summary += `   Material: ${formatCurrency((item.sqmPrice || 0) * (item.qty || 1))}\n`;
        if (item.designFee > 0) summary += `   Design/Layout Fee: ${formatCurrency(item.designFee)}\n`;
        if (item.polesCost > 0) summary += `   Poles (×${item.poles}): ${formatCurrency(item.polesCost)}\n`;
        if (item.installationFee > 0) summary += `   Installation: ${formatCurrency(item.installationFee)}\n`;
        summary += `   *Item Total: ${formatCurrency(item.total)}*\n\n`;
        grandTotal += item.total;
    });

    summary += `*Grand Total: ${formatCurrency(grandTotal)}*`;

    if (includeDisclaimer) {
        summary += `\n\n*Please review and accept before production:*\n${ARTWORK_DISCLAIMER}`;
    }

    return { summary, grandTotal };
}

function normalizeText(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeText(text) {
    return normalizeText(text)
        .split(' ')
        .filter((token) => token.length > 1);
}

function scorePattern(input, sample) {
    if (!input || !sample) return 0;
    if (input === sample) return 1;
    if (input.includes(sample) || sample.includes(input)) return 0.85;

    const inputTokens = new Set(tokenizeText(input));
    const sampleTokens = new Set(tokenizeText(sample));
    if (inputTokens.size === 0 || sampleTokens.size === 0) return 0;

    const overlap = [...inputTokens].filter((token) => sampleTokens.has(token)).length;
    return overlap / Math.max(inputTokens.size, sampleTokens.size);
}

function findLearnedResponse(text) {
    const normalizedInput = normalizeText(text);
    if (!normalizedInput) return null;

    let bestMatch = null;
    let bestScore = 0;

    for (const entry of learnedResponses) {
        const score = scorePattern(normalizedInput, normalizeText(entry.question));
        if (score > bestScore) {
            bestScore = score;
            bestMatch = entry;
        }
    }

    if (bestScore >= LEARNING_MATCH_THRESHOLD) {
        return bestMatch;
    }

    return null;
}

function recordLearningLead(jid, message) {
    const normalized = normalizeText(message);
    if (!normalized) return;

    const existingLead = learningLeads.find((lead) => lead.normalized === normalized);
    if (existingLead) {
        existingLead.count += 1;
        existingLead.lastSeen = new Date().toISOString();
        existingLead.lastUser = jid;
        existingLead.example = message.trim();
    } else {
        learningLeads.unshift({
            normalized,
            example: message.trim(),
            count: 1,
            lastUser: jid,
            lastSeen: new Date().toISOString()
        });
    }

    learningLeads = learningLeads
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_LEARNING_LEADS);
    saveJsonFile(LEARNING_LEADS_FILE, learningLeads);
}

function rememberConversation(jid, text) {
    if (!text) return;
    if (!conversationHistory[jid]) conversationHistory[jid] = [];
    conversationHistory[jid].push(text.trim());
    conversationHistory[jid] = conversationHistory[jid].slice(-MAX_HISTORY);
}

function getConversationPreview(jid) {
    const history = conversationHistory[jid] || [];
    if (history.length === 0) return 'No recent customer messages captured yet.';

    return history
        .slice(-5)
        .map((entry, index) => `${index + 1}. ${entry}`)
        .join('\n');
}

function isHumanRequest(text) {
    return HUMAN_KEYWORDS.some((keyword) => text.includes(keyword));
}

function isFrustratedMessage(text) {
    return FRUSTRATION_KEYWORDS.some((keyword) => text.includes(keyword));
}

function toWhatsAppJid(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) return null;
    if (trimmed.includes('@')) return trimmed;

    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function extractMessageContent(msg) {
    return normalizeMessageContent(msg?.message) || msg?.message || null;
}

function extractMessageText(messageContent) {
    if (!messageContent) return '';

    const text = messageContent.conversation
        || messageContent.extendedTextMessage?.text
        || messageContent.imageMessage?.caption
        || messageContent.videoMessage?.caption
        || messageContent.documentMessage?.caption
        || messageContent.buttonsResponseMessage?.selectedDisplayText
        || messageContent.listResponseMessage?.title
        || messageContent.listResponseMessage?.singleSelectReply?.selectedRowId
        || messageContent.templateButtonReplyMessage?.selectedDisplayText
        || messageContent.templateButtonReplyMessage?.selectedId
        || '';

    return typeof text === 'string' ? text.trim() : '';
}

function isAuthorizedQrRequest(token) {
    if (!QR_ACCESS_TOKEN) return true;
    if (typeof token !== 'string') return false;

    const expected = Buffer.from(QR_ACCESS_TOKEN, 'utf8');
    const received = Buffer.from(token, 'utf8');
    if (expected.length !== received.length) return false;

    return crypto.timingSafeEqual(expected, received);
}

function getQrAccessToken(req) {
    const authorization = req.get('authorization') || '';
    if (authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim();
    }

    const headerToken = req.get('x-qr-access-token');
    return typeof headerToken === 'string' ? headerToken.trim() : '';
}

async function activateHumanHandover(sock, jid, reason) {
    handoverSessions[jid] = {
        active: true,
        reason,
        requestedAt: new Date().toISOString()
    };

    const cart = userCarts[jid] || [];
    const cartSummary = cart.length > 0 ? buildOrderSummary(cart).summary : 'No items in cart yet.';
    const adminNotice = [
        '🤝 *Human handover requested*',
        `Customer: ${jid}`,
        `Reason: ${reason}`,
        '',
        '*Recent customer messages:*',
        getConversationPreview(jid),
        '',
        '*Current cart:*',
        cartSummary,
        '',
        `When you are done, send *resume ${jid}* to return this customer to the bot.`
    ].join('\n');

    await sock.sendMessage(ADMIN_JID, { text: adminNotice });
    await sock.sendMessage(jid, {
        text: `🤝 A ${BUSINESS_NAME} team member has been asked to take over. We will stop the automated replies for now so that a human can assist you properly.`
    });
}

async function submitOrderForReview(sock, jid, cart) {
    const { summary } = buildOrderSummary(cart);
    const adminMessage = [
        '🆕 *New order request*',
        `Customer: ${jid}`,
        'Artwork disclaimer accepted: Yes',
        '',
        summary
    ].join('\n');

    await sock.sendMessage(ADMIN_JID, { text: adminMessage });
}

async function startBot() {
    console.log('🔄 Initializing WhatsApp Engine...');
    setWhatsAppPhase('initializing');

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        let version;
        try {
            const latestVersion = await fetchLatestBaileysVersion();
            version = latestVersion.version;
            console.log(`ℹ️ WhatsApp Web version: ${version.join('.')} (${latestVersion.isLatest ? 'latest' : 'fallback'})`);
        } catch (versionError) {
            console.warn('⚠️ Could not fetch latest WhatsApp Web version; continuing with Baileys built-in default:', versionError?.message || versionError);
        }

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'error' }),
            browser: Browsers.appropriate('Desktop'),
            ...(version ? { version } : {})
        });
        const socketGeneration = ++activeSocketGeneration;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            if (socketGeneration !== activeSocketGeneration) return;
            try {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    setWhatsAppPhase('awaiting_qr');
                    // Store QR in memory as a data URI so /qr always serves the latest one
                    currentQrDataUri = await qrcodeImg.toDataURL(qr);
                    const railwayUrl = getRailwayQrUrl();
                    const qrUrl = railwayUrl || `http://localhost:${PORT}/qr`;
                    console.log('');
                    console.log('⚠️  ================================================');
                    console.log(`⚠️  QR READY — open this URL to scan: ${qrUrl}`);
                    console.log('⚠️  ================================================');
                    console.log('');
                    // Fire-and-forget email — never block the connection handler on SMTP
                    const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
                    qrcodeImg.toFile(qrPath, qr).then(() => {
                        return transporter.sendMail({
                            from: EMAIL_USER,
                            to: EMAIL_USER,
                            subject: 'WhatsApp Bot Login',
                            text: `Scan the attached QR code to log in.\n\nAlternatively, open ${qrUrl} in your browser.`,
                            attachments: [{ filename: 'bot-qr.png', path: qrPath }]
                        });
                    }).then(() => {
                        console.log(`📧 QR code email sent to ${EMAIL_USER}`);
                    }).catch((err) => {
                        console.error('❌ Failed to email WhatsApp QR code:', err.message);
                    });
                }

                if (connection === 'close') {
                    currentQrDataUri = null; // Clear stale QR on any disconnect
                    const disconnectError = lastDisconnect?.error;
                    const statusCode = extractDisconnectStatusCode(disconnectError);
                    const errorMessage = disconnectError?.message || `Disconnect status ${statusCode || 'unknown'}`;
                    console.error('🔌 WhatsApp connection closed:', {
                        statusCode: statusCode || 'unknown',
                        reason: errorMessage
                    });
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        setWhatsAppPhase('logged_out', errorMessage);
                        try {
                            if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        } catch (cleanupError) {
                            console.error('⚠️ Failed to clear WhatsApp auth directory:', cleanupError);
                        }
                        scheduleBotRestart(errorMessage, 1000);
                    } else {
                        scheduleBotRestart(errorMessage);
                    }
                } else if (connection === 'open') {
                    currentQrDataUri = null; // No longer needed once connected
                    clearBotRestartTimer();
                    setWhatsAppPhase('connected');
                    console.log('🚀 BOT IS CONNECTED AND LIVE!');
                }
            } catch (error) {
                console.error('❌ Error while handling WhatsApp connection update:', error);
                scheduleBotRestart(error);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            // 'append' carries historical messages replayed on reconnect; only 'notify' is a live incoming message
            if (type !== 'notify') return;
            for (const msg of Array.isArray(messages) ? messages : []) {
                if (socketGeneration !== activeSocketGeneration) return;
                let jid = null;
                try {
                    const key = msg?.key;
                    const messageContent = extractMessageContent(msg);
                    if (!key || !messageContent || key.fromMe) continue;

                    jid = key.remoteJid;
                    if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;

                    const rawText = extractMessageText(messageContent);
                    const text = rawText.toLowerCase();

                    if (!rawText && !messageContent.documentMessage) continue;
                    if (rawText) rememberConversation(jid, rawText);

                    // Capture WhatsApp display name for personalised greetings
                    if (msg.pushName && !userNames[jid]) {
                        userNames[jid] = msg.pushName;
                    }

                    // Admin: upload new CSV via document message
                    if (jid === ADMIN_JID && messageContent.documentMessage) {
                        const doc = messageContent.documentMessage;
                        if (doc.fileName?.toLowerCase().endsWith('.csv')) {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            fs.writeFileSync(CSV_FILE, buffer);
                            loadProducts();
                            await sock.sendMessage(jid, { text: '📦 Products updated!' });
                            continue;
                        }
                    }

                    if (jid === ADMIN_JID && text.startsWith('teach ')) {
                        const payload = rawText.slice(6);
                        const [question, answer] = payload.split(/\s*=>\s*/);
                        if (!question || !answer) {
                            await sock.sendMessage(jid, { text: 'Use *teach question => response*. Example: *teach do you deliver => Yes, we deliver nationwide.*' });
                            continue;
                        }

                        const normalizedQuestion = normalizeText(question);
                        const existing = learnedResponses.find((entry) => normalizeText(entry.question) === normalizedQuestion);
                        if (existing) {
                            existing.question = question.trim();
                            existing.response = answer.trim();
                            existing.updatedAt = new Date().toISOString();
                        } else {
                            learnedResponses.push({
                                question: question.trim(),
                                response: answer.trim(),
                                createdAt: new Date().toISOString()
                            });
                        }

                        saveJsonFile(LEARNED_RESPONSES_FILE, learnedResponses);
                        await sock.sendMessage(jid, { text: `🧠 Learned reply saved for: *${question.trim()}*` });
                        continue;
                    }

                    if (jid === ADMIN_JID && text === 'leads') {
                        if (learningLeads.length === 0) {
                            await sock.sendMessage(jid, { text: 'No learning leads captured yet.' });
                            continue;
                        }

                        const topLeads = [...learningLeads]
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 10)
                            .map((lead, index) => `${index + 1}. ${lead.example} (${lead.count} time(s))`)
                            .join('\n');
                        await sock.sendMessage(jid, { text: `*Top unanswered messages:*\n\n${topLeads}` });
                        continue;
                    }

                    if (jid === ADMIN_JID && text === 'handovers') {
                        const activeHandovers = Object.entries(handoverSessions).filter(([, session]) => session.active);
                        if (activeHandovers.length === 0) {
                            await sock.sendMessage(jid, { text: 'There are no active human handovers right now.' });
                            continue;
                        }

                        const handoverList = activeHandovers
                            .map(([customerJid, session], index) => `${index + 1}. ${customerJid} — ${session.reason}`)
                            .join('\n');
                        await sock.sendMessage(jid, { text: `*Active handovers:*\n\n${handoverList}` });
                        continue;
                    }

                    if (jid === ADMIN_JID && text.startsWith('resume ')) {
                        const targetJid = toWhatsAppJid(rawText.slice('resume '.length));
                        if (!targetJid) {
                            await sock.sendMessage(jid, { text: 'Use *resume 27123456789* or *resume 27123456789@s.whatsapp.net*.' });
                            continue;
                        }
                        if (!handoverSessions[targetJid]?.active) {
                            await sock.sendMessage(jid, { text: `No active handover found for *${targetJid}*.` });
                            continue;
                        }

                        delete handoverSessions[targetJid];
                        await sock.sendMessage(targetJid, { text: '✅ A team member has finished helping. I can assist you again now — send *menu* or *cart* when you are ready.' });
                        await sock.sendMessage(jid, { text: `Bot control restored for *${targetJid}*.` });
                        continue;
                    }

                    if (handoverSessions[jid]?.active && jid !== ADMIN_JID) {
                        continue;
                    }

                    if (jid !== ADMIN_JID && rawText && (isHumanRequest(text) || isFrustratedMessage(text))) {
                        await activateHumanHandover(sock, jid, rawText);
                        continue;
                    }

                    const userState = userStates[jid] || { step: 'idle' };

                // Cancel / escape from any mid-flow state
                    if (text === 'cancel' || text === 'menu' || /^(hello|hi|hey)\b/.test(text)) {
                        if (userState.step !== 'idle') {
                            userStates[jid] = { step: 'idle' };
                        }
                        if (text === 'cancel') {
                            await sock.sendMessage(jid, { text: '❌ Cancelled. Type *menu* to start over.' });
                            continue;
                        }
                        if (/^(hello|hi|hey)\b/.test(text)) {
                            fallbackCounts[jid] = 0;
                            await sock.sendMessage(jid, { text: buildWelcomeText(jid) });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: buildMenuText() });
                        continue;
                    }

                    if (text === 'help') {
                        await sock.sendMessage(jid, { text: buildHelpText() });
                        continue;
                    }

                // ── State: awaiting_dimensions ──────────────────────────────────────
                    if (userState.step === 'awaiting_dimensions') {
                    const dims = parseDimensions(rawText);
                    if (!dims) {
                        await sock.sendMessage(jid, {
                            text: `❓ I could not read a valid size from that message.\nPlease send *length x height in mm* (for example _${DIMENSION_FORMAT_EXAMPLE}_).\n\nType *cancel* to go back or *human* if you want a person to help.`
                        });
                        continue;
                    }
                    if (dims.error === 'non_positive') {
                        await sock.sendMessage(jid, {
                            text: `⚠️ Please use positive measurements only. Send the *length x height in mm* again, for example _${DIMENSION_FORMAT_EXAMPLE}_.`
                        });
                        continue;
                    }
                    if (dims.error === 'invalid_count') {
                        await sock.sendMessage(jid, {
                            text: `⚠️ Please send only *two* measurements: *length x height in mm*. Example: _${DIMENSION_FORMAT_EXAMPLE}_.`
                        });
                        continue;
                    }
                    if (dims.error === 'too_large') {
                        await sock.sendMessage(jid, {
                            text: `⚠️ Those dimensions exceed our maximum of ${MAX_DIMENSION_MM}mm. Please send the *length x height in mm* again, for example _${DIMENSION_FORMAT_EXAMPLE}_.`
                        });
                        continue;
                    }

                    const product = userState.pendingProduct;
                    const sqmPrice = calcSqmPrice(product, dims.length, dims.height);
                    const designFee = toNumber(product.DesignFee);
                    const sqm = (dims.length / MM_PER_METER) * (dims.height / MM_PER_METER);

                    let reply = `📐 *${product.Name}*\n`;
                    reply += `Length: ${dims.length}mm\n`;
                    reply += `Height: ${dims.height}mm\n`;
                    reply += `Area: ${sqm.toFixed(2)} m²\n`;
                    reply += `Material: ${formatCurrency(sqmPrice)}\n`;
                    if (designFee > 0) reply += `Design/Layout Fee: ${formatCurrency(designFee)}\n`;

                    const pendingItem = {
                        name: product.Name,
                        dimensions: `${dims.length}×${dims.height}mm`,
                        sqmPrice,
                        designFee,
                        polesCost: 0,
                        poles: 0,
                        installationFee: 0,
                        qty: 1
                    };

                    if (product.PolesAvailable === 'yes') {
                        userStates[jid] = { step: 'awaiting_poles', pendingProduct: product, pendingItem };
                        reply += `\nWould you like to add *poles*?\nPrice per pole: ${formatCurrency(product.PolePrice)}\nReply *yes* or *no*.`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }
                    if (toNumber(product.InstallationFee) > 0) {
                        userStates[jid] = { step: 'awaiting_installation', pendingProduct: product, pendingItem };
                        reply += `\nWould you like *installation*? ${formatCurrency(product.InstallationFee)}\nReply *yes* or *no*.`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }

                    const total = sqmPrice + designFee;
                    pendingItem.total = total;
                    if (!userCarts[jid]) userCarts[jid] = [];
                    userCarts[jid].push(pendingItem);
                    userStates[jid] = { step: 'idle' };
                    reply += `\n*Total: ${formatCurrency(total)}*\n✅ Added to cart! Type *cart* to view it or *checkout* when you are ready.`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }

                // ── State: awaiting_poles ───────────────────────────────────────────
                    if (userState.step === 'awaiting_poles') {
                    if (text === 'yes') {
                        userStates[jid] = { ...userState, step: 'awaiting_pole_count' };
                        await sock.sendMessage(jid, {
                            text: `How many poles do you need?\nPrice per pole: ${formatCurrency(userState.pendingProduct.PolePrice)}\n\nType *cancel* to go back.`
                        });
                        continue;
                    }
                    if (text === 'no') {
                        const instFee = toNumber(userState.pendingProduct.InstallationFee);
                        if (instFee > 0) {
                            userStates[jid] = { ...userState, step: 'awaiting_installation' };
                            await sock.sendMessage(jid, {
                                text: `Would you like *installation*? ${formatCurrency(instFee)}\nReply *yes* or *no*.`
                            });
                            continue;
                        }
                        const item = userState.pendingItem;
                        item.total = item.sqmPrice + item.designFee;
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'idle' };
                        await sock.sendMessage(jid, {
                            text: `✅ Added to cart! *Total: ${formatCurrency(item.total)}*\nType *cart* to view it or *checkout* to order.`
                        });
                        continue;
                    }
                        await sock.sendMessage(jid, { text: 'Please reply *yes* or *no*.' });
                        continue;
                    }

                // ── State: awaiting_pole_count ──────────────────────────────────────
                    if (userState.step === 'awaiting_pole_count') {
                    const count = parseInt(text, 10);
                    if (Number.isNaN(count) || count < 1) {
                        await sock.sendMessage(jid, { text: 'Please enter a valid number of poles (for example _2_).' });
                        continue;
                    }
                    const polePrice = toNumber(userState.pendingProduct.PolePrice);
                    const polesCost = count * polePrice;
                    const updatedItem = { ...userState.pendingItem, polesCost, poles: count };
                    const instFee = toNumber(userState.pendingProduct.InstallationFee);

                    if (instFee > 0) {
                        userStates[jid] = { ...userState, step: 'awaiting_installation', pendingItem: updatedItem };
                        await sock.sendMessage(jid, {
                            text: `${count} pole(s) added: ${formatCurrency(polesCost)}\n\nWould you like *installation*? ${formatCurrency(instFee)}\nReply *yes* or *no*.`
                        });
                        continue;
                    }
                    const total = updatedItem.sqmPrice + updatedItem.designFee + polesCost;
                    updatedItem.total = total;
                    if (!userCarts[jid]) userCarts[jid] = [];
                    userCarts[jid].push(updatedItem);
                    userStates[jid] = { step: 'idle' };
                        await sock.sendMessage(jid, {
                        text: `✅ Added to cart! *Total: ${formatCurrency(total)}*\nType *cart* to view it or *checkout* to order.`
                    });
                        continue;
                    }

                // ── State: awaiting_installation ────────────────────────────────────
                    if (userState.step === 'awaiting_installation') {
                    if (text === 'yes' || text === 'no') {
                        const item = userState.pendingItem;
                        item.installationFee = text === 'yes' ? toNumber(userState.pendingProduct.InstallationFee) : 0;
                        item.total = item.sqmPrice + item.designFee + item.polesCost + item.installationFee;
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'idle' };
                        await sock.sendMessage(jid, {
                            text: `✅ Added to cart! *Total: ${formatCurrency(item.total)}*\nType *cart* to view it or *checkout* to order.`
                        });
                        continue;
                    }
                        await sock.sendMessage(jid, { text: 'Please reply *yes* or *no*.' });
                        continue;
                    }

                // ── State: awaiting_checkout_confirmation ───────────────────────────
                    if (userState.step === 'awaiting_checkout_confirmation') {
                    if (['confirm', 'yes', 'submit', 'place order'].includes(text)) {
                        const cart = userState.pendingCart || userCarts[jid] || [];
                        if (cart.length === 0) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                            continue;
                        }

                        await submitOrderForReview(sock, jid, cart);
                        delete userCarts[jid];
                        userStates[jid] = { step: 'idle' };
                        await sock.sendMessage(jid, {
                            text: `✅ Thank you. Your quote/request has been sent to ${BUSINESS_NAME} for follow-up. A team member will contact you if anything needs clarification.`
                        });
                        continue;
                    }

                        await sock.sendMessage(jid, {
                        text: 'Please reply *confirm* to accept the artwork disclaimer and submit your order, or send *human* if you want a person to assist.'
                    });
                        continue;
                    }

                // ── State: awaiting_quote_product ───────────────────────────────────
                    if (userState.step === 'awaiting_quote_product') {
                        const matches = findProductsByKeyword(text);
                        if (matches.length === 0) {
                            await sock.sendMessage(jid, { text: `I couldn't find that product. Could you clarify? E.g. _business cards_, _flyers_, _banners_.\n\nType *cancel* to go back.` });
                            continue;
                        }
                        if (matches.length === 1) {
                            const product = matches[0];
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nTo give you an accurate quote, please send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! How many do you need?` });
                            continue;
                        }
                        const list = matches.map((p, i) => `${i + 1}) ${p.Name}`).join('\n');
                        userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: matches };
                        await sock.sendMessage(jid, { text: `We have a few options:\n${list}\n\nReply with the number.` });
                        continue;
                    }

                // ── State: awaiting_quote_product_selection ─────────────────────────
                    if (userState.step === 'awaiting_quote_product_selection') {
                        const idx = parseInt(text, 10) - 1;
                        const matches = userState.pendingMatches || [];
                        if (Number.isNaN(idx) || idx < 0 || idx >= matches.length) {
                            await sock.sendMessage(jid, { text: `Please reply with a number between 1 and ${matches.length}.` });
                            continue;
                        }
                        const product = matches[idx];
                        if (product.PriceType === 'sqm') {
                            userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                            continue;
                        }
                        userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                        await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! How many do you need?` });
                        continue;
                    }

                // ── State: awaiting_quote_quantity ──────────────────────────────────
                    if (userState.step === 'awaiting_quote_quantity') {
                        const qty = extractQuantityFromText(text);
                        if (!qty) {
                            await sock.sendMessage(jid, { text: `Please enter a valid quantity (e.g. _500_). Type *cancel* to go back.` });
                            continue;
                        }
                        const product = userState.pendingProduct;
                        const total = calcFixedQuoteForQty(product, qty);
                        const unitsPerPack = parseInt(product.UnitsPerProduct, 10) || 1;
                        const packs = Math.ceil(qty / unitsPerPack);
                        let quoteText = `💰 *Quote for ${qty.toLocaleString()} × ${product.Name}*\n`;
                        if (unitsPerPack > 1) quoteText += `(${packs} pack${packs > 1 ? 's' : ''} of ${unitsPerPack})\n`;
                        quoteText += `Estimated total: *${formatCurrency(total)}* (incl. VAT, excl. delivery)\n\nWould you like to add this to your cart? Reply *yes* or *no*.\n\n– ${BUSINESS_NAME} Team`;
                        userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: total };
                        await sock.sendMessage(jid, { text: quoteText });
                        continue;
                    }

                // ── State: awaiting_quote_confirm ───────────────────────────────────
                    if (userState.step === 'awaiting_quote_confirm') {
                        if (['yes', 'y', 'add', 'yes add', 'yeah', 'yep', 'sure'].includes(text)) {
                            const product = userState.pendingProduct;
                            const qty = userState.pendingQty;
                            const total = userState.pendingTotal;
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push({
                                name: product.Name,
                                sqmPrice: toNumber(product.FixedPrice),
                                designFee: 0,
                                polesCost: 0,
                                poles: 0,
                                installationFee: 0,
                                total,
                                qty
                            });
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `✅ Added to your cart! You have ${userCarts[jid].length} item(s). Type *cart* to view or *checkout* to order. 😊\n\n– ${BUSINESS_NAME} Team` });
                            continue;
                        }
                        if (['no', 'n', 'nope', 'nah'].includes(text)) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `No problem! Let me know if you need anything else. Type *menu* or ask for another *quote*. 😊` });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: `Please reply *yes* to add to cart or *no* to cancel.` });
                        continue;
                    }

                // ── State: awaiting_add_product ─────────────────────────────────────
                    if (userState.step === 'awaiting_add_product') {
                        const qty = extractQuantityFromText(text) || userState.pendingQty || 1;
                        const matches = findProductsByKeyword(text);
                        if (matches.length === 0) {
                            await sock.sendMessage(jid, { text: `I couldn't find that product. What would you like to add? E.g. _500 A5 flyers_, _100 business cards_.\n\nType *cancel* to go back.` });
                            continue;
                        }
                        if (matches.length === 1) {
                            const product = matches[0];
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            const total = calcFixedQuoteForQty(product, qty);
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push({ name: product.Name, sqmPrice: toNumber(product.FixedPrice), designFee: 0, polesCost: 0, poles: 0, installationFee: 0, total, qty });
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `✅ Got it! I've added ${qty.toLocaleString()} × *${product.Name}* to your cart.\nWould you like to add anything else? (Type *cart* to view, *quote* for a price, or *checkout* to order.) 😊` });
                            continue;
                        }
                        const list = matches.map((p, i) => `${i + 1}) ${p.Name}`).join('\n');
                        userStates[jid] = { step: 'awaiting_add_product_selection', pendingMatches: matches, pendingQty: qty };
                        await sock.sendMessage(jid, { text: `We have a few options:\n${list}\n\nWhich one would you like to add?` });
                        continue;
                    }

                // ── State: awaiting_add_product_selection ───────────────────────────
                    if (userState.step === 'awaiting_add_product_selection') {
                        const idx = parseInt(text, 10) - 1;
                        const matches = userState.pendingMatches || [];
                        const qty = userState.pendingQty || 1;
                        if (Number.isNaN(idx) || idx < 0 || idx >= matches.length) {
                            await sock.sendMessage(jid, { text: `Please reply with a number between 1 and ${matches.length}.` });
                            continue;
                        }
                        const product = matches[idx];
                        if (product.PriceType === 'sqm') {
                            userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                            continue;
                        }
                        const total = calcFixedQuoteForQty(product, qty);
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push({ name: product.Name, sqmPrice: toNumber(product.FixedPrice), designFee: 0, polesCost: 0, poles: 0, installationFee: 0, total, qty });
                        userStates[jid] = { step: 'idle' };
                        await sock.sendMessage(jid, { text: `✅ Got it! I've added ${qty.toLocaleString()} × *${product.Name}* to your cart.\nWould you like to add anything else? (Type *cart* to view, *quote* for a price, or *checkout* to order.) 😊` });
                        continue;
                    }

                // ── State: awaiting_remove_selection ───────────────────────────────
                    if (userState.step === 'awaiting_remove_selection') {
                        const idx = parseInt(text, 10) - 1;
                        const cart = userCarts[jid] || [];
                        if (Number.isNaN(idx) || idx < 0 || idx >= cart.length) {
                            await sock.sendMessage(jid, { text: `Please reply with a number between 1 and ${cart.length}.` });
                            continue;
                        }
                        const removedItem = cart[idx];
                        userCarts[jid].splice(idx, 1);
                        userStates[jid] = { step: 'idle' };
                        const remaining = userCarts[jid].length;
                        await sock.sendMessage(jid, { text: `I've removed *${removedItem.name}* from your cart. Your updated cart has ${remaining} item(s). Type *cart* to view.` });
                        continue;
                    }

                // ── Main menu / category browsing ───────────────────────────────────
                    if (text === 'products') {
                        await sock.sendMessage(jid, { text: 'Please send *products [category]*, for example _products Signs_.' });
                        continue;
                    }

                    if (text.startsWith('products ')) {
                    const catName = rawText.substring(9).trim();
                    const catProducts = products.filter((p) => p.Category.toLowerCase() === catName.toLowerCase());
                    if (catProducts.length === 0) {
                            await sock.sendMessage(jid, { text: `❓ Category "${catName}" not found. Type *menu* to see categories.` });
                            continue;
                    }

                    let reply = `*${catName} Products:*\n\n`;
                    catProducts.forEach((p) => {
                        if (p.PriceType === 'sqm') {
                            reply += `*ID ${p.ID}*: ${p.Name}\n`;
                            if (p.Size) reply += `  📏 Size: ${p.Size}\n`;
                            if (p.Finish) reply += `  ✨ Finish: ${p.Finish}\n`;
                            if (p.SingleOrDoubleSided) reply += `  ↔️ Sides: ${p.SingleOrDoubleSided}\n`;
                            if (p.UnitsPerProduct) reply += `  📦 Units per product: ${p.UnitsPerProduct}\n`;
                            reply += `  📐 ${formatCurrency(p.PricePerSqm)}/m² (min ${formatCurrency(p.MinPrice)})\n`;
                            if (toNumber(p.DesignFee) > 0) reply += `  🎨 Design fee: ${formatCurrency(p.DesignFee)}\n`;
                            if (p.PolesAvailable === 'yes') reply += `  🪧 Poles: ${formatCurrency(p.PolePrice)}/pole\n`;
                            if (toNumber(p.InstallationFee) > 0) reply += `  🔧 Installation: ${formatCurrency(p.InstallationFee)}\n`;
                        } else {
                            reply += `*ID ${p.ID}*: ${p.Name} — ${formatCurrency(p.FixedPrice)}\n`;
                            if (p.Size) reply += `  📏 Size: ${p.Size}\n`;
                            if (p.Finish) reply += `  ✨ Finish: ${p.Finish}\n`;
                            if (p.SingleOrDoubleSided) reply += `  ↔️ Sides: ${p.SingleOrDoubleSided}\n`;
                            if (p.UnitsPerProduct) reply += `  📦 Units per product: ${p.UnitsPerProduct}\n`;
                        }
                        reply += '\n';
                    });
                    reply += `Type *buy [ID]* to order.\ne.g. _buy ${catProducts[0].ID}_`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }

                // ── Buy command ─────────────────────────────────────────────────────
                    if (text === 'buy') {
                        await sock.sendMessage(jid, { text: 'Please send *buy [ID]*, for example _buy 4_.' });
                        continue;
                    }

                    if (text.startsWith('buy ')) {
                    const parts = text.split(/\s+/);
                    const id = parts[1];
                    const product = products.find((p) => p.ID === id);
                    if (!product) {
                            await sock.sendMessage(jid, { text: `❓ Product ID *${id}* not found. Type *menu* to browse.` });
                            continue;
                    }
                    if (product.PriceType === 'sqm') {
                        userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                            await sock.sendMessage(jid, {
                            text: `📐 *${product.Name}*\nPlease send the *length x height in mm*\nfor example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back or *human* for a team member.`
                        });
                            continue;
                    }

                    const price = toNumber(product.FixedPrice);
                    const qty = parseInt(parts[2] || '1', 10);
                    if (Number.isNaN(qty) || qty < 1) {
                            await sock.sendMessage(jid, { text: 'Please enter a valid quantity, for example _buy 12 2_.' });
                            continue;
                    }
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
                        await sock.sendMessage(jid, {
                        text: `✅ Added ${qty} × *${product.Name}* @ ${formatCurrency(price)} each.\nType *cart* to view it or *checkout* when you are ready.`
                    });
                        continue;
                    }

                // ── Cart ────────────────────────────────────────────────────────────
                    if (text === 'cart' || text === 'my cart' || text === 'view cart') {
                        const cart = userCarts[jid];
                        if (!cart || cart.length === 0) {
                            await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: buildCartText(cart) });
                        continue;
                    }

                // ── Clear cart ──────────────────────────────────────────────────────
                    if (text === 'clear' || text === 'clear cart' || text === 'empty cart') {
                        delete userCarts[jid];
                        userStates[jid] = { step: 'idle' };
                        await sock.sendMessage(jid, { text: '🗑️ Cart cleared. Type *menu* to start over.' });
                        continue;
                    }

                // ── Checkout ────────────────────────────────────────────────────────
                    if (text === 'checkout' || text === 'buy now' || text === 'order' || text === 'place order') {
                        const cart = userCarts[jid];
                        if (!cart || cart.length === 0) {
                            await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                            continue;
                        }

                        const { summary } = buildOrderSummary(cart, { includeDisclaimer: true });
                        userStates[jid] = { step: 'awaiting_checkout_confirmation', pendingCart: cart };
                        await sock.sendMessage(jid, {
                        text: `${summary}\n\nReply *confirm* to accept the artwork disclaimer and submit your order, or send *human* if you want a person to assist.`
                    });
                        continue;
                    }

                // ── Intent: thanks / okay ───────────────────────────────────────────
                    if (/^(thanks|thank you|thx|cheers|ok|okay|cool|great|perfect|noted|pleasure|👍)\b/.test(text)) {
                        await sock.sendMessage(jid, { text: `Pleasure! 😊 Let me know if you need anything else.\n\n– ${BUSINESS_NAME}` });
                        continue;
                    }

                // ── Intent: what do you print / services ───────────────────────────
                    if (/what (do|can|does) (you|duzi|we) (print|make|do|offer|produce)|what('s| is) (on offer|available)|your (products|services|range)|(products|items) (do you have|are available|you (have|sell|offer))/.test(text)) {
                        await sock.sendMessage(jid, { text: buildProductListText() });
                        continue;
                    }

                // ── Intent: turnaround time ─────────────────────────────────────────
                    if (/turnaround|how long|when will|delivery time|production time|when (can i|will i|do i) (get|receive|collect)|how (quickly|fast|soon)|lead time/.test(text)) {
                        await sock.sendMessage(jid, { text: `⏱️ *Turnaround Time*\n\nStandard turnaround is *2–3 business days* after artwork approval and payment.\n\nExpress 24-hour service is available at an extra cost – let me know if you need it!\n\n– ${BUSINESS_NAME} Team` });
                        continue;
                    }

                // ── Intent: delivery / shipping ─────────────────────────────────────
                    if (/\bdeliver(y|ies|ed|ing)?\b|\bshipping\b|\bcourier\b|\bcollect(ion)?\b|\bhow (do|can) (i|we) get\b/.test(text)) {
                        await sock.sendMessage(jid, { text: `🚚 *Delivery*\n\nWe deliver across South Africa! Delivery cost depends on your location.\n\nTell me your suburb and I'll give you a rate, or you're welcome to *collect* from us. 😊\n\n– ${BUSINESS_NAME} Team` });
                        continue;
                    }

                // ── Intent: complaint / issue ───────────────────────────────────────
                    if (/\bcomplaint\b|\bproblem with\b|\bissue with\b|\bwrong order\b|\bdamaged\b|\bfaulty\b|\bnot happy\b|\bdisappointed\b/.test(text) && jid !== ADMIN_JID) {
                        await activateHumanHandover(sock, jid, rawText);
                        continue;
                    }

                // ── Intent: quote / price / how much ────────────────────────────────
                    if (/\b(quote|estimate|how much|rate)\b/.test(text) || (/\b(price|cost)\b/.test(text) && !/products/.test(text))) {
                        if (userState.step === 'idle') {
                            fallbackCounts[jid] = 0;
                            const qty = extractQuantityFromText(text);
                            const matches = findProductsByKeyword(text);

                            if (matches.length === 1) {
                                const product = matches[0];
                                if (product.PriceType === 'sqm') {
                                    userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                    await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nTo give you an accurate quote, please send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                    continue;
                                }
                                if (qty) {
                                    const total = calcFixedQuoteForQty(product, qty);
                                    const unitsPerPack = parseInt(product.UnitsPerProduct, 10) || 1;
                                    const packs = Math.ceil(qty / unitsPerPack);
                                    let quoteText = `💰 *Quote for ${qty.toLocaleString()} × ${product.Name}*\n`;
                                    if (unitsPerPack > 1) quoteText += `(${packs} pack${packs > 1 ? 's' : ''} of ${unitsPerPack})\n`;
                                    quoteText += `Estimated total: *${formatCurrency(total)}* (incl. VAT, excl. delivery)\n\nWould you like to add this to your cart? Reply *yes* or *no*.\n\n– ${BUSINESS_NAME} Team`;
                                    userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: total };
                                    await sock.sendMessage(jid, { text: quoteText });
                                    continue;
                                }
                                userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `Great! To give you an accurate quote – how many *${product.Name}* do you need?` });
                                continue;
                            }

                            if (matches.length > 1) {
                                const list = matches.map((p, i) => `${i + 1}) ${p.Name}`).join('\n');
                                userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: matches };
                                await sock.sendMessage(jid, { text: `We have a few options:\n${list}\n\nWhich one would you like a quote for?` });
                                continue;
                            }

                            await sock.sendMessage(jid, { text: `To give you an accurate quote, I need:\n1) Product type (e.g. _flyers_, _banners_, _business cards_)\n2) Quantity\n3) Paper type / finishing (e.g. gloss/matte)\n\nCould you provide these?` });
                            userStates[jid] = { step: 'awaiting_quote_product' };
                            continue;
                        }
                    }

                // ── Intent: add to cart (conversational) ────────────────────────────
                    if ((/\b(add|adding)\b/.test(text) || text === '+') && userState.step === 'idle') {
                        fallbackCounts[jid] = 0;
                        const qty = extractQuantityFromText(text) || 1;
                        const matches = findProductsByKeyword(text);

                        if (matches.length === 1) {
                            const product = matches[0];
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            const total = calcFixedQuoteForQty(product, qty);
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push({ name: product.Name, sqmPrice: toNumber(product.FixedPrice), designFee: 0, polesCost: 0, poles: 0, installationFee: 0, total, qty });
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `✅ Got it! I've added ${qty.toLocaleString()} × *${product.Name}* to your cart.\nWould you like to add anything else? (Type *cart* to view, *quote* for a price, or *checkout* to order.) 😊` });
                            continue;
                        }

                        if (matches.length > 1) {
                            const list = matches.map((p, i) => `${i + 1}) ${p.Name}`).join('\n');
                            userStates[jid] = { step: 'awaiting_add_product_selection', pendingMatches: matches, pendingQty: qty };
                            await sock.sendMessage(jid, { text: `We have a few options:\n${list}\n\nWhich one would you like to add?` });
                            continue;
                        }

                        userStates[jid] = { step: 'awaiting_add_product', pendingQty: qty };
                        await sock.sendMessage(jid, { text: `Which product would you like to add? E.g. _A5 flyers_, _business cards_, _banners_.\n\nType *cancel* to go back or *menu* to browse.` });
                        continue;
                    }

                // ── Intent: remove from cart ─────────────────────────────────────────
                    if (/\b(remove|delete|take out)\b/.test(text) || text === '-') {
                        const cart = userCarts[jid] || [];
                        if (cart.length === 0) {
                            await sock.sendMessage(jid, { text: `🛒 Your cart is empty – nothing to remove.` });
                            continue;
                        }
                        if (cart.length === 1) {
                            const removedItem = cart[0];
                            delete userCarts[jid];
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `I've removed *${removedItem.name}* from your cart. Your cart is now empty. Type *menu* to continue shopping.` });
                            continue;
                        }
                        // Try to match item name from the message
                        const exactMatchIdx = cart.findIndex((item) => text.includes(normalizeText(item.name)));
                        if (exactMatchIdx >= 0) {
                            const removedItem = cart[exactMatchIdx];
                            userCarts[jid].splice(exactMatchIdx, 1);
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `I've removed *${removedItem.name}* from your cart. Your updated cart has ${userCarts[jid].length} item(s). Type *cart* to view.` });
                            continue;
                        }
                        // Multiple items – ask which one
                        const itemList = cart.map((item, i) => `${i + 1}) ${item.name}`).join('\n');
                        userStates[jid] = { step: 'awaiting_remove_selection' };
                        await sock.sendMessage(jid, { text: `You have ${cart.length} items in your cart. Which one would you like to remove? Reply with the number:\n${itemList}` });
                        continue;
                    }

                    const learnedResponse = findLearnedResponse(rawText);
                    if (learnedResponse) {
                        await sock.sendMessage(jid, { text: learnedResponse.response });
                        continue;
                    }

                    // Default fallback – track count and escalate after 2 failed attempts
                    fallbackCounts[jid] = (fallbackCounts[jid] || 0) + 1;
                    recordLearningLead(jid, rawText);
                    if (fallbackCounts[jid] >= 3 && jid !== ADMIN_JID) {
                        fallbackCounts[jid] = 0;
                        await activateHumanHandover(sock, jid, `Bot could not understand repeated messages (last: "${rawText}")`);
                        continue;
                    }
                    await sock.sendMessage(jid, {
                        text: `I didn't quite catch that 😅. You can ask me about *quotes*, adding items to your *cart*, or *order status*. Or type *human* to speak with a real person.\n\n– ${BUSINESS_NAME}`
                    });
                } catch (error) {
                    console.error('❌ Error while handling message:', {
                        jid,
                        error
                    });
                    if (jid && jid !== ADMIN_JID) {
                        try {
                            await sock.sendMessage(jid, {
                                text: `⚠️ Sorry, I hit a problem while processing that message. Please send *menu* to try again, or send *human* if you want a ${BUSINESS_NAME} team member.`
                            });
                        } catch (sendError) {
                            console.error('❌ Failed to send fallback error message:', sendError);
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp Engine:', error);
        scheduleBotRestart(error);
    }
}

// --- WEB SERVER FOR RAILWAY HEALTH CHECK AND QR ACCESS ---
const app = express();
const PORT = process.env.PORT || 3000;
const QR_ACCESS_TOKEN = process.env.QR_ACCESS_TOKEN || '';
const qrRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: '<p>Too many requests. Please wait a minute.</p>'
});
app.get('/', (req, res) => res.send('Bot is running!'));
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'whatsapp-bot',
        whatsapp: whatsappRuntime
    });
});
// Serve QR code as a self-refreshing HTML page so the user can scan it
// even when email delivery fails. Always shows the latest in-memory QR.
app.get('/qr', qrRouteLimiter, (req, res) => {
    if (!isAuthorizedQrRequest(getQrAccessToken(req))) {
        return res.status(401).send('<p>Unauthorized. Missing or invalid token.</p>');
    }

    const phase = whatsappRuntime.phase;

    if (phase === 'connected') {
        return res.status(200).send(`<!DOCTYPE html>
<html><head><title>WhatsApp Bot QR</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>✅ Bot is already connected — no QR needed.</h2>
</body></html>`);
    }

    if (currentQrDataUri) {
        // Show QR; page auto-refreshes after 55 s in case the QR expires
        return res.send(`<!DOCTYPE html>
<html><head>
<title>Scan WhatsApp QR</title>
<meta http-equiv="refresh" content="55">
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>📱 Scan this QR code in WhatsApp</h2>
<p>Open WhatsApp → <b>Linked Devices</b> → <b>Link a Device</b> → point camera here</p>
<img src="${currentQrDataUri}" style="max-width:300px;border:1px solid #ccc;padding:8px">
<p><small>QR expires in ~60 s. This page refreshes automatically.</small></p>
</body></html>`);
    }

    // No QR yet — auto-refresh every 3 s until one is ready
    return res.status(202).send(`<!DOCTYPE html>
<html><head>
<title>WhatsApp Bot QR</title>
<meta http-equiv="refresh" content="3">
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>⏳ Waiting for QR code…</h2>
<p>Status: <b>${phase}</b></p>
<p>This page refreshes every 3 seconds. Keep it open.</p>
</body></html>`);
});
const server = app.listen(PORT, () => {
    const railwayUrl = getRailwayQrUrl();
    const qrUrl = railwayUrl || `http://localhost:${PORT}/qr`;
    console.log(`📡 Health check server listening on port ${PORT}`);
    console.log(`🔗 QR code will be available at: ${qrUrl}`);
    startBot(); // Start the bot after the server is up
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled promise rejection:', reason);
    // Only trigger a restart when not already connected; stream errors while
    // connected are already handled by the connection.update 'close' handler.
    if (whatsappRuntime.phase !== 'connected') {
        scheduleBotRestart(reason);
    } else {
        setWhatsAppPhase('error', reason);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    scheduleBotRestart(error);
});

// Graceful shutdown on SIGTERM / SIGINT (e.g. Railway stopping the container)
function gracefulShutdown(signal) {
    console.log(`🛑 Received ${signal}. Shutting down gracefully...`);
    clearBotRestartTimer();
    server.close(() => {
        console.log('👋 HTTP server closed. Exiting.');
        process.exit(0);
    });
    setTimeout(() => process.exit(0), GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
