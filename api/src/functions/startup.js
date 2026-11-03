const { app } = require('@azure/functions');
const { loadSecrets } = require('../shared/keyvault');

let secretsLoaded = false;

app.hook.preInvocation(async () => {
    if (!secretsLoaded) {
        const ready = await loadSecrets();
        secretsLoaded = !!ready;
    }
});
