// Full-stack E2E: real src/ frontend + real api/ handlers, on a local SQL Server container.
// See tests/e2e/README.md. Nothing here can reach Azure; the harness blocks it.
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4281);

module.exports = defineConfig({
    testDir: 'tests/e2e/specs',
    outputDir: 'tests/e2e/.artifacts/results',
    // One shared database: tests reset it, so they run serially.
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 45_000,
    expect: { timeout: 7_000 },
    reporter: [
        ['list'],
        ['html', { outputFolder: 'tests/e2e/.artifacts/report', open: 'never' }],
        ['json', { outputFile: 'tests/e2e/.artifacts/results.json' }]
    ],
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        locale: 'en-GB',
        timezoneId: 'Europe/Oslo'
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: 'node tests/e2e/harness/server.js',
        url: `http://127.0.0.1:${PORT}/__test/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: { E2E_PORT: String(PORT) }
    }
});
