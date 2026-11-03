const SiteHeader = (() => {
    let _config = {};
    let _containerEl = null;
    let _user = null;
    let _modalInjected = false;

    function _esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function _icon(name) {
        return typeof icon === 'function' ? icon(name) : '';
    }

    function _initials(user) {
        const parts = [user?.firstName, user?.lastName].filter(Boolean);
        if (parts.length) return parts.map(p => p.trim()[0] || '').join('').slice(0, 2);
        return (user?.email || '?').trim()[0] || '?';
    }

    let _documentListenersBound = false;

    // Renders the navy top bar and, when a title is given, the page hero below it.
    // Called with no title by the page's own script; logoUrl mode (events list) shows the welcome hero.
    function render(config = {}) {
        _config = Object.assign({
            title: null,
            subtitle: null,
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

        let infoHTML = '';
        if (_config.infoBadges && _config.infoBadges.length) {
            const spans = _config.infoBadges.map(b => {
                const cls = b.className ? ` class="meta-item ${_esc(b.className)}"` : ' class="meta-item"';
                const text = b.id ? `<span id="${_esc(b.id)}">${_esc(b.text || '')}</span>` : _esc(b.text || '');
                return `<span${cls}>${b.icon ? _esc(b.icon) + ' ' : ''}${text}</span>`;
            }).join('');
            infoHTML = `<div class="event-info">${spans}</div>`;
        } else if (_config.subtitle) {
            infoHTML = `<div class="event-info"><span>${_esc(_config.subtitle)}</span></div>`;
        }

        let heroHTML = '';
        if (_config.title) {
            heroHTML = `
            <div class="page-hero${_config.inactive ? ' inactive' : ''}">
                <div class="page-hero-inner">
                    <h1>${_esc(_config.title)}</h1>
                    ${infoHTML}
                </div>
            </div>`;
        } else if (_config.logoUrl) {
            heroHTML = `
            <div class="page-hero page-hero-welcome">
                <div class="page-hero-inner">
                    <p class="page-hero-eyebrow">Arctic Cloud Developer Challenge</p>
                    <h1>Build, hack and compete in the Arctic</h1>
                    <p class="page-hero-lead">Register your team, follow your event and claim badges, all in one place.</p>
                </div>
            </div>`;
        }

        const signInHTML = _config.showSignIn
            ? `<a href="register.html" id="header-signin-btn" class="banner-btn">${_icon('log-in')}<span>Sign in</span></a>`
            : '';
        const onEvents = /\/(events|event)\.html$/.test(location.pathname) || location.pathname === '/';

        _containerEl.className = 'app-header';
        _containerEl.innerHTML = `
            <div class="topbar">
                <div class="topbar-inner">
                    <a class="topbar-brand" href="/events.html" aria-label="ACDC Portal home">
                        <img src="/images/ACDCLogo.png" alt="ACDC" width="92" height="26">
                        <span class="topbar-brand-tag">Portal</span>
                    </a>
                    <nav class="topbar-nav" aria-label="Main">
                        <a class="topbar-link" href="/events.html"${onEvents ? ' aria-current="page"' : ''}>Events</a>
                    </nav>
                    <div class="banner-controls">
                        ${signInHTML}
                        <div id="header-user-menu" class="user-menu hidden">
                            <button type="button" id="header-user-btn" class="user-menu-toggle" aria-haspopup="true" aria-expanded="false">
                                <span class="avatar avatar-sm" aria-hidden="true">?</span>
                                <span class="user-menu-name">Profile</span>
                                ${_icon('chevron-down')}
                            </button>
                            <div id="header-user-dropdown" class="user-menu-dropdown hidden">
                                <button type="button" id="header-profile-link" class="user-menu-item">${_icon('user-round')}Update profile</button>
                                <a id="header-dashboard-link" href="admin-dashboard.html" class="user-menu-item hidden">${_icon('layout-dashboard')}Admin portal</a>
                                <button type="button" id="header-logout-menuitem" class="user-menu-item logout">${_icon('log-out')}Log out</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            ${heroHTML}
        `;

        _ensureProfileModal();

        const userBtn = document.getElementById('header-user-btn');
        const userDropdown = document.getElementById('header-user-dropdown');

        if (userBtn) {
            userBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = userDropdown.classList.toggle('hidden') === false;
                userBtn.setAttribute('aria-expanded', String(open));
            });
        }

        const profileLink = document.getElementById('header-profile-link');
        if (profileLink) {
            profileLink.addEventListener('click', () => {
                userDropdown.classList.add('hidden');
                _openProfileModal();
            });
        }

        const logoutMenuItem = document.getElementById('header-logout-menuitem');
        if (logoutMenuItem) {
            logoutMenuItem.addEventListener('click', async (e) => {
                e.preventDefault();
                await Auth.logout();
            });
        }

        if (!_documentListenersBound) {
            _documentListenersBound = true;
            const closeMenu = () => {
                const dropdown = document.getElementById('header-user-dropdown');
                const btn = document.getElementById('header-user-btn');
                if (dropdown) dropdown.classList.add('hidden');
                if (btn) btn.setAttribute('aria-expanded', 'false');
            };
            document.addEventListener('click', (e) => {
                const menu = document.getElementById('header-user-menu');
                if (menu && !menu.contains(e.target)) closeMenu();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeMenu();
            });
        }

        if (_user || _lastUpdate) update(_lastUpdate || {});
    }

    function _setUserButton(user) {
        const userBtn = document.getElementById('header-user-btn');
        if (!userBtn) return;
        const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
        const nameEl = userBtn.querySelector('.user-menu-name');
        const avatarEl = userBtn.querySelector('.avatar');
        if (nameEl) nameEl.textContent = fullName || 'Profile';
        if (avatarEl) avatarEl.textContent = _initials(user);
        userBtn.setAttribute('aria-label', fullName ? `Account menu for ${fullName}` : 'Account menu');
    }

    function _ensureProfileModal() {
        if (_modalInjected) return;
        _modalInjected = true;

        const modalHTML = `
        <div id="sh-profile-modal" class="modal-overlay">
            <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sh-profile-heading">
                <div class="modal-header">
                    <h2 id="sh-profile-heading">Your profile</h2>
                    <button type="button" class="modal-close" id="sh-close-profile" aria-label="Close">&times;</button>
                </div>
                <form id="sh-profile-form">
                    <div class="form-row">
                        <div class="form-group">
                            <label for="sh-firstName">First name *</label>
                            <input type="text" id="sh-firstName" name="firstName" required autocomplete="given-name">
                        </div>
                        <div class="form-group">
                            <label for="sh-lastName">Last name *</label>
                            <input type="text" id="sh-lastName" name="lastName" required autocomplete="family-name">
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="sh-email">Email</label>
                        <input type="email" id="sh-email" name="email" readonly class="readonly">
                    </div>
                    <div class="form-group">
                        <label for="sh-phone">Phone *</label>
                        <input type="tel" id="sh-phone" name="phone" required autocomplete="tel">
                    </div>
                    <div class="form-group">
                        <label for="sh-gamertag">Gamertag</label>
                        <input type="text" id="sh-gamertag" name="gamertag" placeholder="Optional" autocomplete="off">
                    </div>
                    <div class="form-group">
                        <label for="sh-allergies">Allergies or dietary requirements</label>
                        <textarea id="sh-allergies" name="allergies" rows="3" maxlength="500"
                                  placeholder="Optional"></textarea>
                    </div>
                    <div id="sh-profile-error" class="error-message hidden" role="alert"></div>
                    <div id="sh-profile-success" class="success-message hidden" role="status"></div>
                    <button type="submit" class="btn btn-primary" id="sh-save-profile-btn">
                        <span class="btn-text">Save profile</span>
                        <span class="btn-loading hidden">Saving...</span>
                    </button>
                </form>
            </div>
        </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const modal = document.getElementById('sh-profile-modal');

        document.getElementById('sh-close-profile').addEventListener('click', () => {
            modal.classList.remove('active');
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
                modal.classList.remove('active');
            }
        });

        document.getElementById('sh-profile-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await _saveProfile();
        });
    }

    function _openProfileModal() {
        const modal = document.getElementById('sh-profile-modal');
        if (!modal) return;

        if (_user) {
            document.getElementById('sh-firstName').value = _user.firstName || '';
            document.getElementById('sh-lastName').value = _user.lastName || '';
            document.getElementById('sh-email').value = _user.email || '';
            document.getElementById('sh-phone').value = _user.phone || '';
            document.getElementById('sh-gamertag').value = _user.gamertag || '';
            document.getElementById('sh-allergies').value = _user.allergies || '';
        }

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
            _setUserButton(_user);

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

    let _lastUpdate = null;

    function update({ authUser = null, user = null, isAdmin = false } = {}) {
        _lastUpdate = { authUser, user, isAdmin };
        _user = user;

        const signInBtn = document.getElementById('header-signin-btn');
        const userMenu = document.getElementById('header-user-menu');
        const dashboardLink = document.getElementById('header-dashboard-link');

        const isLoggedIn = !!authUser;

        if (signInBtn) signInBtn.classList.toggle('hidden', isLoggedIn);
        if (userMenu) userMenu.classList.toggle('hidden', !isLoggedIn);

        _setUserButton(user || authUser);

        const showAdmin = isAdmin || !!user?.isPortalAdmin;
        if (dashboardLink) {
            dashboardLink.classList.toggle('hidden', !showAdmin);
        }
    }

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

// Show the top bar straight away; the page script re-renders it with its title once data loads.
// Sign-in and invitation pages mark the container data-sign-in="off": a "Sign in" button there
// would only lead away from the flow the visitor is already in.
document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('site-header');
    if (el && !el.hasChildNodes()) SiteHeader.render({ showSignIn: el.dataset.signIn !== 'off' });
});
