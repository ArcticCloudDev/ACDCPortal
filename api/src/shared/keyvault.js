// Key Vault Secret Loader
// Loads secrets from Azure Key Vault into process.env at startup.
// Uses DefaultAzureCredential which works with:
//   - Local dev: your `az login` session
//   - Azure: Managed Identity (automatic, no credentials needed)

const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

// Map Key Vault secret names to environment variable names
// Key Vault doesn't allow underscores, so secrets use hyphens
const SECRET_MAP = {
    'JWT-SECRET': 'JWT_SECRET',
    'RECAPTCHA-SECRET-KEY': 'RECAPTCHA_SECRET_KEY',
    'MAIL-CLIENT-ID': 'MAIL_CLIENT_ID',
    'MAIL-CLIENT-SECRET': 'MAIL_CLIENT_SECRET',
    'MAIL-TENANT-ID': 'MAIL_TENANT_ID',
    'MAIL-SENDER': 'MAIL_SENDER',
    'PORTAL-URL': 'PORTAL_URL',
    'SHAREPOINT-SITE-URL': 'SHAREPOINT_SITE_URL',
    'SHAREPOINT-DOC-LIBRARY': 'SHAREPOINT_DOC_LIBRARY',
    'SQL-CONNECTION-STRING': 'SQL_CONNECTION_STRING',
    'SCHEDULER-SECRET': 'SCHEDULER_SECRET'
};

let _loaded = false;

async function loadSecrets() {
    if (_loaded && process.env.JWT_SECRET) return true;

    const kvUrl = process.env.KEY_VAULT_URL;
    if (!kvUrl) {
        // No Key Vault configured — fall back to env vars (e.g. local.settings.json)
        console.log('[KeyVault] KEY_VAULT_URL not set, using environment variables directly');
        _loaded = true;
        return true;
    }

    try {
        console.log('[KeyVault] Loading secrets from', kvUrl);
        const credential = new DefaultAzureCredential();
        const client = new SecretClient(kvUrl, credential);

        const results = await Promise.allSettled(
            Object.entries(SECRET_MAP).map(async ([kvName, envName]) => {
                // Don't overwrite if already set (allows local overrides)
                if (process.env[envName]) return { kvName, skipped: true };
                
                const secret = await client.getSecret(kvName);
                process.env[envName] = secret.value;
                return { kvName, loaded: true };
            })
        );

        const loaded = results.filter(r => r.status === 'fulfilled' && r.value?.loaded).length;
        const skipped = results.filter(r => r.status === 'fulfilled' && r.value?.skipped).length;
        const failed = results.filter(r => r.status === 'rejected');
        const jwtReady = !!process.env.JWT_SECRET;

        console.log(`[KeyVault] ${loaded} secrets loaded, ${skipped} skipped (already set)`);
        if (failed.length > 0) {
            failed.forEach(f => console.warn('[KeyVault] Failed to load:', f.reason?.message));
        }
        if (!jwtReady) {
            console.warn('[KeyVault] JWT_SECRET is still missing after load attempt; will retry next invocation');
        }

        _loaded = jwtReady && failed.length === 0;
        return jwtReady;
    } catch (err) {
        console.error('[KeyVault] Failed to connect:', err.message);
        console.error('[KeyVault] Will retry on next invocation');
        return false;
    }
}

module.exports = { loadSecrets };
