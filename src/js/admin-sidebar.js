// Admin Sidebar - Shared component for all admin pages
// All admin pages should link to css/admin-styles.css for consistent styling
// Include this file and call renderAdminSidebar() to inject the sidebar

function renderAdminSidebar(activePage = '') {
    const sidebarHTML = `
        <aside class="sidebar">
            <div class="sidebar-header">
                <span class="logo">🏔️</span>
                <span class="title">ACDC Committee</span>
            </div>
            <nav class="sidebar-nav">
                <div class="nav-section">Main</div>
                <a href="admin-dashboard.html" class="nav-item ${activePage === 'dashboard' ? 'active' : ''}">
                    <span class="icon">📊</span><span>Dashboard</span>
                </a>
                <a href="admin-events.html" class="nav-item ${activePage === 'events' ? 'active' : ''}">
                    <span class="icon">📅</span><span>Events</span>
                </a>

                <div class="nav-section">Participants</div>
                <a href="admin-teams.html" class="nav-item ${activePage === 'teams' ? 'active' : ''}">
                    <span class="icon">👥</span><span>Teams</span>
                </a>
                <a href="admin-users.html" class="nav-item ${activePage === 'users' ? 'active' : ''}">
                    <span class="icon">👤</span><span>Users</span>
                </a>
                <a href="admin-interest.html" class="nav-item ${activePage === 'interest' ? 'active' : ''}">
                    <span class="icon">📋</span><span>Interest Queue</span>
                </a>

                <div class="nav-section">Communication</div>
                <a href="admin-email.html" class="nav-item ${activePage === 'email' ? 'active' : ''}">
                    <span class="icon">✉️</span><span>Quick Email</span>
                </a>
                <a href="admin-campaigns.html" class="nav-item ${activePage === 'campaigns' ? 'active' : ''}">
                    <span class="icon">📧</span><span>Sequences</span>
                </a>

                <div class="nav-section">Theme</div>
                <a href="admin-email-templates.html" class="nav-item ${activePage === 'email-templates' ? 'active' : ''}">
                    <span class="icon">📝</span><span>Email Templates</span>
                </a>

                <div class="nav-section">Settings</div>
                <a href="admin-branding.html" class="nav-item ${activePage === 'branding' ? 'active' : ''}">
                    <span class="icon">🎨</span><span>Branding</span>
                </a>
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

