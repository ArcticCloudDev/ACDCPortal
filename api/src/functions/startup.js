// App-level startup hook — loads Key Vault secrets before any function runs
const { app } = require('@azure/functions');
const { loadSecrets } = require('../shared/keyvault');

let secretsLoaded = false;

app.hook.preInvocation(async () => {
    if (!secretsLoaded) {
        await loadSecrets();
        secretsLoaded = true;
    }
});
