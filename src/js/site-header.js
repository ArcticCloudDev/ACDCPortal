// Shared Site Header Component
// Renders the top banner bar used on events.html and event.html
//
// Usage:
//   SiteHeader.render({
//       title: '🏔️ ACDC Portal',
//       subtitle: 'Arctic Cloud Developer Challenge',
//       // Optional: dynamic info spans (event.html uses these)
//       infoBadges: [
//           { icon: '📅', text: 'Mar 12-15, 2026', id: 'event-dates' },
//           { icon: '📍', text: 'Tromsø', id: 'event-location' },
//           { text: '✓ Open', id: 'event-status', className: 'status-badge' }
//       ],
//       containerId: 'site-header',       // target element id (default: 'site-header')
//       showSignIn: true,                  // show Sign In link when logged out (default: true)
//       inactive: false,                   // grey gradient for inactive events
//       profileAction: 'navigate',         // 'navigate' (go to my-page.html) or 'modal' (open profile modal)
//       onProfileClick: null               // custom callback for modal mode
//   });
//
//   SiteHeader.update({ user, authUser });  // refresh auth controls after data loads

const SiteHeader = (() => {
    let _config = {};
    let _containerEl = null;

    function render(config = {}) {
        _config = Object.assign({
            title: '🏔️ ACDC Portal',
            subtitle: 'Arctic Cloud Developer Challenge',
            infoBadges: null,
            containerId: 'site-header',
            showSignIn: true,
            inactive: false,
            profileAction: 'navigate',  // 'navigate' | 'modal'
            onProfileClick: null
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
                // If there's an icon, put id on inner span so icon stays when textContent is set
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
        _containerEl.innerHTML = `
            <div class="event-banner-left">
                <h1>${_config.title}</h1>${infoHTML}
            </div>
            <div class="banner-controls">
                ${signInHTML}
                <button id="header-profile-btn" class="banner-btn hidden">👤 Profile</button>
                <button id="header-logout-btn" class="banner-btn btn-logout hidden">↩ Logout</button>
            </div>
        `;

        // Wire up button handlers
        const profileBtn = document.getElementById('header-profile-btn');
        const logoutBtn = document.getElementById('header-logout-btn');

        if (profileBtn) {
            profileBtn.addEventListener('click', () => {
                if (_config.profileAction === 'modal' && _config.onProfileClick) {
                    _config.onProfileClick();
                } else {
                    window.location.href = 'my-page.html';
                }
            });
        }

        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                await Auth.logout();
            });
        }
    }

    /**
     * Update auth controls visibility and name label.
     * Call after loading user data.
     */
    function update({ authUser = null, user = null } = {}) {
        const signInBtn = document.getElementById('header-signin-btn');
        const profileBtn = document.getElementById('header-profile-btn');
        const logoutBtn = document.getElementById('header-logout-btn');

        const isLoggedIn = !!authUser;

        if (signInBtn) signInBtn.classList.toggle('hidden', isLoggedIn);
        if (profileBtn) profileBtn.classList.toggle('hidden', !isLoggedIn);
        if (logoutBtn) logoutBtn.classList.toggle('hidden', !isLoggedIn);

        if (profileBtn) {
            const fullName = [user?.firstName, user?.lastName]
                .filter(Boolean)
                .join(' ')
                .trim();
            profileBtn.textContent = '';
            profileBtn.innerHTML = fullName ? `👤 ${fullName}` : '👤 Profile';
        }
    }

    /**
     * Get references to the header DOM elements (for pages that need direct access).
     */
    function getElements() {
        return {
            container: _containerEl,
            signInBtn: document.getElementById('header-signin-btn'),
            profileBtn: document.getElementById('header-profile-btn'),
            logoutBtn: document.getElementById('header-logout-btn')
        };
    }

    return { render, update, getElements };
})();
