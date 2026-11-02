// E2E harness: runs the real Azure Functions handlers from api/src/functions behind a
// plain Node HTTP server, serves src/ the way Static Web Apps does, and swaps every
// cloud dependency for a local one:
//   Azure SQL        -> local SQL Server container (tests/e2e/harness/db.js)
//   Key Vault / MSI  -> blocked (throws)
//   Graph sendMail   -> in-memory outbox  (GET /__test/outbox)
//   SharePoint       -> in-memory fake    (tests/e2e/harness/fake-sharepoint.js)
//   Any other host   -> blocked (throws)
// Nothing in api/ or src/ is modified; this file only substitutes modules via require.cache.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..', '..');
const API_DIR = path.join(ROOT, 'api');
const FUNCTIONS_DIR = path.join(API_DIR, 'src', 'functions');
const SHARED_DIR = path.join(API_DIR, 'src', 'shared');
const STATIC_DIR = path.join(ROOT, 'src');
const PORT = Number(process.env.E2E_PORT || 4280);
const LOG_FILE = process.env.E2E_HARNESS_LOG || path.join(ROOT, 'tests', 'e2e', '.artifacts', 'harness.log');

// ---------------------------------------------------------------------------
// 1. Environment: start from a clean, local-only configuration.
// ---------------------------------------------------------------------------
for (const key of Object.keys(process.env)) {
    if (/^(KEY_VAULT_URL|AZURE_|MSI_|IDENTITY_|WEBSITE_|RECAPTCHA_|SHAREPOINT_|MAIL_)/.test(key)) {
        delete process.env[key];
    }
}
Object.assign(process.env, {
    FUNCTIONS_WORKER_RUNTIME: 'node',
    AZURE_FUNCTIONS_ENVIRONMENT: 'Development',
    JWT_SECRET: process.env.E2E_JWT_SECRET || 'e2e-local-jwt-secret-not-for-production-0123456789',
    PORTAL_URL: `http://127.0.0.1:${PORT}`,
    SCHEDULER_SECRET: 'e2e-scheduler-secret',
    MAIL_CLIENT_ID: 'e2e-fake-client',
    MAIL_CLIENT_SECRET: 'e2e-fake-secret',
    MAIL_TENANT_ID: 'e2e-fake-tenant',
    MAIL_SENDER: 'no-reply@e2e.test',
    SHAREPOINT_SITE_URL: 'e2e.sharepoint.local:/sites/E2E',
    SHAREPOINT_DOC_LIBRARY: 'Team Files'
});

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(level, ...args) {
    const line = args.map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : safeJson(a))).join(' ');
    logStream.write(`${new Date().toISOString()} [${level}] ${line}\n`);
}
function safeJson(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
}
// Function code logs heavily through console.*; keep the terminal readable.
console.log = (...a) => log('console', ...a);
console.info = (...a) => log('console', ...a);
console.warn = (...a) => log('warn', ...a);
console.error = (...a) => log('error', ...a);

// ---------------------------------------------------------------------------
// 2. Network: capture Graph sendMail, allow localhost, block everything else.
// ---------------------------------------------------------------------------
const outbox = [];
let mailFailuresRemaining = 0;
const realFetch = globalThis.fetch;

async function harnessFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();

    if (url.hostname === 'graph.microsoft.com' && method === 'POST' && /^\/v1\.0\/users\/[^/]+\/sendMail$/.test(url.pathname)) {
        if (mailFailuresRemaining > 0) {
            mailFailuresRemaining--;
            return new Response('{"error":{"code":"E2ESimulatedFailure"}}', { status: 503 });
        }
        const payload = JSON.parse(init.body);
        const message = payload.message;
        outbox.push({
            id: crypto.randomUUID(),
            sender: decodeURIComponent(url.pathname.split('/')[3]),
            to: message.toRecipients.map(r => r.emailAddress.address.toLowerCase()),
            subject: message.subject,
            html: message.body.content,
            attachments: (message.attachments || []).map(a => ({ name: a.name, contentId: a.contentId })),
            sentAt: new Date().toISOString()
        });
        return new Response(null, { status: 202 });
    }

    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return realFetch(input, init);
    }
    throw new Error(`E2E harness blocked outbound request to ${url.origin}`);
}
globalThis.fetch = harnessFetch;

