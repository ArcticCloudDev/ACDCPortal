// ACDC Portal - Configuration
// Custom OTP authentication (no external auth provider)

const CONFIG = {
    // API Configuration
    api: {
        baseUrl: '/api'
    },
    
    // App settings
    app: {
        name: 'ACDC Portal',
        version: '2.0.0'
    },

    // Auth settings
    auth: {
        tokenKey: 'acdc_token',       // localStorage key for JWT
        userKey: 'acdc_user',         // localStorage key for user data
        otpLength: 6,
        otpExpiryMinutes: 10
    }
};

// Maps a currency code to the best number-formatting locale for it.
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

console.log('Config loaded - Custom OTP Authentication');
