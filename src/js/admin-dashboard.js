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

    currentPermissions = await Permissions.initAdminPage('dashboard', {
        loadingEl: loadingDiv,
        accessDeniedEl: notCommitteeDiv,
        contentEl: mainContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        await loadDashboardData();

        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        dashboardContent.classList.remove('hidden');
        mainContent.appendChild(dashboardContent);

    } catch (error) {
        console.error('Dashboard error:', error);
        loadingDiv.innerHTML = `
            <div class="notice notice-danger">${icon('triangle-alert')}<div><div class="notice-title">Could not load the dashboard</div><div class="notice-body">${escapeHtml(error.message)}</div></div></div>
            <a href="events.html" class="btn-sm">Go to events</a>
        `;
    }
});

// Mirrors GET /participations/team/{id}/count, computed once from the full participation list
// instead of one request per team.
function countTeamMembers(participations) {
    const counts = {};
    for (const p of participations || []) {
        if (p.teamId && (p.roles || []).includes('participant')) {
            const key = String(p.teamId).toLowerCase();
            counts[key] = (counts[key] || 0) + 1;
            continue;
        }
        for (const m of p.teamMemberships || []) {
            if (m.teamId && m.isParticipant) {
                const key = String(m.teamId).toLowerCase();
                counts[key] = (counts[key] || 0) + 1;
            }
        }
    }
    return counts;
}

async function loadDashboardData() {
    try {
        const [events, teams, usersResult, participationsResult, invitationsResult] = await Promise.all([
            API.events.list(),
            API.teams.list(),
            API.users.list().catch(() => []),
            API.participations.list().catch(() => []),
            API.invitations.list().catch(() => null)
        ]);

        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        allTeams = Permissions.filterByEvent(currentPermissions, teams);
        document.getElementById('stat-events').textContent = allEvents.length;
        document.getElementById('stat-teams').textContent = allTeams.length;
        // Teams must be loaded first: each event row shows its team count.
        renderEventsList();

        const userMap = {};
        for (const u of usersResult || []) { userMap[String(u.id).toLowerCase()] = u; }

        const countsByTeam = countTeamMembers(participationsResult);
        const memberCounts = {};
        let totalParticipants = 0;
        for (const team of allTeams) {
            memberCounts[team.id] = countsByTeam[String(team.id).toLowerCase()] || 0;
            totalParticipants += memberCounts[team.id];
        }
        document.getElementById('stat-participants').textContent = totalParticipants;

        renderTeamsTable(userMap, memberCounts);

        if (Array.isArray(invitationsResult)) {
            const pending = invitationsResult.filter(inv => inv.status === 'pending');
            document.getElementById('stat-pending').textContent = pending.length;
        } else {
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
                <p>No events yet. <a href="admin-events.html?action=create">Create one</a></p>
            </div>
        `;
        return;
    }

    const displayEvents = allEvents.slice(0, 5);

    eventsList.innerHTML = displayEvents.map(event => {
        const status = event.status || 'draft';
        const startDate = new Date(event.startDate + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });

        const eventTeams = allTeams.filter(t => sameId(t.eventId, event.id));

        const statusLabels = {
            'draft': 'Draft',
            'pre-registration': 'Pre-Registration',
            'registration': 'Registration',
            'live': 'Live',
            'completed': 'Completed'
        };

        const teamCount = `${eventTeams.length} ${eventTeams.length === 1 ? 'team' : 'teams'}`;
        return `
            <div class="event-row">
                <div class="event-info">
                    <a class="event-name" href="admin-events.html?event=${encodeURIComponent(event.id)}">${escapeHtml(event.name)}</a>
                    <div class="event-meta">
                        <span>${icon('map-pin')}${escapeHtml(event.location || 'TBD')}</span>
                        <span>${icon('calendar')}${startDate}</span>
                        <span>${icon('users')}${teamCount}</span>
                    </div>
                </div>
                <span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>
                <div class="row-actions">
                    <a href="admin-event-participants.html?id=${encodeURIComponent(event.id)}" class="btn-sm ghost">${icon('users')}Participants</a>
                    <a href="admin-events.html?event=${encodeURIComponent(event.id)}" class="btn-sm">${icon('pencil')}Edit</a>
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

    const sortedTeams = [...allTeams]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 8);

    tbody.innerHTML = sortedTeams.map(team => {
        const createdDate = new Date(team.createdAt).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric'
        });
        const event = allEvents.find(e => sameId(e.id, team.eventId));
        const adminUser = team.adminUserId ? userMap[String(team.adminUserId).toLowerCase()] : null;
        const adminLabel = adminUser
            ? (adminUser.firstName && adminUser.lastName ? `${adminUser.firstName} ${adminUser.lastName}` : adminUser.email)
            : (team.adminEmail || '—');

        return `
            <tr>
                <td><strong>${escapeHtml(team.teamName)}</strong></td>
                <td class="text-muted">${escapeHtml(adminLabel)}</td>
                <td><span class="badge count" title="Committed team size: ${Number(team.numberOfParticipants) || 0}">${memberCounts[team.id] ?? 0} / ${Number(team.numberOfParticipants) || 0}</span></td>
                <td>${event ? escapeHtml(event.name) : '—'}</td>
                <td class="text-muted">${createdDate}</td>
                <td><a href="admin-teams.html?team=${encodeURIComponent(team.id)}" class="btn-sm">View team</a></td>
            </tr>
        `;
    }).join('');
}

document.addEventListener('click', async (e) => {
    if (e.target.closest('#export-data')) {
        e.preventDefault();

        const btn = e.target.closest('#export-data');
        const labelEl = btn.querySelector('.quick-action-label');
        const originalLabel = labelEl.textContent;
        labelEl.textContent = 'Exporting…';

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

            labelEl.textContent = 'Exported';
            setTimeout(() => { labelEl.textContent = originalLabel; }, 1500);

        } catch (error) {
            console.error('Export error:', error);
            labelEl.textContent = 'Export failed';
            setTimeout(() => { labelEl.textContent = originalLabel; }, 1500);
        }
    }
});
