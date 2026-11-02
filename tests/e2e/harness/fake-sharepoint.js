// In-memory stand-in for api/src/shared/sharepoint.js with the same method names,
// return shapes and error messages ("Graph API error (404): ...") callers rely on.
const crypto = require('node:crypto');

const files = new Map();   // path -> { id, name, content, createdDateTime, lastModifiedDateTime, fields }
const folders = new Set();
const columns = new Map(); // columnName -> choices[]
let downloadBase = 'http://127.0.0.1/__test/sharepoint/download';

const normalize = p => String(p || '').replace(/^\/+|\/+$/g, '');
const notFound = p => new Error(`Graph API error (404): {"error":{"code":"itemNotFound","message":"${p}"}}`);

function addFolderChain(folderPath) {
    const parts = normalize(folderPath).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
}

function describe(path, file) {
    return {
        id: file.id,
        name: file.name,
        size: file.content.length,
        webUrl: `https://e2e.sharepoint.local/${encodeURI(path)}`,
        createdDateTime: file.createdDateTime,
        lastModifiedDateTime: file.lastModifiedDateTime,
        downloadUrl: `${downloadBase}?path=${encodeURIComponent(path)}`
    };
}

const FakeSharePoint = {
    isConfigured() { return true; },

    async uploadFile(content, fileName, folderPath) {
        const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
        const fullPath = `${normalize(folderPath)}/${safeName}`;
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        // Same ceiling as shared/sharepoint.js (which uses an upload session above 4 MiB).
        if (buffer.length > 10 * 1024 * 1024) {
            throw new Error('File too large. Maximum size is 10MB.');
        }
        addFolderChain(folderPath);
        const now = new Date().toISOString();
        const existing = files.get(fullPath);
        const file = {
            id: existing?.id || crypto.randomUUID(),
            name: safeName,
            content: buffer,
            createdDateTime: existing?.createdDateTime || now,
            lastModifiedDateTime: now,
            fields: existing?.fields || {}
        };
        files.set(fullPath, file);
        const { downloadUrl, ...rest } = describe(fullPath, file);
        return rest;
    },

    async listFiles(folderPath) {
        const base = normalize(folderPath);
        if (base && !folders.has(base)) throw notFound(base);
        const prefix = base ? `${base}/` : '';
        const items = [];
        for (const [p, file] of files) {
            if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
                items.push({ ...describe(p, file), isFolder: false, createdBy: 'E2E Harness', category: file.fields.FileCategory || null });
            }
        }
        for (const f of folders) {
            if (f.startsWith(prefix) && f !== base && !f.slice(prefix.length).includes('/')) {
                items.push({ id: `folder:${f}`, name: f.slice(prefix.length), size: 0, isFolder: true, webUrl: null, createdDateTime: null, lastModifiedDateTime: null, createdBy: null, downloadUrl: undefined, category: null });
            }
        }
        return items;
    },

    async getFile(filePath) {
        const p = normalize(filePath);
        const file = files.get(p);
        if (!file) throw notFound(p);
        return describe(p, file);
    },

    async downloadFile(filePath) {
        const file = files.get(normalize(filePath));
        if (!file) throw new Error('Download failed (404)');
        return file.content;
    },

    async deleteFile(filePath) {
        const p = normalize(filePath);
        if (files.delete(p)) return true;
        if (folders.has(p)) {
            for (const key of [...files.keys()]) if (key.startsWith(`${p}/`)) files.delete(key);
            for (const f of [...folders]) if (f === p || f.startsWith(`${p}/`)) folders.delete(f);
            return true;
        }
        throw notFound(p);
    },

    async deleteFolder(folderPath) {
        try {
            return await this.deleteFile(folderPath);
        } catch (error) {
            if (error.message.includes('(404)')) return false;
            throw error;
        }
    },

    async createSharingLink(filePath, type = 'view', scope = 'organization') {
        const p = normalize(filePath);
        if (!files.has(p) && !folders.has(p)) throw notFound(p);
        return { webUrl: `https://e2e.sharepoint.local/share/${encodeURIComponent(p)}`, type, scope };
    },

    async ensureChoiceColumn(columnName, choices) {
        const merged = [...new Set([...(columns.get(columnName) || []), ...choices])];
        columns.set(columnName, merged);
        return { id: `col:${columnName}`, name: columnName, displayName: columnName, choice: { choices: merged } };
    },

    async setFileMetadata(itemId, fields) {
        for (const file of files.values()) {
            if (file.id === itemId) {
                Object.assign(file.fields, fields);
                return { ...file.fields };
            }
        }
        throw notFound(itemId);
    },

    // --- harness-only helpers ---
    setDownloadBase(url) { downloadBase = url; },
    reset() { files.clear(); folders.clear(); columns.clear(); },
    read(filePath) { return files.get(normalize(filePath)) || null; },
    dump() {
        return {
            folders: [...folders].sort(),
            files: [...files].map(([p, f]) => ({ path: p, id: f.id, size: f.content.length, fields: f.fields })),
            columns: Object.fromEntries(columns)
        };
    }
};

module.exports = FakeSharePoint;
