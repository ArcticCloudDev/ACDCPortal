// ACDC Portal - Admin Teams Management

let currentUser = null;
let allEvents = [];
let allTeams = [];
let teamCounts = {};
let currentPermissions = null;

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const notCommitteeDiv = document.getElementById('not-committee');
    const adminContent = document.getElementById('admin-content');

    // Resolve permissions (handles auth check, sidebar render, access denied)
    currentPermissions = await Permissions.initAdminPage('teams', {
        loadingEl: loadingDiv,
        accessDeniedEl: notCommitteeDiv,
        contentEl: adminContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        // Load data
        await loadData();

        // Setup filters
        setupFilters();

        loadingDiv.classList.add('hidden');
        adminContent.classList.remove('hidden');

    } catch (error) {
        console.error('Error:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error: ${error.message}</p>`;
    }
});

async function loadData() {
    try {
        // Load events for filter (scoped by permissions)
        let events = await API.events.list();
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        populateEventFilter();

        // Load all teams (scoped by permissions)
        let teams = await API.teams.list();
        allTeams = Permissions.filterByEvent(currentPermissions, teams);

        // Load participant counts for each team
        for (const team of allTeams) {
            try {
                const count = await API.participations.getTeamCount(team.id);
                teamCounts[team.id] = count.participantCount || 0;
            } catch (e) {
                teamCounts[team.id] = 0;
            }
        }

        // Render
        renderTeamsTable();
        updateStats();

    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function populateEventFilter() {
    const eventFilter = document.getElementById('event-filter');
    
    // Status labels for display
    const statusLabels = {
        'pre-registration': 'Pre-Reg',
        'registration': 'Registration',
        'live': 'Live'
    };
    
    allEvents.forEach(event => {
        const option = document.createElement('option');
        option.value = event.id;
        option.textContent = event.name;
        const status = event.status || 'draft';
        if (statusLabels[status]) {
            option.textContent += ` (${statusLabels[status]})`;
        }
        eventFilter.appendChild(option);
    });
}

function setupFilters() {
    const eventFilter = document.getElementById('event-filter');
    const searchInput = document.getElementById('search-teams');

    eventFilter.addEventListener('change', renderTeamsTable);
    searchInput.addEventListener('input', debounce(renderTeamsTable, 300));
}

function renderTeamsTable() {
    const tbody = document.getElementById('teams-table-body');
    const eventFilter = document.getElementById('event-filter').value;
    const searchQuery = document.getElementById('search-teams').value.toLowerCase().trim();

    // Filter teams
    let filteredTeams = [...allTeams];

    if (eventFilter) {
        filteredTeams = filteredTeams.filter(t => t.eventId === eventFilter);
    }

    if (searchQuery) {
        filteredTeams = filteredTeams.filter(t => 
            t.teamName.toLowerCase().includes(searchQuery) ||
            (t.adminEmail && t.adminEmail.toLowerCase().includes(searchQuery))
        );
    }

    // Sort by creation date (newest first)
    filteredTeams.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (filteredTeams.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="6" class="empty-state">${searchQuery || eventFilter ? 'No teams match your filters' : 'No teams registered yet'}</td></tr>
        `;
        return;
    }

    tbody.innerHTML = filteredTeams.map(team => {
        const event = allEvents.find(e => e.id === team.eventId);
        const createdDate = new Date(team.createdAt).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        
        const memberCount = teamCounts[team.id] || 0;
        const committed = team.committedParticipants || 3;
        
        let countClass = 'partial';
        if (memberCount >= committed) {
            countClass = 'full';
        } else if (memberCount === 0) {
            countClass = 'empty';
        }

        const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');

        return `
            <tr>
                <td><strong>${escapeHtml(team.teamName)}</strong></td>
                <td>${event ? escapeHtml(event.name) : '<em style="color:#94a3b8">Unknown</em>'}</td>
                <td style="color: #64748b;">${escapeHtml(team.adminEmail || 'Unknown')}</td>
                <td><span class="badge ${countClass}">${memberCount}/${committed}</span></td>
                <td style="color: #64748b;">${createdDate}</td>
                <td style="display: flex; gap: 6px; align-items: center;">
                    <a href="event.html?id=${team.eventId}" class="btn-sm">View Event</a>
                    ${canDelete ? `<button class="btn-sm" style="color: #dc2626; border-color: #fca5a5;" onclick="deleteTeam('${team.id}', '${escapeHtml(team.teamName).replace(/'/g, "\\'")}')">🗑️</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

function updateStats() {
    const totalTeams = allTeams.length;
    let totalParticipants = 0;
    let totalCommitted = 0;

    allTeams.forEach(team => {
        totalParticipants += teamCounts[team.id] || 0;
        totalCommitted += team.committedParticipants || 3;
    });

    const fillRate = totalCommitted > 0 
        ? Math.round((totalParticipants / totalCommitted) * 100) 
        : 0;

    document.getElementById('total-teams').textContent = totalTeams;
    document.getElementById('total-participants').textContent = totalParticipants;
    document.getElementById('total-committed').textContent = totalCommitted;
    document.getElementById('fill-rate').textContent = fillRate + '%';
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function deleteTeam(teamId, teamName) {
    if (!confirm(`Are you sure you want to delete team "${teamName}"?\n\nThis will also remove:\n• Team memberships from all participants\n• Hotel bookings (for participants with no other role)\n• Badge claims for this team\n• Pending invitations\n\nThis action cannot be undone.`)) {
        return;
    }

    try {
        await API.teams.delete(teamId);
        allTeams = allTeams.filter(t => t.id !== teamId);
        delete teamCounts[teamId];
        renderTeamsTable();
        updateStats();
    } catch (error) {
        console.error('Error deleting team:', error);
        alert('Failed to delete team: ' + error.message);
    }
}

console.log('Admin Teams page loaded');
