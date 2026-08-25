const Auth = {
    init() {
        const token = this._getToken();
        if (token && this._isTokenExpired(token)) {
            this._clearSession();
        }
        this._installFetchWrapper();
    },

    isLoggedIn() {
        const token = this._getToken();
        if (!token) return false;
        if (this._isTokenExpired(token)) {
            this._clearSession();
            return false;
        }
        return true;
    },

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

    login(loginHint) {
        const params = new URLSearchParams();
        if (loginHint) params.set('email', loginHint);
        params.set('redirect', window.location.pathname + window.location.search);
        window.location.href = `/register.html?${params.toString()}`;
    },

    setSession(token, user) {
        localStorage.setItem(CONFIG.auth.tokenKey, token);
        localStorage.setItem(CONFIG.auth.userKey, JSON.stringify(user));
    },

    logout() {
        this._clearSession();
        window.location.href = '/events.html';
    },

    async handleRedirect() {
        return null;
    },

    getToken() {
        if (!this.isLoggedIn()) return null;
        return this._getToken();
    },

    handleUnauthorized() {
        if (!this._getToken()) return;
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

            if (isApiRequest && token) {
                const headers = new Headers(init.headers || {});
                headers.delete('Authorization');
                headers.set('x-acdc-token', token);
                init = { ...init, headers };
            }

            const response = await originalFetch(input, init);

            if (isApiRequest && token && response.status === 401) {
                this.handleUnauthorized();
            }

            return response;
        };

        window.__acdcFetchPatched = true;
    },

    _getToken() {
        return localStorage.getItem(CONFIG.auth.tokenKey);
    },

    _isTokenExpired(token) {
        try {
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
            const payload = JSON.parse(atob(padded));

            return payload.exp * 1000 < Date.now();
        } catch {
            return true;
        }
    },

    _clearSession() {
        localStorage.removeItem(CONFIG.auth.tokenKey);
        localStorage.removeItem(CONFIG.auth.userKey);
    }
};

