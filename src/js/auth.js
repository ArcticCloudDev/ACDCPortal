// ACDC Portal - Auth Module (MSAL for Entra External ID with Email OTP)

let msalInstance = null;

const Auth = {
    // Initialize MSAL
    init() {
        if (typeof msal === 'undefined') {
            console.warn('MSAL library not loaded');
            return;
        }
        msalInstance = new msal.PublicClientApplication(msalConfig);
        console.log('MSAL initialized for Email OTP');
    },

    // Check if user is logged in
    isLoggedIn() {
        if (!msalInstance) return false;
        const accounts = msalInstance.getAllAccounts();
        return accounts.length > 0;
    },

    // Get current user
    getUser() {
        if (!msalInstance) return null;
        const accounts = msalInstance.getAllAccounts();
        if (accounts.length === 0) return null;
        
        const account = accounts[0];
        return {
            email: account.username,
            name: account.name || account.username
        };
    },

    // Login with redirect (Entra will show Email OTP screen)
    async login(loginHint) {
        if (!msalInstance) {
            throw new Error('MSAL not initialized');
        }

        const request = {
            ...loginRequest,
            loginHint: loginHint // Pre-fill email
        };

        try {
            await msalInstance.loginRedirect(request);
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    },

    // Sign up with redirect - for new user registration
    // Goes directly to sign-up flow using Entra External ID's prompt parameter
    async signUp(loginHint) {
        if (!msalInstance) {
            throw new Error('MSAL not initialized');
        }

        const request = {
            ...loginRequest,
            loginHint: loginHint,
            prompt: 'create'  // Standard OIDC parameter for sign-up
        };

        try {
            await msalInstance.loginRedirect(request);
        } catch (error) {
            console.error('Sign-up error:', error);
            throw error;
        }
    },

    // Handle redirect after login
    async handleRedirect() {
        if (!msalInstance) {
            this.init();
        }
        if (!msalInstance) return null;

        try {
            const response = await msalInstance.handleRedirectPromise();
            if (response) {
                console.log('Login successful:', response.account.username);
                return response.account;
            }
            return null;
        } catch (error) {
            console.error('Redirect error:', error);
            throw error;
        }
    },

    // Logout
    logout() {
        if (!msalInstance) {
            window.location.href = '/';
            return;
        }

        const accounts = msalInstance.getAllAccounts();
        if (accounts.length === 0) {
            window.location.href = '/';
            return;
        }

        msalInstance.logoutRedirect({
            account: accounts[0],
            postLogoutRedirectUri: window.location.origin
        });
    },

    // Get access token for API calls
    async getToken() {
        if (!msalInstance) return null;

        const accounts = msalInstance.getAllAccounts();
        if (accounts.length === 0) return null;

        try {
            const response = await msalInstance.acquireTokenSilent({
                ...loginRequest,
                account: accounts[0]
            });
            return response.accessToken;
        } catch (error) {
            console.error('Token error:', error);
            return null;
        }
    }
};

console.log('Auth module loaded (Entra Email OTP)');

console.log('Auth module loaded (Pure OTP mode)');
