// ACDC Portal - Committee Admin Dashboard

let currentUser = null;
let allEvents = [];
let allTeams = [];
let currentPermissions = null;

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>');
        }
    }, 1200);
    const notCommitteeDiv = document.getElementById('not-committee');
    const dashboardContent = document.getElementById('dashboard-content');
    const mainContent = document.getElementById('main-content');

    // Resolve permissions (handles auth check, sidebar render, access denied)
    currentPermissions = await Permissions.initAdminPage('dashboard', {
        loadingEl: loadingDiv,
        accessDeniedEl: notCommitteeDiv,
        contentEl: mainContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        // Load all data
        await loadDashboardData();

        // Show dashboard
        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        dashboardContent.classList.remove('hidden');
        mainContent.appendChild(dashboardContent);

    } catch (error) {
        console.error('Dashboard error:', error);
        loadingDiv.innerHTML = `
            <p style="color: #ef4444;">Error: ${error.message}</p>
            <a href="events.html" class="btn-sm primary" style="margin-top: 16px;">Go to Events</a>
        `;
    }
});

async function loadDashboardData() {
    try {
        // Load events (scoped by permissions)
        let events = await API.events.list();
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        document.getElementById('stat-events').textContent = allEvents.length;
        renderEventsList();

        // Load teams and users (for admin name resolution)
        let teams = await API.teams.list();
        allTeams = Permissions.filterByEvent(currentPermissions, teams);
        document.getElementById('stat-teams').textContent = allTeams.length;

        let allUsers = [];
        try { allUsers = await API.users.list(); } catch (e) { /* non-critical */ }
        const userMap = {};
        for (const u of allUsers) { userMap[u.id] = u; }

        // Collect member counts per team
        const memberCounts = {};
        let totalParticipants = 0;
        for (const team of allTeams) {
            try {
                const count = await API.participations.getTeamCount(team.id);
                memberCounts[team.id] = count.participantCount || 0;
                totalParticipants += memberCounts[team.id];
            } catch (e) {
                memberCounts[team.id] = 0;
            }
        }
        document.getElementById('stat-participants').textContent = totalParticipants;

        renderTeamsTable(userMap, memberCounts);

        // Load pending invitations
        try {
            const invitations = await API.invitations.list();
            const pending = invitations.filter(inv => inv.status === 'pending');
            document.getElementById('stat-pending').textContent = pending.length;
        } catch (e) {
            document.getElementById('stat-pending').textContent = '0';
        }

    } catch (error) {
        console.error('Error loading dashboard data:', error);
    }
}

function renderEventsList() {
    const eventsList = document.getElementById('events-list');
    
    if (allEvents.length === 0) {
        eventsList.innerHTML = `
            <div class="empty-state">
                <div class="icon">📅</div>
                <p>No events yet. <a href="admin-events.html?action=create">Create one</a></p>
            </div>
        `;
        return;
    }

    // Show max 5 events
    const displayEvents = allEvents.slice(0, 5);

    eventsList.innerHTML = displayEvents.map(event => {
        const status = event.status || 'draft';
        const isActive = status === 'pre-registration' || status === 'registration' || status === 'live';
        const startDate = new Date(event.startDate + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        
        // Count teams for this event
        const eventTeams = allTeams.filter(t => t.eventId === event.id);
        
        // Status labels
        const statusLabels = {
            'draft': 'Draft',
            'pre-registration': 'Pre-Registration',
            'registration': 'Registration',
            'live': 'Live',
            'completed': 'Completed'
        };
        
        return `
            <div class="event-row">
                <div class="event-info">
                    <div class="event-name">${escapeHtml(event.name)}</div>
                    <div class="event-meta">
                        <span>📍 ${escapeHtml(event.location || 'TBD')}</span>
                        <span>📅 ${startDate}</span>
                        <span class="badge count">${eventTeams.length} teams</span>
                    </div>
                </div>
                <span class="badge ${status}">
                    ${statusLabels[status] || status}
                </span>
                <div style="margin-left: 12px; display: flex; gap: 6px;">
                    <a href="event.html?id=${event.id}" class="btn-sm">View</a>
                    <a href="admin-events.html?edit=${event.id}" class="btn-sm">Edit</a>
                </div>
            </div>
        `;
    }).join('');
}

function renderTeamsTable(userMap = {}, memberCounts = {}) {
    const tbody = document.getElementById('teams-table-body');
    
    if (allTeams.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-state">No teams registered yet</td>
            </tr>
        `;
        return;
    }

    // Sort by creation date (newest first) and take top 8
    const sortedTeams = [...allTeams]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 8);

    tbody.innerHTML = sortedTeams.map(team => {
        const createdDate = new Date(team.createdAt).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric'
        });
        const event = allEvents.find(e => e.id === team.eventId);
        
        return `
            <tr>
                <td>${escapeHtml(team.teamName)}</td>
                <td style="color: var(--admin-text-muted); font-size: 0.8rem;">${escapeHtml((() => { const u = userMap[team.adminUserId]; return u ? (u.firstName && u.lastName ? u.firstName + ' ' + u.lastName : u.email) : team.adminEmail || '—'; })())}</td>
                <td><span class="badge count">${memberCounts[team.id] ?? team.committedParticipants ?? 0}</span></td>
                <td>${event ? escapeHtml(event.name) : '—'}</td>
                <td style="color: var(--admin-text-muted);">${createdDate}</td>
                <td><a href="event.html?id=${team.eventId}" class="btn-sm">View</a></td>
            </tr>
        `;
    }).join('');
}

// Export data functionality
document.addEventListener('click', async (e) => {
    if (e.target.closest('#export-data')) {
        e.preventDefault();
        
        const btn = e.target.closest('#export-data');
        const iconEl = btn.querySelector('.icon');
        const originalIcon = iconEl.textContent;
        iconEl.textContent = '⏳';
        
        try {
            const data = {
                exportDate: new Date().toISOString(),
                events: allEvents,
                teams: allTeams
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `acdc-export-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            iconEl.textContent = '✓';
            setTimeout(() => { iconEl.textContent = originalIcon; }, 1500);
            
        } catch (error) {
            console.error('Export error:', error);
            iconEl.textContent = '✗';
            setTimeout(() => { iconEl.textContent = originalIcon; }, 1500);
        }
    }
});

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

console.log('Admin Dashboard loaded');
