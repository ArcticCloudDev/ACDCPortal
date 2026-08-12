const { app } = require('@azure/functions');
const { requireToken } = require('./auth');

const PUBLIC_FUNCTIONS = new Set([
    'health',
    'auth-check-email',
    'auth-send-otp',
    'auth-verify-otp',
    'events-list'
]);

app.hook.preInvocation(async (context) => {
    // Only HTTP functions
    if (context.invocationContext.options.trigger.type !== 'httpTrigger') {
        return;
    }

    const functionName = context.invocationContext.functionName;

    console.log(`Pre-invocation hook for function: ${functionName}`);

    // Skip public functions
    if (PUBLIC_FUNCTIONS.has(functionName)) {
        return;
    }

    const request = context.inputs[0];
    const auth = requireToken(request);

    if (!auth.ok) {
        context.functionHandler = async () => auth.response;
        return;
    }

    // Make authenticated user available to the function
    request.auth = auth.user;
});