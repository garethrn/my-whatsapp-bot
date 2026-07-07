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
const FRUSTRATION_KEYWORDS = ['frustrated', 'angry', 'upset', 'annoyed', 'not helping', 'complaint', 'terrible', 'useless', 'confused', 'speak to manager'];
const DEFAULT_RESTART_DELAY_MS = 5000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;

const whatsappRuntime = {
    phase: 'booting',
    lastUpdatedAt: new Date().toISOString(),
    lastError: null
};
let botRestartTimer = null;

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
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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
        .pipe(csv())
        .on('data', (d) => results.push(d))
        .on('end', () => {
            products = results;
            console.log('✅ Inventory Loaded');
        });
}
loadProducts();

function getCategories() {
    return [...new Set(products.map((p) => p.Category))];
}

function toNumber(value, fallback = 0) {
    const parsed = parseFloat(value);
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

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'error' }),
            browser: ['Mac OS', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            try {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    setWhatsAppPhase('awaiting_qr');
                    const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
                    await qrcodeImg.toFile(qrPath, qr);
                    // RAILWAY_PUBLIC_DOMAIN is a bare domain (e.g. "myapp.up.railway.app")
                    // RAILWAY_STATIC_URL may be a full URL — strip any existing protocol to avoid duplication
                    const rawHost = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
                    const railwayUrl = rawHost
                        ? `https://${rawHost.replace(/^https?:\/\//, '')}/qr`
                        : null;
                    console.log('⚠️ QR Code generated.');
                    if (railwayUrl) {
                        console.log(`🔗 Scan QR directly at: ${railwayUrl}`);
                    } else {
                        console.log('🔗 Scan QR at: <your-railway-url>/qr');
                    }
                    console.log('📧 Sending QR to email...');
                    try {
                        await transporter.sendMail({
                            from: EMAIL_USER,
                            to: EMAIL_USER,
                            subject: 'WhatsApp Bot Login',
                            text: `Scan the attached QR code to log in.\n\nAlternatively, open ${railwayUrl || '<your-railway-url>/qr'} in your browser.`,
                            attachments: [{ filename: 'bot-qr.png', path: qrPath }]
                        });
                        console.log(`📧 QR code email sent to ${EMAIL_USER}`);
                    } catch (error) {
                        console.error('❌ Failed to email WhatsApp QR code:', error);
                        setWhatsAppPhase('awaiting_qr', 'QR generated but email delivery failed. Visit /qr in your browser or check EMAIL_USER / EMAIL_PASS and Gmail app password settings.');
                    }
                }

                if (connection === 'close') {
                    const disconnectError = lastDisconnect?.error;
                    const statusCode = (disconnectError instanceof Boom) ? disconnectError.output.statusCode : 0;
                    const errorMessage = disconnectError?.message || `Disconnect status ${statusCode || 'unknown'}`;
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
                    clearBotRestartTimer();
                    setWhatsAppPhase('connected');
                    console.log('🚀 BOT IS CONNECTED AND LIVE!');
                }
            } catch (error) {
                console.error('❌ Error while handling WhatsApp connection update:', error);
                scheduleBotRestart(error);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                const msg = messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const jid = msg.key.remoteJid;
                const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
                const text = rawText.toLowerCase();

                if (!rawText && !msg.message.documentMessage) return;
                if (rawText) rememberConversation(jid, rawText);

                // Admin: upload new CSV via document message
                if (jid === ADMIN_JID && msg.message.documentMessage) {
                    const doc = msg.message.documentMessage;
                    if (doc.fileName.endsWith('.csv')) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        fs.writeFileSync(CSV_FILE, buffer);
                        loadProducts();
                        return sock.sendMessage(jid, { text: '📦 Products updated!' });
                    }
                }

                if (jid === ADMIN_JID && text.startsWith('teach ')) {
                    const payload = rawText.slice(6);
                    const [question, answer] = payload.split(/\s*=>\s*/);
                    if (!question || !answer) {
                        return sock.sendMessage(jid, { text: 'Use *teach question => response*. Example: *teach do you deliver => Yes, we deliver nationwide.*' });
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
                    return sock.sendMessage(jid, { text: `🧠 Learned reply saved for: *${question.trim()}*` });
                }

                if (jid === ADMIN_JID && text === 'leads') {
                    if (learningLeads.length === 0) {
                        return sock.sendMessage(jid, { text: 'No learning leads captured yet.' });
                    }

                    const topLeads = [...learningLeads]
                        .sort((a, b) => b.count - a.count)
                        .slice(0, 10)
                        .map((lead, index) => `${index + 1}. ${lead.example} (${lead.count} time(s))`)
                        .join('\n');
                    return sock.sendMessage(jid, { text: `*Top unanswered messages:*\n\n${topLeads}` });
                }

                if (jid === ADMIN_JID && text === 'handovers') {
                    const activeHandovers = Object.entries(handoverSessions).filter(([, session]) => session.active);
                    if (activeHandovers.length === 0) {
                        return sock.sendMessage(jid, { text: 'There are no active human handovers right now.' });
                    }

                    const handoverList = activeHandovers
                        .map(([customerJid, session], index) => `${index + 1}. ${customerJid} — ${session.reason}`)
                        .join('\n');
                    return sock.sendMessage(jid, { text: `*Active handovers:*\n\n${handoverList}` });
                }

                if (jid === ADMIN_JID && text.startsWith('resume ')) {
                    const targetJid = toWhatsAppJid(rawText.slice('resume '.length));
                    if (!targetJid) {
                        return sock.sendMessage(jid, { text: 'Use *resume 27123456789* or *resume 27123456789@s.whatsapp.net*.' });
                    }
                    if (!handoverSessions[targetJid]?.active) {
                        return sock.sendMessage(jid, { text: `No active handover found for *${targetJid}*.` });
                    }

                    delete handoverSessions[targetJid];
                    await sock.sendMessage(targetJid, { text: '✅ A team member has finished helping. I can assist you again now — send *menu* or *cart* when you are ready.' });
                    return sock.sendMessage(jid, { text: `Bot control restored for *${targetJid}*.` });
                }

                if (handoverSessions[jid]?.active && jid !== ADMIN_JID) {
                    return;
                }

                if (jid !== ADMIN_JID && rawText && (isHumanRequest(text) || isFrustratedMessage(text))) {
                    await activateHumanHandover(sock, jid, rawText);
                    return;
                }

                const userState = userStates[jid] || { step: 'idle' };

                // Cancel / escape from any mid-flow state
                if (text === 'cancel' || text === 'menu' || text === 'hello' || text === 'hi') {
                    if (userState.step !== 'idle') {
                        userStates[jid] = { step: 'idle' };
                    }
                    if (text === 'cancel') {
                        return sock.sendMessage(jid, { text: '❌ Cancelled. Type *menu* to start over.' });
                    }
                    return sock.sendMessage(jid, { text: buildMenuText() });
                }

                if (text === 'help') {
                    return sock.sendMessage(jid, { text: buildHelpText() });
                }

                // ── State: awaiting_dimensions ──────────────────────────────────────
                if (userState.step === 'awaiting_dimensions') {
                    const dims = parseDimensions(rawText);
                    if (!dims) {
                        return sock.sendMessage(jid, {
                            text: `❓ I could not read a valid size from that message.\nPlease send *length x height in mm* (for example _${DIMENSION_FORMAT_EXAMPLE}_).\n\nType *cancel* to go back or *human* if you want a person to help.`
                        });
                    }
                    if (dims.error === 'non_positive') {
                        return sock.sendMessage(jid, {
                            text: `⚠️ Please use positive measurements only. Send the *length x height in mm* again, for example _${DIMENSION_FORMAT_EXAMPLE}_.`
                        });
                    }
                    if (dims.error === 'invalid_count') {
                        return sock.sendMessage(jid, {
                            text: `⚠️ Please send only *two* measurements: *length x height in mm*. Example: _${DIMENSION_FORMAT_EXAMPLE}_.`
                        });
                    }
                    if (dims.error === 'too_large') {
                        return sock.sendMessage(jid, {
                            text: `⚠️ Those dimensions exceed our maximum of ${MAX_DIMENSION_MM}mm. Please send the *length x height in mm* again, for example _${DIMENSION_FORMAT_EXAMPLE}_.`
                        });
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
                        return sock.sendMessage(jid, { text: reply });
                    }
                    if (toNumber(product.InstallationFee) > 0) {
                        userStates[jid] = { step: 'awaiting_installation', pendingProduct: product, pendingItem };
                        reply += `\nWould you like *installation*? ${formatCurrency(product.InstallationFee)}\nReply *yes* or *no*.`;
                        return sock.sendMessage(jid, { text: reply });
                    }

                    const total = sqmPrice + designFee;
                    pendingItem.total = total;
                    if (!userCarts[jid]) userCarts[jid] = [];
                    userCarts[jid].push(pendingItem);
                    userStates[jid] = { step: 'idle' };
                    reply += `\n*Total: ${formatCurrency(total)}*\n✅ Added to cart! Type *cart* to view it or *checkout* when you are ready.`;
                    return sock.sendMessage(jid, { text: reply });
                }

                // ── State: awaiting_poles ───────────────────────────────────────────
                if (userState.step === 'awaiting_poles') {
                    if (text === 'yes') {
                        userStates[jid] = { ...userState, step: 'awaiting_pole_count' };
                        return sock.sendMessage(jid, {
                            text: `How many poles do you need?\nPrice per pole: ${formatCurrency(userState.pendingProduct.PolePrice)}\n\nType *cancel* to go back.`
                        });
                    }
                    if (text === 'no') {
                        const instFee = toNumber(userState.pendingProduct.InstallationFee);
                        if (instFee > 0) {
                            userStates[jid] = { ...userState, step: 'awaiting_installation' };
                            return sock.sendMessage(jid, {
                                text: `Would you like *installation*? ${formatCurrency(instFee)}\nReply *yes* or *no*.`
                            });
                        }
                        const item = userState.pendingItem;
                        item.total = item.sqmPrice + item.designFee;
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'idle' };
                        return sock.sendMessage(jid, {
                            text: `✅ Added to cart! *Total: ${formatCurrency(item.total)}*\nType *cart* to view it or *checkout* to order.`
                        });
                    }
                    return sock.sendMessage(jid, { text: 'Please reply *yes* or *no*.' });
                }

                // ── State: awaiting_pole_count ──────────────────────────────────────
                if (userState.step === 'awaiting_pole_count') {
                    const count = parseInt(text, 10);
                    if (Number.isNaN(count) || count < 1) {
                        return sock.sendMessage(jid, { text: 'Please enter a valid number of poles (for example _2_).' });
                    }
                    const polePrice = toNumber(userState.pendingProduct.PolePrice);
                    const polesCost = count * polePrice;
                    const updatedItem = { ...userState.pendingItem, polesCost, poles: count };
                    const instFee = toNumber(userState.pendingProduct.InstallationFee);

                    if (instFee > 0) {
                        userStates[jid] = { ...userState, step: 'awaiting_installation', pendingItem: updatedItem };
                        return sock.sendMessage(jid, {
                            text: `${count} pole(s) added: ${formatCurrency(polesCost)}\n\nWould you like *installation*? ${formatCurrency(instFee)}\nReply *yes* or *no*.`
                        });
                    }
                    const total = updatedItem.sqmPrice + updatedItem.designFee + polesCost;
                    updatedItem.total = total;
                    if (!userCarts[jid]) userCarts[jid] = [];
                    userCarts[jid].push(updatedItem);
                    userStates[jid] = { step: 'idle' };
                    return sock.sendMessage(jid, {
                        text: `✅ Added to cart! *Total: ${formatCurrency(total)}*\nType *cart* to view it or *checkout* to order.`
                    });
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
                        return sock.sendMessage(jid, {
                            text: `✅ Added to cart! *Total: ${formatCurrency(item.total)}*\nType *cart* to view it or *checkout* to order.`
                        });
                    }
                    return sock.sendMessage(jid, { text: 'Please reply *yes* or *no*.' });
                }

                // ── State: awaiting_checkout_confirmation ───────────────────────────
                if (userState.step === 'awaiting_checkout_confirmation') {
                    if (['confirm', 'yes', 'submit', 'place order'].includes(text)) {
                        const cart = userState.pendingCart || userCarts[jid] || [];
                        if (cart.length === 0) {
                            userStates[jid] = { step: 'idle' };
                            return sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                        }

                        await submitOrderForReview(sock, jid, cart);
                        delete userCarts[jid];
                        userStates[jid] = { step: 'idle' };
                        return sock.sendMessage(jid, {
                            text: `✅ Thank you. Your quote/request has been sent to ${BUSINESS_NAME} for follow-up. A team member will contact you if anything needs clarification.`
                        });
                    }

                    return sock.sendMessage(jid, {
                        text: 'Please reply *confirm* to accept the artwork disclaimer and submit your order, or send *human* if you want a person to assist.'
                    });
                }

                // ── Main menu / category browsing ───────────────────────────────────
                if (text === 'products') {
                    return sock.sendMessage(jid, { text: 'Please send *products [category]*, for example _products Signs_.' });
                }

                if (text.startsWith('products ')) {
                    const catName = rawText.substring(9).trim();
                    const catProducts = products.filter((p) => p.Category.toLowerCase() === catName.toLowerCase());
                    if (catProducts.length === 0) {
                        return sock.sendMessage(jid, { text: `❓ Category "${catName}" not found. Type *menu* to see categories.` });
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
                    return sock.sendMessage(jid, { text: reply });
                }

                // ── Buy command ─────────────────────────────────────────────────────
                if (text === 'buy') {
                    return sock.sendMessage(jid, { text: 'Please send *buy [ID]*, for example _buy 4_.' });
                }

                if (text.startsWith('buy ')) {
                    const parts = text.split(/\s+/);
                    const id = parts[1];
                    const product = products.find((p) => p.ID === id);
                    if (!product) {
                        return sock.sendMessage(jid, { text: `❓ Product ID *${id}* not found. Type *menu* to browse.` });
                    }
                    if (product.PriceType === 'sqm') {
                        userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                        return sock.sendMessage(jid, {
                            text: `📐 *${product.Name}*\nPlease send the *length x height in mm*\nfor example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back or *human* for a team member.`
                        });
                    }

                    const price = toNumber(product.FixedPrice);
                    const qty = parseInt(parts[2] || '1', 10);
                    if (Number.isNaN(qty) || qty < 1) {
                        return sock.sendMessage(jid, { text: 'Please enter a valid quantity, for example _buy 12 2_.' });
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
                    return sock.sendMessage(jid, {
                        text: `✅ Added ${qty} × *${product.Name}* @ ${formatCurrency(price)} each.\nType *cart* to view it or *checkout* when you are ready.`
                    });
                }

                // ── Cart ────────────────────────────────────────────────────────────
                if (text === 'cart') {
                    const cart = userCarts[jid];
                    if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                    return sock.sendMessage(jid, { text: buildCartText(cart) });
                }

                // ── Clear cart ──────────────────────────────────────────────────────
                if (text === 'clear') {
                    delete userCarts[jid];
                    userStates[jid] = { step: 'idle' };
                    return sock.sendMessage(jid, { text: '🗑️ Cart cleared. Type *menu* to start over.' });
                }

                // ── Checkout ────────────────────────────────────────────────────────
                if (text === 'checkout') {
                    const cart = userCarts[jid];
                    if (!cart || cart.length === 0) return sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });

                    const { summary } = buildOrderSummary(cart, { includeDisclaimer: true });
                    userStates[jid] = { step: 'awaiting_checkout_confirmation', pendingCart: cart };
                    return sock.sendMessage(jid, {
                        text: `${summary}\n\nReply *confirm* to accept the artwork disclaimer and submit your order, or send *human* if you want a person to assist.`
                    });
                }

                const learnedResponse = findLearnedResponse(rawText);
                if (learnedResponse) {
                    return sock.sendMessage(jid, { text: learnedResponse.response });
                }

                recordLearningLead(jid, rawText);
                return sock.sendMessage(jid, {
                    text: `I want to make this easy for you. Send *menu* to browse, *products [category]* to see items, *buy [ID]* to order, or *human* if you would like a ${BUSINESS_NAME} team member to take over.`
                });
            } catch (error) {
                console.error(`❌ Error while handling message:`, error);
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
app.get('/', (req, res) => res.send('Bot is running!'));
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'whatsapp-bot',
        whatsapp: whatsappRuntime
    });
});
// Serve QR code image so it can be scanned directly from the Railway URL
// (reliable fallback when email delivery fails)
// Simple in-memory rate limiter: max 10 requests per IP per minute
const qrRateLimit = new Map();
app.get('/qr', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 10;
    const record = qrRateLimit.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + windowMs;
    }
    record.count++;
    qrRateLimit.set(ip, record);
    if (record.count > maxRequests) {
        return res.status(429).send('<p>Too many requests. Please wait a minute.</p>');
    }

    const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
    if (!fs.existsSync(qrPath)) {
        const phase = whatsappRuntime.phase;
        if (phase === 'connected') {
            return res.status(200).send('<p>✅ Bot is already connected — no QR code needed.</p>');
        }
        return res.status(404).send('<p>⏳ QR code not yet available. Try again in a few seconds.</p>');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(qrPath);
});
const server = app.listen(PORT, () => {
    console.log(`📡 Health check server listening on port ${PORT}`);
    console.log(`🔗 QR code available at /qr once WhatsApp login is needed`);
    startBot(); // Start the bot after the server is up
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled promise rejection:', reason);
    setWhatsAppPhase('error', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    setWhatsAppPhase('error', error);
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
