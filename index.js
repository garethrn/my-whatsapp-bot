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
const invoiceNinja = require('./invoiceNinja');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');
const path = require('path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');

// --- YOUR CONFIGURATION ---
const ADMIN_JID = process.env.ADMIN_JID;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const STORAGE_DIR = path.join(__dirname, 'storage');
const CSV_FILE = path.join(__dirname, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');
const LEARNED_RESPONSES_FILE = path.join(STORAGE_DIR, 'learned_responses.json');
const LEARNING_LEADS_FILE = path.join(STORAGE_DIR, 'learning_leads.json');
const ORDERS_FILE = path.join(STORAGE_DIR, 'orders.json');
const MAX_HISTORY = 10;
const MAX_LEARNING_LEADS = 200;
const BUSINESS_NAME = 'Duzi Signs';
const MM_PER_METER = 1000;
// Guardrail for obviously invalid custom sizes (50m in mm).
const MAX_DIMENSION_MM = 50000;
// Minimum similarity score (0-1) for a stored learned reply to be reused.
const LEARNING_MATCH_THRESHOLD = 0.45;
const DIMENSION_FORMAT_EXAMPLE = '1200 x 600 mm';
const TRACKING_URL = process.env.TRACKING_URL || 'https://www.trackyourparcel.co.za';
const OWN_DESIGN_DISCLAIMER = 'If the supplied design is incorrect, unusable, or the layout requires changes, design/layout fees will apply.';
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
const PRODUCT_SEARCH_STOP_WORDS = new Set([
    'a', 'about', 'am', 'an', 'and', 'any', 'are', 'can', 'catalogue', 'cost', 'do', 'estimate', 'for',
    'get', 'give', 'have', 'hello', 'help', 'hi', 'how', 'i', 'im', 'in', 'interested', 'is', 'item', 'items',
    'like', 'looking', 'me', 'menu', 'need', 'of', 'on', 'please', 'price', 'print', 'pricing', 'product',
    'products', 'quote', 'quotes', 'rate', 'search', 'show', 'some', 'tell', 'the', 'to', 'want', 'what', 'with',
    'you', 'your'
]);
const DEFAULT_RESTART_DELAY_MS = 5000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;
// Optional webhook secret for verifying Invoice Ninja webhook requests
const INVOICE_NINJA_WEBHOOK_SECRET = process.env.INVOICE_NINJA_WEBHOOK_SECRET || '';

const whatsappRuntime = {
    phase: 'booting',
    lastUpdatedAt: new Date().toISOString(),
    lastError: null
};
let botRestartTimer = null;
let activeSocketGeneration = 0;
// Current QR stored as a PNG data URI (base64); null when no QR is pending
let currentQrDataUri = null;
// The most recent connected WhatsApp socket; used by the webhook handler
let activeSock = null;

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
    // Railway commonly exposes the public hostname via RAILWAY_PUBLIC_DOMAIN or, on older setups,
    // a full URL/hostname in RAILWAY_STATIC_URL. Accept either and normalize to an HTTPS origin.
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
let userProductContext = {};
let learnedResponses = loadJsonFile(LEARNED_RESPONSES_FILE, []);
let learningLeads = loadJsonFile(LEARNING_LEADS_FILE, []);
let handoverSessions = {};
let conversationHistory = {};
let userNames = {};
let fallbackCounts = {};
let userEmails = {};
let orders = loadJsonFile(ORDERS_FILE, []);

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

const DEFAULT_CSV = 'ID,Category,Subcategory,Name,Size,Finish,SingleOrDoubleSided,UnitsPerProduct,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee,Aliases';
const CSV_SAMPLE_ROW = '1,Paper Printing,Business Cards,Business Cards 300GSM,Standard 90x55mm,Semi Gloss,Single sided,100,fixed,,R120.00,,0,no,,0,visiting cards|biz cards';

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

function normalizeSearchText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getProductSearchTerms(text) {
    return normalizeSearchText(text)
        .split(' ')
        .filter((word) => word && !/^\d+$/.test(word) && !PRODUCT_SEARCH_STOP_WORDS.has(word));
}

function findProductsByKeyword(text) {
    const normalized = normalizeSearchText(text);
    const searchWords = getProductSearchTerms(text);
    if (!normalized || searchWords.length === 0) return [];

    return products
        .map((product) => {
            const name = normalizeSearchText(product.Name);
            const category = normalizeSearchText(product.Category);
            const subcategory = normalizeSearchText(product.Subcategory);
            const aliases = normalizeSearchText(product.Aliases || '');
            const detail = normalizeSearchText([
                product.Name,
                product.Category,
                product.Subcategory,
                product.Size,
                product.Finish,
                product.SingleOrDoubleSided,
                product.Aliases
            ].join(' '));

            let score = 0;
            if (name && normalized.includes(name)) score += 18;
            if (name && name.includes(normalized)) score += 14;
            if (subcategory && subcategory.includes(normalized)) score += 12;
            if (category && category.includes(normalized)) score += 10;
            if (aliases && aliases.includes(normalized)) score += 14;
            if (detail.includes(normalized)) score += 8;

            const nameMatches = searchWords.filter((word) => name.includes(word)).length;
            const subcategoryMatches = searchWords.filter((word) => subcategory.includes(word)).length;
            const categoryMatches = searchWords.filter((word) => category.includes(word)).length;
            const aliasMatches = aliases ? searchWords.filter((word) => aliases.includes(word)).length : 0;
            const detailMatches = searchWords.filter((word) => detail.includes(word)).length;

            score += nameMatches * 5;
            score += subcategoryMatches * 4;
            score += categoryMatches * 3;
            score += aliasMatches * 5;
            score += Math.max(0, detailMatches - nameMatches - subcategoryMatches - categoryMatches - aliasMatches);

            if (searchWords.length > 0 && searchWords.every((word) => name.includes(word))) score += 8;
            if (searchWords.length > 1 && searchWords.every((word) => detail.includes(word))) score += 4;

            return { product, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const nameCompare = String(a.product.Name || '').localeCompare(String(b.product.Name || ''));
            if (nameCompare !== 0) return nameCompare;
            // Within same product name, sort by price ascending (lowest first)
            const priceA = a.product.PriceType === 'sqm' ? toNumber(a.product.PricePerSqm) : toNumber(a.product.FixedPrice);
            const priceB = b.product.PriceType === 'sqm' ? toNumber(b.product.PricePerSqm) : toNumber(b.product.FixedPrice);
            if (priceA !== priceB) return priceA - priceB;
            return String(a.product.ID || '').localeCompare(String(b.product.ID || ''));
        });

    // If the top result's subcategory contains every word of the search query,
    // narrow the results to that subcategory only to avoid showing unrelated products.
    if (scored.length > 0) {
        const topSubcat = scored[0].product.Subcategory;
        if (topSubcat) {
            const topSubcatWords = normalizeSearchText(topSubcat).split(' ').filter(Boolean);
            if (topSubcatWords.length > 0 && topSubcatWords.every((w) => normalized.includes(w))) {
                const subcatNorm = topSubcat.toLowerCase().trim();
                const subcatFiltered = scored.filter(({ product }) =>
                    (product.Subcategory || '').toLowerCase().trim() === subcatNorm
                );
                if (subcatFiltered.length > 0 && subcatFiltered.length < scored.length) {
                    return subcatFiltered.map(({ product }) => product);
                }
            }
        }
    }

    return scored.map(({ product }) => product);
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

function pluralizeWord(word, count) {
    return count === 1 ? word : `${word}s`;
}

function getProductQuantityProfile(product) {
    const unitsPerPack = parseInt(product?.UnitsPerProduct, 10) || 1;
    const context = normalizeSearchText([product?.Name, product?.Category].join(' '));
    const isLabelProduct = /\blabels?\b/.test(context);
    const isPageProduct = /\b(page|pager)\b/.test(context);
    const isCardProduct = /\bcards?\b/.test(context);
    const baseUnit = isLabelProduct ? 'label' : (isPageProduct ? 'page' : (isCardProduct ? 'card' : 'unit'));

    if (isLabelProduct) return { mode: 'labels', unitsPerPack, baseUnit: 'label' };
    if (unitsPerPack > 1) return { mode: 'sets', unitsPerPack, baseUnit };
    if (isPageProduct) return { mode: 'pages', unitsPerPack: 1, baseUnit: 'page' };
    return { mode: 'units', unitsPerPack: 1, baseUnit };
}

function getQuantityPrompt(product) {
    const profile = getProductQuantityProfile(product);
    if (profile.mode === 'labels') return 'How many labels do you need?';
    if (profile.mode === 'sets') {
        return `How many sets do you need?\n(1 set = ${profile.unitsPerPack.toLocaleString()} ${pluralizeWord(profile.baseUnit, profile.unitsPerPack)})`;
    }
    if (profile.mode === 'pages') return 'How many pages do you need?';
    return `How many ${pluralizeWord(profile.baseUnit, 2)} do you need?`;
}

function getQuantityValidationPrompt(product) {
    const profile = getProductQuantityProfile(product);
    if (profile.mode === 'labels') return 'Please enter how many labels you need (e.g. _2500_).';
    if (profile.mode === 'sets') return 'Please enter how many sets you need (e.g. _2_).';
    if (profile.mode === 'pages') return 'Please enter how many pages you need (e.g. _100_).';
    return `Please enter how many ${pluralizeWord(profile.baseUnit, 2)} you need (e.g. _500_).`;
}

function getPricedQuantity(product, requestedQty) {
    const profile = getProductQuantityProfile(product);
    if (profile.mode === 'sets') return requestedQty * profile.unitsPerPack;
    return requestedQty;
}

function buildQuoteText(product, requestedQty, total) {
    const profile = getProductQuantityProfile(product);
    let quoteText = '';

    if (profile.mode === 'labels') {
        quoteText = `💰 *Quote for ${requestedQty.toLocaleString()} labels (${product.Name})*\n`;
    } else if (profile.mode === 'sets') {
        quoteText = `💰 *Quote for ${requestedQty.toLocaleString()} set${requestedQty === 1 ? '' : 's'} of ${product.Name}*\n`;
        quoteText += `(1 set = ${profile.unitsPerPack.toLocaleString()} ${pluralizeWord(profile.baseUnit, profile.unitsPerPack)})\n`;
    } else if (profile.mode === 'pages') {
        quoteText = `💰 *Quote for ${requestedQty.toLocaleString()} page${requestedQty === 1 ? '' : 's'} of ${product.Name}*\n`;
    } else {
        quoteText = `💰 *Quote for ${requestedQty.toLocaleString()} ${pluralizeWord(profile.baseUnit, requestedQty)} of ${product.Name}*\n`;
    }

    quoteText += `Estimated total: *${formatCurrency(total)}* (incl. VAT, excl. delivery)\n\n1. Yes – add to cart\n2. No – cancel\n\n– ${BUSINESS_NAME} Team`;
    return quoteText;
}

function greetUser(jid) {
    const name = userNames[jid];
    return name ? `Hi there ${name}! 👋` : 'Hi there! 👋';
}

function buildWelcomeText(jid) {
    return [
        greetUser(jid),
        `Thank you for contacting *${BUSINESS_NAME}*. I'm AutoBot, your virtual assistant. Let me know how I can assist you today:`,
        '',
        '1. Place a new order',
        '2. Product List',
        '3. Track My Order',
        '4. Store Contact Details',
        '',
        'Reply with the number of your choice.'
    ].join('\n');
}

function buildContactDetailsText() {
    return [
        `📍 *${BUSINESS_NAME}*`,
        '62 Naidoo Rd,',
        'Raisethorpe,',
        'Pietermaritzburg, 3201',
        '',
        '📞 Telephone: 033 811 5277'
    ].join('\n');
}

function buildTrackingText() {
    return `🔍 *Track Your Order*\n\nYou can track your order using the link below:\n${TRACKING_URL}\n\nIf you need further assistance, type *human* to speak with a team member or *4* for our store contact details.\n\n– ${BUSINESS_NAME} Team`;
}

function buildProductListText() {
    const categories = getCategories();
    const lines = [`Here's what we print at *${BUSINESS_NAME}*:`, ''];
    categories.forEach((cat) => lines.push(`• ${cat.trim()}`));
    lines.push('', "Anything specific you're looking for? Type *menu* to browse our full catalogue or ask for a *quote*! 😊");
    return lines.join('\n');
}

function buildProductOptionSummary(product, index) {
    const pricing = product.PriceType === 'sqm'
        ? `${formatCurrency(product.PricePerSqm)}/m²${toNumber(product.MinPrice) > 0 ? ` (min ${formatCurrency(product.MinPrice)})` : ''}`
        : formatCurrency(product.FixedPrice);

    const qualifier = [];
    if (product.Size && product.Size.trim()) qualifier.push(product.Size.trim());
    if (product.PriceType !== 'sqm' && product.UnitsPerProduct && product.UnitsPerProduct.trim()) qualifier.push(`${product.UnitsPerProduct.trim()} units`);

    const name = String(product.Name || '').trim();
    const displayName = qualifier.length > 0 ? `${name} (${qualifier.join(', ')})` : name;
    return `${index + 1}. ${displayName} - ${pricing}`;
}

function buildProductMatchesText(matches, intro, outro) {
    const lines = [intro, ''];
    matches.forEach((product, index) => lines.push(buildProductOptionSummary(product, index)));
    if (outro) lines.push('', outro);
    return lines.join('\n');
}

function getCategories() {
    return [...new Set(products.map((p) => p.Category))];
}

function getSubcategories(categoryName) {
    return [...new Set(
        products
            .filter((p) => p.Category.toLowerCase().trim() === categoryName.toLowerCase().trim())
            .map((p) => p.Subcategory)
            .filter(Boolean)
    )];
}

function buildSubcategoryMenuText(categoryName, subcategories) {
    let reply = `*${categoryName.trim()} – Choose a subcategory:*\n\n`;
    subcategories.forEach((sub, i) => {
        reply += `${i + 1}. ${sub.trim()}\n`;
    });
    reply += '\nReply with a *number* to see products in that subcategory.';
    reply += '\nType *menu* to go back to categories.';
    return reply;
}

function buildSubcategoryProductListText(subcategoryName, sortedProducts) {
    let reply = `*${subcategoryName.trim()} Products:*\n\n`;
    sortedProducts.forEach((p, i) => {
        reply += `${buildProductOptionSummary(p, i)}\n`;
    });
    reply += '\nReply with the *number* of the product you want and I’ll help you price it or add it to your cart.';
    return reply;
}

function toNumber(value, fallback = 0) {
    const normalized = String(value ?? '')
        .replace(/[^\d,.-]+/g, '')
        .replace(/,/g, '');
    const parsed = parseFloat(normalized);
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

    let reply = '*📋 Our Product Categories:*\n\n';
    categories.forEach((cat, i) => {
        reply += `${i + 1}. ${cat}\n`;
    });
    reply += '\nReply with a *number* to browse that category.';
    reply += '\nWhen a product list is shown, reply with the *number* of the item you want.';
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
        '- When a product list is shown, reply with the *number* of the item you want',
        '- For sqm products, send *length x height in mm* (example: _1200 x 600 mm_)',
        '- Send *cart* to see your basket',
        '- Send *checkout* to review your total and confirm the order',
        '- Send *human* any time if you want a person to take over'
    ].join('\n');
}

function buildPostCartText(cartCount) {
    return [
        `You now have ${cartCount} item(s) in your cart.`,
        '',
        'Would you like to:',
        '1. Add more items',
        '2. View cart',
        '3. Checkout'
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
        summary += `   Material: ${formatCurrency(item.total - (item.designFee || 0) - (item.polesCost || 0) - (item.installationFee || 0))}\n`;
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

function isProductInquiry(text, matches) {
    if (!matches || matches.length === 0) return false;

    const normalized = normalizeSearchText(text);
    if (!normalized) return false;

    if (/\b(looking for|need|want|interested in|show me|tell me about|do you have|can you print|can you do|can i get)\b/.test(normalized)) {
        return true;
    }

    const searchWords = getProductSearchTerms(text);
    if (searchWords.length === 0 || searchWords.length > 6) return false;

    const rawWords = normalized.split(' ').filter(Boolean);
    return rawWords.every((word) => PRODUCT_SEARCH_STOP_WORDS.has(word) || /^\d+$/.test(word) || searchWords.includes(word));
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
    // When no QR_ACCESS_TOKEN is configured, keep `/qr` publicly reachable and rely on rate limiting instead.
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

/**
 * Extract the international phone number from a WhatsApp JID.
 * e.g. "27123456789@s.whatsapp.net" → "+27123456789"
 */
function getPhoneFromJid(jid) {
    return '+' + (jid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
}

/**
 * Append an order record to the persistent orders store.
 */
function saveOrder(record) {
    orders.push(record);
    saveJsonFile(ORDERS_FILE, orders);
}

/**
 * Find a persisted order record by its Invoice Ninja quote ID.
 */
function findOrderByQuoteId(quoteId) {
    return orders.find((o) => o.invoiceNinjaQuoteId === quoteId) || null;
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

async function requestHumanHandoverConfirmation(sock, jid, reason) {
    userStates[jid] = {
        step: 'awaiting_handover_confirmation',
        pendingHandoverReason: reason
    };

    await sock.sendMessage(jid, {
        text: `🤝 I can ask a ${BUSINESS_NAME} team member to take over.\nIf you confirm, I will pause my automated replies so a person can assist you.\n\n1. Yes – hand over to a team member\n2. No – keep chatting with me`
    });
}

async function submitOrderForReview(sock, jid, cart) {
    const { summary, grandTotal } = buildOrderSummary(cart);
    const customerName = userNames[jid] || '';
    const customerPhone = getPhoneFromJid(jid);
    const customerEmail = userEmails[jid] || '';

    const orderId = crypto.randomBytes(6).toString('hex');
    const orderRecord = {
        id: orderId,
        jid,
        customerName,
        customerPhone,
        customerEmail,
        cart: JSON.parse(JSON.stringify(cart)),
        grandTotal,
        createdAt: new Date().toISOString(),
        invoiceNinjaQuoteId: null,
        invoiceNinjaQuoteNumber: null,
        invoiceNinjaLink: null,
        status: 'pending',
        error: null
    };

    let quoteInfo = null;
    if (invoiceNinja.isConfigured()) {
        try {
            const client = await invoiceNinja.findOrCreateClient({
                name: customerName,
                phone: customerPhone,
                email: customerEmail
            });
            const quote = await invoiceNinja.createQuote(client.id, cart, ARTWORK_DISCLAIMER);
            const quoteUrl = invoiceNinja.getQuoteUrl(quote);
            quoteInfo = { id: quote.id, number: quote.number, url: quoteUrl };
            orderRecord.invoiceNinjaQuoteId = quote.id;
            orderRecord.invoiceNinjaQuoteNumber = quote.number;
            orderRecord.invoiceNinjaLink = quoteUrl;
            orderRecord.status = 'quoted';
        } catch (inError) {
            console.error('❌ Invoice Ninja quote creation failed:', inError.message);
            orderRecord.status = 'pending';
            orderRecord.error = inError.message;
        }
    }
    saveOrder(orderRecord);

    const quoteNote = quoteInfo
        ? `\n\n📄 Quote *${quoteInfo.number}* created: ${quoteInfo.url || '(no link)'}`
        : (invoiceNinja.isConfigured() ? '\n\n⚠️ Quote creation failed – manual follow-up needed.' : '');

    const adminMessage = [
        '🆕 *New order request*',
        `Customer: ${jid}`,
        `Name: ${customerName || '(unknown)'}`,
        `Phone: ${customerPhone}`,
        `Email: ${customerEmail || '(not provided)'}`,
        'Artwork disclaimer accepted: Yes',
        '',
        summary,
        quoteNote
    ].join('\n');

    await sock.sendMessage(ADMIN_JID, { text: adminMessage });

    if (quoteInfo?.url) {
        await sock.sendMessage(jid, {
            text: `📄 Your quote *${quoteInfo.number}* has been created!\n\nView and approve it here:\n${quoteInfo.url}\n\nA ${BUSINESS_NAME} team member will follow up with you shortly.`
        });
    }

    return { quoteCreated: !!(quoteInfo?.url) };
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
                    try {
                        currentQrDataUri = await qrcodeImg.toDataURL(qr);
                    } catch (qrError) {
                        currentQrDataUri = null;
                        console.error('❌ Failed to generate QR image for the /qr endpoint:', qrError?.message || qrError);
                        console.error('ℹ️ The bot can keep running, but /qr will stay unavailable until QR image generation succeeds.');
                    }
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
                    activeSock = null;
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
                    activeSock = sock;
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
                        await requestHumanHandoverConfirmation(sock, jid, rawText);
                        continue;
                    }

                    const userState = userStates[jid] || { step: 'idle' };

                // Cancel / escape from any mid-flow state
                    if (text === 'cancel' || text === 'menu' || /^(hello|hi|hey)\b/.test(text)) {
                        if (text === 'cancel') {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: '❌ Cancelled. Type *menu* to start over.' });
                            continue;
                        }
                        if (/^(hello|hi|hey)\b/.test(text)) {
                            fallbackCounts[jid] = 0;
                            userStates[jid] = { step: 'awaiting_main_menu' };
                            await sock.sendMessage(jid, { text: buildWelcomeText(jid) });
                            continue;
                        }
                        // menu
                        userStates[jid] = { step: 'awaiting_category_selection' };
                        await sock.sendMessage(jid, { text: buildMenuText() });
                        continue;
                    }

                    if (text === 'help') {
                        await sock.sendMessage(jid, { text: buildHelpText() });
                        continue;
                    }

                // ── State: awaiting_main_menu ──────────────────────────────────────
                    if (userState.step === 'awaiting_main_menu') {
                        if (text === '1' || /place.*(new\s+)?order|new order/.test(text)) {
                            userStates[jid] = { step: 'awaiting_quote_product' };
                            await sock.sendMessage(jid, {
                                text: `Tell us what you require and I'll find the closest options for you.\n\nFor example: _banners_, _flyers_, _business cards_, _vehicle graphics_\n\nOr type *menu* to browse our full product catalogue.`
                            });
                            continue;
                        }
                        if (text === '2' || /product\s*list|catalogue|browse|products/.test(text)) {
                            userStates[jid] = { step: 'awaiting_category_selection' };
                            await sock.sendMessage(jid, { text: buildMenuText() });
                            continue;
                        }
                        if (text === '3' || /track|my order/.test(text)) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: buildTrackingText() });
                            continue;
                        }
                        if (text === '4' || /contact|address|store|location|phone|telephone/.test(text)) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: buildContactDetailsText() });
                            continue;
                        }
                        await sock.sendMessage(jid, {
                            text: 'Please reply with a number:\n\n1. Place a new order\n2. Product List\n3. Track My Order\n4. Store Contact Details'
                        });
                        continue;
                    }

                // ── State: awaiting_category_selection ─────────────────────────────
                    if (userState.step === 'awaiting_category_selection') {
                        const categories = getCategories();
                        const catIdx = parseInt(text, 10) - 1;
                        let selectedCat = null;
                        if (!Number.isNaN(catIdx) && catIdx >= 0 && catIdx < categories.length) {
                            selectedCat = categories[catIdx];
                        } else {
                            // try matching by name
                            selectedCat = categories.find((c) => normalizeText(c) === normalizeText(text)) || null;
                        }
                        if (selectedCat) {
                            const subcategories = getSubcategories(selectedCat);
                            if (subcategories.length > 1) {
                                // Show subcategory menu first
                                userStates[jid] = { step: 'awaiting_subcategory_selection', pendingCategory: selectedCat, pendingSubcategories: subcategories };
                                await sock.sendMessage(jid, { text: buildSubcategoryMenuText(selectedCat, subcategories) });
                                continue;
                            }
                            // Only one subcategory (or none) — go straight to products
                            const catProducts = products.filter((p) =>
                                p.Category.toLowerCase().trim() === selectedCat.toLowerCase().trim()
                            );
                            if (catProducts.length === 0) {
                                await sock.sendMessage(jid, { text: `❓ No products found in "${selectedCat}". Type *menu* to try again.` });
                                userStates[jid] = { step: 'idle' };
                                continue;
                            }
                            const sorted = [...catProducts].sort((a, b) => {
                                const priceA = a.PriceType === 'sqm' ? toNumber(a.PricePerSqm) : toNumber(a.FixedPrice);
                                const priceB = b.PriceType === 'sqm' ? toNumber(b.PricePerSqm) : toNumber(b.FixedPrice);
                                return priceA - priceB;
                            });
                            userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: sorted };
                            await sock.sendMessage(jid, { text: buildSubcategoryProductListText(selectedCat, sorted) });
                            continue;
                        }
                        // Input doesn't match a category number or name — reset and fall through to normal processing
                        userStates[jid] = { step: 'idle' };
                    }

                // ── State: awaiting_subcategory_selection ──────────────────────────
                    if (userState.step === 'awaiting_subcategory_selection') {
                        const subcategories = userState.pendingSubcategories || [];
                        const subIdx = parseInt(text, 10) - 1;
                        let selectedSub = null;
                        if (!Number.isNaN(subIdx) && subIdx >= 0 && subIdx < subcategories.length) {
                            selectedSub = subcategories[subIdx];
                        } else {
                            selectedSub = subcategories.find((s) => normalizeText(s) === normalizeText(text)) || null;
                        }
                        if (selectedSub) {
                            const subProducts = products.filter((p) =>
                                (p.Subcategory || '').toLowerCase().trim() === selectedSub.toLowerCase().trim()
                            );
                            if (subProducts.length === 0) {
                                await sock.sendMessage(jid, { text: `❓ No products found in "${selectedSub}". Type *menu* to try again.` });
                                userStates[jid] = { step: 'idle' };
                                continue;
                            }
                            const sorted = [...subProducts].sort((a, b) => {
                                const priceA = a.PriceType === 'sqm' ? toNumber(a.PricePerSqm) : toNumber(a.FixedPrice);
                                const priceB = b.PriceType === 'sqm' ? toNumber(b.PricePerSqm) : toNumber(b.FixedPrice);
                                return priceA - priceB;
                            });
                            userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: sorted };
                            await sock.sendMessage(jid, { text: buildSubcategoryProductListText(selectedSub, sorted) });
                            continue;
                        }
                        // Invalid input — re-show the subcategory menu
                        await sock.sendMessage(jid, { text: `Please reply with a number between 1 and ${subcategories.length}.\n\n${buildSubcategoryMenuText(userState.pendingCategory, subcategories)}` });
                        continue;
                    }

                // ── State: awaiting_handover_confirmation ─────────────────────────────
                    if (userState.step === 'awaiting_handover_confirmation') {
                        if (text === '1' || ['yes', 'y', 'confirm', 'ok', 'okay', 'please do'].includes(text)) {
                            await activateHumanHandover(sock, jid, userState.pendingHandoverReason || rawText);
                            continue;
                        }
                        if (text === '2' || ['no', 'n', 'cancel', 'keep chatting', 'keep going'].includes(text)) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `No problem 👍 I'll keep assisting you here. Tell me what product or quote you need.` });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: 'Please reply *1* (yes, hand over) or *2* (no, keep chatting with me).' });
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
                        dimLength: dims.length,
                        dimHeight: dims.height,
                        sqmPrice,
                        designFee,
                        polesCost: 0,
                        poles: 0,
                        installationFee: 0,
                        qty: 1
                    };

                    if (product.PolesAvailable === 'yes') {
                        userStates[jid] = { step: 'awaiting_poles', pendingProduct: product, pendingItem };
                        reply += `\nWould you like to add *poles*?\nPrice per pole: ${formatCurrency(product.PolePrice)}\n\n1. Yes\n2. No`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }
                    if (toNumber(product.InstallationFee) > 0) {
                        userStates[jid] = { step: 'awaiting_installation', pendingProduct: product, pendingItem };
                        reply += `\nWould you like *installation*? ${formatCurrency(product.InstallationFee)}\n\n1. Yes\n2. No`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }

                    userStates[jid] = { step: 'awaiting_sqm_quantity', pendingProduct: product, pendingItem };
                    reply += `\n${getQuantityPrompt(product)}\n\nType *cancel* to go back.`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }

                // ── State: awaiting_poles ───────────────────────────────────────────
                    if (userState.step === 'awaiting_poles') {
                    if (text === 'yes' || text === '1') {
                        userStates[jid] = { ...userState, step: 'awaiting_pole_count' };
                        await sock.sendMessage(jid, {
                            text: `How many poles do you need?\nPrice per pole: ${formatCurrency(userState.pendingProduct.PolePrice)}\n\nType *cancel* to go back.`
                        });
                        continue;
                    }
                    if (text === 'no' || text === '2') {
                        const instFee = toNumber(userState.pendingProduct.InstallationFee);
                        if (instFee > 0) {
                            userStates[jid] = { ...userState, step: 'awaiting_installation' };
                            await sock.sendMessage(jid, {
                                text: `Would you like *installation*? ${formatCurrency(instFee)}\n\n1. Yes\n2. No`
                            });
                            continue;
                        }
                        const item = userState.pendingItem;
                        userStates[jid] = { step: 'awaiting_sqm_quantity', pendingProduct: userState.pendingProduct, pendingItem: item };
                        await sock.sendMessage(jid, {
                            text: getQuantityPrompt(userState.pendingProduct) + '\n\nType *cancel* to go back.'
                        });
                        continue;
                    }
                        await sock.sendMessage(jid, { text: 'Please reply *1* (yes) or *2* (no).' });
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
                            text: `${count} pole(s) added: ${formatCurrency(polesCost)}\n\nWould you like *installation*? ${formatCurrency(instFee)}\n\n1. Yes\n2. No`
                        });
                        continue;
                    }
                    userStates[jid] = { step: 'awaiting_sqm_quantity', pendingProduct: userState.pendingProduct, pendingItem: updatedItem };
                        await sock.sendMessage(jid, {
                        text: `${count} pole(s) added: ${formatCurrency(polesCost)}\n\n${getQuantityPrompt(userState.pendingProduct)}\n\nType *cancel* to go back.`
                    });
                        continue;
                    }

                // ── State: awaiting_installation ────────────────────────────────────
                    if (userState.step === 'awaiting_installation') {
                    if (text === 'yes' || text === '1' || text === 'no' || text === '2') {
                        const item = userState.pendingItem;
                        item.installationFee = (text === 'yes' || text === '1') ? toNumber(userState.pendingProduct.InstallationFee) : 0;
                        userStates[jid] = { step: 'awaiting_sqm_quantity', pendingProduct: userState.pendingProduct, pendingItem: item };
                        await sock.sendMessage(jid, {
                            text: getQuantityPrompt(userState.pendingProduct) + '\n\nType *cancel* to go back.'
                        });
                        continue;
                    }
                        await sock.sendMessage(jid, { text: 'Please reply *1* (yes) or *2* (no).' });
                        continue;
                    }

                // ── State: awaiting_design_choice ────────────────────────────────────
                    if (userState.step === 'awaiting_design_choice') {
                        const item = userState.pendingItem;
                        const product = userState.pendingProduct;
                        const originalDesignFee = toNumber(product.DesignFee);

                        const isYes = text === '1' || ['yes', 'y', 'own', 'i have', 'have design', 'my design'].some((k) => text.includes(k));
                        const isNo = text === '2' || ['no', 'n', 'need design', 'no design', 'create'].some((k) => text.includes(k));

                        if (isYes) {
                            // Customer has own design — remove design fee from total
                            item.total = item.total - item.designFee;
                            item.designFee = 0;
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push(item);
                            userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, {
                                text: `✅ Added *${item.name}* to your cart! *Total: ${formatCurrency(item.total)}*\n\n⚠️ *Design Disclaimer:* ${OWN_DESIGN_DISCLAIMER}\n\n${buildPostCartText(userCarts[jid].length)}`
                            });
                            continue;
                        }
                        if (isNo) {
                            // Customer needs design — keep design fee
                            // item.designFee and item.total already include the fee
                            if (item.designFee === 0 && originalDesignFee > 0) {
                                item.designFee = originalDesignFee;
                                item.total += originalDesignFee;
                            }
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push(item);
                            userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, {
                                text: `✅ Added *${item.name}* to your cart! Design/Layout fee of ${formatCurrency(item.designFee)} included.\n*Total: ${formatCurrency(item.total)}*\n\n${buildPostCartText(userCarts[jid].length)}`
                            });
                            continue;
                        }
                        await sock.sendMessage(jid, {
                            text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(originalDesignFee)})\n\nReply *1* or *2*.`
                        });
                        continue;
                    }

                // ── State: awaiting_post_cart_add ────────────────────────────────────
                    if (userState.step === 'awaiting_post_cart_add') {
                        if (text === '1' || ['yes', 'y', 'more', 'add', 'another'].some((k) => text.includes(k))) {
                            userStates[jid] = { step: 'awaiting_add_product' };
                            await sock.sendMessage(jid, {
                                text: `What else would you like to add? E.g. _A5 flyers_, _business cards_, _banners_.\n\nType *cancel* to go back or *menu* to browse.`
                            });
                            continue;
                        }
                        if (text === '2' || text === 'cart' || text === 'view cart') {
                            const cart = userCarts[jid] || [];
                            userStates[jid] = { step: 'idle' };
                            if (cart.length === 0) {
                                await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                            } else {
                                await sock.sendMessage(jid, { text: buildCartText(cart) });
                            }
                            continue;
                        }
                        if (text === '3' || text === 'checkout' || text === 'order') {
                            userStates[jid] = { step: 'idle' };
                            const cart = userCarts[jid];
                            if (!cart || cart.length === 0) {
                                await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                                continue;
                            }
                            if (invoiceNinja.isConfigured() && !userEmails[jid]) {
                                userStates[jid] = { step: 'awaiting_customer_email', pendingCart: cart };
                                await sock.sendMessage(jid, {
                                    text: `📧 To generate your quote, please send your *email address*.\n\nOr type *skip* to continue without one.`
                                });
                                continue;
                            }
                            const { summary } = buildOrderSummary(cart, { includeDisclaimer: true });
                            userStates[jid] = { step: 'awaiting_checkout_confirmation', pendingCart: cart };
                            await sock.sendMessage(jid, {
                                text: `${summary}\n\nReply *confirm* to accept the artwork disclaimer and submit your order, or send *human* if you want a person to assist.`
                            });
                            continue;
                        }
                        if (['no', 'n', 'done', 'nothing'].some((k) => text === k)) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `No problem! Type *cart* to view your basket or *checkout* to place your order. 😊` });
                            continue;
                        }
                        await sock.sendMessage(jid, {
                            text: buildPostCartText(userCarts[jid]?.length || 0)
                        });
                        continue;
                    }

                // ── State: awaiting_sqm_quantity ────────────────────────────────────
                    if (userState.step === 'awaiting_sqm_quantity') {
                        const product = userState.pendingProduct;
                        const item = userState.pendingItem;
                        const qty = extractQuantityFromText(text);
                        if (!qty) {
                            await sock.sendMessage(jid, { text: `${getQuantityValidationPrompt(product)} Type *cancel* to go back.` });
                            continue;
                        }
                        item.qty = qty;
                        const labelProfile = getProductQuantityProfile(product);
                        if (labelProfile.mode === 'labels' && item.dimLength && item.dimHeight) {
                            // For labels: total area = L × B × Qty; apply min price to the full order
                            const totalSqm = (item.dimLength / MM_PER_METER) * (item.dimHeight / MM_PER_METER) * qty;
                            item.sqmPrice = Math.max(totalSqm * toNumber(product.PricePerSqm), toNumber(product.MinPrice));
                            item.total = item.sqmPrice + item.designFee + item.polesCost + item.installationFee;
                        } else {
                            item.total = (item.sqmPrice * qty) + item.designFee + item.polesCost + item.installationFee;
                        }
                        if (item.designFee > 0) {
                            userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                            await sock.sendMessage(jid, {
                                text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(item.designFee)})\n\nReply *1* or *2*.`
                            });
                            continue;
                        }
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'awaiting_post_cart_add' };
                        await sock.sendMessage(jid, {
                            text: `✅ Added ${qty.toLocaleString()} × *${product.Name}* to your cart! *Total: ${formatCurrency(item.total)}*\n\n${buildPostCartText(userCarts[jid].length)}`
                        });
                        continue;
                    }

                // ── State: awaiting_buy_quantity ─────────────────────────────────────
                    if (userState.step === 'awaiting_buy_quantity') {
                        const product = userState.pendingProduct;
                        const qty = extractQuantityFromText(text);
                        if (!qty) {
                            await sock.sendMessage(jid, { text: `${getQuantityValidationPrompt(product)} Type *cancel* to go back.` });
                            continue;
                        }
                        const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                        const designFee = toNumber(product.DesignFee);
                        const item = {
                            name: product.Name,
                            sqmPrice: toNumber(product.FixedPrice),
                            designFee,
                            polesCost: 0,
                            poles: 0,
                            installationFee: 0,
                            total: materialTotal + designFee,
                            qty
                        };
                        if (designFee > 0) {
                            userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                            await sock.sendMessage(jid, {
                                text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n\nReply *1* or *2*.`
                            });
                            continue;
                        }
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'awaiting_post_cart_add' };
                        await sock.sendMessage(jid, {
                            text: `✅ Added ${qty.toLocaleString()} × *${product.Name}* to your cart! *Total: ${formatCurrency(item.total)}*\n\n${buildPostCartText(userCarts[jid].length)}`
                        });
                        continue;
                    }

                // ── State: awaiting_customer_email ─────────────────────────────────
                    if (userState.step === 'awaiting_customer_email') {
                        const cart = userState.pendingCart || userCarts[jid] || [];
                        if (cart.length === 0) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                            continue;
                        }
                        if (text === 'skip') {
                            // Proceed without email
                        } else if (/.+@.+\..+/.test(text)) {
                            userEmails[jid] = rawText.trim();
                        } else {
                            await sock.sendMessage(jid, {
                                text: `Please send a valid email address (for example _you@example.com_).\n\nOr type *skip* to continue without one.`
                            });
                            continue;
                        }
                        const { summary } = buildOrderSummary(cart, { includeDisclaimer: true });
                        userStates[jid] = { step: 'awaiting_checkout_confirmation', pendingCart: cart };
                        await sock.sendMessage(jid, {
                            text: `${summary}\n\nReply *confirm* to accept the artwork disclaimer and submit your order, or send *human* if you want a person to assist.`
                        });
                        continue;
                    }

                // ── State: awaiting_checkout_confirmation ───────────────────────────
                    if (userState.step === 'awaiting_checkout_confirmation') {
                    if (['1', 'confirm', 'yes', 'submit', 'place order'].includes(text)) {
                        const cart = userState.pendingCart || userCarts[jid] || [];
                        if (cart.length === 0) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: '🛒 Your cart is empty.' });
                            continue;
                        }

                        const { quoteCreated } = await submitOrderForReview(sock, jid, cart);
                        delete userCarts[jid];
                        userStates[jid] = { step: 'idle' };
                        if (!quoteCreated) {
                            await sock.sendMessage(jid, {
                                text: `✅ Thank you. Your quote/request has been sent to ${BUSINESS_NAME} for follow-up. A team member will contact you if anything needs clarification.`
                            });
                        }
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
                            userProductContext[jid] = product;
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nTo give you an accurate quote, please send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! ${getQuantityPrompt(product)}` });
                            continue;
                        }
                        userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: matches };
                        await sock.sendMessage(jid, {
                            text: buildProductMatchesText(
                                matches,
                                'I found these options:',
                                matches.every((product) => product.PriceType === 'sqm')
                                    ? 'Reply with the option number and then I’ll ask for the size in mm to calculate the price.'
                                    : 'Reply with the option number for a quote.'
                            )
                        });
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
                        userProductContext[jid] = product;
                        if (product.PriceType === 'sqm') {
                            userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                            continue;
                        }
                        userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                        await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! ${getQuantityPrompt(product)}` });
                        continue;
                    }

                // ── State: awaiting_quote_quantity ──────────────────────────────────
                    if (userState.step === 'awaiting_quote_quantity') {
                        const product = userState.pendingProduct;
                        const qty = extractQuantityFromText(text);
                        if (!qty) {
                            await sock.sendMessage(jid, { text: `${getQuantityValidationPrompt(product)} Type *cancel* to go back.` });
                            continue;
                        }
                        const total = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                        const quoteText = buildQuoteText(product, qty, total);
                        userProductContext[jid] = product;
                        userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: total };
                        await sock.sendMessage(jid, { text: quoteText });
                        continue;
                    }

                // ── State: awaiting_quote_confirm ───────────────────────────────────
                    if (userState.step === 'awaiting_quote_confirm') {
                        if (text === '1' || ['yes', 'y', 'add', 'yes add', 'yeah', 'yep', 'sure'].includes(text)) {
                            const product = userState.pendingProduct;
                            const qty = userState.pendingQty;
                            const materialTotal = userState.pendingTotal;
                            const designFee = toNumber(product.DesignFee);
                            const item = {
                                name: product.Name,
                                sqmPrice: toNumber(product.FixedPrice),
                                designFee,
                                polesCost: 0,
                                poles: 0,
                                installationFee: 0,
                                total: materialTotal + designFee,
                                qty
                            };
                            if (designFee > 0) {
                                userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                                await sock.sendMessage(jid, {
                                    text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n\nReply *1* or *2*.`
                                });
                                continue;
                            }
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push(item);
                            userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, { text: `✅ Added to your cart! *Total: ${formatCurrency(item.total)}*\n\n${buildPostCartText(userCarts[jid].length)}` });
                            continue;
                        }
                        if (text === '2' || ['no', 'n', 'nope', 'nah'].includes(text)) {
                            userStates[jid] = { step: 'idle' };
                            await sock.sendMessage(jid, { text: `No problem! Let me know if you need anything else. Type *menu* or ask for another *quote*. 😊` });
                            continue;
                        }
                        await sock.sendMessage(jid, { text: `Please reply *1* (yes, add to cart) or *2* (no, cancel).` });
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
                            userProductContext[jid] = product;
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                            const designFee = toNumber(product.DesignFee);
                            const item = { name: product.Name, sqmPrice: toNumber(product.FixedPrice), designFee, polesCost: 0, poles: 0, installationFee: 0, total: materialTotal + designFee, qty };
                            if (designFee > 0) {
                                userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                                await sock.sendMessage(jid, {
                                    text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n\nReply *1* or *2*.`
                                });
                                continue;
                            }
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push(item);
                            userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, { text: `✅ Got it! I've added ${qty.toLocaleString()} × *${product.Name}* to your cart.\n\n${buildPostCartText(userCarts[jid].length)}` });
                            continue;
                        }
                        userStates[jid] = { step: 'awaiting_add_product_selection', pendingMatches: matches, pendingQty: qty };
                        await sock.sendMessage(jid, {
                            text: buildProductMatchesText(matches, 'I found these options:', 'Reply with the option number to add it to your cart.')
                        });
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
                        userProductContext[jid] = product;
                        if (product.PriceType === 'sqm') {
                            userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                            continue;
                        }
                        const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                        const designFee = toNumber(product.DesignFee);
                        const item = { name: product.Name, sqmPrice: toNumber(product.FixedPrice), designFee, polesCost: 0, poles: 0, installationFee: 0, total: materialTotal + designFee, qty };
                        if (designFee > 0) {
                            userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                            await sock.sendMessage(jid, {
                                text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n\nReply *1* or *2*.`
                            });
                            continue;
                        }
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'awaiting_post_cart_add' };
                        await sock.sendMessage(jid, { text: `✅ Got it! I've added ${qty.toLocaleString()} × *${product.Name}* to your cart.\n\n${buildPostCartText(userCarts[jid].length)}` });
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
                    const catProducts = products.filter((p) => p.Category.toLowerCase().trim() === catName.toLowerCase().trim() ||
                        (p.Subcategory && p.Subcategory.toLowerCase().trim() === catName.toLowerCase().trim()));
                    if (catProducts.length === 0) {
                            await sock.sendMessage(jid, { text: `❓ Category "${catName}" not found. Type *menu* to see categories.` });
                            continue;
                    }

                    // Sort by price ascending (lowest first)
                    const sorted = [...catProducts].sort((a, b) => {
                        const priceA = a.PriceType === 'sqm' ? toNumber(a.PricePerSqm) : toNumber(a.FixedPrice);
                        const priceB = b.PriceType === 'sqm' ? toNumber(b.PricePerSqm) : toNumber(b.FixedPrice);
                        return priceA - priceB;
                    });

                        userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: sorted };
                        await sock.sendMessage(jid, { text: buildSubcategoryProductListText(catName, sorted) });
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
                    userProductContext[jid] = product;
                    if (product.PriceType === 'sqm') {
                        userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                            await sock.sendMessage(jid, {
                            text: `📐 *${product.Name}*\nPlease send the *length x height in mm*\nfor example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back or *human* for a team member.`
                        });
                            continue;
                    }

                    const price = toNumber(product.FixedPrice);
                    if (parts.length > 2) {
                        const qty = parseInt(parts[2], 10);
                        if (Number.isNaN(qty) || qty < 1) {
                                await sock.sendMessage(jid, { text: 'Please enter a valid quantity, for example _buy 12 2_.' });
                                continue;
                        }
                        const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                        const designFee = toNumber(product.DesignFee);
                        const item = {
                            name: product.Name,
                            sqmPrice: price,
                            designFee,
                            polesCost: 0,
                            poles: 0,
                            installationFee: 0,
                            total: materialTotal + designFee,
                            qty
                        };
                        if (designFee > 0) {
                            userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                            await sock.sendMessage(jid, {
                                text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n\nReply *1* or *2*.`
                            });
                            continue;
                        }
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, {
                            text: `✅ Added ${qty.toLocaleString()} × *${product.Name}* @ ${formatCurrency(price)} each.\n\n${buildPostCartText(userCarts[jid].length)}`
                        });
                            continue;
                    }
                    userStates[jid] = { step: 'awaiting_buy_quantity', pendingProduct: product };
                        await sock.sendMessage(jid, {
                        text: `*${product.Name}*\nPrice: ${formatCurrency(price)} per unit\n\n${getQuantityPrompt(product)}\n\nType *cancel* to go back.`
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

                        // When Invoice Ninja is configured, collect an email address first
                        // (skip if we already have one for this session)
                        if (invoiceNinja.isConfigured() && !userEmails[jid]) {
                            userStates[jid] = { step: 'awaiting_customer_email', pendingCart: cart };
                            await sock.sendMessage(jid, {
                                text: `📧 To generate your quote, please send your *email address*.\n\nOr type *skip* to continue without one.`
                            });
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
                        await requestHumanHandoverConfirmation(sock, jid, rawText);
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
                                userProductContext[jid] = product;
                                if (product.PriceType === 'sqm') {
                                    userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                    await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nTo give you an accurate quote, please send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                    continue;
                                }
                                if (qty) {
                                    const total = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                                    const quoteText = buildQuoteText(product, qty, total);
                                    userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: total };
                                    await sock.sendMessage(jid, { text: quoteText });
                                    continue;
                                }
                                userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `Great! To give you an accurate quote for *${product.Name}* – ${getQuantityPrompt(product)}` });
                                continue;
                            }

                            if (matches.length > 1) {
                                userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: matches };
                                await sock.sendMessage(jid, {
                                    text: buildProductMatchesText(
                                        matches,
                                        'I found these options:',
                                        matches.every((product) => product.PriceType === 'sqm')
                                            ? 'Reply with the option number and then I’ll ask for the size in mm to calculate the price.'
                                            : 'Reply with the option number for a quote.'
                                    )
                                });
                                continue;
                            }

                            const previousProduct = userProductContext[jid];
                            if (previousProduct) {
                                if (qty) {
                                    const total = calcFixedQuoteForQty(previousProduct, getPricedQuantity(previousProduct, qty));
                                    const quoteText = buildQuoteText(previousProduct, qty, total);
                                    userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: previousProduct, pendingQty: qty, pendingTotal: total };
                                    await sock.sendMessage(jid, { text: `Still on *${previousProduct.Name}*.\n\n${quoteText}` });
                                    continue;
                                }
                                userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: previousProduct };
                                await sock.sendMessage(jid, { text: `Still on *${previousProduct.Name}*.\n${getQuantityPrompt(previousProduct)}` });
                                continue;
                            }

                            await sock.sendMessage(jid, { text: `To give you an accurate quote, I need:\n1) Product type (e.g. _flyers_, _banners_, _business cards_)\n2) Quantity\n3) Paper type / finishing (e.g. gloss/matte)\n\nCould you provide these?` });
                            userStates[jid] = { step: 'awaiting_quote_product' };
                            continue;
                        }
                    }

                // ── Intent: product search / browse ──────────────────────────────────
                    if (userState.step === 'idle') {
                        const matches = findProductsByKeyword(text);
                        if (isProductInquiry(text, matches)) {
                            fallbackCounts[jid] = 0;

                            if (matches.length === 1) {
                                const [product] = matches;
                                userProductContext[jid] = product;
                                if (product.PriceType === 'sqm') {
                                    userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                    await sock.sendMessage(jid, {
                                        text: `📐 *${product.Name}*\nThis item is priced by size.\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_, and I’ll calculate the price for you.`
                                    });
                                    continue;
                                }

                                userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                                await sock.sendMessage(jid, {
                                    text: buildProductMatchesText(
                                        matches,
                                        'I found this option:',
                                        getQuantityPrompt(product)
                                    )
                                });
                                continue;
                            }

                            userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: matches };
                            await sock.sendMessage(jid, {
                                text: buildProductMatchesText(
                                    matches,
                                    'I found these options:',
                                    matches.every((product) => product.PriceType === 'sqm')
                                        ? 'Reply with the option number and then I’ll ask for the size in mm to calculate the price.'
                                        : 'Reply with the option number and I’ll help you price it or add it to your cart.'
                                )
                            });
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
                            userProductContext[jid] = product;
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                            const designFee = toNumber(product.DesignFee);
                            const item = { name: product.Name, sqmPrice: toNumber(product.FixedPrice), designFee, polesCost: 0, poles: 0, installationFee: 0, total: materialTotal + designFee, qty };
                            if (designFee > 0) {
                                userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
                                await sock.sendMessage(jid, {
                                    text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n\nReply *1* or *2*.`
                                });
                                continue;
                            }
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push(item);
                            userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, { text: `✅ Got it! I've added ${qty.toLocaleString()} × *${product.Name}* to your cart.\n\n${buildPostCartText(userCarts[jid].length)}` });
                            continue;
                        }

                        if (matches.length > 1) {
                            const list = matches.map((p, i) => `${i + 1}. ${p.Name}`).join('\n');
                            userStates[jid] = { step: 'awaiting_add_product_selection', pendingMatches: matches, pendingQty: qty };
                            await sock.sendMessage(jid, { text: `We have a few options:\n${list}\n\nReply with the number to add it to your cart.` });
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

                    // Default fallback – track count and escalate after 3 failed attempts
                    fallbackCounts[jid] = (fallbackCounts[jid] || 0) + 1;
                    recordLearningLead(jid, rawText);
                    if (fallbackCounts[jid] >= 3 && jid !== ADMIN_JID) {
                        fallbackCounts[jid] = 0;
                        await requestHumanHandoverConfirmation(sock, jid, `Bot could not understand repeated messages (last: "${rawText}")`);
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

// --- INVOICE NINJA WEBHOOK ---
// Configure this URL in Invoice Ninja → Settings → Webhooks
// POST https://your-app.up.railway.app/webhook/invoice-ninja
app.post('/webhook/invoice-ninja', (req, res, next) => {
    // Capture raw body so we can verify the HMAC signature when a secret is configured
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        req.rawBody = Buffer.concat(chunks).toString('utf8');
        try {
            req.body = JSON.parse(req.rawBody);
        } catch {
            req.body = {};
        }
        next();
    });
}, (req, res) => {
    if (INVOICE_NINJA_WEBHOOK_SECRET) {
        const signature = req.get('x-ninja-signature') || '';
        const expected = crypto
            .createHmac('sha256', INVOICE_NINJA_WEBHOOK_SECRET)
            .update(req.rawBody)
            .digest('hex');
        const sigBuf = Buffer.from(signature.padEnd(expected.length, '\0'));
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    // Acknowledge immediately; process the event asynchronously
    res.json({ ok: true });

    (async () => {
        try {
            const event = req.body;
            // Invoice Ninja v5 webhook payload: { action: '...', data: { ...entity... } }
            const action = (event?.action || '').toLowerCase();
            const entityData = event?.data || {};
            const quoteId = entityData?.id;

            if (!quoteId) return;

            const order = findOrderByQuoteId(quoteId);
            if (!order) return; // Not one of our orders

            const jid = order.jid;
            if (!activeSock || whatsappRuntime.phase !== 'connected') {
                console.warn('⚠️ Invoice Ninja webhook received but WhatsApp not connected. Event:', action, 'Order:', order.id);
                return;
            }

            // Quote approved (status_id 3 in Invoice Ninja v5)
            const isApproved = action === 'approve' ||
                (action === 'update' && entityData?.status_id === 3);

            // Quote / invoice paid
            const isPaid = action === 'paid' ||
                (action === 'update' && (entityData?.status_id === 5 || entityData?.status_id === 6));

            // Quote expired (status_id 4)
            const isExpired = action === 'update' && entityData?.status_id === 4;

            if (isApproved) {
                // Update our order record
                const idx = orders.findIndex((o) => o.id === order.id);
                if (idx >= 0) { orders[idx].status = 'approved'; saveJsonFile(ORDERS_FILE, orders); }

                await activeSock.sendMessage(jid, {
                    text: `✅ Great news! Your quote *${order.invoiceNinjaQuoteNumber}* has been approved.\n\nA ${BUSINESS_NAME} team member will be in touch to confirm production details.`
                });
                await activeSock.sendMessage(ADMIN_JID, {
                    text: `✅ *Quote approved*\nCustomer: ${jid}\nQuote: ${order.invoiceNinjaQuoteNumber}`
                });
            } else if (isPaid) {
                const idx = orders.findIndex((o) => o.id === order.id);
                if (idx >= 0) { orders[idx].status = 'paid'; saveJsonFile(ORDERS_FILE, orders); }

                await activeSock.sendMessage(jid, {
                    text: `💳 Payment received for quote *${order.invoiceNinjaQuoteNumber}*. Thank you!\n\nWe will begin production shortly. 😊\n\n– ${BUSINESS_NAME} Team`
                });
                await activeSock.sendMessage(ADMIN_JID, {
                    text: `💳 *Payment received*\nCustomer: ${jid}\nQuote: ${order.invoiceNinjaQuoteNumber}`
                });
            } else if (isExpired) {
                const idx = orders.findIndex((o) => o.id === order.id);
                if (idx >= 0) { orders[idx].status = 'expired'; saveJsonFile(ORDERS_FILE, orders); }

                await activeSock.sendMessage(jid, {
                    text: `⚠️ Your quote *${order.invoiceNinjaQuoteNumber}* has expired. Please type *checkout* to generate a new one, or send *human* to speak with a team member.`
                });
            }
        } catch (err) {
            console.error('❌ Error processing Invoice Ninja webhook:', err);
        }
    })();
});

// --- PRODUCTS CSV DOWNLOAD / UPLOAD ---
// All endpoints are protected by the same QR_ACCESS_TOKEN auth used for /qr, and rate-limited.
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    fileFilter: (_req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.csv') || file.mimetype === 'text/csv') {
            cb(null, true);
        } else {
            cb(new Error('Only .csv files are accepted.'));
        }
    }
});

const productsRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: '<p>Too many requests. Please wait a minute.</p>'
});

function productsAuthMiddleware(req, res, next) {
    if (!isAuthorizedQrRequest(getQrAccessToken(req))) {
        return res.status(401).send('<p>Unauthorized. Missing or invalid token.</p>');
    }
    next();
}

// GET /products/template — blank CSV with headers and one sample row
app.get('/products/template', productsRouteLimiter, productsAuthMiddleware, (_req, res) => {
    const template = DEFAULT_CSV + '\n' + CSV_SAMPLE_ROW + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products_template.csv"');
    res.send(template);
});

// GET /products/csv — current products.csv
app.get('/products/csv', productsRouteLimiter, productsAuthMiddleware, (_req, res) => {
    if (!fs.existsSync(CSV_FILE)) {
        return res.status(404).send('<p>No products file found.</p>');
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    res.sendFile(CSV_FILE);
});

// POST /products/upload — replace products.csv with the uploaded file
app.post('/products/upload', productsRouteLimiter, productsAuthMiddleware, (req, res) => {
    csvUpload.single('file')(req, res, (err) => {
        if (err) {
            return res.status(400).send(`<p>Upload failed: ${err.message}</p>`);
        }
        if (!req.file) {
            return res.status(400).send('<p>No file provided. Please attach a .csv file with field name "file".</p>');
        }
        fs.writeFileSync(CSV_FILE, req.file.buffer);
        loadProducts();
        res.send('<!DOCTYPE html><html><head><title>Upload complete</title></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>✅ Products updated!</h2><p>The products CSV has been replaced and reloaded.</p><p><a href="products">← Back to Products Admin</a></p></body></html>');
    });
});

// GET /products — HTML admin page for downloading/uploading the products CSV
app.get('/products', productsRouteLimiter, productsAuthMiddleware, (req, res) => {
    const token = getQrAccessToken(req);
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Products CSV Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
    h1 { font-size: 1.4rem; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .card h2 { margin-top: 0; font-size: 1.1rem; }
    a.btn, button.btn { display: inline-block; padding: 10px 18px; background: #25d366; color: #fff; text-decoration: none; border: none; border-radius: 6px; cursor: pointer; font-size: 0.95rem; }
    a.btn.secondary { background: #444; }
    input[type=file] { display: block; margin: 12px 0; }
    p.hint { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>📦 Products CSV Admin</h1>

  <div class="card">
    <h2>1. Download template</h2>
    <p class="hint">A blank CSV with headers and one sample row so you know the required format.</p>
    <a class="btn secondary" href="products/template${tokenParam}">⬇ Download template</a>
  </div>

  <div class="card">
    <h2>2. Download current products</h2>
    <p class="hint">Download the live products file to edit it.</p>
    <a class="btn secondary" href="products/csv${tokenParam}">⬇ Download products.csv</a>
  </div>

  <div class="card">
    <h2>3. Upload updated CSV</h2>
    <p class="hint">Upload your edited CSV to replace the current products file. The bot will reload products immediately.</p>
    <form method="POST" action="products/upload${tokenParam}" enctype="multipart/form-data">
      <input type="file" name="file" accept=".csv">
      <button class="btn" type="submit">⬆ Upload</button>
    </form>
  </div>
</body>
</html>`);
});

const server = app.listen(PORT, () => {
    const railwayUrl = getRailwayQrUrl();
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
