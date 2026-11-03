// Team file submissions (SharePoint, faked in-memory by the harness).
const { test, expect } = require('../fixtures');
const { buildWorld } = require('../support/world');

function fileWorld() {
    return buildWorld({
        event: {
            status: 'live',
            sharepointUrl: 'https://contoso.sharepoint.com/sites/acdc',
            fileCategories: ['Presentation', 'Video']
        }
    });
}

test('a team member uploads, sees and removes a file', async ({ page, harness, loginAs, dialogs }) => {
    const w = fileWorld();
    await harness.seed(w.seed());
    await loginAs(w.member);
    await page.goto(`/event.html?id=${w.event.id}`);

    await page.locator(`#file-cat-${w.team.id}`).selectOption('Presentation');
    await page.locator(`#file-${w.team.id}`).setInputFiles({
        name: 'pitch-deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e')
    });
    await expect(page.locator(`#upload-progress-${w.team.id}`)).toContainText('uploaded successfully');
    const row = page.locator('.uploaded-file-row', { hasText: 'pitch-deck.pdf' });
    await expect(row).toBeVisible();

    const sp = await harness.sharepoint();
    const stored = sp.files.find(file => file.path === `Events/${w.event.id}/${w.team.id}/pitch-deck.pdf`);
    expect(stored).toMatchObject({ size: 12, fields: { FileCategory: 'Presentation' } });

    await row.locator('.btn-remove').click();
    await expect.poll(() => dialogs.last()?.message).toBe('Are you sure you want to remove this file from SharePoint?');
    await expect(row).toHaveCount(0);
    expect((await harness.sharepoint()).files).toHaveLength(0);
});

test('files are scoped to team members', async ({ apiAs, harness }) => {
    const w = fileWorld();
    await harness.seed(w.seed());
    const q = `eventId=${w.event.id}&teamId=${w.team.id}`;
    const member = await apiAs(w.member);
    const up = await member.post(`/api/files/upload?${q}&category=Video`, {
        multipart: { file: { name: 'demo.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') } }
    });
    expect(up.status()).toBe(200);
    expect((await (await member.get(`/api/files/list?${q}`)).json()).map(x => x.name)).toEqual(['demo.mp4']);

    const outsider = await apiAs(w.loner);
    expect((await outsider.get(`/api/files/list?${q}`)).status()).toBe(403);
    expect((await outsider.delete(`/api/files/delete?path=Events/${w.event.id}/${w.team.id}/demo.mp4`)).status()).toBe(403);
});

test('files between 4 MB and the advertised 10 MB limit upload cleanly', async ({ apiAs, harness }) => {
    const w = fileWorld();
    await harness.seed(w.seed());
    const res = await (await apiAs(w.member)).post(`/api/files/upload?eventId=${w.event.id}&teamId=${w.team.id}`, {
        multipart: { file: { name: 'big.zip', mimeType: 'application/zip', buffer: Buffer.alloc(5 * 1024 * 1024, 1) } }
    });
    expect(res.status()).toBe(200);
});
