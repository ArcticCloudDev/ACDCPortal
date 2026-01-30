// ACDC Portal - Committee Admin Dashboard

let currentUser = null;
let allEvents = [];
let allTeams = [];

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const notCommitteeDiv = document.getElementById('not-committee');
    const dashboardContent = document.getElementById('dashboard-content');
    const mainContent = document.getElementById('main-content');

    // Initialize Auth
    Auth.init();
    renderAdminSidebar('dashboard');

    try {
        // Handle redirect
        await Auth.handleRedirect();

        // Check if logged in
        if (!Auth.isLoggedIn()) {
            window.location.href = '/login.html';
            return;
        }

        const authUser = Auth.getUser();

        // Load user data
        currentUser = await API.users.get(authUser.email);

        // Check if user is portal admin
        if (!currentUser.isPortalAdmin) {
            loadingDiv.classList.add('hidden');
            mainContent.classList.add('hidden');
            notCommitteeDiv.classList.remove('hidden');
            return;
        }

        // Load all data
        await loadDashboardData();

        // Show dashboard
        loadingDiv.classList.add('hidden');
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
        // Load events
        allEvents = await API.events.list();
        document.getElementById('stat-events').textContent = allEvents.length;
        renderEventsList();

        // Load teams
        allTeams = await API.teams.list();
        document.getElementById('stat-teams').textContent = allTeams.length;
        renderTeamsTable();

        // Calculate total participants across all teams
        let totalParticipants = 0;
        for (const team of allTeams) {
            try {
                const count = await API.participations.getTeamCount(team.id);
                totalParticipants += count.participantCount || 0;
            } catch (e) {
                // Skip if error
            }
        }
        document.getElementById('stat-participants').textContent = totalParticipants;

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
        const isActive = event.isActive;
        const startDate = new Date(event.startDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        
        // Count teams for this event
        const eventTeams = allTeams.filter(t => t.eventId === event.id);
        
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
                <span class="badge ${isActive ? 'active' : 'inactive'}">
                    ${isActive ? 'Active' : 'Inactive'}
                </span>
                <div style="margin-left: 12px; display: flex; gap: 6px;">
                    <a href="event.html?id=${event.id}" class="btn-sm">View</a>
                    <a href="admin-events.html?edit=${event.id}" class="btn-sm">Edit</a>
                </div>
            </div>
        `;
    }).join('');
}

function renderTeamsTable() {
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
                <td style="color: var(--admin-text-muted); font-size: 0.8rem;">${escapeHtml(team.adminEmail || '—')}</td>
                <td><span class="badge count">${team.committedParticipants || 0}</span></td>
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
