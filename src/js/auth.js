// ACDC Portal - Auth Module (Custom OTP + JWT)
// No external auth provider — uses our own OTP verification + JWT sessions
// Maintains the same interface as the old MSAL wrapper for compatibility

const Auth = {
    // Initialize — load session from localStorage
    init() {
        // Check if token is expired
        const token = this._getToken();
        if (token && this._isTokenExpired(token)) {
            console.log('JWT expired, clearing session');
            this._clearSession();
        }
        console.log('Auth initialized (Custom OTP + JWT)');
    },

    // Check if user is logged in (has valid JWT)
    isLoggedIn() {
        const token = this._getToken();
        if (!token) return false;
        if (this._isTokenExpired(token)) {
            this._clearSession();
            return false;
        }
        return true;
    },

    // Get current user data
    getUser() {
        if (!this.isLoggedIn()) return null;
        
        const userData = localStorage.getItem(CONFIG.auth.userKey);
        if (!userData) return null;
        
        try {
            return JSON.parse(userData);
        } catch {
            return null;
        }
    },

    // "Login" — redirect to unified register/sign-in page
    // Pages that need auth call Auth.login() which sends the user to
    // register.html where the email check routes to OTP (known) or registration (new).
    login(loginHint) {
        const params = new URLSearchParams();
        if (loginHint) params.set('email', loginHint);
        params.set('redirect', window.location.pathname + window.location.search);
        window.location.href = `/register.html?${params.toString()}`;
    },

    // Store session after successful OTP verification
    setSession(token, user) {
        localStorage.setItem(CONFIG.auth.tokenKey, token);
        localStorage.setItem(CONFIG.auth.userKey, JSON.stringify(user));
    },

    // Logout — clear session and redirect to home
    logout() {
        this._clearSession();
        window.location.href = '/events.html';
    },

    // Handle redirect — kept for compatibility
    // Old code calls `await Auth.handleRedirect()` on page load.
    // With JWT, there's no redirect to handle — just return null.
    async handleRedirect() {
        // No-op: JWT auth doesn't use redirects
        return null;
    },

    // Get JWT token for API calls (if needed in future)
    getToken() {
        if (!this.isLoggedIn()) return null;
        return this._getToken();
    },

    // --- Private helpers ---

    _getToken() {
        return localStorage.getItem(CONFIG.auth.tokenKey);
    },

    _isTokenExpired(token) {
        try {
            // JWT structure: header.payload.signature
            const payload = JSON.parse(atob(token.split('.')[1]));
            // exp is in seconds, Date.now() is in ms
            return payload.exp * 1000 < Date.now();
        } catch {
            return true; // Invalid token = expired
        }
    },

    _clearSession() {
        localStorage.removeItem(CONFIG.auth.tokenKey);
        localStorage.removeItem(CONFIG.auth.userKey);
    }
};

console.log('Auth module loaded (Custom OTP + JWT)');
