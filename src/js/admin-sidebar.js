// Admin Sidebar - Shared component for all admin pages
// All admin pages should link to css/admin-styles.css for consistent styling
// Include this file and call renderAdminSidebar() to inject the sidebar
//
// Usage:
//   renderAdminSidebar('events');              // No filtering (initial render)
//   renderAdminSidebar('events', permissions); // Filtered by permissions

// All available nav items with their page keys
const SIDEBAR_NAV_ITEMS = [
    { section: 'Main' },
    { page: 'dashboard', href: 'admin-dashboard.html', icon: '📊', label: 'Dashboard' },
    { page: 'events',    href: 'admin-events.html',    icon: '📅', label: 'Events' },

    { section: 'Participants' },
    { page: 'teams',    href: 'admin-teams.html',    icon: '👥', label: 'Teams' },
    { page: 'users',    href: 'admin-users.html',    icon: '👤', label: 'People' },

    { section: 'Competition' },
    { page: 'badges', href: 'admin-badges.html', icon: '🏅', label: 'Badges' },

    { section: 'Communication' },
    { page: 'email',     href: 'admin-email.html',     icon: '✉️', label: 'Quick Email' },
    { page: 'campaigns', href: 'admin-campaigns.html', icon: '📧', label: 'Sequences' },

    { section: 'Theme' },
    { page: 'email-templates', href: 'admin-email-templates.html', icon: '📝', label: 'Email Templates' },
];

function renderAdminSidebar(activePage = '', permissions = null) {
    // Determine which pages to show
    const allowedPages = permissions ? permissions.allowedPages : null;

    // Build nav items HTML, filtering by permissions
    let navHTML = '';
    let lastSectionHadItems = false;
    let pendingSection = null;

    for (const item of SIDEBAR_NAV_ITEMS) {
        if (item.section) {
            // Buffer the section header — only render it if at least one item follows
            pendingSection = `<div class="nav-section">${item.section}</div>`;
            lastSectionHadItems = false;
        } else if (item.page) {
            // Skip if permissions provided and page not allowed
            if (allowedPages && !allowedPages.includes(item.page)) continue;

            // Render the buffered section header if needed
            if (pendingSection) {
                navHTML += pendingSection;
                pendingSection = null;
            }
            lastSectionHadItems = true;

            const activeClass = activePage === item.page ? 'active' : '';
            navHTML += `<a href="${item.href}" class="nav-item ${activeClass}">
                    <span class="icon">${item.icon}</span><span>${item.label}</span>
                </a>`;
        }
    }

    // Role indicator for the sidebar header
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

    // Find or create sidebar container
    const adminLayout = document.querySelector('.admin-layout');
    if (adminLayout) {
        // Remove any existing sidebar
        const existingSidebar = adminLayout.querySelector('.sidebar');
        if (existingSidebar) {
            existingSidebar.remove();
        }
        // Insert new sidebar at the beginning
        adminLayout.insertAdjacentHTML('afterbegin', sidebarHTML);
    }
}

