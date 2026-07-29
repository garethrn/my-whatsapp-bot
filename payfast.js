'use strict';

/**
 * PayFast payment gateway integration.
 *
 * Required environment variables:
 *   PAYFAST_MERCHANT_ID   – Your PayFast merchant ID (from your PayFast account dashboard)
 *   PAYFAST_MERCHANT_KEY  – Your PayFast merchant key (from your PayFast account dashboard)
 *
 * Optional environment variables:
 *   PAYFAST_PASSPHRASE    – Security passphrase set in PayFast → Settings → Integration
 *   PAYFAST_SANDBOX       – Set to "true" to use the PayFast sandbox for testing (default: false / live)
 */

const crypto = require('crypto');
const https = require('https');

const MERCHANT_ID = (process.env.PAYFAST_MERCHANT_ID || '').trim();
const MERCHANT_KEY = (process.env.PAYFAST_MERCHANT_KEY || '').trim();
const PASSPHRASE = (process.env.PAYFAST_PASSPHRASE || '').trim();
const SANDBOX_CREDENTIALS = {
    merchantId: '10004002',
    merchantKey: 'q1cd2rdny4a53'
};
const rawSandboxValue = (process.env.PAYFAST_SANDBOX || '').trim().toLowerCase();
const SANDBOX_FLAG = rawSandboxValue === 'true' || rawSandboxValue === '1' || rawSandboxValue === 'yes' || rawSandboxValue === 'on';
const hasSandboxCredentials = MERCHANT_ID === SANDBOX_CREDENTIALS.merchantId && MERCHANT_KEY === SANDBOX_CREDENTIALS.merchantKey;
const SANDBOX = SANDBOX_FLAG || hasSandboxCredentials;

const PAYFAST_HOST = SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
const PAYMENT_URL = `https://${PAYFAST_HOST}/eng/process`;

/**
 * Returns true when the minimum PayFast configuration is present.
 */
function isConfigured() {
    return !!(MERCHANT_ID && MERCHANT_KEY);
}

/**
 * Returns true when running in sandbox / test mode.
 */
function isSandbox() {
    return SANDBOX;
}

/**
 * Return a preflight configuration issue (if any) before redirecting to PayFast.
 * This avoids generic PayFast errors when local setup is invalid.
 * @returns {string}
 */
function getCheckoutConfigError() {
    if (!isConfigured()) {
        return 'PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY must be configured.';
    }

    if (rawSandboxValue === 'false' && hasSandboxCredentials) {
        return 'Sandbox test credentials detected in live mode. Set PAYFAST_SANDBOX=true or switch to live merchant credentials.';
    }

    return '';
}

/**
 * Encode a value using PHP-compatible URL encoding (spaces become +).
 * PHP's urlencode() encodes all characters except A-Z a-z 0-9 _ - .
 * JavaScript's encodeURIComponent() additionally leaves ! ~ * ' ( ) unencoded,
 * so we must percent-encode those manually to match PHP's output exactly.
 * @param {string} value
 * @returns {string}
 */
