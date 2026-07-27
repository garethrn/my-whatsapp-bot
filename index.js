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
const { Readable } = require('stream');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const driveStorage = require('./driveStorage');

// --- YOUR CONFIGURATION ---
const ADMIN_JID = process.env.ADMIN_JID;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
// Optional plaintext admin password for dashboard login (highly recommended).
// If not set, dashboard access falls back to QR_ACCESS_TOKEN only.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const STORAGE_DIR = path.join(__dirname, 'storage');
const CSV_FILE = path.join(__dirname, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');
const LEARNED_RESPONSES_FILE = path.join(STORAGE_DIR, 'learned_responses.json');
const LEARNING_LEADS_FILE = path.join(STORAGE_DIR, 'learning_leads.json');
const ORDERS_FILE = path.join(STORAGE_DIR, 'orders.json');
const AUDIT_LOG_FILE = path.join(STORAGE_DIR, 'admin_audit.log');
const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');
const MAX_HISTORY = 10;
const MAX_NAVIGATION_HISTORY = 25;
const MAX_LEARNING_LEADS = 200;
const BUSINESS_NAME = 'Duzi Signs';
const MM_PER_METER = 1000;
// Guardrail for obviously invalid custom sizes (50m in mm).
const MAX_DIMENSION_MM = 50000;
// Minimum similarity score (0-1) for a stored learned reply to be reused.
const LEARNING_MATCH_THRESHOLD = 0.45;
const DIMENSION_FORMAT_EXAMPLE = '1200 x 600 mm';
const TRACKING_URL = process.env.TRACKING_URL || 'https://www.trackyourparcel.co.za';
const NAVIGATION_HINT = 'Type *back* to go to the previous step or *home* for the main menu.';
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
let userNavigationHistory = {};
let userNames = {};
let fallbackCounts = {};
let userEmails = {};
let orders = loadJsonFile(ORDERS_FILE, []);
let settings = loadJsonFile(SETTINGS_FILE, { wholesalePassword: '' });
// Tracks which customer JIDs have authenticated as wholesale clients in this session.
let wholesaleActiveSessions = {};
// Full conversation log keyed by JID – stores both user and bot messages for the admin dashboard.
const MAX_CHAT_LOG = 100;
let chatLog = {}; // { [jid]: [{ role: 'user'|'bot', text: string, timestamp: string }] }
let chatLogLastActivity = {}; // { [jid]: ISO timestamp of last message }

// ── Admin dashboard sessions ──────────────────────────────────────────────────
// In-memory session store: token → { ip, createdAt, expiresAt }
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const adminSessions = new Map();

function createAdminSession(ip) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    adminSessions.set(token, { ip, createdAt: now, expiresAt: now + ADMIN_SESSION_TTL_MS });
    return token;
}

function validateAdminSession(token) {
    if (!token || typeof token !== 'string') return false;
    const session = adminSessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) { adminSessions.delete(token); return false; }
    return true;
}

function deleteAdminSession(token) {
    adminSessions.delete(token);
}

/** Append a one-line entry to the persistent admin audit log. */
function auditLog(action, detail, ip) {
    const line = `${new Date().toISOString()} | ${action.padEnd(16)} | ip=${ip || '-'} | ${detail}\n`;
    try { fs.appendFileSync(AUDIT_LOG_FILE, line); } catch { /* non-fatal */ }
}

/**
 * Parse the admin session cookie from an Express request.
 * Falls back to the ****** / QR_ACCESS_TOKEN query param so existing
 * integrations using the token continue to work.
 */
function getAdminSessionToken(req) {
    // 1. Cookie set by the login form
    const cookieHeader = req.get('cookie') || '';
    for (const part of cookieHeader.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === 'adminSession') return decodeURIComponent(v.join('='));
    }
    // 2. ****** header
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return null;
}

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

const DEFAULT_CSV = 'ID,Category,Subcategory,SubSubcategory,SubSubSubcategory,Name,Size,Finish,SingleOrDoubleSided,UnitsPerProduct,PriceType,PricePerSqm,FixedPrice,MinPrice,DesignFee,PolesAvailable,PolePrice,InstallationFee,RequiresArtwork,Aliases';
const CSV_SAMPLE_ROW = '1,Paper Printing,Business Cards,Single Sided,,Business Cards 300GSM,Standard 90x55mm,Semi Gloss,Single sided,100,fixed,,R120.00,,0,no,,0,yes,visiting cards|biz cards';

const PRODUCT_FIELD_ALIASES = {
    ID: ['ID', 'ProductID', 'Product Id', 'SKU', 'Code'],
    Category: ['Category', 'Department'],
    Subcategory: ['Subcategory', 'Sub Category', 'Product Type', 'Type'],
    SubSubcategory: ['SubSubcategory', 'Sub Sub Category', 'Sub-Sub-Category', 'SubSubCategory'],
    SubSubSubcategory: ['SubSubSubcategory', 'Sub Sub Sub Category', 'Sub-Sub-Sub-Category', 'SubSubSubCategory'],
    Name: ['Name', 'Product', 'Product Name', 'Item', 'Item Name', 'Description'],
    Size: ['Size', 'Dimensions'],
    Finish: ['Finish', 'Material'],
    SingleOrDoubleSided: ['SingleOrDoubleSided', 'Single Or Double Sided', 'Sides', 'Sided'],
    UnitsPerProduct: ['UnitsPerProduct', 'Units Per Product', 'Pack Size', 'Pack Quantity', 'Quantity', 'Qty'],
    PriceType: ['PriceType', 'Price Type', 'Pricing Type'],
    PricePerSqm: ['PricePerSqm', 'Price Per Sqm', 'Price Per Square Metre', 'Price Per Square Meter', 'Sqm Price'],
    FixedPrice: ['FixedPrice', 'Fixed Price', 'Price', 'Selling Price', 'Unit Price', 'Amount'],
    MinPrice: ['MinPrice', 'Minimum Price'],
    DesignFee: ['DesignFee', 'Design Fee'],
    PolesAvailable: ['PolesAvailable', 'Poles Available'],
    PolePrice: ['PolePrice', 'Pole Price'],
    InstallationFee: ['InstallationFee', 'Installation Fee'],
    RequiresArtwork: ['RequiresArtwork', 'Requires Artwork', 'Artwork Required', 'Ask Artwork', 'AskArtwork'],
    Aliases: ['Aliases', 'Alias', 'Keywords', 'Tags']
};

