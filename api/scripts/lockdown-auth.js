// One-time codemod: convert anonymous Azure Function HTTP triggers to require
// a valid JWT session (via requireAuth), except for a documented allowlist of
// endpoints that must remain public (login/registration/invite-accept flows).
//
// Usage: node api/scripts/lockdown-auth.js
const fs = require('fs');
const path = require('path');

const FUNCTIONS_DIR = path.join(__dirname, '..', 'src', 'functions');

// Files that are entirely public (auth/registration bootstrap flows).
// Left untouched.
const SKIP_FILES = new Set([
    'auth-check-email.js',
    'auth-send-otp.js',
    'auth-verify-otp.js',
    'register.js',
    'register-initiate.js',
    'register-verify.js',
    'startup.js'
]);

// Per-file allowlist of app.http() registration names that must stay
// anonymous (public pages / pre-login flows). Everything else with
// authLevel: 'anonymous' in that file gets a requireAuth() gate.
const PUBLIC_EXCEPTIONS = {
    'interest.js': new Set(['interest-register', 'interest-verify', 'interest-record']),
    'invitations.js': new Set(['invitations-get', 'invitations-accept']),
    'events.js': new Set(['events-list', 'events-active', 'events-get']),
    'badges.js': new Set(['badges-list', 'badges-get', 'event-badges-list', 'event-badge-summary'])
};

// Files/routes where admin (isPortalAdmin) should be required rather than
// just "any authenticated user".
const ADMIN_ONLY_FILES = new Set(['errors.js']);

// Routes handled specially (server-to-server, Azure Function key auth instead
// of a user JWT). authLevel becomes 'function', no requireAuth() call added.
const FUNCTION_KEY_ONLY = {
    'scheduled-emails.js': new Set(['scheduled-emails-run'])
};

const HEADER_RE = /app\.http\('([^']+)',\s*\{\r?\n(\s*)methods: (\[[^\]]*\]),\r?\n\s*authLevel: 'anonymous',\r?\n\s*route: '([^']*)',\r?\n\s*handler: async \(request, context\) => \{\r?\n(\s*)try \{\r?\n/g;

function processFile(filePath, fileName) {
    let text = fs.readFileSync(filePath, 'utf8');
    const publicSet = PUBLIC_EXCEPTIONS[fileName] || new Set();
    const functionKeySet = FUNCTION_KEY_ONLY[fileName] || new Set();
    const isAdminFile = ADMIN_ONLY_FILES.has(fileName);

    let changed = false;
    let needsImport = false;

    text = text.replace(HEADER_RE, (match, name, indent, methods, route, tryIndent) => {
        if (publicSet.has(name)) {
            return match; // leave untouched
        }

        if (functionKeySet.has(name)) {
            changed = true;
            return match.replace("authLevel: 'anonymous',", "authLevel: 'function',");
        }

        changed = true;
        needsImport = true;
        const authOptions = isAdminFile ? ', { requireAdmin: true }' : '';
        const guard = `${tryIndent}    const auth = requireAuth(request, context${authOptions});\r\n` +
                      `${tryIndent}    if (!auth.authorized) {\r\n` +
                      `${tryIndent}        return { status: auth.status, jsonBody: auth.jsonBody };\r\n` +
                      `${tryIndent}    }\r\n\r\n`;

        return match.replace("authLevel: 'anonymous',", "authLevel: 'function',") + guard;
    });

    if (!changed) return { fileName, changed: false };

    if (needsImport && !/require\(['"]\.\.\/shared\/auth['"]\)/.test(text)) {
        // Insert after the first require(...) line
        const lines = text.split('\r\n');
        let inserted = false;
        for (let i = 0; i < lines.length; i++) {
            if (!inserted && /^const .* = require\(/.test(lines[i])) {
                lines.splice(i + 1, 0, "const { requireAuth } = require('../shared/auth');");
                inserted = true;
                break;
            }
        }
        text = lines.join('\r\n');
    }

    fs.writeFileSync(filePath, text, 'utf8');
    return { fileName, changed: true };
}

function main() {
    const files = fs.readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.js'));
    const results = [];
    for (const fileName of files) {
        if (SKIP_FILES.has(fileName)) {
            results.push({ fileName, changed: false, skipped: true });
            continue;
        }
        const filePath = path.join(FUNCTIONS_DIR, fileName);
        results.push(processFile(filePath, fileName));
    }

    for (const r of results) {
        const status = r.skipped ? 'SKIPPED (public)' : (r.changed ? 'UPDATED' : 'no anonymous routes found');
        console.log(`${r.fileName.padEnd(30)} ${status}`);
    }
}

main();
