const SIDEBAR_NAV_ITEMS = [
    { section: 'Main' },
    { page: 'dashboard', href: 'admin-dashboard.html', icon: 'layout-dashboard', label: 'Dashboard' },
    { page: 'events',    href: 'admin-events.html',    icon: 'calendar-days',    label: 'Events' },

    { section: 'Participants' },
    { page: 'teams', href: 'admin-teams.html', icon: 'users',      label: 'Teams' },
    { page: 'users', href: 'admin-users.html', icon: 'user-round', label: 'People' },

    { section: 'Competition' },
    { page: 'badges', href: 'admin-badges.html', icon: 'award', label: 'Badges' },

    { section: 'Communication' },
    { page: 'email',     href: 'admin-email.html',     icon: 'send', label: 'Send email' },
    { page: 'campaigns', href: 'admin-campaigns.html', icon: 'mail', label: 'Email sequences' },
    { page: 'email-templates', href: 'admin-email-templates.html', icon: 'file-text', label: 'Email templates' },
];

function renderAdminSidebar(activePage = '', permissions = null) {
    const allowedPages = permissions ? permissions.allowedPages : null;
    const svg = name => (typeof icon === 'function' ? icon(name) : '');

    let navHTML = '';
    let pendingSection = null;

    for (const item of SIDEBAR_NAV_ITEMS) {
        if (item.section) {
            pendingSection = `<div class="nav-section">${item.section}</div>`;
        } else if (item.page) {
            if (allowedPages && !allowedPages.includes(item.page)) continue;

            if (pendingSection) {
                navHTML += pendingSection;
                pendingSection = null;
            }

            const isActive = activePage === item.page;
            navHTML += `<a href="${item.href}" class="nav-item${isActive ? ' active' : ''}"${isActive ? ' aria-current="page"' : ''}>
                    ${svg(item.icon)}<span>${item.label}</span>
                </a>`;
        }
    }

    let roleIndicator = '';
    if (permissions && !permissions.isPortalAdmin && permissions.highestRole) {
        const roleLabel = typeof Permissions !== 'undefined'
            ? Permissions.getRoleLabel(permissions)
            : permissions.highestRole;
        roleIndicator = `<div class="sidebar-role-label">${escapeHtml(roleLabel)}</div>`;
    }

    const brand = `
        <a class="sidebar-brand" href="admin-dashboard.html" aria-label="ACDC Admin home">
            <img src="/images/ACDCLogo.png" alt="ACDC" width="78" height="22">
            <span class="sidebar-brand-tag">Admin</span>
        </a>`;

    const sidebarHTML = `
        <div class="admin-mobilebar">
            <button type="button" class="admin-menu-btn" aria-label="Open menu" aria-controls="admin-sidebar" aria-expanded="false">${svg('menu')}</button>
            ${brand}
        </div>
        <div class="sidebar-backdrop" hidden></div>
        <aside class="sidebar" id="admin-sidebar">
            <div class="sidebar-header">
                ${brand}
                ${roleIndicator}
            </div>
            <nav class="sidebar-nav" aria-label="Admin">
                ${navHTML}
            </nav>
            <div class="sidebar-footer">
                <a href="events.html" class="nav-item">
                    ${svg('arrow-left')}<span>Back to portal</span>
                </a>
            </div>
        </aside>
    `;

    const adminLayout = document.querySelector('.admin-layout');
    if (!adminLayout) return;

    adminLayout.querySelectorAll(':scope > .sidebar, :scope > .admin-mobilebar, :scope > .sidebar-backdrop').forEach(el => el.remove());
    adminLayout.insertAdjacentHTML('afterbegin', sidebarHTML);

    const sidebar = adminLayout.querySelector('.sidebar');
    const backdrop = adminLayout.querySelector('.sidebar-backdrop');
    const menuBtn = adminLayout.querySelector('.admin-menu-btn');

    const setOpen = (open) => {
        sidebar.classList.toggle('open', open);
        backdrop.hidden = !open;
        menuBtn.setAttribute('aria-expanded', String(open));
        document.body.classList.toggle('sidebar-open', open);
        if (open) sidebar.querySelector('.nav-item')?.focus();
    };

    menuBtn.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
    backdrop.addEventListener('click', () => setOpen(false));
    sidebar.addEventListener('click', (e) => {
        if (e.target.closest('a.nav-item')) setOpen(false);
    });

    if (!window.__acdcSidebarKeysBound) {
        window.__acdcSidebarKeysBound = true;
        document.addEventListener('keydown', (e) => {
            const open = document.querySelector('.sidebar.open');
            if (e.key === 'Escape' && open) {
                open.classList.remove('open');
                document.querySelector('.sidebar-backdrop')?.setAttribute('hidden', '');
                const btn = document.querySelector('.admin-menu-btn');
                btn?.setAttribute('aria-expanded', 'false');
                document.body.classList.remove('sidebar-open');
                btn?.focus();
            }
        });
    }
}
