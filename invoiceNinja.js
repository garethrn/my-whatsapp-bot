'use strict';

/**
 * Invoice Ninja v5 API integration.
 *
 * Required environment variables:
 *   INVOICE_NINJA_URL         – base URL of your Invoice Ninja instance (e.g. https://your-app.invoiceninja.com)
 *   INVOICE_NINJA_API_TOKEN   – API token from Invoice Ninja → Settings → API Tokens
 *
 * Optional environment variables:
 *   INVOICE_NINJA_TAX_NAME    – tax label on line items (default: "VAT")
 *   INVOICE_NINJA_TAX_RATE    – tax rate as a percentage (default: 15)
 */

const https = require('https');
const http = require('http');

const IN_URL = (process.env.INVOICE_NINJA_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');
const IN_TOKEN = process.env.INVOICE_NINJA_API_TOKEN || '';
const IN_TAX_NAME = process.env.INVOICE_NINJA_TAX_NAME || 'VAT';
const parsedTaxRate = parseFloat(process.env.INVOICE_NINJA_TAX_RATE || '0');
const IN_TAX_RATE = Number.isFinite(parsedTaxRate) ? parsedTaxRate : 0;

/**
 * Returns true when the minimum Invoice Ninja configuration is present.
 */
function isConfigured() {
    return !!(IN_URL && IN_TOKEN);
}

/**
 * Make an authenticated JSON request to the Invoice Ninja v5 REST API.
 * @param {string} method  HTTP method (GET, POST, PUT, …)
 * @param {string} apiPath Path relative to /api/v1  (e.g. '/clients')
 * @param {object|null} body  JSON body for POST/PUT requests
 * @returns {Promise<object>} Parsed JSON response
 */
function apiRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        let base;
        try {
            base = new URL(IN_URL);
        } catch (e) {
            return reject(new Error(`Invalid INVOICE_NINJA_URL: "${IN_URL}"`));
        }

        const payload = body ? JSON.stringify(body) : null;
        const basePath = base.pathname.replace(/\/+$/, '');

        const options = {
            hostname: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            path: `${basePath}/api/v1${apiPath}`,
            method,
            headers: {
                'X-API-Token': IN_TOKEN,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        };

        const lib = base.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const payload = String(data || '').trim();
                    if (!payload) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(payload));
                    } catch (e) {
                        const contentType = res.headers['content-type'] || 'unknown';
                        reject(new Error(`Invoice Ninja non-JSON response (${res.statusCode}, content-type: ${contentType}): ${payload.slice(0, 300)}`));
                    }
                } else {
                    reject(new Error(`Invoice Ninja API ${res.statusCode}: ${data.slice(0, 400)}`));
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Find a client by email address; create one if not found.
 * @param {{ name: string, phone: string, email: string }} params
 * @returns {Promise<object>} Invoice Ninja client object
 */
async function findOrCreateClient({ name, phone, email }) {
    if (email) {
        const search = await apiRequest('GET', `/clients?email=${encodeURIComponent(email)}`);
        const existing = search?.data?.[0];
        if (existing) return existing;
    }

    const clientBody = {
        name: name || phone || 'WhatsApp Customer',
        phone: phone || '',
        contacts: [
            {
                first_name: name || '',
                email: email || '',
                phone: phone || ''
            }
        ]
    };

    const result = await apiRequest('POST', '/clients', clientBody);
    if (!result?.data?.id) {
        throw new Error('Invoice Ninja create-client response missing client data. Check INVOICE_NINJA_URL and INVOICE_NINJA_API_TOKEN.');
    }
    return result.data;
}

/**
 * Convert WhatsApp cart items to Invoice Ninja line_items.
 * Each cart entry may expand into multiple lines (material, design, poles, installation).
 * @param {Array} cart
 * @returns {Array} Invoice Ninja line_items array
 */
function cartToLineItems(cart) {
    const lines = [];
    // Only attach tax fields when a non-zero rate is configured
    const taxFields = IN_TAX_RATE > 0 ? { tax_name1: IN_TAX_NAME, tax_rate1: IN_TAX_RATE } : {};

    for (const item of cart) {
        const label = item.dimensions ? `${item.name} (${item.dimensions})` : item.name;
        const qty = (Number.isFinite(item.qty) && item.qty > 0) ? item.qty : 1;
        // sqmPrice is the total material cost for the item; derive the unit cost
        const unitCost = parseFloat(((item.sqmPrice || 0) / qty).toFixed(4));
        // Use the product's SKU code as the product_key so Invoice Ninja can match
        // line items to the correct product in its catalogue. Fall back to the
        // product name when no SKU is set.
        const productKey = (item.sku && String(item.sku).trim()) ? String(item.sku).trim() : item.name;

        const noteParts = [label];
        if (item.unitPriceDescription) noteParts.push(`Unit price: ${item.unitPriceDescription}`);
        if (item.artworkReceived) noteParts.push('Artwork uploaded by customer');
        if (item.designNotes) noteParts.push(`Design requirements: ${item.designNotes}`);

        lines.push({
            product_key: productKey,
            notes: noteParts.join(' | '),
            quantity: qty,
            cost: unitCost,
            ...taxFields
        });

        if ((item.designFee || 0) > 0) {
            lines.push({
                product_key: 'Design/Layout Fee',
                notes: `Design/Layout Fee for ${item.name}`,
                quantity: 1,
                cost: parseFloat((item.designFee).toFixed(4)),
                ...taxFields
            });
        }

        if ((item.polesCost || 0) > 0 && item.poles > 0) {
            lines.push({
                product_key: 'Poles',
                notes: `Poles ×${item.poles} for ${item.name}`,
                quantity: item.poles,
                cost: parseFloat((item.polesCost / item.poles).toFixed(4)),
                ...taxFields
            });
        }

        if ((item.installationFee || 0) > 0) {
            lines.push({
                product_key: 'Installation',
                notes: `Installation for ${item.name}`,
                quantity: 1,
                cost: parseFloat((item.installationFee).toFixed(4)),
                ...taxFields
            });
        }
    }

    return lines;
}

/**
 * Create a quote in Invoice Ninja.
 * @param {string} clientId   Invoice Ninja client ID
 * @param {Array} cart        WhatsApp cart items
 * @param {string} publicNotes Public notes / artwork disclaimer text
 * @returns {Promise<object>} Created quote object
 */
async function createQuote(clientId, cart, publicNotes) {
    const result = await apiRequest('POST', '/quotes', {
        client_id: clientId,
        line_items: cartToLineItems(cart),
        public_notes: publicNotes || '',
        terms: 'Quote valid for 14 days. Artwork disclaimer accepted by customer via WhatsApp.'
    });
    if (!result?.data?.id) {
        throw new Error('Invoice Ninja quote response missing quote data. Check INVOICE_NINJA_URL (without /api/v1) and API token permissions.');
    }
    return result.data;
}

/**
 * Build the public-facing URL that the customer can open to view / approve the quote.
 * Invoice Ninja v5 client portal URL format: /client/quotes/:invitation_key
 * @param {object} quote  Quote object returned from createQuote
 * @returns {string|null}
 */
function getQuoteUrl(quote) {
    if (!quote) return null;
    const key = quote.invitations?.[0]?.key;
    if (!key) return null;
    return `${IN_URL}/client/quotes/${key}`;
}

/**
 * Extract the first invitation key from a quote object.
 * @param {object} quote  Quote object returned from createQuote
 * @returns {string|null}
 */
function getQuoteInvitationKey(quote) {
    return quote?.invitations?.[0]?.key || null;
}

/**
 * Download the PDF for a quote from Invoice Ninja using the server-side API token.
 * Returns the PDF as a Buffer.
 * @param {string} quoteId  Invoice Ninja quote ID
 * @returns {Promise<Buffer>}
 */
async function getQuotePdf(quoteId) {
    return new Promise((resolve, reject) => {
        let base;
        try {
            base = new URL(IN_URL);
        } catch (e) {
            return reject(new Error(`Invalid INVOICE_NINJA_URL: "${IN_URL}"`));
        }

        const basePath = base.pathname.replace(/\/+$/, '');
        const options = {
            hostname: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            path: `${basePath}/api/v1/quotes/${encodeURIComponent(quoteId)}/download`,
            method: 'GET',
            headers: {
                'X-API-Token': IN_TOKEN,
                Accept: 'application/pdf, application/octet-stream, */*'
            }
        };

        const lib = base.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(Buffer.concat(chunks));
                } else {
                    reject(new Error(`Invoice Ninja PDF download ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8', 0, 400)}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

module.exports = {
    isConfigured,
    apiRequest,
    findOrCreateClient,
    cartToLineItems,
    createQuote,
    getQuoteUrl,
    getQuoteInvitationKey,
    getQuotePdf
};
