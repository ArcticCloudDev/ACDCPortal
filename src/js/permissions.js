// ACDC Portal - Permissions Module
// Resolves effective permissions for the current user based on their
// portal admin status and event-scoped participation roles.
//
// Usage in admin pages:
//   const permissions = await Permissions.resolve();
//   if (!permissions || !permissions.allowedPages.includes('events')) { ... }
//   renderAdminSidebar('events', permissions);

const Permissions = {
    // Loaded at runtime from data/role-permissions.json — single source of truth
    ROLE_CONFIG: null,
    _configLoaded: false,

    /**
     * Load the role config from the JSON file (once).
     */
    async _loadConfig() {
        if (this._configLoaded) return;
        const resp = await fetch('/data/role-permissions.json');
        if (!resp.ok) throw new Error(`Failed to load role-permissions.json (${resp.status})`);
        const data = await resp.json();
        this.ROLE_CONFIG = data.roles;
        this._configLoaded = true;
    },

    // Cache the resolved permissions for the session
    _cached: null,

    /**
     * Resolve effective permissions for the current logged-in user.
     * Returns null if not logged in.
     * Caches the result — call clearCache() to force a refresh.
     *
     * @returns {Promise<Object|null>} Permissions object:
     *   {
     *     isPortalAdmin: boolean,
     *     allowedPages: string[],
     *     eventScoped: boolean,
     *     allowedEventIds: string[],       // empty = all events
     *     rolesByEvent: { eventId: string[] },
     *     highestRole: string|null,         // 'portalAdmin', 'committee', 'judge', or null
     *     eventNames: { eventId: string },  // friendly names for scoped events
     *     user: object                       // the full user record
     *   }
     */
    async resolve() {
        // Return cached if available
        if (this._cached) return this._cached;

        // Ensure config is loaded
        await this._loadConfig();

        // Must be logged in
        if (!Auth.isLoggedIn()) return null;

        const authUser = Auth.getUser();
        if (!authUser || !authUser.email) return null;

        try {
            const user = await API.users.get(authUser.email);

            // Portal admin = god mode
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

            // Get user's participations across all events
            const participations = await API.participations.getByPerson(authUser.email);

            // Aggregate permissions from all participations
            const allowedPages = new Set();
            const allowedEventIds = new Set();
            const rolesByEvent = {};
            const eventNames = {};
            let highestRole = null;

            // Role priority for determining highest role
            const rolePriority = { committee: 2, judge: 1 };

            for (const p of (participations || [])) {
                for (const role of (p.roles || [])) {
                    const roleConfig = this.ROLE_CONFIG[role];
                    if (roleConfig && roleConfig.pages) {
                        // Add this role's pages to allowed set
                        roleConfig.pages.forEach(page => allowedPages.add(page));
                        // Track event access
                        allowedEventIds.add(p.eventId);
                        // Track roles per event
                        if (!rolesByEvent[p.eventId]) rolesByEvent[p.eventId] = [];
                        if (!rolesByEvent[p.eventId].includes(role)) {
                            rolesByEvent[p.eventId].push(role);
                        }
                        // Track event names
                        if (p.eventName) eventNames[p.eventId] = p.eventName;
                        // Track highest role
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

    /**
     * Check if the current user has access to a specific admin page.
     * Resolves permissions if not already cached.
     */
    async hasPageAccess(pageName) {
        const perms = await this.resolve();
        return perms && perms.allowedPages.includes(pageName);
    },

    /**
     * Check if a specific event ID is accessible.
     * Portal admins can access all events.
     */
    canAccessEvent(permissions, eventId) {
        if (!permissions) return false;
        if (!permissions.eventScoped) return true; // portal admin
        return permissions.allowedEventIds.includes(eventId);
    },

    /**
     * Filter an array of items to only those the user can access.
     * Items must have an eventId property.
     * Portal admins get all items unfiltered.
     */
    filterByEvent(permissions, items, eventIdField = 'eventId') {
        if (!permissions) return [];
        if (!permissions.eventScoped) return items; // portal admin sees all
        return items.filter(item => permissions.allowedEventIds.includes(item[eventIdField]));
    },

    /**
     * Get a display label for the user's role context.
     * e.g. "Committee · ACDC 2027" or "Judge · ACDC 2027"
     */
    getRoleLabel(permissions) {
        if (!permissions) return '';
        if (permissions.isPortalAdmin) return 'Portal Admin';

        const eventNames = Object.values(permissions.eventNames);
        const roleLabel = permissions.highestRole
            ? this.ROLE_CONFIG[permissions.highestRole]?.label || permissions.highestRole
            : 'Member';

        if (eventNames.length === 1) {
            return `${roleLabel} · ${eventNames[0]}`;
        } else if (eventNames.length > 1) {
            return `${roleLabel} · ${eventNames.length} events`;
        }
        return roleLabel;
    },

    /**
     * Clear cached permissions (e.g. after role changes).
     */
    clearCache() {
        this._cached = null;
    },

    /**
     * Standard admin page initialization.
     * Handles auth check, permission check, and sidebar rendering.
     * Returns permissions object or null (with appropriate redirects/UI shown).
     *
     * @param {string} pageName - The page identifier (e.g. 'events', 'teams')
     * @param {Object} options - Optional config
     * @param {HTMLElement} options.loadingEl - Loading indicator element
     * @param {HTMLElement} options.accessDeniedEl - Access denied message element
     * @param {HTMLElement} options.contentEl - Main content element to show on success
     * @returns {Promise<Object|null>} Permissions object, or null if access denied
     */
    async initAdminPage(pageName, options = {}) {
        const { loadingEl, accessDeniedEl, contentEl } = options;

        // Ensure Auth is initialized
        if (typeof Auth !== 'undefined' && Auth.init) {
            Auth.init();
        }

        // Render sidebar immediately (will be updated with permissions later)
        renderAdminSidebar(pageName);

        try {
            // Check auth state
            if (typeof Auth !== 'undefined' && Auth.handleRedirect) {
                await Auth.handleRedirect();
            }

            // Check if logged in
            if (!Auth.isLoggedIn()) {
                window.location.href = '/register.html';
                return null;
            }

            // Resolve permissions
            const permissions = await this.resolve();

            // Check page access
            if (!permissions || !permissions.allowedPages.includes(pageName)) {
                if (loadingEl) loadingEl.classList.add('hidden');
                if (contentEl) contentEl.classList.add('hidden');
                if (accessDeniedEl) {
                    accessDeniedEl.classList.remove('hidden');
                } else {
                    // Create a default access denied message
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

            // Update sidebar with permissions (show only allowed pages)
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
