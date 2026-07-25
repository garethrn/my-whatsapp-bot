/**
 * driveStorage.js – Pluggable file-storage abstraction.
 *
 * When the three Google Drive environment variables are set the module
 * uploads every file to Drive (inside a per-customer subfolder) and
 * returns Drive metadata (fileId, web-view link, download link).
 *
 * When the variables are absent every call falls back silently to local
 * disk storage inside the `./storage/` directory and returns only the
 * local filename so the rest of the code keeps working unchanged.
 *
 * Required env vars (all optional – omit to stay local):
 *   GOOGLE_DRIVE_CLIENT_EMAIL  – service-account e-mail address
 *   GOOGLE_DRIVE_PRIVATE_KEY   – PEM private key (newlines as \n or actual)
 *   GOOGLE_DRIVE_FOLDER_ID     – ID of the Drive folder to upload into
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');

// ── Drive initialisation ──────────────────────────────────────────────────────

const DRIVE_CLIENT_EMAIL = (process.env.GOOGLE_DRIVE_CLIENT_EMAIL || '').trim();
const DRIVE_PRIVATE_KEY  = (process.env.GOOGLE_DRIVE_PRIVATE_KEY  || '').replace(/\\n/g, '\n');
const DRIVE_FOLDER_ID    = (process.env.GOOGLE_DRIVE_FOLDER_ID    || '').trim();

const DRIVE_CONFIGURED = !!(DRIVE_CLIENT_EMAIL && DRIVE_PRIVATE_KEY && DRIVE_FOLDER_ID);

let driveClient = null;

if (DRIVE_CONFIGURED) {
    try {
        const { google } = require('googleapis');
        const auth = new google.auth.JWT({
            email: DRIVE_CLIENT_EMAIL,
            key:   DRIVE_PRIVATE_KEY,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });
        driveClient = google.drive({ version: 'v3', auth });
        console.log('✅ Google Drive storage initialised');
    } catch (e) {
        console.warn('⚠️  Google Drive: googleapis not available or auth error:', e.message);
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Cache of folder-name → Drive folder ID to avoid repeated list calls. */
const folderIdCache = new Map();

/**
 * Return the Drive ID of a named subfolder inside `parentId`, creating it if
 * it does not yet exist.
 */
async function getOrCreateFolder(name, parentId) {
    const cacheKey = `${parentId}::${name}`;
    if (folderIdCache.has(cacheKey)) return folderIdCache.get(cacheKey);

    const escaped = name.replace(/'/g, "\\'");
    const res = await driveClient.files.list({
        q: `name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive',
    });

    let id;
    if (res.data.files && res.data.files.length > 0) {
        id = res.data.files[0].id;
    } else {
        const created = await driveClient.files.create({
            requestBody: {
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
            },
            fields: 'id',
        });
        id = created.data.id;
    }

    folderIdCache.set(cacheKey, id);
    return id;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload a file buffer.
 *
 * @param {Buffer}  buffer     - File contents.
 * @param {string}  filename   - Desired filename (used on Drive / locally).
 * @param {string}  mimeType   - MIME type, e.g. 'image/jpeg'.
 * @param {string}  [folder]   - Optional subfolder name inside the root Drive
 *                               folder (e.g. a customer phone number).
 * @returns {Promise<{
 *   provider: 'googledrive'|'local',
 *   localFilename?: string,
 *   driveFileId?: string,
 *   driveWebViewLink?: string,
 *   driveDownloadLink?: string,
 *   uploadedAt: string,
 * }>}
 */
async function uploadFile(buffer, filename, mimeType, folder) {
    const uploadedAt = new Date().toISOString();

    if (driveClient) {
        try {
            let parentId = DRIVE_FOLDER_ID;
            if (folder) {
                parentId = await getOrCreateFolder(String(folder).slice(0, 100), DRIVE_FOLDER_ID);
            }

            const res = await driveClient.files.create({
                requestBody: {
                    name: filename,
                    parents: [parentId],
                },
                media: {
                    mimeType: mimeType || 'application/octet-stream',
                    body: Readable.from(buffer),
                },
                fields: 'id,webViewLink',
            });

            const fileId = res.data.id;

            // Make the file world-readable so the admin dashboard can provide a
            // direct download link without requiring Drive credentials in the browser.
            await driveClient.permissions.create({
                fileId,
                requestBody: { role: 'reader', type: 'anyone' },
            });

            return {
                provider: 'googledrive',
                driveFileId: fileId,
                driveWebViewLink: res.data.webViewLink,
                driveDownloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
                uploadedAt,
            };
        } catch (err) {
            console.error('⚠️  Drive upload failed, falling back to local storage:', err.message);
        }
    }

    // Local fallback – file is already written by the caller; just record the name.
    return { provider: 'local', localFilename: filename, uploadedAt };
}

/**
 * Stream a Drive file to an Express response object.
 * Used by the backend `/admin/api/files/:fileId/download` proxy route so that
 * admin browsers never need their own Drive credentials.
 *
 * @param {string}   fileId  - Google Drive file ID.
 * @param {object}   res     - Express response object.
 */
async function streamDriveFile(fileId, res) {
    if (!driveClient) throw new Error('Google Drive is not configured');

    const driveRes = await driveClient.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    // Forward content-type from Drive when available
    const ct = driveRes.headers && driveRes.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);

    driveRes.data.pipe(res);
}

/**
 * Fetch file metadata (name, mimeType, size) from Drive.
 *
 * @param {string} fileId
 * @returns {Promise<{name: string, mimeType: string, size: string}>}
 */
async function getFileMeta(fileId) {
    if (!driveClient) throw new Error('Google Drive is not configured');
    const res = await driveClient.files.get({
        fileId,
        fields: 'name,mimeType,size',
    });
    return res.data;
}

module.exports = {
    isDriveEnabled: () => DRIVE_CONFIGURED && !!driveClient,
    uploadFile,
    streamDriveFile,
    getFileMeta,
};