function normalizeCsvHeader(header) {
    return String(header || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function getFirstMappedValue(row, fieldName) {
    const normalizedRow = Object.entries(row || {}).reduce((acc, [key, value]) => {
        acc[normalizeCsvHeader(key)] = value;
        return acc;
    }, {});

    const aliases = PRODUCT_FIELD_ALIASES[fieldName] || [fieldName];
    for (const alias of aliases) {
        const value = normalizedRow[normalizeCsvHeader(alias)];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }

    return '';
}

function normalizeProductRecord(row) {
    const product = {
        ID: getFirstMappedValue(row, 'ID'),
        Category: getFirstMappedValue(row, 'Category'),
        Subcategory: getFirstMappedValue(row, 'Subcategory'),
        SubSubcategory: getFirstMappedValue(row, 'SubSubcategory'),
        SubSubSubcategory: getFirstMappedValue(row, 'SubSubSubcategory'),
        Name: getFirstMappedValue(row, 'Name'),
        Size: getFirstMappedValue(row, 'Size'),
        Finish: getFirstMappedValue(row, 'Finish'),
        SingleOrDoubleSided: getFirstMappedValue(row, 'SingleOrDoubleSided'),
        UnitsPerProduct: getFirstMappedValue(row, 'UnitsPerProduct'),
        PriceType: getFirstMappedValue(row, 'PriceType').toLowerCase(),
        PricePerSqm: getFirstMappedValue(row, 'PricePerSqm'),
        FixedPrice: getFirstMappedValue(row, 'FixedPrice'),
        MinPrice: getFirstMappedValue(row, 'MinPrice'),
        DesignFee: getFirstMappedValue(row, 'DesignFee'),
        PolesAvailable: getFirstMappedValue(row, 'PolesAvailable').toLowerCase(),
        PolePrice: getFirstMappedValue(row, 'PolePrice'),
        InstallationFee: getFirstMappedValue(row, 'InstallationFee'),
        RequiresArtwork: getFirstMappedValue(row, 'RequiresArtwork').toLowerCase() || 'yes',
        Aliases: getFirstMappedValue(row, 'Aliases')
    };

    if (!product.Name) product.Name = product.Subcategory || product.Category;

    if (product.PriceType !== 'sqm' && product.PriceType !== 'fixed') {
        product.PriceType = product.PricePerSqm ? 'sqm' : 'fixed';
    }

    const hasCatalogFields = product.Category || product.Subcategory || product.Name;
    const hasPriceFields = product.PricePerSqm || product.FixedPrice || product.MinPrice;
    if (!hasCatalogFields && !hasPriceFields) return null;

    return product;
}

function parseProductsCsvStream(stream) {
    return new Promise((resolve, reject) => {
        const rows = [];
        stream
            .pipe(csv({ mapHeaders: ({ header }) => String(header || '').replace(/^\uFEFF/, '').trim() }))
            .on('data', (row) => rows.push(row))
            .on('error', reject)
            .on('end', () => {
                const normalizedProducts = rows
                    .map((row) => normalizeProductRecord(row))
                    .filter(Boolean);

                const validProducts = normalizedProducts.filter((product) => {
                    const hasName = Boolean((product.Name || product.Subcategory || product.Category || '').trim());
                    const hasPrice = product.PriceType === 'sqm'
                        ? toNumber(product.PricePerSqm) > 0 || toNumber(product.MinPrice) > 0
                        : toNumber(product.FixedPrice) > 0 || toNumber(product.PricePerSqm) > 0;
                    return hasName && hasPrice;
                });

                if (validProducts.length === 0) {
                    reject(new Error('The CSV could not be matched to the expected product fields. Please use the template or include columns such as Name, Category, FixedPrice or PricePerSqm.'));
                    return;
                }

                resolve(validProducts);
            });
    });
}

function parseProductsCsvBuffer(buffer) {
    return parseProductsCsvStream(Readable.from([buffer]));
}

async function loadProducts() {
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, DEFAULT_CSV);
    }

    try {
        products = await parseProductsCsvStream(fs.createReadStream(CSV_FILE));
        console.log(`✅ Inventory Loaded (${products.length} products)`);
    } catch (error) {
        console.error('❌ Failed to load products:', error.message);
    }
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

    const scored = products
        .map((product) => {
            const name = normalizeSearchText(product.Name);
            const category = normalizeSearchText(product.Category);
            const subcategory = normalizeSearchText(product.Subcategory);
            const subSubcategory = normalizeSearchText(product.SubSubcategory || '');
            const subSubSubcategory = normalizeSearchText(product.SubSubSubcategory || '');
            const aliases = normalizeSearchText(product.Aliases || '');
            const detail = normalizeSearchText([
                product.Name,
                product.Category,
                product.Subcategory,
                product.SubSubcategory,
                product.SubSubSubcategory,
                product.Size,
                product.Finish,
                product.SingleOrDoubleSided,
                product.Aliases
            ].join(' '));

            let score = 0;
            if (name && normalized.includes(name)) score += 18;
            if (name && name.includes(normalized)) score += 14;
            if (subcategory && subcategory.includes(normalized)) score += 12;
            if (subSubcategory && subSubcategory.includes(normalized)) score += 11;
            if (subSubSubcategory && subSubSubcategory.includes(normalized)) score += 10;
            if (category && category.includes(normalized)) score += 10;
            if (aliases && aliases.includes(normalized)) score += 14;
            if (detail.includes(normalized)) score += 8;

            const nameMatches = searchWords.filter((word) => name.includes(word)).length;
            const subcategoryMatches = searchWords.filter((word) => subcategory.includes(word)).length;
            const subSubcategoryMatches = subSubcategory ? searchWords.filter((word) => subSubcategory.includes(word)).length : 0;
            const subSubSubcategoryMatches = subSubSubcategory ? searchWords.filter((word) => subSubSubcategory.includes(word)).length : 0;
            const categoryMatches = searchWords.filter((word) => category.includes(word)).length;
            const aliasMatches = aliases ? searchWords.filter((word) => aliases.includes(word)).length : 0;
            const detailMatches = searchWords.filter((word) => detail.includes(word)).length;

            score += nameMatches * 5;
            score += subcategoryMatches * 4;
            score += subSubcategoryMatches * 4;
            score += subSubSubcategoryMatches * 3;
            score += categoryMatches * 3;
            score += aliasMatches * 5;
            score += Math.max(0, detailMatches - nameMatches - subcategoryMatches - subSubcategoryMatches - subSubSubcategoryMatches - categoryMatches - aliasMatches);

            if (searchWords.length > 0 && searchWords.every((word) => name.includes(word))) score += 8;
            if (searchWords.length > 1 && searchWords.every((word) => detail.includes(word))) score += 4;

            return { product, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const nameCompare = String(a.product.Name || a.product.Subcategory || a.product.Category || '').localeCompare(String(b.product.Name || b.product.Subcategory || b.product.Category || ''));
            if (nameCompare !== 0) return nameCompare;
            // Within same product name, sort by price ascending (lowest first)
            const priceA = a.product.PriceType === 'sqm' ? toNumber(a.product.PricePerSqm) : toNumber(a.product.FixedPrice);
            const priceB = b.product.PriceType === 'sqm' ? toNumber(b.product.PricePerSqm) : toNumber(b.product.FixedPrice);
            if (priceA !== priceB) return priceA - priceB;
            return String(a.product.ID || '').localeCompare(String(b.product.ID || ''));
        });

    // Cascaded narrowing: if the top result's category labels (subcategory →
    // sub-sub-category → sub-sub-sub-category) contain all words of the search
    // query, narrow results to that level to avoid showing unrelated products.
    if (scored.length > 0) {
        let narrowed = scored;

        // 1. Narrow to top subcategory
        const topSubcat = scored[0].product.Subcategory;
        if (topSubcat) {
            const topSubcatWords = normalizeSearchText(topSubcat).split(' ').filter(Boolean);
            if (topSubcatWords.length > 0 && topSubcatWords.every((w) => normalized.includes(w))) {
                const subcatNorm = topSubcat.toLowerCase().trim();
                const subcatFiltered = scored.filter(({ product }) =>
                    (product.Subcategory || '').toLowerCase().trim() === subcatNorm
                );
                if (subcatFiltered.length > 0 && subcatFiltered.length < scored.length) {
                    narrowed = subcatFiltered;
                }
            }
        }

        // 2. Narrow to top sub-sub-category
        if (narrowed.length > 0) {
            const topSubSubcat = narrowed[0].product.SubSubcategory;
            if (topSubSubcat) {
                const topSubSubcatWords = normalizeSearchText(topSubSubcat).split(' ').filter(Boolean);
                if (topSubSubcatWords.length > 0 && topSubSubcatWords.every((w) => normalized.includes(w))) {
                    const subSubcatNorm = topSubSubcat.toLowerCase().trim();
                    const subSubcatFiltered = narrowed.filter(({ product }) =>
                        (product.SubSubcategory || '').toLowerCase().trim() === subSubcatNorm
                    );
                    if (subSubcatFiltered.length > 0 && subSubcatFiltered.length < narrowed.length) {
                        narrowed = subSubcatFiltered;
                    }
                }
            }
        }

        // 3. Narrow to top sub-sub-sub-category
        if (narrowed.length > 0) {
            const topSubSubSubcat = narrowed[0].product.SubSubSubcategory;
            if (topSubSubSubcat) {
                const topSubSubSubcatWords = normalizeSearchText(topSubSubSubcat).split(' ').filter(Boolean);
                if (topSubSubSubcatWords.length > 0 && topSubSubSubcatWords.every((w) => normalized.includes(w))) {
                    const subSubSubcatNorm = topSubSubSubcat.toLowerCase().trim();
                    const subSubSubcatFiltered = narrowed.filter(({ product }) =>
                        (product.SubSubSubcategory || '').toLowerCase().trim() === subSubSubcatNorm
                    );
                    if (subSubSubcatFiltered.length > 0 && subSubSubcatFiltered.length < narrowed.length) {
                        narrowed = subSubSubcatFiltered;
                    }
                }
            }
        }

        return narrowed.map(({ product }) => product);
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

/**
 * Returns the design fee scaled by the number of sets/packs for pack-based products.
 * For single-unit products the fee is returned flat (charged once per order).
 */
function calcScaledDesignFee(product, qty) {
    const baseFee = toNumber(product.DesignFee);
    if (baseFee === 0) return 0;
    const profile = getProductQuantityProfile(product);
    if (profile.mode === 'sets') return baseFee * qty;
    return baseFee;
}

/**
 * Returns the wholesale price multiplier for a given customer and product.
 * Products in the 'Supplies' category are excluded from the discount.
 */
function getWholesaleMultiplier(jid, product) {
    if (!wholesaleActiveSessions[jid]) return 1;
    const cat = (product?.Category || '').trim().toLowerCase();
    if (cat === 'supplies') return 1;
    return 0.8; // 20% off
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

    quoteText += `Estimated total: *${formatCurrency(total)}* (incl. VAT, excl. delivery)\n\n1. Yes – add to cart\n2. No – cancel\n0. Back\n\n– ${BUSINESS_NAME} Team`;
    return quoteText;
}

async function promptForDesignChoiceIfNeeded(sock, jid, product, item) {
    const designFee = item.designFee > 0
        ? item.designFee
        : calcScaledDesignFee(product, item.qty || 1);

    if (designFee <= 0) return false;

    if (item.designFee === 0) {
        item.designFee = designFee;
        item.total += designFee;
    }

    userStates[jid] = { step: 'awaiting_design_choice', pendingProduct: product, pendingItem: item };
    await sock.sendMessage(jid, {
        text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(designFee)})\n0. Back\n\nReply *1* or *2*.`
    });
    return true;
}

function greetUser(jid) {
    const name = userNames[jid];
    return name ? `Hi there ${name}! 👋` : 'Hi there! 👋';
}

function buildWelcomeText(jid) {
    const wholesaleLine = wholesaleActiveSessions[jid]
        ? '5. ✅ Wholesale Mode Active'
        : '5. Wholesale Clients';
    return [
        greetUser(jid),
        `Thank you for contacting *${BUSINESS_NAME}*. I'm AutoBot, your virtual assistant. Let me know how I can assist you today:`,
        '',
        '1. Place a new order',
        '2. Product List',
        '3. Track My Order',
        '4. Store Contact Details',
        wholesaleLine,
        '',
        '0. Back',
        '',
        'Reply with the number of your choice.',
        NAVIGATION_HINT
    ].join('\n');
}

function buildContactDetailsText() {
    return [
        `📍 *${BUSINESS_NAME}*`,
        '62 Naidoo Rd,',
        'Raisethorpe,',
        'Pietermaritzburg, 3201',
        '',
        '📞 Telephone: 033 811 5277',
        '',
        NAVIGATION_HINT
    ].join('\n');
}

function buildTrackingText() {
    return `🔍 *Track Your Order*\n\nYou can track your order using the link below:\n${TRACKING_URL}\n\nIf you need further assistance, type *human* to speak with a team member or *4* for our store contact details.\n\n${NAVIGATION_HINT}\n\n– ${BUSINESS_NAME} Team`;
}

function buildProductListText() {
    const categories = getCategories();
    const lines = [`Here's what we print at *${BUSINESS_NAME}*:`, ''];
    categories.forEach((cat) => lines.push(`• ${cat.trim()}`));
    lines.push('', "Anything specific you're looking for? Type *menu* to browse our full catalogue or ask for a *quote*! 😊");
    return lines.join('\n');
}

function buildProductOptionSummary(product, index) {
    const hasSqmPrice = toNumber(product.PricePerSqm) > 0;
    const hasFixedPrice = toNumber(product.FixedPrice) > 0;
    const pricing = product.PriceType === 'sqm' && hasSqmPrice
        ? `${formatCurrency(product.PricePerSqm)}/m²${toNumber(product.MinPrice) > 0 ? ` (min ${formatCurrency(product.MinPrice)})` : ''}`
        : (hasFixedPrice ? formatCurrency(product.FixedPrice) : (hasSqmPrice ? `${formatCurrency(product.PricePerSqm)}/m²` : 'Price on request'));

    const qualifier = [];
    if (product.Size && product.Size.trim()) qualifier.push(product.Size.trim());
    if (product.PriceType !== 'sqm' && product.UnitsPerProduct && product.UnitsPerProduct.trim()) qualifier.push(`${product.UnitsPerProduct.trim()} units`);

    const name = String(product.Name || product.Subcategory || product.Category || 'Product').trim();
    const displayName = qualifier.length > 0 ? `${name} (${qualifier.join(', ')})` : name;
    return `${index + 1}. ${displayName} - ${pricing}`;
}

function buildProductMatchesText(matches, intro, outro) {
    const lines = [intro, ''];
    matches.forEach((product, index) => lines.push(buildProductOptionSummary(product, index)));
    lines.push('0. Back');
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

function getSubSubcategories(categoryName, subcategoryName) {
    return [...new Set(
        products
            .filter((p) =>
                p.Category.toLowerCase().trim() === categoryName.toLowerCase().trim() &&
                (p.Subcategory || '').toLowerCase().trim() === subcategoryName.toLowerCase().trim()
            )
            .map((p) => p.SubSubcategory)
            .filter(Boolean)
    )];
}

function getSubSubSubcategories(categoryName, subcategoryName, subSubcategoryName) {
    return [...new Set(
        products
            .filter((p) =>
                p.Category.toLowerCase().trim() === categoryName.toLowerCase().trim() &&
                (p.Subcategory || '').toLowerCase().trim() === subcategoryName.toLowerCase().trim() &&
                (p.SubSubcategory || '').toLowerCase().trim() === subSubcategoryName.toLowerCase().trim()
            )
            .map((p) => p.SubSubSubcategory)
            .filter(Boolean)
    )];
}

function buildSubcategoryMenuText(categoryName, subcategories) {
    let reply = `*${categoryName.trim()} – Choose a subcategory:*\n\n`;
    subcategories.forEach((sub, i) => {
        reply += `${i + 1}. ${sub.trim()}\n`;
    });
    reply += '\n0. Back\n';
    reply += '\nReply with a *number* to see products in that subcategory.';
    reply += `\n${NAVIGATION_HINT}`;
    return reply;
}

function buildSubSubcategoryMenuText(subcategoryName, subSubcategories) {
    let reply = `*${subcategoryName.trim()} – Choose a type:*\n\n`;
    subSubcategories.forEach((sub, i) => {
        reply += `${i + 1}. ${sub.trim()}\n`;
    });
    reply += '\n0. Back\n';
    reply += '\nReply with a *number* to see products in that type.';
    reply += `\n${NAVIGATION_HINT}`;
    return reply;
}

function buildSubSubSubcategoryMenuText(subSubcategoryName, subSubSubcategories) {
    let reply = `*${subSubcategoryName.trim()} – Choose an option:*\n\n`;
    subSubSubcategories.forEach((sub, i) => {
        reply += `${i + 1}. ${sub.trim()}\n`;
    });
    reply += '\n0. Back\n';
    reply += '\nReply with a *number* to see products in that option.';
    reply += `\n${NAVIGATION_HINT}`;
    return reply;
}

function buildSubcategoryProductListText(subcategoryName, sortedProducts) {
    let reply = `*${subcategoryName.trim()} Products:*\n\n`;
    sortedProducts.forEach((p, i) => {
        reply += `${buildProductOptionSummary(p, i)}\n`;
    });
    reply += '\n0. Back\n';
    reply += '\nReply with the *number* of the product you want and I’ll help you price it or add it to your cart.';
    return reply;
}

/**
 * Given an array of matched products, determine the next navigation step.
 * If all matches share the same subcategory and span multiple sub-sub-categories,
 * returns an action to present a sub-sub-category menu. Similarly cascades to
 * sub-sub-sub-category when applicable.
 * @param {Array} matches
 * @returns {{ action: string, [key]: any }}
 */
function getNextNavigationAction(matches) {
    if (!matches || matches.length === 0) return { action: 'show_products', products: [] };

    // Only drill deeper if all matches share the same subcategory
    const uniqueSubcats = [...new Set(matches.map((p) => (p.Subcategory || '').toLowerCase().trim()))];
    if (uniqueSubcats.length !== 1) {
        return { action: 'show_products', products: matches };
    }

    // Check for multiple distinct sub-sub-categories
    const uniqueSubSubcats = [...new Set(matches.map((p) => (p.SubSubcategory || '')).filter(Boolean))];
    if (uniqueSubSubcats.length > 1) {
        return {
            action: 'show_subsubcategory_menu',
            subcategoryName: matches[0].Subcategory,
            subSubcategories: uniqueSubSubcats,
            matches
        };
    }

    // One sub-sub-category: check for sub-sub-sub-categories
    if (uniqueSubSubcats.length === 1) {
        const uniqueSubSubSubcats = [...new Set(matches.map((p) => (p.SubSubSubcategory || '')).filter(Boolean))];
        if (uniqueSubSubSubcats.length > 1) {
            return {
                action: 'show_subsubsubcategory_menu',
                subSubcategoryName: uniqueSubSubcats[0],
                subSubSubcategories: uniqueSubSubSubcats,
                matches
            };
        }
    }

    return { action: 'show_products', products: matches };
}

/**
 * Apply a navigation action (sub-sub or sub-sub-sub category menus) by setting
 * the user's state and sending the appropriate menu message.
 * Returns true if an intermediate menu was sent (caller should `continue`),
 * false if the action is 'show_products' and the caller should render the list.
 * @param {object} sock
 * @param {string} jid
 * @param {{ action: string, [key]: any }} navAction
 * @returns {Promise<boolean>}
 */
async function handleNavigationAction(sock, jid, navAction) {
    if (navAction.action === 'show_subsubcategory_menu') {
        userStates[jid] = {
            step: 'awaiting_subsubcategory_selection',
            pendingSubcategoryName: navAction.subcategoryName,
            pendingSubSubcategories: navAction.subSubcategories,
            pendingMatches: navAction.matches
        };
        await sock.sendMessage(jid, { text: buildSubSubcategoryMenuText(navAction.subcategoryName, navAction.subSubcategories) });
        return true;
    }
    if (navAction.action === 'show_subsubsubcategory_menu') {
        userStates[jid] = {
            step: 'awaiting_subsubsubcategory_selection',
            pendingSubSubcategoryName: navAction.subSubcategoryName,
            pendingSubSubSubcategories: navAction.subSubSubcategories,
            pendingMatches: navAction.matches
        };
        await sock.sendMessage(jid, { text: buildSubSubSubcategoryMenuText(navAction.subSubcategoryName, navAction.subSubSubcategories) });
        return true;
    }
    return false;
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
    reply += '\n0. Back\n';
    reply += '\nReply with a *number* to browse that category.';
    reply += '\nWhen a product list is shown, reply with the *number* of the item you want.';
    reply += '\nType *cart* to review your basket';
    reply += '\nType *human* if you would like a team member to take over.';
    reply += `\n${NAVIGATION_HINT}`;
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
        '- Send *back* to return to the previous step',
        '- Send *home* or *main menu* to restart from the main menu',
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
        '3. Checkout',
        '0. Back',
        '',
        NAVIGATION_HINT
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

    reply += `\n*Total: ${formatCurrency(grandTotal)}*\nType *checkout* to confirm or *clear* to empty the cart.\n${NAVIGATION_HINT}`;
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
        if (item.wholesaleDiscount > 0) summary += `   🏷️ Wholesale Discount (20%): -${formatCurrency(item.wholesaleDiscount)}\n`;
        if (item.designFee > 0) summary += `   Design/Layout Fee: ${formatCurrency(item.designFee)}\n`;
        if (item.polesCost > 0) summary += `   Poles (×${item.poles}): ${formatCurrency(item.polesCost)}\n`;
        if (item.installationFee > 0) summary += `   Installation: ${formatCurrency(item.installationFee)}\n`;
        if (item.artworkReceived) summary += `   📎 Artwork: Uploaded by customer\n`;
        if (item.designNotes) summary += `   ✏️ Design requirements: ${item.designNotes}\n`;
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
    logChatEntry(jid, 'user', text);
}

function logChatEntry(jid, role, text) {
    if (!jid || !text) return;
    if (!chatLog[jid]) chatLog[jid] = [];
    const ts = new Date().toISOString();
    chatLog[jid].push({ role, text: String(text).trim(), timestamp: ts });
    chatLog[jid] = chatLog[jid].slice(-MAX_CHAT_LOG);
    chatLogLastActivity[jid] = ts;
}

function getConversationPreview(jid) {
    const history = conversationHistory[jid] || [];
    if (history.length === 0) return 'No recent customer messages captured yet.';

    return history
        .slice(-5)
        .map((entry, index) => `${index + 1}. ${entry}`)
        .join('\n');
}

function cloneNavigationValue(value) {
    if (value === undefined || value === null) return null;
    return JSON.parse(JSON.stringify(value));
}

function captureNavigationSnapshot(jid, responseText) {
    return {
        state: cloneNavigationValue(userStates[jid] || { step: 'idle' }) || { step: 'idle' },
        cart: cloneNavigationValue(userCarts[jid] || null),
        productContext: cloneNavigationValue(userProductContext[jid] || null),
        email: userEmails[jid] || null,
        responseText: String(responseText || '').trim()
    };
}

function snapshotsMatch(previousSnapshot, nextSnapshot) {
    return JSON.stringify(previousSnapshot) === JSON.stringify(nextSnapshot);
}

function pushNavigationSnapshot(jid, responseText) {
    const trimmedText = String(responseText || '').trim();
    if (!trimmedText) return;

    const history = userNavigationHistory[jid] || [];
    const snapshot = captureNavigationSnapshot(jid, trimmedText);
    if (history.length > 0 && snapshotsMatch(history[history.length - 1], snapshot)) return;

    history.push(snapshot);
    userNavigationHistory[jid] = history.slice(-MAX_NAVIGATION_HISTORY);
}

function applyNavigationSnapshot(jid, snapshot) {
    userStates[jid] = cloneNavigationValue(snapshot?.state) || { step: 'idle' };

    if (snapshot?.cart) userCarts[jid] = cloneNavigationValue(snapshot.cart);
    else delete userCarts[jid];

    if (snapshot?.productContext) userProductContext[jid] = cloneNavigationValue(snapshot.productContext);
    else delete userProductContext[jid];

    if (snapshot?.email) userEmails[jid] = snapshot.email;
    else delete userEmails[jid];
}

function resetNavigationHistory(jid, responseText) {
    userNavigationHistory[jid] = [];
    pushNavigationSnapshot(jid, responseText);
}

function restorePreviousNavigationSnapshot(jid) {
    const history = userNavigationHistory[jid] || [];
    if (history.length < 2) return null;

    history.pop();
    const previousSnapshot = history[history.length - 1] || null;
    if (!previousSnapshot) return null;

    applyNavigationSnapshot(jid, previousSnapshot);
    userNavigationHistory[jid] = history;
    return previousSnapshot.responseText;
}

function isBackCommand(text) {
    return /^(0|back|go back|previous)$/i.test(text || '');
}

function isHomeCommand(text) {
    return /^(home|main menu|main)$/i.test(text || '');
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
        text: `🤝 I can ask a ${BUSINESS_NAME} team member to take over.\nIf you confirm, I will pause my automated replies so a person can assist you.\n\n1. Yes – hand over to a team member\n2. No – keep chatting with me\n0. Back`
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
        : (invoiceNinja.isConfigured() ? `\n\n⚠️ Quote creation failed – manual follow-up needed.\nError: ${orderRecord.error || 'unknown'}` : '');

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
        const rawSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (targetJid, content, options) => {
            const payload = content && typeof content === 'object' ? { ...content } : content;
            const skipNavigation = Boolean(payload?.__skipNavigation);
            if (payload && typeof payload === 'object' && '__skipNavigation' in payload) delete payload.__skipNavigation;

            if (!skipNavigation && targetJid !== ADMIN_JID && typeof payload?.text === 'string' && payload.text.trim()) {
                pushNavigationSnapshot(targetJid, payload.text);
            }

            // Log bot replies for the admin dashboard (skip messages sent to the admin's own JID)
            if (targetJid !== ADMIN_JID && typeof payload?.text === 'string' && payload.text.trim()) {
                logChatEntry(targetJid, 'bot', payload.text);
            }

            return rawSendMessage(targetJid, payload, options);
        };
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

                    const isMediaMessage = !!(messageContent.imageMessage || messageContent.documentMessage);
                    if (!rawText && !isMediaMessage) continue;
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
                            try {
                                const parsedProducts = await parseProductsCsvBuffer(buffer);
                                fs.writeFileSync(CSV_FILE, buffer);
                                products = parsedProducts;
                                await sock.sendMessage(jid, { text: `📦 Products updated! Loaded ${products.length} products.` });
                            } catch (error) {
                                await sock.sendMessage(jid, { text: `⚠️ Products not updated.\n${error.message}` });
                            }
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

                    if (isBackCommand(text)) {
                        fallbackCounts[jid] = 0;
                        const previousResponse = restorePreviousNavigationSnapshot(jid);
                        if (previousResponse) {
                            await sock.sendMessage(jid, { text: previousResponse, __skipNavigation: true });
                        } else {
                            const welcomeText = buildWelcomeText(jid);
                            userStates[jid] = { step: 'awaiting_main_menu' };
                            resetNavigationHistory(jid, welcomeText);
                            await sock.sendMessage(jid, { text: welcomeText, __skipNavigation: true });
                        }
                        continue;
                    }

                    if (isHomeCommand(text)) {
                        fallbackCounts[jid] = 0;
                        const welcomeText = buildWelcomeText(jid);
                        userStates[jid] = { step: 'awaiting_main_menu' };
                        resetNavigationHistory(jid, welcomeText);
                        await sock.sendMessage(jid, { text: welcomeText, __skipNavigation: true });
                        continue;
                    }

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
                        if (text === '5' || /wholesale/.test(text)) {
                            if (wholesaleActiveSessions[jid]) {
                                await sock.sendMessage(jid, {
                                    text: `✅ *Wholesale mode is already active* for your session.\n\nYou receive a 20% discount on all products (excluding Supplies).\n\n${NAVIGATION_HINT}`
                                });
                                continue;
                            }
                            if (!settings.wholesalePassword) {
                                await sock.sendMessage(jid, {
                                    text: `❌ Wholesale pricing is not available at this time. Please contact us directly for more information.\n\n${NAVIGATION_HINT}`
                                });
                                continue;
                            }
                            userStates[jid] = { step: 'awaiting_wholesale_password' };
                            await sock.sendMessage(jid, {
                                text: `🔐 *Wholesale Client Access*\n\nPlease enter your wholesale password to activate discounted pricing:\n\n0. Back`
                            });
                            continue;
                        }
                        await sock.sendMessage(jid, {
                            text: 'Please reply with a number:\n\n1. Place a new order\n2. Product List\n3. Track My Order\n4. Store Contact Details\n5. Wholesale Clients\n0. Back'
                        });
                        continue;
                    }

                // ── State: awaiting_wholesale_password ────────────────────────────
                    if (userState.step === 'awaiting_wholesale_password') {
                        if (text === '0' || text === 'back') {
                            userStates[jid] = { step: 'awaiting_main_menu' };
                            await sock.sendMessage(jid, { text: buildWelcomeText(jid) });
                            continue;
                        }
                        if (settings.wholesalePassword && text === settings.wholesalePassword) {
                            wholesaleActiveSessions[jid] = true;
                            userStates[jid] = { step: 'awaiting_main_menu' };
                            await sock.sendMessage(jid, {
                                text: `✅ *Wholesale pricing activated!*\n\nYou now have a *20% discount* on all products (excluding Supplies) for this session.\n\n${buildWelcomeText(jid)}`
                            });
                            continue;
                        }
                        await sock.sendMessage(jid, {
                            text: `❌ Incorrect password. Please try again or type *0* to go back.`
                        });
                        continue;
                    }

                // ── State: awaiting_category_selection ─────────────────────────────
                    if (userState.step === 'awaiting_category_selection') {
                        const categories = getCategories();
                        const selectedNumber = extractQuantityFromText(text);
                        const catIdx = selectedNumber ? selectedNumber - 1 : -1;
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
                            // Only one subcategory (or none) — check for sub-sub-categories before showing products
                            const catProducts = products.filter((p) =>
                                p.Category.toLowerCase().trim() === selectedCat.toLowerCase().trim()
                            );
                            if (catProducts.length === 0) {
                                await sock.sendMessage(jid, { text: `❓ No products found in "${selectedCat}". Type *menu* to try again.` });
                                userStates[jid] = { step: 'idle' };
                                continue;
                            }
                            const navAction = getNextNavigationAction(catProducts);
                            if (await handleNavigationAction(sock, jid, navAction)) continue;
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
                        const selectedNumber = extractQuantityFromText(text);
                        const subIdx = selectedNumber ? selectedNumber - 1 : -1;
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
                            const navAction = getNextNavigationAction(subProducts);
                            if (await handleNavigationAction(sock, jid, navAction)) continue;
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

                // ── State: awaiting_subsubcategory_selection ───────────────────────
                    if (userState.step === 'awaiting_subsubcategory_selection') {
                        const subSubcategories = userState.pendingSubSubcategories || [];
                        const selectedNumber = extractQuantityFromText(text);
                        const subSubIdx = selectedNumber ? selectedNumber - 1 : -1;
                        let selectedSubSub = null;
                        if (!Number.isNaN(subSubIdx) && subSubIdx >= 0 && subSubIdx < subSubcategories.length) {
                            selectedSubSub = subSubcategories[subSubIdx];
                        } else {
                            selectedSubSub = subSubcategories.find((s) => normalizeText(s) === normalizeText(text)) || null;
                        }
                        if (selectedSubSub) {
                            const allMatches = userState.pendingMatches || products;
                            const filteredProducts = allMatches.filter((p) =>
                                (p.SubSubcategory || '').toLowerCase().trim() === selectedSubSub.toLowerCase().trim()
                            );
                            if (filteredProducts.length === 0) {
                                await sock.sendMessage(jid, { text: `❓ No products found for "${selectedSubSub}". Type *menu* to try again.` });
                                userStates[jid] = { step: 'idle' };
                                continue;
                            }
                            const navAction = getNextNavigationAction(filteredProducts);
                            if (await handleNavigationAction(sock, jid, navAction)) continue;
                            const sorted = [...filteredProducts].sort((a, b) => {
                                const priceA = a.PriceType === 'sqm' ? toNumber(a.PricePerSqm) : toNumber(a.FixedPrice);
                                const priceB = b.PriceType === 'sqm' ? toNumber(b.PricePerSqm) : toNumber(b.FixedPrice);
                                return priceA - priceB;
                            });
                            userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: sorted };
                            await sock.sendMessage(jid, { text: buildSubcategoryProductListText(selectedSubSub, sorted) });
                            continue;
                        }
                        // Invalid input — re-show the sub-sub-category menu
                        await sock.sendMessage(jid, { text: `Please reply with a number between 1 and ${subSubcategories.length}.\n\n${buildSubSubcategoryMenuText(userState.pendingSubcategoryName || '', subSubcategories)}` });
                        continue;
                    }

                // ── State: awaiting_subsubsubcategory_selection ────────────────────
                    if (userState.step === 'awaiting_subsubsubcategory_selection') {
                        const subSubSubcategories = userState.pendingSubSubSubcategories || [];
                        const selectedNumber = extractQuantityFromText(text);
                        const subSubSubIdx = selectedNumber ? selectedNumber - 1 : -1;
                        let selectedSubSubSub = null;
                        if (!Number.isNaN(subSubSubIdx) && subSubSubIdx >= 0 && subSubSubIdx < subSubSubcategories.length) {
                            selectedSubSubSub = subSubSubcategories[subSubSubIdx];
                        } else {
                            selectedSubSubSub = subSubSubcategories.find((s) => normalizeText(s) === normalizeText(text)) || null;
                        }
                        if (selectedSubSubSub) {
                            const allMatches = userState.pendingMatches || products;
                            const filteredProducts = allMatches.filter((p) =>
                                (p.SubSubSubcategory || '').toLowerCase().trim() === selectedSubSubSub.toLowerCase().trim()
                            );
                            if (filteredProducts.length === 0) {
                                await sock.sendMessage(jid, { text: `❓ No products found for "${selectedSubSubSub}". Type *menu* to try again.` });
                                userStates[jid] = { step: 'idle' };
                                continue;
                            }
                            const sorted = [...filteredProducts].sort((a, b) => {
                                const priceA = a.PriceType === 'sqm' ? toNumber(a.PricePerSqm) : toNumber(a.FixedPrice);
                                const priceB = b.PriceType === 'sqm' ? toNumber(b.PricePerSqm) : toNumber(b.FixedPrice);
                                return priceA - priceB;
                            });
                            userStates[jid] = { step: 'awaiting_quote_product_selection', pendingMatches: sorted };
                            await sock.sendMessage(jid, { text: buildSubcategoryProductListText(selectedSubSubSub, sorted) });
                            continue;
                        }
                        // Invalid input — re-show the sub-sub-sub-category menu
                        await sock.sendMessage(jid, { text: `Please reply with a number between 1 and ${subSubSubcategories.length}.\n\n${buildSubSubSubcategoryMenuText(userState.pendingSubSubcategoryName || '', subSubSubcategories)}` });
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
                        reply += `\nWould you like to add *poles*?\nPrice per pole: ${formatCurrency(product.PolePrice)}\n\n1. Yes\n2. No\n0. Back`;
                        await sock.sendMessage(jid, { text: reply });
                        continue;
                    }
                    if (toNumber(product.InstallationFee) > 0) {
                        userStates[jid] = { step: 'awaiting_installation', pendingProduct: product, pendingItem };
                        reply += `\nWould you like *installation*? ${formatCurrency(product.InstallationFee)}\n\n1. Yes\n2. No\n0. Back`;
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
                                text: `Would you like *installation*? ${formatCurrency(instFee)}\n\n1. Yes\n2. No\n0. Back`
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
                            text: `${count} pole(s) added: ${formatCurrency(polesCost)}\n\nWould you like *installation*? ${formatCurrency(instFee)}\n\n1. Yes\n2. No\n0. Back`
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
                        // Use the fee already on the item (which may be scaled for pack products).
                        const originalDesignFee = item.designFee > 0
                            ? item.designFee
                            : calcScaledDesignFee(product, item.qty || 1);

                        const isYes = text === '1' || ['yes', 'y', 'own', 'i have', 'have design', 'my design'].some((k) => text.includes(k));
                        const isNo = text === '2' || ['no', 'n', 'need design', 'no design', 'create'].some((k) => text.includes(k));

                        if (isYes) {
                            // Customer has own design — remove design fee
                            item.total = item.total - item.designFee;
                            item.designFee = 0;
                            const requiresArtwork = (product.RequiresArtwork || 'yes').toLowerCase();
                            if (requiresArtwork === 'no') {
                                // Product doesn't require artwork upload — add to cart directly
                                if (!userCarts[jid]) userCarts[jid] = [];
                                userCarts[jid].push(item);
                                userStates[jid] = { step: 'awaiting_post_cart_add' };
                                await sock.sendMessage(jid, {
                                    text: `✅ Added *${item.name}* to your cart.\n*Total: ${formatCurrency(item.total)}*\n\n⚠️ *Design Disclaimer:* ${OWN_DESIGN_DISCLAIMER}\n\n${buildPostCartText(userCarts[jid].length)}`
                                });
                            } else {
                                // Ask customer to upload their artwork
                                userStates[jid] = { step: 'awaiting_artwork_upload', pendingItem: item, pendingProduct: product };
                                await sock.sendMessage(jid, {
                                    text: `📎 Please upload your artwork now.\n\nSend the image or file directly in this chat.\n\nIf you don't have your artwork ready yet, reply *no artwork* and a design fee will apply.\n0. Back`
                                });
                            }
                            continue;
                        }
                        if (isNo) {
                            // Customer needs design — keep design fee and collect design requirements
                            if (item.designFee === 0 && originalDesignFee > 0) {
                                item.designFee = originalDesignFee;
                                item.total += originalDesignFee;
                            }
                            userStates[jid] = { step: 'awaiting_design_info', pendingItem: item, pendingProduct: product };
                            await sock.sendMessage(jid, {
                                text: `✏️ Please provide all the information needed for your design.\n\nInclude as much detail as possible:\n• Business or personal name\n• Text/copy to appear on the design\n• Preferred colors or branding\n• Any logos or reference images (you can upload them here)\n• Any other specific requirements\n\nType your requirements below:`
                            });
                            continue;
                        }
                        await sock.sendMessage(jid, {
                            text: `Do you have your own design/artwork ready?\n\n1. Yes – I have my own design\n2. No – I need design work done (Design/Layout fee: ${formatCurrency(originalDesignFee)})\n0. Back\n\nReply *1* or *2*.`
                        });
                        continue;
                    }

                // ── State: awaiting_artwork_upload ────────────────────────────────────
                    if (userState.step === 'awaiting_artwork_upload') {
                        const item = userState.pendingItem;
                        const hasMedia = !!(messageContent.imageMessage || messageContent.documentMessage);
                        const noArtwork = text && ['no artwork', 'no art', "don't have", 'dont have', 'not ready', 'no file'].some((k) => text.includes(k));

                        if (hasMedia) {
                            // Save the uploaded artwork file (Drive or local fallback)
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                const mimeType = messageContent.imageMessage ? 'image/jpeg' : (messageContent.documentMessage?.mimetype || 'application/octet-stream');
                                const ext = messageContent.imageMessage
                                    ? 'jpg'
                                    : (messageContent.documentMessage?.fileName?.split('.').pop() || 'bin');
                                const artworkFilename = `artwork-${jid.replace(/[^a-z0-9]/gi, '')}-${Date.now()}.${ext}`;
                                const artworkPath = path.join(STORAGE_DIR, artworkFilename);
                                fs.writeFileSync(artworkPath, buffer); // always write locally as backup
                                const fileRef = await driveStorage.uploadFile(buffer, artworkFilename, mimeType, getPhoneFromJid(jid));
                                item.artworkFile = artworkFilename;
                                item.fileRef = fileRef;
                            } catch (artErr) {
                                console.error('⚠️ Failed to save customer artwork:', artErr.message);
                            }
                            item.artworkReceived = true;
                            if (!userCarts[jid]) userCarts[jid] = [];
                            userCarts[jid].push(item);
                            userStates[jid] = { step: 'awaiting_post_cart_add' };
                            await sock.sendMessage(jid, {
                                text: `✅ Artwork received! Added *${item.name}* to your cart.\n*Total: ${formatCurrency(item.total)}*\n\n⚠️ *Design Disclaimer:* ${OWN_DESIGN_DISCLAIMER}\n\n${buildPostCartText(userCarts[jid].length)}`
                            });
                            continue;
                        }

                        if (noArtwork) {
                            // Customer said they had their own design but doesn't have the artwork ready.
                            // Restore the design fee (scaled for pack products) — they will need design work done.
                            const product = userState.pendingProduct;
                            const originalDesignFee = calcScaledDesignFee(product, item.qty || 1);
                            if (originalDesignFee > 0 && item.designFee === 0) {
                                item.designFee = originalDesignFee;
                                item.total += originalDesignFee;
                            }
                            userStates[jid] = { step: 'awaiting_design_info', pendingItem: item, pendingProduct: userState.pendingProduct };
                            const feeNotice = item.designFee > 0
                                ? `\n\n⚠️ Since you don't have your artwork ready, the design/layout fee of *${formatCurrency(item.designFee)}* has been added.`
                                : '';
                            await sock.sendMessage(jid, {
                                text: `✏️ No problem! Please provide all the information needed for your design.${feeNotice}\n\nInclude as much detail as possible:\n• Business or personal name\n• Text/copy to appear on the design\n• Preferred colors or branding\n• Any logos or reference images (you can upload them here)\n• Any other specific requirements\n\nType your requirements below:`
                            });
                            continue;
                        }

                        await sock.sendMessage(jid, {
                            text: `📎 Please upload your artwork file or image.\n\nIf you don't have your artwork ready, reply *no artwork* and we'll collect your design requirements instead.\n0. Back`
                        });
                        continue;
                    }

                // ── State: awaiting_design_info ────────────────────────────────────
                    if (userState.step === 'awaiting_design_info') {
                        const item = userState.pendingItem;
                        const hasMedia = !!(messageContent.imageMessage || messageContent.documentMessage);

                        if (!rawText && hasMedia) {
                            // They sent a reference image only — save it and ask for text details
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                const mimeType = messageContent.imageMessage ? 'image/jpeg' : (messageContent.documentMessage?.mimetype || 'application/octet-stream');
                                const ext = messageContent.imageMessage
                                    ? 'jpg'
                                    : (messageContent.documentMessage?.fileName?.split('.').pop() || 'bin');
                                const refFilename = `design-ref-${jid.replace(/[^a-z0-9]/gi, '')}-${Date.now()}.${ext}`;
                                const refPath = path.join(STORAGE_DIR, refFilename);
                                fs.writeFileSync(refPath, buffer);
                                const fileRef = await driveStorage.uploadFile(buffer, refFilename, mimeType, getPhoneFromJid(jid));
                                item.artworkFile = refFilename;
                                item.fileRef = fileRef;
                            } catch (refErr) {
                                console.error('⚠️ Failed to save design reference image:', refErr.message);
                            }
                            userStates[jid] = { step: 'awaiting_design_info', pendingItem: item, pendingProduct: userState.pendingProduct };
                            await sock.sendMessage(jid, {
                                text: `📎 Reference image received! Now please type the text and other details for your design:\n• Business or personal name\n• Text/copy to appear on the design\n• Preferred colors or branding\n• Any other specific requirements`
                            });
                            continue;
                        }

                        if (!rawText) {
                            await sock.sendMessage(jid, {
                                text: `✏️ Please type your design requirements (business name, text, colors, etc.).\n\nYou can also attach a reference image along with your message.`
                            });
                            continue;
                        }

                        // Save text requirements; also save a reference image if attached
                        item.designNotes = rawText;
                        if (hasMedia && !item.artworkFile) {
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                const mimeType = messageContent.imageMessage ? 'image/jpeg' : (messageContent.documentMessage?.mimetype || 'application/octet-stream');
                                const ext = messageContent.imageMessage
                                    ? 'jpg'
                                    : (messageContent.documentMessage?.fileName?.split('.').pop() || 'bin');
                                const refFilename = `design-ref-${jid.replace(/[^a-z0-9]/gi, '')}-${Date.now()}.${ext}`;
                                const refPath = path.join(STORAGE_DIR, refFilename);
                                fs.writeFileSync(refPath, buffer);
                                const fileRef = await driveStorage.uploadFile(buffer, refFilename, mimeType, getPhoneFromJid(jid));
                                item.artworkFile = refFilename;
                                item.fileRef = fileRef;
                            } catch (refErr) {
                                console.error('⚠️ Failed to save design reference image:', refErr.message);
                            }
                        }
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push(item);
                        userStates[jid] = { step: 'awaiting_post_cart_add' };
                        await sock.sendMessage(jid, {
                            text: `✅ Design requirements noted! Added *${item.name}* to your cart.\nDesign/Layout fee of ${formatCurrency(item.designFee)} included.\n*Total: ${formatCurrency(item.total)}*\n\n${buildPostCartText(userCarts[jid].length)}`
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
                        const wholesaleMultiplier = getWholesaleMultiplier(jid, product);
                        if (labelProfile.mode === 'labels' && item.dimLength && item.dimHeight) {
                            // For labels: total area = L × B × Qty; apply min price to the full order
                            const totalSqm = (item.dimLength / MM_PER_METER) * (item.dimHeight / MM_PER_METER) * qty;
                            const rawSqmPrice = Math.max(totalSqm * toNumber(product.PricePerSqm), toNumber(product.MinPrice));
                            const discountedSqmPrice = rawSqmPrice * wholesaleMultiplier;
                            if (wholesaleMultiplier < 1) item.wholesaleDiscount = rawSqmPrice - discountedSqmPrice;
                            item.sqmPrice = discountedSqmPrice;
                            item.total = item.sqmPrice + item.designFee + item.polesCost + item.installationFee;
                        } else {
                            const rawMaterial = item.sqmPrice * qty;
                            const discountedMaterial = rawMaterial * wholesaleMultiplier;
                            if (wholesaleMultiplier < 1) item.wholesaleDiscount = rawMaterial - discountedMaterial;
                            item.total = discountedMaterial + item.designFee + item.polesCost + item.installationFee;
                        }
                        if (await promptForDesignChoiceIfNeeded(sock, jid, product, item)) {
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
                        const wholesaleMultiplier = getWholesaleMultiplier(jid, product);
                        const discountedMaterial = materialTotal * wholesaleMultiplier;
                        const wholesaleDiscount = materialTotal - discountedMaterial;
                        const designFee = calcScaledDesignFee(product, qty);
                        const item = {
                            name: product.Name,
                            sqmPrice: toNumber(product.FixedPrice),
                            designFee,
                            polesCost: 0,
                            poles: 0,
                            installationFee: 0,
                            total: discountedMaterial + designFee,
                            qty,
                            ...(wholesaleDiscount > 0 && { wholesaleDiscount })
                        };
                        if (await promptForDesignChoiceIfNeeded(sock, jid, product, item)) {
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
                        const navAction = getNextNavigationAction(matches);
                        if (await handleNavigationAction(sock, jid, navAction)) continue;
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
                        const selectedNumber = extractQuantityFromText(text);
                        const idx = selectedNumber ? selectedNumber - 1 : -1;
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
                        const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                        const discountedTotal = materialTotal * getWholesaleMultiplier(jid, product);
                        const quoteText = buildQuoteText(product, qty, discountedTotal);
                        userProductContext[jid] = product;
                        userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: discountedTotal };
                        await sock.sendMessage(jid, { text: quoteText });
                        continue;
                    }

                // ── State: awaiting_quote_confirm ───────────────────────────────────
                    if (userState.step === 'awaiting_quote_confirm') {
                        if (text === '1' || ['yes', 'y', 'add', 'yes add', 'yeah', 'yep', 'sure'].includes(text)) {
                            const product = userState.pendingProduct;
                            const qty = userState.pendingQty;
                            const discountedMaterial = userState.pendingTotal;
                            const wholesaleMultiplier = getWholesaleMultiplier(jid, product);
                            const rawMaterial = wholesaleMultiplier < 1 ? discountedMaterial / wholesaleMultiplier : discountedMaterial;
                            const wholesaleDiscount = rawMaterial - discountedMaterial;
                            const designFee = calcScaledDesignFee(product, qty);
                            const item = {
                                name: product.Name,
                                sqmPrice: toNumber(product.FixedPrice),
                                designFee,
                                polesCost: 0,
                                poles: 0,
                                installationFee: 0,
                                total: discountedMaterial + designFee,
                                qty,
                                ...(wholesaleDiscount > 0 && { wholesaleDiscount })
                            };
                            if (await promptForDesignChoiceIfNeeded(sock, jid, product, item)) {
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
                        const qty = extractQuantityFromText(text) || userState.pendingQty || null;
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
                            if (qty) {
                                const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                                userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: materialTotal };
                                await sock.sendMessage(jid, { text: buildQuoteText(product, qty, materialTotal) });
                                continue;
                            }
                            userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! ${getQuantityPrompt(product)}` });
                            continue;
                        }
                        const navAction = getNextNavigationAction(matches);
                        if (await handleNavigationAction(sock, jid, navAction)) continue;
                        userStates[jid] = { step: 'awaiting_add_product_selection', pendingMatches: matches, pendingQty: qty };
                        await sock.sendMessage(jid, {
                            text: buildProductMatchesText(matches, 'I found these options:', 'Reply with the option number to select a product.')
                        });
                        continue;
                    }

                // ── State: awaiting_add_product_selection ───────────────────────────
                    if (userState.step === 'awaiting_add_product_selection') {
                        const selectedNumber = extractQuantityFromText(text);
                        const idx = selectedNumber ? selectedNumber - 1 : -1;
                        const matches = userState.pendingMatches || [];
                        const qty = userState.pendingQty || null;
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
                        if (qty) {
                            const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                            const discountedTotal = materialTotal * getWholesaleMultiplier(jid, product);
                            userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: discountedTotal };
                            await sock.sendMessage(jid, { text: buildQuoteText(product, qty, discountedTotal) });
                            continue;
                        }
                        userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                        await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! ${getQuantityPrompt(product)}` });
                        continue;
                    }

                // ── State: awaiting_remove_selection ───────────────────────────────
                    if (userState.step === 'awaiting_remove_selection') {
                        const selectedNumber = extractQuantityFromText(text);
                        const idx = selectedNumber ? selectedNumber - 1 : -1;
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
                        const wholesaleMultiplier = getWholesaleMultiplier(jid, product);
                        const discountedMaterial = materialTotal * wholesaleMultiplier;
                        const wholesaleDiscount = materialTotal - discountedMaterial;
                        const designFee = calcScaledDesignFee(product, qty);
                        const item = {
                            name: product.Name,
                            sqmPrice: price,
                            designFee,
                            polesCost: 0,
                            poles: 0,
                            installationFee: 0,
                            total: discountedMaterial + designFee,
                            qty,
                            ...(wholesaleDiscount > 0 && { wholesaleDiscount })
                        };
                        if (await promptForDesignChoiceIfNeeded(sock, jid, product, item)) {
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
                                const navAction = getNextNavigationAction(matches);
                                if (await handleNavigationAction(sock, jid, navAction)) continue;
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

                            const navAction = getNextNavigationAction(matches);
                            if (await handleNavigationAction(sock, jid, navAction)) continue;
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
                        const qty = extractQuantityFromText(text);
                        const matches = findProductsByKeyword(text);

                        if (matches.length === 1) {
                            const product = matches[0];
                            userProductContext[jid] = product;
                            if (product.PriceType === 'sqm') {
                                userStates[jid] = { step: 'awaiting_dimensions', pendingProduct: product };
                                await sock.sendMessage(jid, { text: `📐 *${product.Name}*\nPlease send the *length x height in mm*, for example _${DIMENSION_FORMAT_EXAMPLE}_.\n\nType *cancel* to go back.` });
                                continue;
                            }
                            if (qty) {
                                const materialTotal = calcFixedQuoteForQty(product, getPricedQuantity(product, qty));
                                userStates[jid] = { step: 'awaiting_quote_confirm', pendingProduct: product, pendingQty: qty, pendingTotal: materialTotal };
                                await sock.sendMessage(jid, { text: buildQuoteText(product, qty, materialTotal) });
                                continue;
                            }
                            userStates[jid] = { step: 'awaiting_quote_quantity', pendingProduct: product };
                            await sock.sendMessage(jid, { text: `Got it – *${product.Name}*! ${getQuantityPrompt(product)}` });
                            continue;
                        }

                        if (matches.length > 1) {
                            const navAction = getNextNavigationAction(matches);
                            if (await handleNavigationAction(sock, jid, navAction)) continue;
                            const list = matches.map((p, i) => `${i + 1}. ${p.Name}`).join('\n');
                            userStates[jid] = { step: 'awaiting_add_product_selection', pendingMatches: matches, pendingQty: qty };
                            await sock.sendMessage(jid, { text: `We have a few options:\n${list}\n\nReply with the number to select a product.` });
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
                        await sock.sendMessage(jid, { text: `You have ${cart.length} items in your cart. Which one would you like to remove? Reply with the number:\n${itemList}\n0. Back` });
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
//
// Invoice Ninja performs a GET request to verify the endpoint is reachable when
// you first register the webhook. This handler returns 200 OK for that check.
app.get('/webhook/invoice-ninja', (_req, res) => {
    res.json({ ok: true, service: 'whatsapp-bot', endpoint: 'webhook/invoice-ninja' });
});

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
    const sessionToken = getAdminSessionToken(req);
    if (validateAdminSession(sessionToken)) return next();
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
    csvUpload.single('file')(req, res, async (err) => {
        if (err) {
            return res.status(400).send(`<p>Upload failed: ${err.message}</p>`);
        }
        if (!req.file) {
            return res.status(400).send('<p>No file provided. Please attach a .csv file with field name "file".</p>');
        }
        try {
            const parsedProducts = await parseProductsCsvBuffer(req.file.buffer);
            fs.writeFileSync(CSV_FILE, req.file.buffer);
            products = parsedProducts;
            res.send(`<!DOCTYPE html><html><head><title>Upload complete</title></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>✅ Products updated!</h2><p>The products CSV has been replaced and reloaded with ${products.length} products.</p><p><a href="products">← Back to Products Admin</a></p></body></html>`);
        } catch (error) {
            res.status(400).send(`<!DOCTYPE html><html><head><title>Upload failed</title></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>⚠️ Upload failed</h2><p>${error.message}</p><p><a href="products">← Back to Products Admin</a></p></body></html>`);
        }
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

// --- ADMIN DASHBOARD ---
// Protected by the same QR_ACCESS_TOKEN used for /qr and /products.
// Access at: /admin  (or /admin?token=YOUR_TOKEN)

const adminRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: '{"error":"Too many requests. Please wait a minute."}'
});

function adminAuthMiddleware(req, res, next) {
    // 1. Valid session cookie
    const sessionToken = getAdminSessionToken(req);
    if (validateAdminSession(sessionToken)) return next();

    // 2. Fallback: QR_ACCESS_TOKEN (legacy / programmatic access)
    if (isAuthorizedQrRequest(getQrAccessToken(req))) return next();

    // 3. Unauthorized — redirect browsers to the login page, return JSON for API calls
    const acceptsHtml = (req.get('accept') || '').includes('text/html');
    if (acceptsHtml) {
        const loginUrl = `/admin/login?next=${encodeURIComponent(req.originalUrl)}`;
        return res.redirect(302, loginUrl);
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

// Helper: derive a human-readable status for a conversation JID
function getConversationStatus(jid) {
    if (handoverSessions[jid]?.active) return 'handover';
    const jidOrders = orders.filter((o) => o.jid === jid);
    const hasPaid = jidOrders.some((o) => o.status === 'paid');
    const hasQuoted = jidOrders.some((o) => ['quoted', 'approved'].includes(o.status));
    if (hasPaid) return 'paid';
    if (hasQuoted) return 'quoted';
    const step = userStates[jid]?.step || 'idle';
    const hasCart = (userCarts[jid] || []).length > 0;
    if (hasCart || step !== 'idle') return 'in_progress';
    if (chatLog[jid]?.length > 0) return 'idle';
    return 'idle';
}

// GET /admin/api/conversations — list all known JIDs with summary info
app.get('/admin/api/conversations', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    // Collect all JIDs seen across any in-memory structure
    const jidSet = new Set([
        ...Object.keys(chatLog),
        ...Object.keys(userStates),
        ...Object.keys(userCarts),
        ...Object.keys(handoverSessions),
        ...orders.map((o) => o.jid)
    ]);
    jidSet.delete(ADMIN_JID);

    const conversations = [...jidSet].map((jid) => {
        const lastMsg = (chatLog[jid] || []).slice(-1)[0] || null;
        const jidOrders = orders.filter((o) => o.jid === jid);
        return {
            jid,
            phone: getPhoneFromJid(jid),
            name: userNames[jid] || null,
            status: getConversationStatus(jid),
            step: userStates[jid]?.step || 'idle',
            cartItemCount: (userCarts[jid] || []).length,
            orderCount: jidOrders.length,
            lastOrderStatus: jidOrders.length > 0 ? jidOrders[jidOrders.length - 1].status : null,
            lastActivity: chatLogLastActivity[jid] || null,
            lastMessage: lastMsg ? { role: lastMsg.role, text: lastMsg.text.slice(0, 100) } : null,
            isHandover: Boolean(handoverSessions[jid]?.active)
        };
    }).sort((a, b) => {
        // Sort by last activity descending
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return b.lastActivity.localeCompare(a.lastActivity);
    });

    res.json({ ok: true, conversations });
});

// GET /admin/api/conversations/:jid — full message log for one conversation
app.get('/admin/api/conversations/:jid', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const messages = chatLog[jid] || [];
    const jidOrders = orders.filter((o) => o.jid === jid);
    res.json({
        ok: true,
        jid,
        phone: getPhoneFromJid(jid),
        name: userNames[jid] || null,
        status: getConversationStatus(jid),
        step: userStates[jid]?.step || 'idle',
        cart: userCarts[jid] || [],
        isHandover: Boolean(handoverSessions[jid]?.active),
        handoverReason: handoverSessions[jid]?.reason || null,
        orders: jidOrders,
        messages
    });
});

// POST /admin/api/send — send a message to a customer (triggers human handover automatically)
app.post('/admin/api/send', adminRouteLimiter, adminAuthMiddleware, express.json(), async (req, res) => {
    const { jid, message } = req.body || {};
    if (!jid || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'jid and message are required' });
    }
    if (!activeSock || whatsappRuntime.phase !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp is not connected' });
    }
    try {
        // Trigger human handover if not already active
        if (!handoverSessions[jid]?.active) {
            await activateHumanHandover(activeSock, jid, 'Admin sent a message via the dashboard');
        }
        await activeSock.sendMessage(jid, { text: message.trim() });
        // Log the admin message as a 'bot' entry (sent on behalf of the business)
        logChatEntry(jid, 'bot', `[Admin] ${message.trim()}`);
        auditLog('SEND_MSG', `to=${jid}`, req.ip);
        res.json({ ok: true });
    } catch (err) {
        console.error('❌ Admin send failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin/api/resume — resume bot control for a customer (end human handover)
app.post('/admin/api/resume', adminRouteLimiter, adminAuthMiddleware, express.json(), async (req, res) => {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    if (!handoverSessions[jid]?.active) {
        return res.status(400).json({ error: 'No active handover for this conversation' });
    }
    if (!activeSock || whatsappRuntime.phase !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp is not connected' });
    }
    try {
        delete handoverSessions[jid];
        await activeSock.sendMessage(jid, { text: '✅ A team member has finished helping. I can assist you again now — send *menu* or *cart* when you are ready.' });
        auditLog('RESUME_BOT', `for=${jid}`, req.ip);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /admin/api/orders — all orders with full metadata
app.get('/admin/api/orders', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    const sorted = [...orders].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ ok: true, orders: sorted });
});

// GET /admin/api/settings — retrieve bot settings (sensitive values are masked)
app.get('/admin/api/settings', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    res.json({
        ok: true,
        wholesalePasswordSet: !!(settings.wholesalePassword)
    });
});

// POST /admin/api/settings — update bot settings
app.post('/admin/api/settings', adminRouteLimiter, adminAuthMiddleware, express.json(), (req, res) => {
    const { wholesalePassword } = req.body || {};
    if (typeof wholesalePassword !== 'string') {
        return res.status(400).json({ error: 'wholesalePassword must be a string' });
    }
    settings.wholesalePassword = wholesalePassword;
    saveJsonFile(SETTINGS_FILE, settings);
    auditLog('SETTINGS_UPDATE', 'wholesalePassword updated', req.ip);
    res.json({ ok: true });
});

// GET /admin/api/leads — top unanswered messages
app.get('/admin/api/leads', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    const sorted = [...learningLeads].sort((a, b) => b.count - a.count);
    res.json({ ok: true, leads: sorted });
});

// GET /admin/api/handovers — active human handover sessions
app.get('/admin/api/handovers', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    const active = Object.entries(handoverSessions)
        .filter(([, s]) => s.active)
        .map(([jid, s]) => ({
            jid,
            phone: getPhoneFromJid(jid),
            name: userNames[jid] || null,
            reason: s.reason,
            requestedAt: s.requestedAt
        }));
    res.json({ ok: true, handovers: active });
});

// GET /admin/api/files/:filename — securely proxy a locally stored file to the admin browser
app.get('/admin/api/files/:filename', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(STORAGE_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    auditLog('DOWNLOAD_FILE', `file=${filename}`, req.ip);
    res.download(filePath);
});

// GET /admin/api/drive/:fileId/download — proxy a Drive file to the admin browser
app.get('/admin/api/drive/:fileId/download', adminRouteLimiter, adminAuthMiddleware, async (req, res) => {
    if (!driveStorage.isDriveEnabled()) {
        return res.status(404).json({ error: 'Google Drive not configured' });
    }
    try {
        const meta = await driveStorage.getFileMeta(req.params.fileId);
        res.setHeader('Content-Disposition', `attachment; filename="${(meta.name || 'file').replace(/"/g, '')}"`);
        auditLog('DOWNLOAD_DRIVE', `fileId=${req.params.fileId}`, req.ip);
        await driveStorage.streamDriveFile(req.params.fileId, res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin login / logout ──────────────────────────────────────────────────────
const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: '{"error":"Too many login attempts. Try again later."}'
});

// GET /admin/login — show login form
app.get('/admin/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BUSINESS_NAME} – Admin Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 12px; padding: 40px; width: 100%; max-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,.1); }
  .logo { font-size: 2rem; text-align: center; margin-bottom: 8px; }
  h1 { font-size: 1.2rem; text-align: center; color: #075e54; margin-bottom: 24px; }
  label { font-size: .85rem; color: #444; display: block; margin-bottom: 4px; }
  input[type=password] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 1rem; margin-bottom: 16px; outline: none; }
  input[type=password]:focus { border-color: #075e54; }
  button { width: 100%; padding: 12px; background: #075e54; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #054c44; }
  .err { color: #e74c3c; font-size: .85rem; margin-bottom: 12px; text-align: center; }
  .hint { font-size: .75rem; color: #aaa; text-align: center; margin-top: 16px; }
</style>
</head><body>
<div class="card">
  <div class="logo">💬</div>
  <h1>${BUSINESS_NAME}<br>Admin Dashboard</h1>
  ${req.query.err === '1' ? '<p class="err">Incorrect password. Please try again.</p>' : ''}
  <form method="POST" action="/admin/login">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" placeholder="Enter admin password" autofocus required>
    <button type="submit">Sign In</button>
  </form>
  <p class="hint">Set <code>ADMIN_PASSWORD</code> env var to enable password auth.</p>
</div>
</body></html>`);
});

// POST /admin/login — validate password, create session
app.post('/admin/login', loginRateLimiter, express.urlencoded({ extended: false }), (req, res) => {
    const { password = '' } = req.body;
    // Always redirect to /admin after login — no user-supplied next param.
    const DASHBOARD = '/admin';

    // Password check: ADMIN_PASSWORD env var, or fall back to QR_ACCESS_TOKEN
    const storedPw = ADMIN_PASSWORD || QR_ACCESS_TOKEN;
    if (!storedPw) {
        // No password configured — allow through (open dashboard mode)
        const token = createAdminSession(req.ip);
        auditLog('LOGIN', 'no-password-configured', req.ip);
        res.setHeader('Set-Cookie', `adminSession=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
        return res.redirect(302, DASHBOARD);
    }

    const pwBuf = Buffer.from(password);
    const expectedBuf = Buffer.from(storedPw);
    const valid = pwBuf.length === expectedBuf.length && crypto.timingSafeEqual(pwBuf, expectedBuf);

    if (!valid) {
        auditLog('LOGIN_FAIL', `ip=${req.ip}`, req.ip);
        return res.redirect(302, '/admin/login?err=1');
    }

    const token = createAdminSession(req.ip);
    auditLog('LOGIN', 'success', req.ip);
    res.setHeader('Set-Cookie', `adminSession=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
    res.redirect(302, DASHBOARD);
});

// POST /admin/logout — clear session
app.post('/admin/logout', adminRouteLimiter, (req, res) => {
    const token = getAdminSessionToken(req);
    if (token) { deleteAdminSession(token); auditLog('LOGOUT', '', req.ip); }
    res.setHeader('Set-Cookie', 'adminSession=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0');
    res.redirect(302, '/admin/login');
});


app.get('/admin', adminRouteLimiter, adminAuthMiddleware, (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${BUSINESS_NAME} – Admin Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

    /* ── Top bar ── */
    .topbar { background: #075e54; color: #fff; padding: 0 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; height: 52px; }
    .topbar h1 { font-size: 1rem; font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status-dot { width: 9px; height: 9px; border-radius: 50%; background: #ccc; display: inline-block; flex-shrink: 0; }
    .status-dot.connected { background: #25d366; }
    .wa-status { font-size: 0.78rem; opacity: 0.85; white-space: nowrap; }

    /* ── Tab navigation ── */
    .tabs { display: flex; gap: 2px; flex-shrink: 0; }
    .tab-btn { background: transparent; color: rgba(255,255,255,.75); border: none; padding: 6px 12px; cursor: pointer; font-size: 0.82rem; border-radius: 4px; white-space: nowrap; transition: background .15s; }
    .tab-btn:hover { background: rgba(255,255,255,.12); color: #fff; }
    .tab-btn.active { background: rgba(255,255,255,.22); color: #fff; font-weight: 600; }
    .logout-btn { background: rgba(255,255,255,.15); color: #fff; border: 1px solid rgba(255,255,255,.3); padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 0.78rem; white-space: nowrap; }
    .logout-btn:hover { background: rgba(255,255,255,.25); }

    /* ── Main / Panels ── */
    .main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
    .panel { display: none; flex: 1; overflow: hidden; }
    .panel.active { display: flex; }

    /* ── CHATS PANEL ── */
    .chat-layout { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 300px; flex-shrink: 0; background: #fff; border-right: 1px solid #ddd; display: flex; flex-direction: column; overflow: hidden; }
    .sidebar-header { padding: 10px 14px; border-bottom: 1px solid #ddd; display: flex; align-items: center; gap: 8px; }
    .sidebar-header h2 { font-size: 0.9rem; font-weight: 600; flex: 1; }
    .refresh-btn { font-size: 0.78rem; cursor: pointer; color: #075e54; border: none; background: none; padding: 4px 8px; border-radius: 4px; }
    .refresh-btn:hover { background: #f0f2f5; }
    .legend { padding: 6px 14px; font-size: 0.72rem; color: #555; border-bottom: 1px solid #eee; display: flex; gap: 10px; flex-wrap: wrap; }
    .legend span { display: flex; align-items: center; gap: 3px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .dot-paid { background: #27ae60; }
    .dot-quoted { background: #2980b9; }
    .dot-in_progress { background: #f39c12; }
    .dot-handover { background: #e74c3c; }
    .dot-idle { background: #aaa; }
    .conv-list { overflow-y: auto; flex: 1; }
    .conv-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f0f2f5; display: flex; align-items: flex-start; gap: 10px; }
    .conv-item:hover { background: #f5f5f5; }
    .conv-item.active { background: #e9f5e9; }
    .conv-avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 1rem; color: #fff; font-weight: 700; }
    .conv-body { flex: 1; overflow: hidden; }
    .conv-name { font-size: 0.88rem; font-weight: 600; display: flex; align-items: center; gap: 5px; }
    .conv-phone { font-size: 0.78rem; color: #666; }
    .conv-preview { font-size: 0.76rem; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .conv-meta { text-align: right; flex-shrink: 0; }
    .conv-time { font-size: 0.7rem; color: #aaa; white-space: nowrap; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; margin-top: 3px; }
    .badge-paid { background: #d5f5e3; color: #1a7a47; }
    .badge-quoted { background: #d6eaf8; color: #1b5e8f; }
    .badge-in_progress { background: #fef9e7; color: #8a6200; }
    .badge-handover { background: #fde8e8; color: #a93226; }
    .badge-idle { background: #f0f0f0; color: #666; }

    /* ── Chat area ── */
    .chat-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .chat-header { background: #fff; border-bottom: 1px solid #ddd; padding: 10px 18px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .chat-info { flex: 1; overflow: hidden; }
    .chat-name { font-size: 0.95rem; font-weight: 600; }
    .chat-sub { font-size: 0.78rem; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btn-resume { padding: 6px 12px; background: #075e54; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.8rem; flex-shrink: 0; }
    .btn-resume:hover { background: #054c44; }
    .btn-resume:disabled { background: #aaa; cursor: default; }
    .chat-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 7px; background: #e5ddd5; }
    .msg { max-width: 72%; padding: 7px 11px; border-radius: 8px; font-size: 0.86rem; line-height: 1.45; word-break: break-word; white-space: pre-wrap; }
    .msg-user { align-self: flex-start; background: #fff; border-bottom-left-radius: 2px; }
    .msg-bot { align-self: flex-end; background: #dcf8c6; border-bottom-right-radius: 2px; }
    .msg-admin { align-self: flex-end; background: #cce5ff; border-bottom-right-radius: 2px; }
    .msg-time { font-size: 0.66rem; color: #999; margin-top: 2px; text-align: right; }
    .msg-file { font-size: 0.78rem; margin-top: 4px; }
    .msg-file a { color: #075e54; }
    .chat-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 0.9rem; background: #e5ddd5; }
    .chat-input-area { background: #f0f2f5; border-top: 1px solid #ddd; padding: 10px 14px; display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0; }
    .chat-input { flex: 1; border: 1px solid #ddd; border-radius: 20px; padding: 9px 15px; font-size: 0.88rem; resize: none; max-height: 120px; outline: none; font-family: inherit; }
    .chat-input:focus { border-color: #075e54; }
    .send-btn { background: #075e54; color: #fff; border: none; border-radius: 50%; width: 42px; height: 42px; cursor: pointer; font-size: 1rem; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    .send-btn:hover { background: #054c44; }
    .send-btn:disabled { background: #aaa; cursor: default; }
    .takeover-notice { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 7px 12px; font-size: 0.8rem; color: #856404; margin: 0 14px 7px; flex-shrink: 0; }
    .no-conv { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #aaa; gap: 6px; background: #e5ddd5; }
    .no-conv-icon { font-size: 2.8rem; }

    /* ── Full-width panels (Orders, Leads, Handovers, QR) ── */
    .full-panel { flex: 1; overflow-y: auto; padding: 24px; background: #f0f2f5; }
    .full-panel h2 { font-size: 1.1rem; margin-bottom: 16px; color: #333; }
    .data-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.08); font-size: 0.85rem; }
    .data-table th { background: #075e54; color: #fff; padding: 10px 14px; text-align: left; font-size: 0.8rem; }
    .data-table td { padding: 9px 14px; border-bottom: 1px solid #f0f2f5; vertical-align: top; }
    .data-table tr:last-child td { border-bottom: none; }
    .data-table tr:hover td { background: #f9f9f9; }
    .btn-sm { padding: 4px 10px; border-radius: 4px; border: 1px solid #ddd; background: #fff; font-size: 0.78rem; cursor: pointer; color: #333; }
    .btn-sm:hover { background: #f5f5f5; }
    .btn-sm-primary { background: #075e54; color: #fff; border-color: #075e54; }
    .btn-sm-primary:hover { background: #054c44; }
    .empty-state { text-align: center; padding: 48px; color: #aaa; }

    /* ── Products panel ── */
    .products-panel { flex: 1; overflow-y: auto; padding: 24px; background: #f0f2f5; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 20px; background: #fff; }
    .card h3 { margin-top: 0; font-size: 1rem; margin-bottom: 8px; }
    .hint { color: #666; font-size: 0.82rem; margin-bottom: 10px; }
    .btn { display: inline-block; padding: 9px 16px; background: #25d366; color: #fff; text-decoration: none; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    .btn-sec { background: #444; }
    input[type=file] { display: block; margin: 10px 0; }

    /* ── QR panel ── */
    .qr-panel { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 24px; background: #f0f2f5; }
    .qr-panel iframe { border: 1px solid #ddd; border-radius: 8px; background: #fff; }
    .qr-status-box { background: #fff; padding: 20px; border-radius: 8px; text-align: center; min-width: 280px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    .qr-status-box h3 { margin-bottom: 8px; }
  </style>
</head>
<body>

<!-- ── Top bar ── -->
<div class="topbar">
  <h1>💬 ${BUSINESS_NAME} – Admin</h1>
  <span class="status-dot" id="waDot"></span>
  <span class="wa-status" id="waStatus">…</span>
  <div class="tabs">
    <button class="tab-btn active" data-tab="chats" onclick="switchTab('chats')">💬 Chats</button>
    <button class="tab-btn" data-tab="orders" onclick="switchTab('orders')">📋 Orders</button>
    <button class="tab-btn" data-tab="products" onclick="switchTab('products')">📦 Products</button>
    <button class="tab-btn" data-tab="leads" onclick="switchTab('leads')">💡 Leads</button>
    <button class="tab-btn" data-tab="handovers" onclick="switchTab('handovers')">🤝 Handovers</button>
    <button class="tab-btn" data-tab="settings" onclick="switchTab('settings')">⚙️ Settings</button>
    <button class="tab-btn" data-tab="qr" onclick="switchTab('qr')">📱 QR</button>
  </div>
  <form method="POST" action="/admin/logout" style="flex-shrink:0">
    <button type="submit" class="logout-btn">Sign out</button>
  </form>
</div>

<!-- ── Main content ── -->
<div class="main">

  <!-- CHATS TAB -->
  <div id="panel-chats" class="panel active">
    <div class="chat-layout" style="flex:1;overflow:hidden">
      <div class="sidebar">
        <div class="sidebar-header">
          <h2>Conversations</h2>
          <button class="refresh-btn" onclick="loadConversations()">⟳ Refresh</button>
        </div>
        <div class="legend">
          <span><span class="dot dot-paid"></span>Paid</span>
          <span><span class="dot dot-quoted"></span>Quoted</span>
          <span><span class="dot dot-in_progress"></span>In Progress</span>
          <span><span class="dot dot-handover"></span>Handover</span>
          <span><span class="dot dot-idle"></span>Idle</span>
        </div>
        <div class="conv-list" id="convList"><p style="padding:16px;color:#aaa;font-size:.82rem">Loading…</p></div>
      </div>
      <div class="chat-area" id="chatArea">
        <div class="no-conv">
          <div class="no-conv-icon">💬</div>
          <p>Select a conversation to view</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ORDERS TAB -->
  <div id="panel-orders" class="panel" style="flex-direction:column">
    <div class="full-panel" id="ordersPanel"><p style="color:#aaa">Loading orders…</p></div>
  </div>

  <!-- PRODUCTS TAB -->
  <div id="panel-products" class="panel" style="flex-direction:column">
    <div class="products-panel">
      <h2 style="margin-bottom:16px">📦 Products CSV</h2>
      <div class="card">
        <h3>Download template</h3>
        <p class="hint">Blank CSV with headers and one sample row.</p>
        <a class="btn btn-sec" href="/products/template">⬇ Download template</a>
      </div>
      <div class="card">
        <h3>Download current products</h3>
        <p class="hint">Download the live products.csv for editing.</p>
        <a class="btn btn-sec" href="/products/csv">⬇ Download products.csv</a>
      </div>
      <div class="card">
        <h3>Upload updated CSV</h3>
        <p class="hint">Replace the live catalogue. The bot reloads immediately.</p>
        <form method="POST" action="/products/upload" enctype="multipart/form-data">
          <input type="file" name="file" accept=".csv">
          <button class="btn" type="submit">⬆ Upload</button>
        </form>
      </div>
    </div>
  </div>

  <!-- LEADS TAB -->
  <div id="panel-leads" class="panel" style="flex-direction:column">
    <div class="full-panel" id="leadsPanel"><p style="color:#aaa">Loading leads…</p></div>
  </div>

  <!-- HANDOVERS TAB -->
  <div id="panel-handovers" class="panel" style="flex-direction:column">
    <div class="full-panel" id="handoversPanel"><p style="color:#aaa">Loading handovers…</p></div>
  </div>

  <!-- SETTINGS TAB -->
  <div id="panel-settings" class="panel" style="flex-direction:column">
    <div class="products-panel">
      <h2 style="margin-bottom:16px">⚙️ Settings</h2>
      <div class="card">
        <h3>🏷️ Wholesale Client Password</h3>
        <p class="hint">Set a password that wholesale clients can enter in the bot to unlock a 20% discount on all products (excluding the Supplies category). Leave blank to disable wholesale pricing.</p>
        <div id="wholesaleStatus" style="margin-bottom:10px;font-size:.85rem;color:#666">Loading…</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="password" id="wholesalePasswordInput" placeholder="New wholesale password" style="padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:.88rem;flex:1;min-width:200px">
          <button class="btn" onclick="saveWholesalePassword()" style="flex-shrink:0">💾 Save Password</button>
          <button class="btn btn-sec" onclick="clearWholesalePassword()" style="flex-shrink:0">🗑️ Clear (Disable)</button>
        </div>
        <p id="wholesaleSaveMsg" style="margin-top:8px;font-size:.82rem;display:none"></p>
      </div>
    </div>
  </div>

  <!-- QR TAB -->
  <div id="panel-qr" class="panel" style="flex-direction:column">
    <div class="qr-panel" id="qrPanel">
      <div class="qr-status-box">
        <h3 id="qrStatusTitle">Checking WhatsApp…</h3>
        <p id="qrStatusSub" style="font-size:.85rem;color:#666;margin-top:6px"></p>
        <div id="qrImgWrap" style="margin-top:16px;display:none">
          <img id="qrImg" src="" style="max-width:260px;border:1px solid #ccc;padding:8px;border-radius:4px">
          <p style="font-size:.75rem;color:#aaa;margin-top:6px">QR refreshes automatically every 55 s.</p>
        </div>
        <button class="btn btn-sec" style="margin-top:16px;font-size:.82rem" onclick="refreshQrPanel()">⟳ Refresh</button>
      </div>
    </div>
  </div>

</div>

<script>
// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
}

function statusLabel(s) {
  return { paid:'Paid', quoted:'Quoted', in_progress:'In Progress', handover:'Handover', idle:'Idle' }[s] || s;
}

function avatarLetter(name, phone) {
  return (name || phone || '?').charAt(0).toUpperCase();
}

function avatarColor(jid) {
  const colors = ['#25d366','#075e54','#128c7e','#2980b9','#8e44ad','#c0392b','#d35400','#16a085'];
  let h = 0; for (let i = 0; i < jid.length; i++) h = (h*31 + jid.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

// ── Tab switching ─────────────────────────────────────────────────────────────
let currentTab = 'chats';
function switchTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('panel-' + name).classList.add('active');
  currentTab = name;
  if (name === 'orders') loadOrders();
  else if (name === 'leads') loadLeads();
  else if (name === 'handovers') loadHandovers();
  else if (name === 'settings') loadSettings();
  else if (name === 'qr') refreshQrPanel();
}

// ── Settings tab ──────────────────────────────────────────────────────────────
async function loadSettings() {
  const statusEl = document.getElementById('wholesaleStatus');
  if (!statusEl) return;
  try {
    const r = await fetch('/admin/api/settings');
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (data.ok) {
      statusEl.textContent = data.wholesalePasswordSet
        ? '✅ Wholesale password is currently set.'
        : '⚠️ No wholesale password set — wholesale pricing is disabled.';
    }
  } catch(e) { statusEl.textContent = 'Error loading settings.'; }
}

async function saveWholesalePassword() {
  const input = document.getElementById('wholesalePasswordInput');
  const msg = document.getElementById('wholesaleSaveMsg');
  const pw = (input && input.value) || '';
  if (!pw) { alert('Please enter a password first.'); return; }
  try {
    const r = await fetch('/admin/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wholesalePassword: pw })
    });
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (data.ok) {
      if (msg) { msg.style.display='block'; msg.style.color='#27ae60'; msg.textContent='✅ Wholesale password saved successfully.'; }
      if (input) input.value = '';
      loadSettings();
    } else {
      if (msg) { msg.style.display='block'; msg.style.color='#c0392b'; msg.textContent='Error: ' + (data.error||'Unknown error'); }
    }
  } catch(e) {
    if (msg) { msg.style.display='block'; msg.style.color='#c0392b'; msg.textContent='Error: ' + e.message; }
  }
}

async function clearWholesalePassword() {
  if (!confirm('Are you sure you want to disable wholesale pricing? This will clear the wholesale password.')) return;
  const msg = document.getElementById('wholesaleSaveMsg');
  try {
    const r = await fetch('/admin/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wholesalePassword: '' })
    });
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (data.ok) {
      if (msg) { msg.style.display='block'; msg.style.color='#27ae60'; msg.textContent='✅ Wholesale password cleared. Wholesale pricing is now disabled.'; }
      loadSettings();
    }
  } catch(e) {
    if (msg) { msg.style.display='block'; msg.style.color='#c0392b'; msg.textContent='Error: ' + e.message; }
  }
}

// ── WhatsApp status ───────────────────────────────────────────────────────────
let waPhase = 'unknown';
async function checkWaStatus() {
  try {
    const r = await fetch('/health');
    const data = await r.json();
    waPhase = (data.whatsapp && data.whatsapp.phase) || 'unknown';
    const dot = document.getElementById('waDot');
    const statusEl = document.getElementById('waStatus');
    if (dot) dot.className = 'status-dot' + (waPhase === 'connected' ? ' connected' : '');
    if (statusEl) statusEl.textContent = waPhase;
  } catch(e) {}
}

// ── Conversations (Chat tab) ──────────────────────────────────────────────────
let activeJid = null;
let pollInterval = null;
let convDataHash = '';
let chatFrameBuilt = false; // true once the static chat area frame has been rendered
let lastMsgCount = 0;

function renderConversations(list) {
  const hash = JSON.stringify(list.map(c => c.jid + c.status + (c.lastActivity||'')));
  if (hash === convDataHash) return; // nothing changed — skip re-render
  convDataHash = hash;

  const el = document.getElementById('convList');
  if (!list.length) {
    el.innerHTML = '<p style="padding:16px;color:#aaa;font-size:.82rem">No conversations yet.</p>';
    return;
  }
  el.innerHTML = list.map(c => {
    const isActive = c.jid === activeJid;
    const label = c.name || c.phone || c.jid;
    const preview = c.lastMessage ? (c.lastMessage.role === 'user' ? '' : '🤖 ') + c.lastMessage.text : 'No messages yet';
    const enc = encodeURIComponent(c.jid);
    return \`<div class="conv-item\${isActive?' active':''}" onclick="selectConv('\${enc}')">
      <div class="conv-avatar" style="background:\${avatarColor(c.jid)}">\${avatarLetter(c.name,c.phone)}</div>
      <div class="conv-body">
        <div class="conv-name"><span>\${esc(label)}</span><span class="dot dot-\${c.status}" title="\${statusLabel(c.status)}"></span></div>
        \${c.name ? '<div class="conv-phone">'+esc(c.phone)+'</div>' : ''}
        <div class="conv-preview">\${esc(preview)}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">\${fmtTime(c.lastActivity)}</div>
        <span class="badge badge-\${c.status}">\${statusLabel(c.status)}</span>
      </div>
    </div>\`;
  }).join('');
}

async function loadConversations() {
  try {
    const r = await fetch('/admin/api/conversations');
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (data.ok) renderConversations(data.conversations);
  } catch(e) {}
}

async function selectConv(encodedJid) {
  if (pollInterval) clearInterval(pollInterval);
  activeJid = decodeURIComponent(encodedJid);
  chatFrameBuilt = false;
  lastMsgCount = 0;

  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', decodeURIComponent(el.onclick.toString().match(/'([^']+)'/)?.[1]||'') === activeJid);
  });

  await refreshChat();
  pollInterval = setInterval(refreshChat, 4000);
}

async function refreshChat() {
  if (!activeJid) return;
  try {
    const r = await fetch('/admin/api/conversations/' + encodeURIComponent(activeJid));
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (!data.ok) return;
    if (!chatFrameBuilt) {
      buildChatFrame(data);
    } else {
      updateChatContent(data);
    }
    // Refresh sidebar count/status without full re-render
    loadConversations();
  } catch(e) { console.error('chat refresh error', e); }
}

/** First-time render of the static chat frame (header + input area). */
function buildChatFrame(data) {
  chatFrameBuilt = true;
  const area = document.getElementById('chatArea');
  area.innerHTML = \`
    <div class="chat-header" id="chatHeader"></div>
    <div class="takeover-notice" id="takeoverNotice" style="display:none;margin:0 14px 7px;"></div>
    <div class="chat-messages" id="msgContainer"></div>
    <div class="chat-input-area">
      <textarea class="chat-input" id="msgInput" rows="1"
        placeholder="Type a message… (sending will activate human takeover)"
        oninput="autoResize(this)" onkeydown="handleKey(event)"></textarea>
      <button class="send-btn" onclick="sendMsg()" title="Send">➤</button>
    </div>
  \`;
  updateChatContent(data);
}

/** Incremental update — only touches elements that may have changed. */
function updateChatContent(data) {
  const label = data.name || data.phone || data.jid;
  const isHandover = data.isHandover;

  // ── Header ────────────────────────────────────────────────────────────────
  const cartInfo = data.cart && data.cart.length ? \`🛒 \${data.cart.length} item(s) in cart\` : '';
  const stepInfo = data.step && data.step !== 'idle' ? \`Step: \${data.step}\` : '';
  const sub = [cartInfo, stepInfo].filter(Boolean).join(' · ') || data.jid;
  const headerEl = document.getElementById('chatHeader');
  if (headerEl) {
    headerEl.innerHTML = \`
      <div class="conv-avatar" style="background:\${avatarColor(data.jid)};width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:1rem;flex-shrink:0">\${avatarLetter(data.name,data.phone)}</div>
      <div class="chat-info">
        <div class="chat-name">\${esc(label)} <span class="badge badge-\${data.status}">\${statusLabel(data.status)}</span></div>
        <div class="chat-sub">\${esc(sub)}</div>
      </div>
      \${isHandover ? '<button class="btn-resume" onclick="resumeBot()">✅ Resume Bot</button>' : ''}
    \`;
  }

  // ── Handover notice ────────────────────────────────────────────────────────
  const noticeEl = document.getElementById('takeoverNotice');
  if (noticeEl) {
    noticeEl.style.display = isHandover ? 'block' : 'none';
    if (isHandover) noticeEl.innerHTML = '🤝 <strong>Human handover active.</strong> Messages you type go directly to the customer. Click <em>Resume Bot</em> to hand back.';
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  const msgContainer = document.getElementById('msgContainer');
  if (!msgContainer) return;

  const msgs = data.messages || [];
  if (msgs.length === lastMsgCount) return; // nothing new

  const wasAtBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 50;

  if (msgs.length < lastMsgCount) {
    // Rare case (e.g. log trimmed): full re-render
    msgContainer.innerHTML = '';
  }

  // Append only new messages
  const startIdx = Math.max(0, lastMsgCount);
  const fragment = document.createDocumentFragment();
  for (let i = startIdx; i < msgs.length; i++) {
    const m = msgs[i];
    const cls = m.role === 'user' ? 'msg-user' : (m.text && m.text.startsWith('[Admin]') ? 'msg-admin' : 'msg-bot');
    const prefix = m.role !== 'user' ? (m.text && m.text.startsWith('[Admin]') ? '👤 Admin  ' : '🤖 Bot  ') : '';
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.innerHTML = esc(prefix + m.text) + '<div class="msg-time">' + fmtTime(m.timestamp) + '</div>';
    // Attach file links if present
    if (m.fileRef) {
      const link = document.createElement('div');
      link.className = 'msg-file';
      if (m.fileRef.provider === 'googledrive') {
        link.innerHTML = '📎 <a href="/admin/api/drive/' + esc(m.fileRef.driveFileId) + '/download" target="_blank">Download file (Drive)</a>';
      } else if (m.fileRef.localFilename) {
        link.innerHTML = '📎 <a href="/admin/api/files/' + esc(m.fileRef.localFilename) + '" target="_blank">Download file</a>';
      }
      div.appendChild(link);
    }
    fragment.appendChild(div);
  }
  if (msgs.length < lastMsgCount) {
    // After full clear, add all messages
    const fragment2 = document.createDocumentFragment();
    for (const m of msgs) {
      const cls = m.role === 'user' ? 'msg-user' : (m.text && m.text.startsWith('[Admin]') ? 'msg-admin' : 'msg-bot');
      const prefix = m.role !== 'user' ? (m.text && m.text.startsWith('[Admin]') ? '👤 Admin  ' : '🤖 Bot  ') : '';
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.innerHTML = esc(prefix + m.text) + '<div class="msg-time">' + fmtTime(m.timestamp) + '</div>';
      fragment2.appendChild(div);
    }
    msgContainer.appendChild(fragment2);
  } else {
    msgContainer.appendChild(fragment);
  }
  lastMsgCount = msgs.length;

  if (wasAtBottom) msgContainer.scrollTop = msgContainer.scrollHeight;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
}

async function sendMsg() {
  const input = document.getElementById('msgInput');
  if (!input || !activeJid) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  const btn = document.querySelector('.send-btn');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/admin/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: activeJid, message: text })
    });
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (!data.ok) alert('Send failed: ' + (data.error || 'unknown error'));
    else await refreshChat();
  } catch(e) { alert('Send failed: ' + e.message); }
  finally { if (btn) btn.disabled = false; input.focus(); }
}

async function resumeBot() {
  if (!activeJid) return;
  if (!confirm('Resume bot control for this customer? The human handover will end.')) return;
  try {
    const r = await fetch('/admin/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: activeJid })
    });
    const data = await r.json();
    if (!data.ok) alert('Failed: ' + (data.error || 'unknown'));
    else { chatFrameBuilt = false; await refreshChat(); }
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Orders tab ────────────────────────────────────────────────────────────────
async function loadOrders() {
  const el = document.getElementById('ordersPanel');
  if (!el) return;
  try {
    const r = await fetch('/admin/api/orders');
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (!data.ok) { el.innerHTML = '<p class="empty-state">Failed to load orders.</p>'; return; }
    const orders = data.orders;
    if (!orders.length) { el.innerHTML = '<h2>📋 Orders</h2><p class="empty-state">No orders yet.</p>'; return; }
    el.innerHTML = '<h2>📋 Orders</h2>' +
      '<table class="data-table"><thead><tr>' +
      '<th>Date</th><th>Customer</th><th>Status</th><th>Total</th><th>Quote</th><th>Files</th>' +
      '</tr></thead><tbody>' +
      orders.map(o => {
        const quoteLink = o.invoiceNinjaLink
          ? \`<a href="\${esc(o.invoiceNinjaLink)}" target="_blank">\${esc(o.invoiceNinjaQuoteNumber||'View')}</a>\`
          : (o.invoiceNinjaQuoteNumber ? esc(o.invoiceNinjaQuoteNumber) : '—');
        const files = (o.cart || []).flatMap(item => {
          const links = [];
          if (item.fileRef) {
            if (item.fileRef.provider === 'googledrive' && item.fileRef.driveFileId) {
              links.push(\`<a href="/admin/api/drive/\${esc(item.fileRef.driveFileId)}/download" target="_blank">📎 Drive</a>\`);
            } else if (item.fileRef.localFilename) {
              links.push(\`<a href="/admin/api/files/\${esc(item.fileRef.localFilename)}" target="_blank">📎 Local</a>\`);
            }
          }
          if (item.artworkFile) links.push(\`<a href="/admin/api/files/\${esc(item.artworkFile)}" target="_blank">🖼 Artwork</a>\`);
          return links;
        }).join(' ');
        return \`<tr>
          <td>\${fmtTime(o.createdAt)}</td>
          <td>\${esc(o.customerName||o.customerPhone||o.jid)}</td>
          <td><span class="badge badge-\${o.status}">\${statusLabel(o.status)}</span></td>
          <td>R\${(o.grandTotal||0).toFixed(2)}</td>
          <td>\${quoteLink}</td>
          <td>\${files||'—'}</td>
        </tr>\`;
      }).join('') +
      '</tbody></table>';
  } catch(e) { el.innerHTML = '<p class="empty-state">Error loading orders.</p>'; }
}

// ── Leads tab ─────────────────────────────────────────────────────────────────
async function loadLeads() {
  const el = document.getElementById('leadsPanel');
  if (!el) return;
  try {
    const r = await fetch('/admin/api/leads');
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (!data.ok) { el.innerHTML = '<p class="empty-state">Failed to load leads.</p>'; return; }
    const leads = data.leads;
    if (!leads.length) { el.innerHTML = '<h2>💡 Unanswered Messages (Leads)</h2><p class="empty-state">No leads yet.</p>'; return; }
    el.innerHTML = '<h2>💡 Unanswered Messages (Leads)</h2>' +
      '<table class="data-table"><thead><tr><th>#</th><th>Example message</th><th>Count</th><th>Last seen</th></tr></thead><tbody>' +
      leads.map((l, i) => \`<tr>
        <td>\${i+1}</td>
        <td>\${esc(l.example)}</td>
        <td>\${l.count}</td>
        <td>\${fmtTime(l.lastSeen)}</td>
      </tr>\`).join('') +
      '</tbody></table>';
  } catch(e) { el.innerHTML = '<p class="empty-state">Error loading leads.</p>'; }
}

// ── Handovers tab ─────────────────────────────────────────────────────────────
async function loadHandovers() {
  const el = document.getElementById('handoversPanel');
  if (!el) return;
  try {
    const r = await fetch('/admin/api/handovers');
    if (r.status === 401) { location.href='/admin/login'; return; }
    const data = await r.json();
    if (!data.ok) { el.innerHTML = '<p class="empty-state">Failed to load handovers.</p>'; return; }
    const handovers = data.handovers;
    if (!handovers.length) { el.innerHTML = '<h2>🤝 Active Handovers</h2><p class="empty-state">No active handovers.</p>'; return; }
    el.innerHTML = '<h2>🤝 Active Handovers</h2>' +
      '<table class="data-table"><thead><tr><th>Customer</th><th>Phone</th><th>Reason</th><th>Since</th><th>Action</th></tr></thead><tbody>' +
      handovers.map(h => \`<tr>
        <td>\${esc(h.name||h.jid)}</td>
        <td>\${esc(h.phone)}</td>
        <td>\${esc(h.reason||'')}</td>
        <td>\${fmtTime(h.requestedAt)}</td>
        <td>
          <button class="btn-sm" onclick="switchTab('chats');selectConv('\${encodeURIComponent(h.jid)}')">💬 Open chat</button>
          <button class="btn-sm btn-sm-primary" onclick="resumeHandover('\${encodeURIComponent(h.jid)}')">✅ Resume bot</button>
        </td>
      </tr>\`).join('') +
      '</tbody></table>';
  } catch(e) { el.innerHTML = '<p class="empty-state">Error loading handovers.</p>'; }
}

async function resumeHandover(encodedJid) {
  const jid = decodeURIComponent(encodedJid);
  if (!confirm('Resume bot for ' + jid + '?')) return;
  try {
    const r = await fetch('/admin/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid })
    });
    const data = await r.json();
    if (!data.ok) alert('Failed: ' + (data.error||'unknown'));
    else loadHandovers();
  } catch(e) { alert('Error: ' + e.message); }
}

// ── QR tab ────────────────────────────────────────────────────────────────────
async function refreshQrPanel() {
  try {
    const r = await fetch('/health');
    const data = await r.json();
    const phase = (data.whatsapp && data.whatsapp.phase) || 'unknown';
    const title = document.getElementById('qrStatusTitle');
    const sub = document.getElementById('qrStatusSub');
    const wrap = document.getElementById('qrImgWrap');
    const img = document.getElementById('qrImg');
    if (title) title.textContent = phase === 'connected' ? '✅ WhatsApp Connected' : '⏳ Status: ' + phase;
    if (sub) sub.textContent = phase === 'connected'
      ? 'The bot is live and handling messages.'
      : 'Open the QR page to scan and link your WhatsApp account.';
    if (wrap && img) {
      if (phase !== 'connected') {
        wrap.style.display = 'block';
        img.src = '/qr'; // embed as iframe or link
        wrap.innerHTML = '<p style="font-size:.85rem">👉 <a href="/qr" target="_blank" style="color:#075e54">Open QR Code page</a> to scan with WhatsApp.</p>';
      } else {
        wrap.style.display = 'none';
      }
    }
  } catch(e) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadConversations();
checkWaStatus();
setInterval(loadConversations, 10000);
setInterval(checkWaStatus, 15000);
</script>
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
