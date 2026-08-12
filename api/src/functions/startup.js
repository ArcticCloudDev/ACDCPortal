// App-level startup hook — loads Key Vault secrets before any function runs
const { app } = require('@azure/functions');
const { logError } = require('../shared/error-log');
const { loadSecrets } = require('../shared/keyvault');

let secretsLoaded = false;

app.hook.preInvocation(async () => {
    if (!secretsLoaded) {
        const ready = await loadSecrets();
        secretsLoaded = !!ready;
    }
});
