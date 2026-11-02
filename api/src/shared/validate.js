// Small input validators shared by the admin/event handlers. Everything here is
// pure and synchronous; handlers turn a `false` into a 400.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// True for an absolute http(s) URL (or https-only with { httpsOnly: true }).
function isHttpUrl(value, { httpsOnly = false } = {}) {
    if (typeof value !== 'string' || value.length > 2000) return false;
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        return false;
    }
    if (url.protocol === 'https:') return true;
    return !httpsOnly && url.protocol === 'http:';
}

function isEmail(value) {
    return typeof value === 'string' && value.length <= 320 && EMAIL_PATTERN.test(value.trim());
}

// 'YYYY-MM-DD' that round-trips through Date (rejects 2027-02-31).
function isIsoDate(value) {
    if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Integer in [min, max]; accepts numeric strings ("3") because forms send strings.
function toInt(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null;
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

function toNumber(value, { min = -Infinity, max = Infinity } = {}) {
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null;
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return null;
    return n;
}

// SQL Server returns UNIQUEIDENTIFIER upper-case and shared/auth.js compares with ===,
// so IDs that take part in those comparisons are normalised to upper-case first.
function upperId(value) {
    return typeof value === 'string' ? value.toUpperCase() : value;
}

module.exports = { isHttpUrl, isEmail, isIsoDate, toInt, toNumber, upperId };
