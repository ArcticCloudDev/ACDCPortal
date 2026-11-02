// Small request-body validator. Collects human-readable problems; handlers return
// `v.failure()` (a 400 response) when `v.failed` is set. Never echoes the offending value.
const { isGuid } = require('./id');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(value) {
    return typeof value === 'string' && value.trim().length <= 320 && EMAIL_PATTERN.test(value.trim());
}

function normalizeEmail(value) {
    return String(value).trim().toLowerCase();
}

// http(s) only: anything else (javascript:, data:, file:...) is rejected.
function isHttpUrl(value) {
    if (typeof value !== 'string' || value.length > 2000) return false;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

class Validator {
    constructor() {
        this.errors = [];
    }

    get failed() {
        return this.errors.length > 0;
    }

    failure() {
        return { status: 400, jsonBody: { error: this.errors[0], message: this.errors[0], errors: this.errors } };
    }

    // Trimmed string, or undefined when absent (null/'' count as "clear" and return null
    // unless required). `min` applies only when a value is present.
    string(value, name, { max = 200, min = 0, required = false } = {}) {
        if (value === undefined || value === null || value === '') {
            if (required) this.errors.push(`${name} is required`);
            return value === undefined ? undefined : null;
        }
        if (typeof value !== 'string') {
            this.errors.push(`${name} must be text`);
            return undefined;
        }
        const trimmed = value.trim();
        if (trimmed.length < min) {
            this.errors.push(min === 1 ? `${name} is required` : `${name} must be at least ${min} characters`);
            return undefined;
        }
        if (trimmed.length > max) {
            this.errors.push(`${name} must be at most ${max} characters`);
            return undefined;
        }
        return trimmed;
    }

    email(value, name = 'email', { required = true } = {}) {
        if (value === undefined || value === null || value === '') {
            if (required) this.errors.push(`${name} is required`);
            return undefined;
        }
        if (!isEmail(value)) {
            this.errors.push(`${name} must be a valid email address`);
            return undefined;
        }
        return normalizeEmail(value);
    }

    guid(value, name, { required = false } = {}) {
        if (value === undefined || value === null || value === '') {
            if (required) this.errors.push(`${name} is required`);
            return undefined;
        }
        if (!isGuid(value)) {
            this.errors.push(`${name} is not a valid id`);
            return undefined;
        }
        return value;
    }

    integer(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
        if (value === undefined || value === null || value === '') {
            if (required) this.errors.push(`${name} is required`);
            return undefined;
        }
        const n = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN);
        if (!Number.isInteger(n)) {
            this.errors.push(`${name} must be a whole number`);
            return undefined;
        }
        if (n < min || n > max) {
            this.errors.push(`${name} must be between ${min} and ${max}`);
            return undefined;
        }
        return n;
    }

    boolean(value, name) {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 1 || value === '1') return true;
        if (value === 'false' || value === 0 || value === '0') return false;
        this.errors.push(`${name} must be true or false`);
        return undefined;
    }

    oneOf(value, name, allowed, { required = false } = {}) {
        if (value === undefined || value === null || value === '') {
            if (required) this.errors.push(`${name} is required`);
            return undefined;
        }
        if (!allowed.includes(value)) {
            this.errors.push(`${name} must be one of: ${allowed.join(', ')}`);
            return undefined;
        }
        return value;
    }

    httpUrl(value, name, { required = false } = {}) {
        if (value === undefined || value === null || value === '') {
            if (required) this.errors.push(`${name} is required`);
            return value === undefined ? undefined : null;
        }
        if (!isHttpUrl(value)) {
            this.errors.push(`${name} must be an http(s) URL`);
            return undefined;
        }
        return String(value).trim();
    }
}

// Parses the JSON body; resolves to null when the body is missing or not JSON.
async function readJson(request) {
    try {
        const body = await request.json();
        return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
        return null;
    }
}

const INVALID_JSON = { status: 400, jsonBody: { error: 'A JSON object body is required', message: 'A JSON object body is required' } };

module.exports = { Validator, isEmail, normalizeEmail, isHttpUrl, readJson, INVALID_JSON };
