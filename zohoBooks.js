'use strict';

/**
 * Zoho Books integration scaffold.
 *
 * This module currently provides configuration checks only, so the app can
 * switch between Invoice Ninja and Zoho Books safely while full quote/invoice
 * sync is prepared.
 *
 * To activate this provider mode set:
 *   BILLING_PROVIDER=zoho_books
 *
 * Required environment variables for Zoho Books mode:
 *   ZOHO_BOOKS_ORG_ID       – your Zoho Books organization ID
 *   ZOHO_BOOKS_ACCESS_TOKEN – OAuth access token for Zoho Books API
 */

/**
 * Returns true when the minimum Zoho Books configuration is present.
 */
function isConfigured() {
    const ZOHO_BOOKS_ORG_ID = (process.env.ZOHO_BOOKS_ORG_ID || '').trim();
    const ZOHO_BOOKS_ACCESS_TOKEN = (process.env.ZOHO_BOOKS_ACCESS_TOKEN || '').trim();
    return !!(ZOHO_BOOKS_ORG_ID && ZOHO_BOOKS_ACCESS_TOKEN);
}

module.exports = {
    isConfigured
};
