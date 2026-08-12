// ACDC Portal - Auth Module (Custom OTP + JWT)
// No external auth provider � uses our own OTP verification + JWT sessions
// Maintains the same interface as the old MSAL wrapper for compatibility

const Auth = {
    // Initialize � load session from localStorage
    init() {
        // Check if token is expired
        const token = this._getToken();
        if (token && this._isTokenExpired(token)) {
            console.log('JWT expired, clearing session');
            this._clearSession();
        }
        this._installFetchWrapper();
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

    // "Login" � redirect to unified register/sign-in page
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

    // Logout � clear session and redirect to home
    logout() {
        this._clearSession();
        window.location.href = '/events.html';
    },

    // Handle redirect � kept for compatibility
    // Old code calls `await Auth.handleRedirect()` on page load.
    // With JWT, there's no redirect to handle � just return null.
    async handleRedirect() {
        // No-op: JWT auth doesn't use redirects
        return null;
    },

    // Get JWT token for API calls (if needed in future)
    getToken() {
        if (!this.isLoggedIn()) return null;
        return this._getToken();
    },

    // Called when the server rejects our token (401) even though the client
    // thought it was still valid (e.g. clock skew, server-side invalidation).
    // Clears the stale session so the user isn't left in a broken half-logged-in
    // state where every API call silently fails.
    //
    // Also forces a page reload: pages read `Auth.getUser()`/`Auth.isLoggedIn()`
    // once near the top of their init logic and use that snapshot (e.g. `authUser`)
    // for the rest of the page load, including subsequent header/UI updates. If we
    // only clear localStorage here, those already-captured variables stay "truthy"
    // for the remainder of the page's lifetime, leaving the header showing a logged
    // -in Profile menu while the actual profile data fails to load (empty modal).
    // Reloading makes every page immediately and consistently reflect the real
    // (logged-out) state. The guard flag prevents multiple concurrent 401s from
    // triggering more than one reload.
    handleUnauthorized() {
        if (!this._getToken()) return; // already logged out, nothing to do
        console.warn('Session rejected by server (401) — clearing local session');
        this._clearSession();
        if (!window.__acdcReloadingAfterAuthClear) {
            window.__acdcReloadingAfterAuthClear = true;
            window.location.reload();
        }
    },

    _installFetchWrapper() {
        if (window.__acdcFetchPatched) return;

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
            const url = typeof input === 'string' ? input : input?.url || '';
            const isApiRequest = typeof url === 'string' && url.includes('/api/');
            const token = this.getToken();

            // Always attach the Bearer token to API requests when logged in.
            // Endpoints that are intentionally public (login/registration/invite
            // flows) don't check the Authorization header, so this is harmless.
            if (isApiRequest && token) {
                const headers = new Headers(init.headers || {});
                headers.set('Authorization', `Bearer ${token}`);
                init = { ...init, headers };
            }

            const response = await originalFetch(input, init);

            // If the server rejects our token (expired/invalid), clear the stale
            // local session so the user isn't left silently "half logged-in" with
            // every subsequent API call failing the same way.
            if (isApiRequest && token && response.status === 401) {
                this.handleUnauthorized();
            }

            return response;
        };

        window.__acdcFetchPatched = true;
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
