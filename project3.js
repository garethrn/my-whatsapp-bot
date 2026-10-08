'use strict';
const PROJECT3_BASE_URL = String(process.env.PROJECT3_BASE_URL || '').trim();
const PROJECT3_API_KEY = String(process.env.PROJECT3_API_KEY || '').trim();

function isConfigured() {
  return Boolean(PROJECT3_BASE_URL && PROJECT3_API_KEY);
}

module.exports = { isConfigured };
