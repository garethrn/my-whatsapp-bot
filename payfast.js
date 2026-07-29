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
const SANDBOX = SANDBOX_FLAG;

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

    if (!SANDBOX && hasSandboxCredentials) {
        return 'Sandbox test credentials detected in live mode. Set PAYFAST_SANDBOX=true or switch to live merchant credentials.';
    }

    if (SANDBOX && !hasSandboxCredentials) {
        // Live credentials used in sandbox mode — PayFast will likely reject the payment
        // with "no payment methods available". Use the standard sandbox test credentials:
        //   PAYFAST_MERCHANT_ID=10004002  PAYFAST_MERCHANT_KEY=q1cd2rdny4a53
        // OR register at sandbox.payfast.co.za and use those sandbox-specific credentials.
        console.warn('[PayFast] WARNING: PAYFAST_SANDBOX=true but credentials do not match the standard sandbox test credentials (10004002/q1cd2rdny4a53). If you are using your own sandbox account credentials from sandbox.payfast.co.za, this is fine. Otherwise set PAYFAST_MERCHANT_ID=10004002 and PAYFAST_MERCHANT_KEY=q1cd2rdny4a53 for sandbox testing.');
    }

    return '';
}

/**
 * Encode a value using PHP-compatible URL encoding (spaces become +).
 * PHP's urlencode() encodes all characters except A-Z a-z 0-9 _ - .
 * JavaScript's encodeURIComponent() additionally leaves ! ~ * ' ( ) unencoded,
 * so we must percent-encode those manually to match PHP's output exactly.
 *
 * The `trim` option (default true) mirrors the behaviour of trimming user-supplied
 * form values before submission. Set trim=false for ITN verification so that values
 * received from PayFast are encoded exactly as-is (PHP's urlencode does not trim).
 * @param {string} value
 * @param {boolean} [trim=true]
 * @returns {string}
 */
function phpUrlencode(value, trim = true) {
    const str = trim ? String(value).trim() : String(value);
    return encodeURIComponent(str)
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

    // PayFast mandates MD5 for request signing — this is NOT a password hash.
    // See: https://developers.payfast.co.za/docs#checkout_page_submission
    return crypto.createHash('md5').update(paramString).digest('hex'); // lgtm[js/insufficient-password-hash]
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
 * Compute a PayFast MD5 signature for ITN verification.
 * Unlike buildPaymentData, PayFast includes ALL fields (even empty strings) in the
 * ITN signature — empty values must NOT be filtered out or the hash won't match.
 * @param {object} data - Key-value pairs in received order (signature already removed)
 * @returns {string} MD5 hex digest
 */
function computeItnSignature(data) {
    const parts = Object.entries(data)
        .filter(([, v]) => v !== null && v !== undefined)
        // trim=false: ITN values come from PayFast and must be encoded exactly as received.
        // PHP's urlencode() does not trim whitespace, so neither should we.
        .map(([k, v]) => `${k}=${phpUrlencode(v, false)}`);

    let paramString = parts.join('&');
    if (PASSPHRASE) {
        paramString += `&passphrase=${phpUrlencode(PASSPHRASE)}`;
    }

    // PayFast mandates MD5 for request signing — this is NOT a password hash.
    // See: https://developers.payfast.co.za/docs#checkout_page_submission
    return crypto.createHash('md5').update(paramString).digest('hex'); // lgtm[js/insufficient-password-hash]
}

/**
 * Verify the signature of a PayFast ITN (Instant Transaction Notification).
 * Uses a constant-time comparison to prevent timing attacks.
 * @param {object} itnParams - Parsed POST body received from PayFast
 * @returns {{ valid: boolean, status: string, orderId: string, amount: number }}
 */
function verifyItn(itnParams) {
    const { signature, ...rest } = itnParams;
    const expectedSig = computeItnSignature(rest);

    // Use timing-safe comparison to prevent attackers from inferring the correct
    // signature byte-by-byte through response timing differences.
    let valid = false;
    try {
        const receivedBuf = Buffer.from(String(signature || ''), 'utf8');
        const expectedBuf = Buffer.from(expectedSig, 'utf8');
        // timingSafeEqual requires equal-length buffers; MD5 hex is always 32 chars.
        valid = receivedBuf.length === expectedBuf.length &&
                crypto.timingSafeEqual(receivedBuf, expectedBuf);
    } catch {
        valid = false;
    }

    return {
        valid,
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
        // Use phpUrlencode with trim=false (spaces → +) to match the application/x-www-form-urlencoded
        // encoding that PayFast expects — values must be encoded exactly as received, without trimming.
        const paramString = Object.entries(itnParams)
            .map(([k, v]) => `${k}=${phpUrlencode(String(v), false)}`)
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
