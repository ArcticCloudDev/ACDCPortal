const Permissions = {
    ROLE_CONFIG: null,
    _configLoaded: false,

    async _loadConfig() {
        if (this._configLoaded) return;
        const resp = await fetch('/data/role-permissions.json');
        if (!resp.ok) throw new Error(`Failed to load role-permissions.json (${resp.status})`);
        const data = await resp.json();
        this.ROLE_CONFIG = data.roles;
        this._configLoaded = true;
    },

    _cached: null,

    async resolve() {
        if (this._cached) return this._cached;

        await this._loadConfig();

        if (!Auth.isLoggedIn()) return null;

        const authUser = Auth.getUser();
        if (!authUser || !authUser.email) return null;

        try {
            const user = await API.users.get(authUser.email);

            if (user.isPortalAdmin) {
                this._cached = {
                    isPortalAdmin: true,
                    allowedPages: [...this.ROLE_CONFIG.portalAdmin.pages],
                    eventScoped: false,
                    allowedEventIds: [],
                    rolesByEvent: {},
                    highestRole: 'portalAdmin',
                    eventNames: {},
                    user: user
                };
                return this._cached;
            }

            const participations = await API.participations.getByPerson(authUser.email);

            const allowedPages = new Set();
            const allowedEventIds = new Set();
            const rolesByEvent = {};
            const eventNames = {};
            let highestRole = null;

            const rolePriority = { committee: 2, judge: 1 };

            for (const p of (participations || [])) {
                for (const role of (p.roles || [])) {
                    const roleConfig = this.ROLE_CONFIG[role];
                    if (roleConfig && roleConfig.pages) {
                        roleConfig.pages.forEach(page => allowedPages.add(page));
                        allowedEventIds.add(p.eventId);
                        if (!rolesByEvent[p.eventId]) rolesByEvent[p.eventId] = [];
                        if (!rolesByEvent[p.eventId].includes(role)) {
                            rolesByEvent[p.eventId].push(role);
                        }
                        if (p.eventName) eventNames[p.eventId] = p.eventName;
                        if (!highestRole || (rolePriority[role] || 0) > (rolePriority[highestRole] || 0)) {
                            highestRole = role;
                        }
                    }
                }
            }

            this._cached = {
                isPortalAdmin: false,
                allowedPages: [...allowedPages],
                eventScoped: true,
                allowedEventIds: [...allowedEventIds],
                rolesByEvent: rolesByEvent,
                highestRole: highestRole,
                eventNames: eventNames,
                user: user
            };
            return this._cached;

        } catch (error) {
            console.error('Permissions: Error resolving permissions:', error);
            return null;
        }
    },

    async hasPageAccess(pageName) {
        const perms = await this.resolve();
        return perms && perms.allowedPages.includes(pageName);
    },

    canAccessEvent(permissions, eventId) {
        if (!permissions) return false;
        if (!permissions.eventScoped) return true;
        return permissions.allowedEventIds.includes(eventId);
    },

    filterByEvent(permissions, items, eventIdField = 'eventId') {
        if (!permissions) return [];
        if (!permissions.eventScoped) return items;
        return items.filter(item => permissions.allowedEventIds.includes(item[eventIdField]));
    },

    getRoleLabel(permissions) {
        if (!permissions) return '';
        if (permissions.isPortalAdmin) return 'Portal Admin';

        const eventNames = Object.values(permissions.eventNames);
        const roleLabel = permissions.highestRole
            ? this.ROLE_CONFIG[permissions.highestRole]?.label || permissions.highestRole
            : 'Member';

        if (eventNames.length === 1) {
            return `${roleLabel} � ${eventNames[0]}`;
        } else if (eventNames.length > 1) {
            return `${roleLabel} � ${eventNames.length} events`;
        }
        return roleLabel;
    },

    clearCache() {
        this._cached = null;
    },

    async initAdminPage(pageName, options = {}) {
        const { loadingEl, accessDeniedEl, contentEl } = options;

        if (typeof Auth !== 'undefined' && Auth.init) {
            Auth.init();
        }

        renderAdminSidebar(pageName);

        try {
            if (typeof Auth !== 'undefined' && Auth.handleRedirect) {
                await Auth.handleRedirect();
            }

            if (!Auth.isLoggedIn()) {
                window.location.href = '/register.html';
                return null;
            }

            const permissions = await this.resolve();

            if (!permissions || !permissions.allowedPages.includes(pageName)) {
                if (loadingEl) loadingEl.classList.add('hidden');
                if (contentEl) contentEl.classList.add('hidden');
                if (accessDeniedEl) {
                    accessDeniedEl.classList.remove('hidden');
                } else {
                    document.body.innerHTML = `
                        <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;">
                            <div style="text-align:center;max-width:400px;">
                                <h2>🔒 Access Denied</h2>
                                <p>You don't have permission to access this page.</p>
                                <a href="index.html" style="color:#2563eb;">Back to Portal</a>
                            </div>
                        </div>`;
                }
                return null;
            }

            renderAdminSidebar(pageName, permissions);

            return permissions;

        } catch (error) {
            console.error(`Permissions: Error initializing ${pageName}:`, error);
            if (loadingEl) {
                loadingEl.innerHTML = `<p class="error-message">Error: ${error.message}</p>`;
            }
            return null;
        }
    }
};