// ---------------------------------------------------------------------------
// 3. Module substitution (same technique as tests/*.test.js).
// ---------------------------------------------------------------------------
function mockModule(request, exportsObject, fromDir = SHARED_DIR) {
    const resolved = require.resolve(request, { paths: [fromDir] });
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

const blocked = (what) => () => { throw new Error(`E2E harness blocked ${what}`); };
class BlockedCredential { getToken() { throw new Error('E2E harness blocked Azure credential use'); } }
mockModule('@azure/identity', { DefaultAzureCredential: BlockedCredential, ClientSecretCredential: BlockedCredential, ManagedIdentityCredential: BlockedCredential });
mockModule('@azure/keyvault-secrets', { SecretClient: class { getSecret() { throw new Error('E2E harness blocked Key Vault'); } } });
mockModule('@azure/msal-node', {
    ConfidentialClientApplication: class {
        async acquireTokenByClientCredential() { return { accessToken: 'e2e-fake-graph-token', expiresOn: new Date(Date.now() + 3600e3) }; }
    }
});
mockModule('node-fetch', Object.assign(harnessFetch, { default: harnessFetch }));

const db = require('./db');
mockModule(path.join(SHARED_DIR, 'sql.js'), { getPool: db.getPool, closePool: db.closePool, sql: db.sql });
mockModule(path.join(SHARED_DIR, 'keyvault.js'), { loadSecrets: async () => true });
const fakeSharePoint = require('./fake-sharepoint');
fakeSharePoint.setDownloadBase(`http://127.0.0.1:${PORT}/__test/sharepoint/download`);
mockModule(path.join(SHARED_DIR, 'sharepoint.js'), fakeSharePoint);

// @azure/functions: keep the real HttpRequest/HttpResponse/InvocationContext, capture registrations.
const realFunctions = require(require.resolve('@azure/functions', { paths: [FUNCTIONS_DIR] }));
const registrations = [];
const preInvocationHooks = [];
const fakeApp = {
    http: (name, options) => registrations.push({ name, ...options }),
    get: (name, o) => fakeApp.http(name, { ...o, methods: ['GET'] }),
    post: (name, o) => fakeApp.http(name, { ...o, methods: ['POST'] }),
    put: (name, o) => fakeApp.http(name, { ...o, methods: ['PUT'] }),
    patch: (name, o) => fakeApp.http(name, { ...o, methods: ['PATCH'] }),
    deleteRequest: (name, o) => fakeApp.http(name, { ...o, methods: ['DELETE'] }),
    timer: (name) => log('warn', `timer trigger '${name}' registered but not scheduled in E2E harness`),
    setup: () => {},
    hook: {
        preInvocation: (fn) => preInvocationHooks.push(fn),
        postInvocation: () => {},
        appStart: () => {},
        appTerminate: () => {}
    }
};
mockModule('@azure/functions', { ...realFunctions, app: fakeApp }, FUNCTIONS_DIR);

for (const file of fs.readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.js')).sort()) {
    require(path.join(FUNCTIONS_DIR, file));
}

const Storage = require(path.join(SHARED_DIR, 'storage.js'));
const otpModule = require(path.join(FUNCTIONS_DIR, 'auth-send-otp.js'));

// ---------------------------------------------------------------------------
// 4. Routing with Functions host semantics: literal segments outrank parameters.
// ---------------------------------------------------------------------------
function compileRoute(template) {
    const segments = template.split('/').filter(Boolean).map(seg => {
        const m = /^\{(\*?)([A-Za-z_][\w]*)(?::[^}?]+)?(\?)?\}$/.exec(seg);
        return m ? { param: m[2], optional: !!m[3], catchAll: !!m[1] } : { literal: seg.toLowerCase() };
    });
    return segments;
}

const routes = registrations.map(r => ({
    ...r,
    methods: (r.methods || ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).map(m => m.toUpperCase()),
    segments: compileRoute(r.route || r.name)
}));

function matchRoute(segments, parts) {
    const params = {};
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const part = parts[i];
        if (seg.catchAll) {
            params[seg.param] = parts.slice(i).join('/');
            return params;
        }
        if (part === undefined) {
            if (seg.optional) continue;
            return null;
        }
        if (seg.literal !== undefined) {
            if (seg.literal !== part.toLowerCase()) return null;
        } else {
            params[seg.param] = decodeURIComponent(part);
        }
    }
    return parts.length <= segments.length ? params : null;
}

