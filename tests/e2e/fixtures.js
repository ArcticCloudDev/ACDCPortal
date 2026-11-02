// Shared Playwright fixtures for the full-stack suite.
//  - resets the database + harness state before every test
//  - serves CDN assets (Quill, reCAPTCHA) locally and blocks every other external host
//  - fails a test on uncaught page errors or any API 5xx unless the test opts in
//  - accepts dialogs by default and records them (queue answers with `dialogs.next(...)`)
const path = require('node:path');
const fs = require('node:fs');
const base = require('@playwright/test');
const jwt = require('../../api/node_modules/jsonwebtoken');
const f = require('./support/factories');

const { expect } = base;
const ROOT = path.join(__dirname, '..', '..');
const JWT_SECRET = process.env.E2E_JWT_SECRET || 'e2e-local-jwt-secret-not-for-production-0123456789';
const SCHEDULER_SECRET = 'e2e-scheduler-secret';

const LOCAL_ASSETS = [
    [/cdn\.quilljs\.com\/1\.3\.\d\/quill\.min\.js/, 'node_modules/quill/dist/quill.min.js', 'text/javascript'],
    [/cdn\.quilljs\.com\/1\.3\.\d\/quill\.snow\.css/, 'node_modules/quill/dist/quill.snow.css', 'text/css'],
    [/unpkg\.com\/quill-image-resize-module@[\d.]+\/image-resize\.min\.js/, 'node_modules/quill-image-resize-module/image-resize.min.js', 'text/javascript'],
    [/unpkg\.com\/quill-image-drop-module@[\d.]+\/image-drop\.min\.js/, 'node_modules/quill-image-drop-module/image-drop.min.js', 'text/javascript']
];
const RECAPTCHA_STUB = 'window.grecaptcha={ready:function(f){f()},execute:function(){return Promise.resolve("e2e-captcha-token")}};';
const NO_MOTION_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';

function signToken(u, { expiresIn = '8h', secret = JWT_SECRET } = {}) {
    return jwt.sign(
        { email: u.email.toLowerCase(), userId: u.id ?? null, isPortalAdmin: !!u.isPortalAdmin },
        secret,
        { expiresIn, issuer: 'acdc-portal' }
    );
}

// Shape stored by src/js/register.js after verify-otp.
function sessionUser(u) {
    return {
        id: u.id,
        email: u.email.toLowerCase(),
        firstName: u.firstName,
        lastName: u.lastName,
        name: `${u.firstName} ${u.lastName}`,
        profileComplete: u.profileComplete !== false,
        isPortalAdmin: !!u.isPortalAdmin
    };
}

function extractOtp(html) {
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const match = text.match(/\b(\d{6})\b/);
    if (!match) throw new Error('No 6-digit code in email');
    return match[1];
}