function phpUrlencode(value) {
    return encodeURIComponent(String(value).trim())
        .replace(/%20/g, '+')
        .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Basic email validation for PayFast payer details.
 * @param {string} value
 * @returns {boolean}
 */
function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/**
 * Compute a PayFast MD5 signature from an ordered data object.
 * Follows the same algorithm as the official PayFast PHP SDK:
 *   1. Join non-empty fields as key=urlencode(value)&...
 *   2. Append &passphrase=... if set
 *   3. MD5 the resulting string
 * @param {object} data - Key-value pairs in the order they should appear in the hash
 * @returns {string} MD5 hex digest
 */
function computeSignature(data) {
    const parts = Object.entries(data)
        .filter(([, v]) => v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${phpUrlencode(v)}`);

    let paramString = parts.join('&');
    if (PASSPHRASE) {
        paramString += `&passphrase=${phpUrlencode(PASSPHRASE)}`;
    }

    // PayFast requires MD5 for their payment signature algorithm — this is
    // a request-signing operation mandated by the PayFast API specification,
    // NOT a password-storage or password-verification hash.
    // See: https://developers.payfast.co.za/docs#checkout_page_submission
    // lgtm[js/insufficient-password-hash]
    // codeql[js/insufficient-password-hash] -- PayFast requires MD5 request signatures for checkout/ITN verification.
    return crypto.createHash('md5').update(paramString).digest('hex');
}

/**
 * Build the PayFast payment data object for an order.
 * Fields are ordered as PayFast expects for correct signature computation.
 * @param {object} order        - Order record (id, grandTotal, customerName, customerEmail, customerPhone)
 * @param {string} notifyUrl    - URL PayFast will POST the ITN to
 * @param {string} returnUrl    - URL to redirect the customer after successful payment
 * @param {string} cancelUrl    - URL to redirect the customer if they cancel
 * @param {string} [itemName]   - Description shown on the PayFast payment page (max 100 chars)
 * @returns {object} PayFast payment fields including computed signature
 */
function buildPaymentData(order, notifyUrl, returnUrl, cancelUrl, itemName) {
    const amount = parseFloat(order.grandTotal || 0).toFixed(2);
    const nameParts = (order.customerName || '').trim().split(/\s+/);
    const nameFirst = (nameParts[0] || 'Customer').slice(0, 100);
    const nameLast = (nameParts.slice(1).join(' ') || '').slice(0, 100);

    // Fields must be added in this exact order — PayFast computes the signature
    // using the order fields are listed in the payment form.
    const data = {};
    data.merchant_id = MERCHANT_ID;
    data.merchant_key = MERCHANT_KEY;
    data.return_url = returnUrl;
    data.cancel_url = cancelUrl;
    data.notify_url = notifyUrl;
    if (nameFirst) data.name_first = nameFirst;
    if (nameLast) data.name_last = nameLast;
    if (isValidEmail(order.customerEmail)) data.email_address = String(order.customerEmail).trim();
    // Only include cell_number when it is a valid South African mobile number.
    // PayFast rejects numbers that don't match +27[6-8]XXXXXXXX or 0[6-8]XXXXXXXX.
    if (order.customerPhone) {
        const phone = String(order.customerPhone).replace(/\s/g, '');
        if (/^(\+27|0)[6-8][0-9]{8}$/.test(phone)) {
            data.cell_number = phone;
        }
    }
    data.m_payment_id = order.id;
    data.amount = amount;
    data.item_name = (itemName || `Order ${order.id}`).slice(0, 100);

    data.signature = computeSignature(data);
    return data;
}

/**
 * Returns the PayFast payment form endpoint URL for the current mode.
 * @returns {string}
 */
function getPaymentUrl() {
    return PAYMENT_URL;
}

/**
 * Verify the signature of a PayFast ITN (Instant Transaction Notification).
 * @param {object} itnParams - Parsed POST body received from PayFast
 * @returns {{ valid: boolean, status: string, orderId: string, amount: number }}
 */
function verifyItn(itnParams) {
    const { signature, ...rest } = itnParams;
    const expectedSig = computeSignature(rest);
    return {
        valid: signature === expectedSig,
        status: itnParams.payment_status || '',
        orderId: itnParams.m_payment_id || '',
        amount: parseFloat(itnParams.amount_gross || '0')
    };
}

/**
 * Confirm an ITN with PayFast's server-to-server validation endpoint.
 * PayFast responds with "VALID" or "INVALID".
 *
 * The PayFast API requires two additional headers on this request:
 *   version: v1.0.0
 *   merchant-id: <your merchant ID>
 * Without them the endpoint always returns "INVALID".
 *
 * @param {object} itnParams - Raw ITN POST body as a key-value object
 * @returns {Promise<boolean>} true if PayFast confirms the payment is valid
 */
function validateItnWithPayFast(itnParams) {
    return new Promise((resolve, reject) => {
        const paramString = Object.entries(itnParams)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&');

        const options = {
            hostname: PAYFAST_HOST,
            path: '/eng/query/validate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(paramString),
                'version': 'v1.0.0',
                'merchant-id': MERCHANT_ID
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const result = data.trim();
                console.log(`[PayFast] ITN server validation response: ${result}`);
                resolve(result === 'VALID');
            });
        });

        req.on('error', reject);
        req.write(paramString);
        req.end();
    });
}

module.exports = {
    isConfigured,
    isSandbox,
    getCheckoutConfigError,
    buildPaymentData,
    getPaymentUrl,
    verifyItn,
    validateItnWithPayFast
};
