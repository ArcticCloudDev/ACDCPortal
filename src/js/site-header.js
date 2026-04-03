// Shared Site Header Component
// Renders the top banner bar + self-contained profile modal.
// Works identically on events.html and event.html — no page-specific config needed.
//
// Usage:
//   SiteHeader.render({
//       title: '🏔️ ACDC Portal',
//       subtitle: 'Arctic Cloud Developer Challenge',
//       infoBadges: [ ... ],           // optional info spans
//       containerId: 'site-header',    // target element id
//       showSignIn: true,              // show Sign In link when logged out
//       inactive: false                // grey gradient for inactive events
//   });
//
//   SiteHeader.update({ user, authUser, isAdmin });

const SiteHeader = (() => {
    let _config = {};
    let _containerEl = null;
    let _user = null;           // current user object (for profile modal)
    let _modalInjected = false; // only inject modal HTML once

    function render(config = {}) {
        _config = Object.assign({
            title: '🏔️ ACDC Portal',
            subtitle: 'Arctic Cloud Developer Challenge',
            logoUrl: null,
            infoBadges: null,
            containerId: 'site-header',
            showSignIn: true,
            inactive: false
        }, config);

        _containerEl = document.getElementById(_config.containerId);
        if (!_containerEl) {
            console.warn('SiteHeader: container #' + _config.containerId + ' not found');
            return;
        }

        // Build info section
        let infoHTML = '';
        if (_config.infoBadges && _config.infoBadges.length) {
            const spans = _config.infoBadges.map(b => {
                const cls = b.className ? ` class="${b.className}"` : '';
                const idAttr = b.id ? ` id="${b.id}"` : '';
                const icon = b.icon ? b.icon + ' ' : '';
                if (b.icon && b.id) {
                    return `<span${cls}>${icon}<span id="${b.id}">${b.text || ''}</span></span>`;
                }
                return `<span${idAttr}${cls}>${icon}${b.text || ''}</span>`;
            }).join('\n                        ');
            infoHTML = `
                    <div class="event-info">
                        ${spans}
                    </div>`;
        } else if (_config.subtitle) {
            infoHTML = `
                    <div class="event-info">
                        <span>${_config.subtitle}</span>
                    </div>`;
        }

        const inactiveClass = _config.inactive ? ' inactive' : '';
        const signInHTML = _config.showSignIn
            ? `<a href="register.html" id="header-signin-btn" class="banner-btn">🔑 Sign In</a>`
            : '';

        _containerEl.className = 'event-banner' + inactiveClass;
        const titleHTML = _config.logoUrl
            ? `<img src="${_config.logoUrl}" alt="ACDC Logo" style="height: 48px; display: block;">`
            : `<h1>${_config.title}</h1>${infoHTML}`;
        _containerEl.innerHTML = `
            <div class="event-banner-left">
                ${titleHTML}
            </div>
            <div class="banner-controls">
                ${signInHTML}
                <div id="header-user-menu" class="user-menu hidden">
                    <button id="header-user-btn" class="banner-btn user-menu-toggle">👤 Profile</button>
                    <div id="header-user-dropdown" class="user-menu-dropdown">
                        <button id="header-profile-link" class="user-menu-item">📝 Update Profile</button>
                        <a id="header-dashboard-link" href="admin-dashboard.html" class="user-menu-item hidden">📊 Admin Portal</a>
                        <button id="header-logout-menuitem" class="user-menu-item logout">↩ Log Out</button>
                    </div>
                </div>
            </div>
        `;

        // Inject modal once
        _ensureProfileModal();

        // Wire up dropdown handlers
        const userMenu = document.getElementById('header-user-menu');
        const userBtn = document.getElementById('header-user-btn');
        const userDropdown = document.getElementById('header-user-dropdown');

        if (userBtn) {
            userBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                userDropdown.classList.toggle('hidden');
            });
        }

        // Profile button → open modal
        const profileLink = document.getElementById('header-profile-link');
        if (profileLink) {
            profileLink.addEventListener('click', () => {
                userDropdown.classList.add('hidden');
                _openProfileModal();
            });
        }

        // Logout
        const logoutMenuItem = document.getElementById('header-logout-menuitem');
        if (logoutMenuItem) {
            logoutMenuItem.addEventListener('click', async (e) => {
                e.preventDefault();
                await Auth.logout();
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (userMenu && !userMenu.contains(e.target)) {
                userDropdown.classList.add('hidden');
            }
        });
    }

    // ============================================================
    // Profile Modal — injected once, reused across any page
    // ============================================================

    function _ensureProfileModal() {
        if (_modalInjected) return;
        _modalInjected = true;

        const modalHTML = `
        <div id="sh-profile-modal" class="modal-overlay">
            <div class="modal">
                <div class="modal-header">
                    <h2>👤 Your Profile</h2>
                    <button class="modal-close" id="sh-close-profile">&times;</button>
                </div>
                <form id="sh-profile-form">
                    <div class="form-group">
                        <label for="sh-firstName">First Name *</label>
                        <input type="text" id="sh-firstName" name="firstName" required>
                    </div>
                    <div class="form-group">
                        <label for="sh-lastName">Last Name *</label>
                        <input type="text" id="sh-lastName" name="lastName" required>
                    </div>
                    <div class="form-group">
                        <label for="sh-email">Email</label>
                        <input type="email" id="sh-email" name="email" readonly class="readonly">
                    </div>
                    <div class="form-group">
                        <label for="sh-phone">Phone *</label>
                        <input type="tel" id="sh-phone" name="phone" required>
                    </div>
                    <div class="form-group">
                        <label for="sh-gamertag">Gamertag</label>
                        <input type="text" id="sh-gamertag" name="gamertag" placeholder="Your gaming username (optional)">
                    </div>
                    <div class="form-group">
                        <label for="sh-allergies">Allergies / Dietary Requirements</label>
                        <textarea id="sh-allergies" name="allergies" rows="3" maxlength="500"
                                  placeholder="Enter any allergies or dietary requirements..."></textarea>
                    </div>
                    <div id="sh-profile-error" class="error-message hidden"></div>
                    <div id="sh-profile-success" class="success-message hidden"></div>
                    <button type="submit" class="btn btn-primary" id="sh-save-profile-btn">
                        <span class="btn-text">Save Profile</span>
                        <span class="btn-loading hidden">Saving...</span>
                    </button>
                </form>
            </div>
        </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const modal = document.getElementById('sh-profile-modal');

        // Close button
        document.getElementById('sh-close-profile').addEventListener('click', () => {
            modal.classList.remove('active');
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
                modal.classList.remove('active');
            }
        });

        // Form submit
        document.getElementById('sh-profile-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await _saveProfile();
        });
    }

    function _openProfileModal() {
        const modal = document.getElementById('sh-profile-modal');
        if (!modal) return;

        // Populate form with current user data
        if (_user) {
            document.getElementById('sh-firstName').value = _user.firstName || '';
            document.getElementById('sh-lastName').value = _user.lastName || '';
            document.getElementById('sh-email').value = _user.email || '';
            document.getElementById('sh-phone').value = _user.phone || '';
            document.getElementById('sh-gamertag').value = _user.gamertag || '';
            document.getElementById('sh-allergies').value = _user.allergies || '';
        }

        // Reset messages
        document.getElementById('sh-profile-error').classList.add('hidden');
        document.getElementById('sh-profile-success').classList.add('hidden');

        modal.classList.add('active');
    }

    async function _saveProfile() {
        const saveBtn = document.getElementById('sh-save-profile-btn');
        const errorDiv = document.getElementById('sh-profile-error');
        const successDiv = document.getElementById('sh-profile-success');

        const formData = {
            firstName: document.getElementById('sh-firstName').value.trim(),
            lastName: document.getElementById('sh-lastName').value.trim(),
            phone: document.getElementById('sh-phone').value.trim(),
            gamertag: document.getElementById('sh-gamertag').value.trim(),
            allergies: document.getElementById('sh-allergies').value.trim(),
            profileComplete: true
        };

        saveBtn.disabled = true;
        saveBtn.querySelector('.btn-text').classList.add('hidden');
        saveBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');

        try {
            await API.users.update(_user.id, formData);
            _user = { ..._user, ...formData };

            // Update the header name button to reflect changes
            const userBtn = document.getElementById('header-user-btn');
            if (userBtn) {
                const fullName = [_user.firstName, _user.lastName].filter(Boolean).join(' ').trim();
                userBtn.textContent = fullName ? `👤 ${fullName}` : '👤 Profile';
            }

            successDiv.textContent = 'Profile saved!';
            successDiv.classList.remove('hidden');

            setTimeout(() => {
                document.getElementById('sh-profile-modal').classList.remove('active');
            }, 1500);
        } catch (error) {
            errorDiv.textContent = error.message || 'Could not save profile.';
            errorDiv.classList.remove('hidden');
        } finally {
            saveBtn.disabled = false;
            saveBtn.querySelector('.btn-text').classList.remove('hidden');
            saveBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Update auth controls visibility and name label.
     * Call after loading user data and participation info.
     */
    function update({ authUser = null, user = null, isAdmin = false } = {}) {
        _user = user; // store for profile modal

        const signInBtn = document.getElementById('header-signin-btn');
        const userMenu = document.getElementById('header-user-menu');
        const userBtn = document.getElementById('header-user-btn');
        const dashboardLink = document.getElementById('header-dashboard-link');

        const isLoggedIn = !!authUser;

        if (signInBtn) signInBtn.classList.toggle('hidden', isLoggedIn);
        if (userMenu) userMenu.classList.toggle('hidden', !isLoggedIn);

        if (userBtn) {
            const fullName = [user?.firstName, user?.lastName]
                .filter(Boolean)
                .join(' ')
                .trim();
            userBtn.textContent = fullName ? `👤 ${fullName}` : '👤 Profile';
        }

        // Show admin portal link for portal admins OR event committee/judge
        const showAdmin = isAdmin || !!user?.isPortalAdmin;
        if (dashboardLink) {
            dashboardLink.classList.toggle('hidden', !showAdmin);
        }
    }

    /**
     * Get references to the header DOM elements (for pages that need direct access).
     */
    function getElements() {
        return {
            container: _containerEl,
            signInBtn: document.getElementById('header-signin-btn'),
            userMenu: document.getElementById('header-user-menu'),
            userBtn: document.getElementById('header-user-btn'),
            profileLink: document.getElementById('header-profile-link'),
            dashboardLink: document.getElementById('header-dashboard-link')
        };
    }

    return { render, update, getElements };
})();
