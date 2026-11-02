// Every page renders for the roles that should see it, with no uncaught JS errors
// and no API 5xx (both enforced by the fixtures).
const { test, expect } = require('../fixtures');
const { buildWorld } = require('../support/world');

test.describe('public pages', () => {
    test('legacy entry points redirect to their current pages', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveURL(/\/events\.html$/);
        await page.goto('/login.html?email=a%40b.c');
        await expect(page).toHaveURL(/\/register\.html\?email=a%40b\.c/);
        await page.goto('/interest.html?eventId=ABC');
        await expect(page).toHaveURL(/register\.html\?intent=interest&eventId=ABC/);
        await page.goto('/my-page.html');
        await expect(page).toHaveURL(/\/events\.html$/);
    });

    test('unknown paths fall back to the SPA entry, missing .html is a 404', async ({ page, request }) => {
        await page.goto('/some/deep/link');
        await expect(page).toHaveURL(/\/events\.html$/);
        expect((await request.get('/missing.html')).status()).toBe(404);
        expect((await request.get('/js/missing.js')).status()).toBe(404);
    });

    test('events page shows only open events to anonymous visitors', async ({ page, harness }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await page.goto('/events.html');
        await expect(page.locator('.event-card h3')).toHaveText(['ACDC 2027']);
        await expect(page.locator('#header-signin-btn')).toBeVisible();
    });

    test('register page renders the email step', async ({ page }) => {
        await page.goto('/register.html');
        await expect(page.locator('#checkEmail')).toBeVisible();
        await expect(page.locator('#email-check-btn')).toBeEnabled();
    });
});

test.describe('participant pages', () => {
    test('team leader sees their team on the event page', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.leader);
        await page.goto(`/event.html?id=${w.event.id}`);
        await expect(page.locator('#content')).toBeVisible();
        await expect(page.locator("#site-header h1")).toHaveText('ACDC 2027 - Power Rangers');
        const card = page.locator(`.team-card[data-team-id="${w.team.id}"]`);
        // No ORDER BY behind this list (random GUID keys), so compare as a set.
        await expect(card.locator('.participant-card .name')).toHaveCount(2);
        expect((await card.locator('.participant-card .name').allInnerTexts()).sort()).toEqual(['Lena Leader', 'Mats Member']);
    });
});

const ADMIN_PAGES = [
    ['admin-dashboard.html', '#stat-events'],
    ['admin-events.html', '#events-table-body'],
    ['admin-teams.html', '#total-teams'],
    ['admin-users.html', '#stats-row'],
    ['admin-person.html', '#search-email'],
    ['admin-badges.html', '#badges-container'],
    ['admin-interest.html', '#queue-table-body'],
    ['admin-email.html', '#editor-container .ql-editor'],
    ['admin-email-templates.html', '#body-editor .ql-editor'],
    ['admin-campaigns.html', '#sequences-list']
];

test.describe('admin pages render for a portal admin', () => {
    for (const [pagePath, marker] of ADMIN_PAGES) {
        test(pagePath, async ({ page, harness, loginAs }) => {
            const w = buildWorld();
            await harness.seed(w.seed());
            await loginAs(w.admin);
            await page.goto(`/${pagePath}`);
            await expect(page.locator(marker).first()).toBeVisible();
            await expect(page.locator('aside.sidebar')).toBeVisible();
        });
    }

    test('admin-event-participants.html', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        await harness.seed(w.seed());
        await loginAs(w.admin);
        await page.goto(`/admin-event-participants.html?id=${w.event.id}`);
        await expect(page.locator('#participant-count')).toContainText('participant');
    });
});

test.describe('fresh database', () => {
    test.use({ allowPageErrors: true });

    test('BUG: the email templates page works before any template config is saved', async ({ page, harness, loginAs }) => {
        const w = buildWorld();
        const { 'system-email-config': _omit, ...seed } = w.seed();
        await harness.seed(seed);
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await loginAs(w.admin);
        await page.goto('/admin-email-templates.html');
        await expect(page.locator('#body-editor .ql-editor')).toBeVisible();
        await page.locator('.template-option[data-template="welcome"]').click();
        await page.locator('#event-select').selectOption(w.event.id);
        await expect(page.locator('#field-header-title')).toBeVisible();
        expect(errors).toEqual([]);  // <- bug
    });
});
