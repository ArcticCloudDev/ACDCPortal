const CONFIG = {
    api: {
        baseUrl: '/api'
    },

    app: {
        name: 'ACDC Portal',
        version: '2.0.0'
    },

    auth: {
        tokenKey: 'acdc_token',
        userKey: 'acdc_user',
        otpLength: 6,
        otpExpiryMinutes: 10
    }
};

function currencyLocale(currency) {
    const map = {
        NOK: 'nb-NO',
        SEK: 'sv-SE',
        DKK: 'da-DK',
        EUR: 'de-DE',
        GBP: 'en-GB',
        USD: 'en-US',
    };
    return map[(currency || '').toUpperCase()] || 'en-US';
}

// A user-supplied URL may only be rendered into href/src when its scheme is http(s).
function safeHttpUrl(value) {
    if (typeof value !== 'string') return '';
    try {
        const url = new URL(value.trim());
        return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
    } catch {
        return '';
    }
}