function specificity(route) {
    return route.segments.map(s => (s.literal !== undefined ? '0' : s.catchAll ? '2' : '1')).join('');
}

function findRoute(method, apiPath) {
    const parts = apiPath.split('/').filter(Boolean);
    const candidates = [];
    for (const route of routes) {
        if (!route.methods.includes(method)) continue;
        const params = matchRoute(route.segments, parts);
        if (params) candidates.push({ route, params });
    }
    candidates.sort((a, b) => specificity(a.route).localeCompare(specificity(b.route)));
    return candidates[0] || null;
}

// ---------------------------------------------------------------------------
// 5. Static files, mirroring staticwebapp.config.json.
// ---------------------------------------------------------------------------
// SWA only reads the config from app_location (src/), and never serves it as a file.
const SWA_CONFIG_FILE = path.join(STATIC_DIR, 'staticwebapp.config.json');
const swaConfig = JSON.parse(fs.readFileSync(SWA_CONFIG_FILE, 'utf8'));
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff'
};

function globToRegex(glob) {
    return new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
const fallbackExcludes = (swaConfig.navigationFallback?.exclude || []).map(globToRegex);

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let filePath = path.normalize(path.join(STATIC_DIR, rel));
    if (!filePath.startsWith(STATIC_DIR)) return send(res, 403, 'Forbidden');
    if (filePath === SWA_CONFIG_FILE) return send(res, 404, 'Not Found');

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        const excluded = fallbackExcludes.some(rx => rx.test(rel));
        if (excluded || !swaConfig.navigationFallback) return send(res, 404, 'Not Found');
        filePath = path.join(STATIC_DIR, swaConfig.navigationFallback.rewrite);
    }

    const headers = { ...(swaConfig.globalHeaders || {}) };
    // E2E_CSP=enforce turns the report-only policy into an enforcing one, to prove pages comply.
    if (process.env.E2E_CSP === 'enforce' && headers['Content-Security-Policy-Report-Only']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy-Report-Only'];
        delete headers['Content-Security-Policy-Report-Only'];
    }
    headers['Content-Type'] = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
}

function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
}

// ---------------------------------------------------------------------------
// 6. API dispatch through the real Functions request/response types.
// ---------------------------------------------------------------------------
let invocationCounter = 0;
const invocationLog = [];

