// Screenshots of every page, per role, at desktop and phone width, against the local
// harness (never production). Used for design reviews and before/after comparisons.
//
//   E2E_PORT=4285 E2E_SQL_DATABASE=acdc_e2e_shots node tests/e2e/harness/server.js   (terminal 1)
//   E2E_PORT=4285 node tests/e2e/support/capture-screens.js <outDir>                   (terminal 2)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const f = require('./factories');
const { buildWorld, mergeSeeds } = require('./world');
const { signToken, sessionUser } = require('../fixtures');

const BASE = `http://127.0.0.1:${process.env.E2E_PORT || 4285}`;
const OUT = path.resolve(process.argv[2] || 'tests/e2e/.artifacts/screens');
const VIEWPORTS = { desktop: { width: 1366, height: 900 }, phone: { width: 375, height: 812 } };
const ONLY = process.env.SHOTS ? new RegExp(process.env.SHOTS) : null;   // e.g. SHOTS='events|dashboard'
const SCHEME = process.env.SCHEME || 'light';                         // light | dark

async function post(route, body) {
    const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!res.ok) throw new Error(`${route} -> ${res.status} ${await res.text()}`);
}

function richWorld() {
    const w = buildWorld({ event: { name: 'ACDC 2027', status: 'registration', location: 'Lillehammer, Norway', costPerParticipant: 3500 } });
    const soon = f.event({ name: 'ACDC 2028', status: 'pre-registration', registrationOpen: false, location: 'Tromsø' });
    const judge = f.user({ firstName: 'Judy', lastName: 'Judge', email: 'judy.judge@e2e.test' });
    const extraTeams = ['Fjord Hackers', 'Northern Lights', 'Byte Vikings'].map(n => f.team(w.event, w.loner, { teamName: n, numberOfParticipants: 4, adminUserId: null }));
    const badges = [
        f.badge({ name: 'Early Bird', category: 'soft' }),
        f.badge({ name: 'Dataverse Wizard', category: 'low-code' }),
        f.badge({ name: 'Pro Coder', category: 'pro-code' }),
        f.badge({ name: 'Best in Show', category: 'sponsor', claimType: 'exclusive' })
    ];
    const newcomer = f.user({ profileComplete: false, firstName: '', lastName: '', phone: '', email: 'new.nora@e2e.test' });
    const invite = f.invitation(w.event, w.leader, { teamId: w.team.id, teamName: w.team.teamName, email: 'pending.pia@e2e.test', inviteeFirstName: 'Pia', inviteeLastName: 'Pending' });
    const seed = mergeSeeds(w.seed(), {
        events: [soon],
        teams: extraTeams,
        badges,
        'event-badges': badges.map(b => f.eventBadge(w.event, b)),
        invitations: [invite],
        users: [judge, newcomer],
        participations: [f.participation(judge, w.event, { roles: ['judge'] }), f.participation(w.loner, soon, { roles: ['interest'] })]
    });
    return { w, judge, newcomer, invite, seed };
}

async function login(page, user) {
    await page.goto(`${BASE}/__test/blank`);
    await page.evaluate(([t, u]) => { localStorage.setItem('acdc_token', t); localStorage.setItem('acdc_user', JSON.stringify(u)); },
        [signToken(user), sessionUser(user)]);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    await post('/__test/reset');
    const { w, judge, newcomer, invite, seed } = richWorld();
    await post('/__test/seed', seed);

    const shots = [
        ['anon', null, 'events', '/events.html'],
        ['anon', null, 'register', '/register.html'],
        ['anon', null, 'register-team', `/register.html?intent=team&eventId=${w.event.id}`],
        ['anon', null, 'accept-invitation', `/accept-invitation.html?invite=${invite.id}`],
        ['newcomer', newcomer, 'complete-registration', '/complete-registration.html'],
        ['leader', w.leader, 'events', '/events.html'],
        ['leader', w.leader, 'event-team', `/event.html?id=${w.event.id}`],
        ['leader', w.leader, 'event-badges', `/event.html?id=${w.event.id}#badges`],
        ['loner', w.loner, 'event-noteam', `/event.html?id=${w.event.id}`],
        ['judge', judge, 'event-judge', `/event.html?id=${w.event.id}`],
        ['admin', w.admin, 'admin-dashboard', '/admin-dashboard.html'],
        ['admin', w.admin, 'admin-events', '/admin-events.html'],
        ['admin', w.admin, 'admin-event-edit', `/admin-events.html?event=${w.event.id}`],
        ...['committee', 'judges', 'leads', 'sponsors', 'budget', 'teams', 'sequence'].map(tab =>
            ['admin', w.admin, `admin-event-edit-${tab}`, `/admin-events.html?event=${w.event.id}&tab=${tab}`]),
        ['admin', w.admin, 'admin-teams', '/admin-teams.html'],
        ['admin', w.admin, 'admin-users', '/admin-users.html'],
        ['admin', w.admin, 'admin-badges', '/admin-badges.html'],
        ['admin', w.admin, 'admin-email', '/admin-email.html'],
        ['admin', w.admin, 'admin-participants', `/admin-event-participants.html?id=${w.event.id}`],
        ['admin', w.admin, 'admin-interest', '/admin-interest.html'],
        ['admin', w.admin, 'admin-person', `/admin-person.html?email=${encodeURIComponent(w.leader.email)}`],
        ['admin', w.admin, 'admin-email-templates', '/admin-email-templates.html'],
        ['admin', w.admin, 'admin-campaigns', '/admin-campaigns.html']
    ];

    const browser = await chromium.launch();
    try {
        for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
            for (const [role, user, name, url] of shots) {
                if (ONLY && !ONLY.test(`${role}-${name}`)) continue;
                const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-GB', timezoneId: 'Europe/Oslo', colorScheme: SCHEME });
                await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort());
                const page = await context.newPage();
                if (user) await login(page, user);
                await page.goto(`${BASE}${url}`);
                await page.waitForLoadState('networkidle').catch(() => {});
                await page.waitForTimeout(400);
                const file = path.join(OUT, `${vpName}-${SCHEME === 'dark' ? 'dark-' : ''}${role}-${name}.png`);
                await page.screenshot({ path: file, fullPage: true });
                await context.close();
                process.stdout.write(`${path.basename(file)}\n`);
            }
        }
    } finally {
        await browser.close();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
