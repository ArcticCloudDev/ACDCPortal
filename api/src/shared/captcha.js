const { logError } = require('./error-log');

async function verifyCaptcha(token, context) {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    if (!secret) {
        const isLocal = process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Development'
            || (process.env.FUNCTIONS_WORKER_RUNTIME === 'node' && !process.env.WEBSITE_HOSTNAME);
        if (isLocal) {
            context.warn('RECAPTCHA_SECRET_KEY not configured - allowing in local dev');
            return true;
        }
        context.error('RECAPTCHA_SECRET_KEY not configured in production!');
        return false;
    }

    try {
        const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`
        });
        const data = await response.json();
        return data.success && (data.score === undefined || data.score >= 0.5);
    } catch (error) {
        await logError(context, error);
        context.error('reCAPTCHA verification error:', error);
        return false;
    }
}

module.exports = { verifyCaptcha };
