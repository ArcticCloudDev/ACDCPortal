const { buildWorld } = require('./world');

const BASE_URL = 'http://127.0.0.1:4280';

async function request(path, options) {
    const response = await fetch(`${BASE_URL}${path}`, {
        ...options,
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
        throw new Error(`${options?.method || 'GET'} ${path} failed (${response.status}): ${await response.text()}`);
    }
    return response;
}

function extractOtp(html) {
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const match = text.match(/\b(\d{6})\b/);
    if (!match) throw new Error('Local verification email did not contain a six-digit code');
    return match[1];
}

async function main() {
    const health = await (await request('/__test/health')).json();
    if (!health.ok) throw new Error('The local E2E harness is not healthy');

    const world = buildWorld();
    const suffix = Date.now();
    const users = [world.admin, world.leader, world.member, world.loner];
    users.forEach((user, index) => {
        user.email = `local-demo-${suffix}-${index}@e2e.test`;
    });
    for (const participation of Object.values(world.participations)) {
        participation.email = users.find(user => user.id === participation.userId)?.email;
    }

    await request('/__test/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(world.seed())
    });
    await request('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: world.admin.email })
    });

    const messages = await (await request(`/__test/outbox?to=${encodeURIComponent(world.admin.email)}`)).json();
    const mail = messages.at(-1);
    if (!mail) throw new Error('No local verification email was captured');

    console.log(`Demo event and admin seeded. Sign in at http://127.0.0.1:4280/register.html`);
    console.log(`Admin email: ${world.admin.email}`);
    console.log(`One-time code: ${extractOtp(mail.html)}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
