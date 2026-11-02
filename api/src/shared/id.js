const crypto = require('crypto');

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateId() {
    return crypto.randomUUID();
}

// True for a canonical GUID string. Check route/body IDs with this before they reach a
// UNIQUEIDENTIFIER parameter, otherwise SQL Server raises a conversion error (500).
function isGuid(value) {
    return typeof value === 'string' && GUID_PATTERN.test(value);
}

// SQL Server returns UNIQUEIDENTIFIER values upper-case while generateId() is lower-case,
// so ID equality must ignore case.
function sameId(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
}

module.exports = { generateId, isGuid, sameId };
