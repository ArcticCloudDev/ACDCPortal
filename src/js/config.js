// ACDC Portal - Configuration
// Uses Entra External ID with Email OTP (no password)

const CONFIG = {
    // Entra External ID Configuration
    auth: {
        clientId: 'c14c3e9e-a80f-4c83-ab48-52673788cf8f',
        tenantId: '6faefb57-2c64-4298-a1c2-28d08a434986',
        tenantName: 'acdcregistration',
        // For External ID tenants, use ciamlogin.com
        authority: 'https://acdcregistration.ciamlogin.com/',
        redirectUri: window.location.origin,
        scopes: ['openid', 'profile', 'email']
    },
    
    // API Configuration
    api: {
        baseUrl: '/api'
    },
    
    // App settings
    app: {
        name: 'ACDC Portal',
        version: '1.0.0'
    }
};

// MSAL Configuration for Entra External ID
const msalConfig = {
    auth: {
        clientId: CONFIG.auth.clientId,
        authority: CONFIG.auth.authority,
        redirectUri: CONFIG.auth.redirectUri,
        knownAuthorities: [CONFIG.auth.authority]
    },
    cache: {
        cacheLocation: 'sessionStorage',
        storeAuthStateInCookie: false
    }
};

// Login request - will use Email OTP as configured in Entra
const loginRequest = {
    scopes: CONFIG.auth.scopes
};

console.log('Config loaded - Entra External ID with Email OTP');
