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

// Global system-level settings (currency, locale). Loaded on page init via SystemConfig.load().
const SystemConfig = {
    currency: 'NOK',
    locale: 'nb-NO',
    _loaded: false,

    async load() {
        if (this._loaded) return;
        try {
            const data = await fetch('/api/system/config').then(r => r.ok ? r.json() : null);
            if (data) {
                this.currency = data.currency || 'NOK';
                this.locale = data.locale || 'nb-NO';
            }
        } catch (e) {
            // keep defaults on error
        }
        this._loaded = true;
    },

    formatAmount(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '\u2014';
        return n.toLocaleString(this.locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + '\u00a0' + this.currency;
    }
};

console.log('Config loaded - Custom OTP Authentication');