async function handleApi(req, res, url, body) {
    const apiPath = url.pathname.replace(/^\/api\/?/, '');
    const method = req.method.toUpperCase();
    const match = findRoute(method, apiPath);
    if (!match) return send(res, 404, '');

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;

    const request = new realFunctions.HttpRequest({
        method,
        url: url.href,
        headers,
        params: match.params,
        body: body.length > 0 ? { bytes: body } : undefined
    });
    const invocationId = `e2e-${++invocationCounter}`;
    const context = new realFunctions.InvocationContext({
        invocationId,
        functionName: match.route.name,
        logHandler: (level, ...args) => log(level, `[${match.route.name}]`, ...args)
    });

    const started = Date.now();
    let response;
    try {
        for (const hook of preInvocationHooks) await hook({ invocationContext: context, inputs: [request] });
        const result = await match.route.handler(request, context);
        response = result instanceof realFunctions.HttpResponse ? result : new realFunctions.HttpResponse(result || {});
    } catch (error) {
        log('error', `[${match.route.name}] unhandled exception`, error);
        response = new realFunctions.HttpResponse({ status: 500 });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    res.end(buffer);

    invocationLog.push({ name: match.route.name, method, path: url.pathname, status: response.status, ms: Date.now() - started });
    if (invocationLog.length > 5000) invocationLog.shift();
    log('info', `${method} ${url.pathname}${url.search} -> ${response.status} (${match.route.name}, ${Date.now() - started}ms)`);
}

// ---------------------------------------------------------------------------
// 7. Test-only control surface. Exists only in this harness, never in api/.
// ---------------------------------------------------------------------------
const SEED_ORDER = [
    'sequences', 'events', 'users', 'teams', 'allowedEmails', 'badges', 'event-badges', 'participations',
    'invitations', 'interest-leads', 'interest-queue', 'solo-queue', 'badge-claims', 'email-campaigns',
    'email-deliveries', 'event-sponsors', 'event-financials', 'system-email-config'
];
const RAW_TABLES = { 'event-sponsors': 'EventSponsors', 'event-financials': 'EventFinancials' };

async function insertRaw(table, item) {
    const pool = await db.getPool();
    const request = pool.request();
    const cols = [];
    Object.entries(item).filter(([, v]) => v !== undefined).forEach(([k, v], i) => {
        if (v === null) request.input(`p${i}`, db.sql.NVarChar, null);
        else request.input(`p${i}`, v);
        cols.push([`[${k.charAt(0).toUpperCase()}${k.slice(1)}]`, `@p${i}`]);
    });
    await request.query(`INSERT INTO [${table}] (${cols.map(c => c[0]).join(', ')}) VALUES (${cols.map(c => c[1]).join(', ')})`);
}

async function seed(data) {
    for (const key of SEED_ORDER) {
        for (const item of data[key] || []) {
            if (key === 'allowedEmails') await Storage.allowedEmails.add(item);
            else if (key === 'users') await Storage.users.create(item);
            else if (key === 'teams') await Storage.teams.create(item);
            else if (key === 'system-email-config') await new Storage.Storage(key).saveRaw(item);
            else if (RAW_TABLES[key]) await insertRaw(RAW_TABLES[key], item);
            else await new Storage.Storage(key).create(item);
        }
    }
    const unknown = Object.keys(data).filter(k => !SEED_ORDER.includes(k));
    if (unknown.length) throw new Error(`Unknown seed collections: ${unknown.join(', ')}`);
}

function resetInMemoryState() {
    outbox.length = 0;
    mailFailuresRemaining = 0;
    invocationLog.length = 0;
    otpModule.rateLimits.byEmail.clear();
    otpModule.rateLimits.byIp.clear();
    fakeSharePoint.reset();
}

async function handleTestControl(req, res, url, body) {
    const route = `${req.method} ${url.pathname}`;
    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    switch (route) {
        case 'GET /__test/health':
            return send(res, 200, { ok: true, endpoints: routes.length });
        case 'GET /__test/blank':
            return send(res, 200, '<!DOCTYPE html><title>blank</title>', { 'Content-Type': 'text/html; charset=utf-8' });
        case 'POST /__test/reset':
            await db.truncateAll();
            resetInMemoryState();
            return send(res, 200, { ok: true });
        case 'POST /__test/seed':
            await seed(json);
            return send(res, 200, { ok: true });
        case 'GET /__test/outbox': {
            const to = url.searchParams.get('to');
            return send(res, 200, to ? outbox.filter(m => m.to.includes(to.toLowerCase())) : outbox);
        }
        case 'POST /__test/mail/fail-next':
            mailFailuresRemaining = Number(json.count || 1);
            return send(res, 200, { ok: true });
        case 'GET /__test/invocations':
            return send(res, 200, invocationLog);
        case 'GET /__test/routes':
            return send(res, 200, routes.map(r => ({ name: r.name, methods: r.methods, route: r.route })));
        case 'GET /__test/sharepoint/files':
            return send(res, 200, fakeSharePoint.dump());
        case 'GET /__test/sharepoint/download': {
            const file = fakeSharePoint.read(url.searchParams.get('path'));
            return file ? send(res, 200, file.content, { 'Content-Type': 'application/octet-stream' }) : send(res, 404, 'Not Found');
        }
        default:
            return send(res, 404, { message: `Unknown test control route ${route}` });
    }
}

// ---------------------------------------------------------------------------
// 8. Server
// ---------------------------------------------------------------------------
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
        const body = await readBody(req);
        if (url.pathname.startsWith('/__test/')) return await handleTestControl(req, res, url, body);
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url, body);
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
        return serveStatic(req, res, url.pathname);
    } catch (error) {
        log('error', 'harness failure', error);
        if (!res.headersSent) send(res, 500, { message: `harness error: ${error.message}` });
        else res.end();
    }
});

(async () => {
    await db.ensureDatabase();
    server.listen(PORT, '127.0.0.1', () => {
        process.stdout.write(`[e2e-harness] ${routes.length} endpoints on http://127.0.0.1:${PORT} (log: ${LOG_FILE})\n`);
    });
})().catch(error => {
    process.stderr.write(`[e2e-harness] failed to start: ${error.stack}\n`);
    process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