function createHarness(request) {
    const call = async (method, url, data) => {
        const res = await request.fetch(url, { method, data });
        if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${await res.text()}`);
        return res.json();
    };
    const harness = {
        reset: () => call('POST', '/__test/reset'),
        seed: data => call('POST', '/__test/seed', data),
        outbox: to => call('GET', `/__test/outbox${to ? `?to=${encodeURIComponent(to)}` : ''}`),
        failNextMail: (count = 1) => call('POST', '/__test/mail/fail-next', { count }),
        invocations: () => call('GET', '/__test/invocations'),
        sharepoint: () => call('GET', '/__test/sharepoint/files'),
        async waitForMail(to, { subject, timeout = 7000 } = {}) {
            const deadline = Date.now() + timeout;
            for (;;) {
                const mails = await harness.outbox(to);
                const hit = mails.filter(m => !subject || (subject instanceof RegExp ? subject.test(m.subject) : m.subject.includes(subject))).pop();
                if (hit) return hit;
                if (Date.now() > deadline) {
                    throw new Error(`No mail to ${to}${subject ? ` matching ${subject}` : ''}; outbox: ${JSON.stringify(mails.map(m => m.subject))}`);
                }
                await new Promise(r => setTimeout(r, 150));
            }
        },
        async otpFor(email) {
            return extractOtp((await harness.waitForMail(email, { subject: 'Verification Code' })).html);
        }
    };
    return harness;
}

const test = base.test.extend({
    allowPageErrors: [false, { option: true }],
    allowServerErrors: [false, { option: true }],
    // CSP violations fail tests when E2E_CSP=enforce (the target state); otherwise they are only attached.
    allowCspViolations: [process.env.E2E_CSP !== 'enforce', { option: true }],

    harness: async ({ request }, use) => {
        await use(createHarness(request));
    },

    // Fresh database + outbox + rate limits for every test.
    _resetState: [async ({ harness }, use) => {
        await harness.reset();
        await use();
    }, { auto: true }],

    context: async ({ context }, use) => {
        const blocked = [];
        await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => {
            const url = route.request().url();
            if (/google\.com\/recaptcha\/api\.js/.test(url)) {
                return route.fulfill({ status: 200, contentType: 'text/javascript', body: RECAPTCHA_STUB });
            }
            for (const [pattern, file, contentType] of LOCAL_ASSETS) {
                if (pattern.test(url)) return route.fulfill({ status: 200, contentType, body: fs.readFileSync(path.join(ROOT, file)) });
            }
            blocked.push(url);
            return route.abort('blockedbyclient');
        });
        await context.addInitScript(css => {
            window.print = () => { window.__e2ePrinted = (window.__e2ePrinted || 0) + 1; };
            window.open = (url) => { (window.__e2eOpened = window.__e2eOpened || []).push(String(url)); return null; };
            document.addEventListener('DOMContentLoaded', () => {
                const style = document.createElement('style');
                style.textContent = css;
                document.head.appendChild(style);
            });
        }, NO_MOTION_CSS);
        // Content-Security-Policy violations (enforced or report-only) are reported back here.
        const cspViolations = [];
        await context.exposeBinding('__e2eReportCsp', (_source, v) => cspViolations.push(v));
        await context.addInitScript(() => {
            document.addEventListener('securitypolicyviolation', e => {
                window.__e2eReportCsp({
                    page: location.pathname,
                    directive: e.violatedDirective,
                    blocked: e.blockedURI,
                    source: `${e.sourceFile || ''}:${e.lineNumber || ''}`,
                    sample: e.sample
                });
            });
        });
        context.__blockedRequests = blocked;
        context.__cspViolations = cspViolations;
        await use(context);
    },

    dialogs: [async ({ page }, use) => {
        const seen = [];
        const answers = [];
        page.on('dialog', async dialog => {
            seen.push({ type: dialog.type(), message: dialog.message() });
            const answer = answers.length ? answers.shift() : 'accept';
            if (answer === 'dismiss') await dialog.dismiss();
            else await dialog.accept(typeof answer === 'object' ? answer.value : undefined);
        });
        await use({
            seen,
            messages: () => seen.map(d => d.message),
            next: (...queued) => answers.push(...queued),           // 'accept' | 'dismiss' | { value }
            last: () => seen[seen.length - 1]
        });
    }, { auto: true }],

    page: async ({ page, context, allowPageErrors, allowServerErrors, allowCspViolations }, use, testInfo) => {
        const pageErrors = [];
        const serverErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('response', response => {
            if (response.url().includes('/api/') && response.status() >= 500) {
                serverErrors.push(`${response.request().method()} ${new URL(response.url()).pathname} -> ${response.status()}`);
            }
        });
        await use(page);
        if (pageErrors.length) await testInfo.attach('page-errors', { body: pageErrors.join('\n'), contentType: 'text/plain' });
        if (serverErrors.length) await testInfo.attach('api-5xx', { body: serverErrors.join('\n'), contentType: 'text/plain' });
        const csp = context.__cspViolations || [];
        if (csp.length) await testInfo.attach('csp-violations', { body: JSON.stringify(csp, null, 2), contentType: 'application/json' });
        if (!allowPageErrors) expect(pageErrors, 'uncaught errors in the page').toEqual([]);
        if (!allowServerErrors) expect(serverErrors, 'API calls that returned 5xx').toEqual([]);
        if (!allowCspViolations) expect(csp, 'Content-Security-Policy violations').toEqual([]);
    },

    // Puts a signed session in localStorage exactly as a real OTP login would.
    loginAs: async ({ page }, use) => {
        await use(async (u) => {
            await page.goto('/__test/blank');
            await page.evaluate(([token, userJson]) => {
                localStorage.setItem('acdc_token', token);
                localStorage.setItem('acdc_user', JSON.stringify(userJson));
            }, [signToken(u), sessionUser(u)]);
        });
    },

    // API client acting as a given user (or anonymous with no argument).
    apiAs: async ({ playwright, baseURL }, use) => {
        const contexts = [];
        await use(async (u, extraHeaders = {}) => {
            const ctx = await playwright.request.newContext({
                baseURL,
                extraHTTPHeaders: { ...(u ? { 'x-acdc-token': signToken(u) } : {}), ...extraHeaders }
            });
            contexts.push(ctx);
            return ctx;
        });
        await Promise.all(contexts.map(c => c.dispose()));
    }
});

module.exports = { test, expect, f, signToken, sessionUser, extractOtp, JWT_SECRET, SCHEDULER_SECRET };
