const SIDEBAR_NAV_ITEMS = [
    { section: 'Main' },
    { page: 'dashboard', href: 'admin-dashboard.html', icon: '📊', label: 'Dashboard' },
    { page: 'events',    href: 'admin-events.html',    icon: '📅', label: 'Events' },

    { section: 'Participants' },
    { page: 'teams',    href: 'admin-teams.html',    icon: '👥', label: 'Teams',  darkIcon: true },
    { page: 'users',    href: 'admin-users.html',    icon: '👤', label: 'People', darkIcon: true },

    { section: 'Competition' },
    { page: 'badges', href: 'admin-badges.html', icon: '🏅', label: 'Badges' },

    { section: 'Communication' },
    { page: 'email',     href: 'admin-email.html',     icon: '✉️', label: 'Quick Email' },
    { page: 'campaigns', href: 'admin-campaigns.html', icon: '📧', label: 'Sequences' },

    { section: 'Theme' },
    { page: 'email-templates', href: 'admin-email-templates.html', icon: '📝', label: 'Email Templates' },
];

function renderAdminSidebar(activePage = '', permissions = null) {
    const allowedPages = permissions ? permissions.allowedPages : null;

    let navHTML = '';
    let lastSectionHadItems = false;
    let pendingSection = null;

    for (const item of SIDEBAR_NAV_ITEMS) {
        if (item.section) {
            pendingSection = `<div class="nav-section">${item.section}</div>`;
            lastSectionHadItems = false;
        } else if (item.page) {
            if (allowedPages && !allowedPages.includes(item.page)) continue;

            if (pendingSection) {
                navHTML += pendingSection;
                pendingSection = null;
            }
            lastSectionHadItems = true;

            const activeClass = activePage === item.page ? 'active' : '';
            const iconClass = item.darkIcon ? 'icon icon-invert' : 'icon';
            navHTML += `<a href="${item.href}" class="nav-item ${activeClass}">
                    <span class="${iconClass}">${item.icon}</span><span>${item.label}</span>
                </a>`;
        }
    }

    let roleIndicator = '';
    if (permissions && !permissions.isPortalAdmin && permissions.highestRole) {
        const roleLabel = typeof Permissions !== 'undefined'
            ? Permissions.getRoleLabel(permissions)
            : permissions.highestRole;
        roleIndicator = `<div class="sidebar-role-label">${roleLabel}</div>`;
    }

    const sidebarHTML = `
        <aside class="sidebar">
            <div class="sidebar-header">
                <span class="logo">🏔️</span>
                <span class="title">ACDC Admin</span>
                ${roleIndicator}
            </div>
            <nav class="sidebar-nav">
                ${navHTML}
            </nav>
            <div class="sidebar-footer">
                <a href="index.html" class="nav-item">
                    <span class="icon">🏠</span><span>Back to Portal</span>
                </a>
            </div>
        </aside>
    `;

    const adminLayout = document.querySelector('.admin-layout');
    if (adminLayout) {
        const existingSidebar = adminLayout.querySelector('.sidebar');
        if (existingSidebar) {
            existingSidebar.remove();
        }
        adminLayout.insertAdjacentHTML('afterbegin', sidebarHTML);
    }
}

