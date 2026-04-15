// ACDC Portal - Admin Teams Management

let currentUser = null;
let allEvents = [];
let allTeams = [];
let teamCounts = {};
let allParticipations = [];
let allUsers = [];
let allInvitations = [];
const expandedTeams = new Set();
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
        clearTimeout(wakeTimer);
        adminContent.classList.remove('hidden');

    } catch (error) {
        console.error('Error:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error: ${error.message}</p>`;
    }
});

async function loadData() {
    try {
        const [events, teams, participations, users, invitations] = await Promise.all([
            API.events.list(),
            API.teams.list(),
            API.participations.list(),
            API.users.list(),
            API.invitations.list()
        ]);

        // Scope event-bearing entities by permissions
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        allTeams = Permissions.filterByEvent(currentPermissions, teams);
        allParticipations = Permissions.filterByEvent(currentPermissions, participations);
        allUsers = users || [];
        allInvitations = (invitations || []).filter(i => i.status === 'pending');

        populateEventFilter();

        // Compute team counts from loaded participations
        teamCounts = {};
        allTeams.forEach(team => {
            teamCounts[team.id] = getTeamMembers(team.id).length;
        });

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
        filteredTeams = filteredTeams.filter(t => {
            const adminInfo = getTeamAdminInfo(t.id);
            return t.teamName.toLowerCase().includes(searchQuery) ||
                adminInfo.name.toLowerCase().includes(searchQuery) ||
                adminInfo.email.toLowerCase().includes(searchQuery);
        });
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
        const pendingCount = allInvitations.filter(i => i.teamId === team.id).length;
        const committed = team.committedParticipants || 3;
        
        let countClass = 'partial';
        if (memberCount >= committed) {
            countClass = 'full';
        } else if (memberCount === 0) {
            countClass = 'empty';
        }

        const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');
        const members = getTeamMembers(team.id);
        const isExpanded = expandedTeams.has(team.id);
        const eventUrl = `admin-events.html?event=${team.eventId}&tab=teams`;
        const adminInfo = getTeamAdminInfo(team.id);

        const memberRows = members.map(member => {
            const displayName = (member.user?.firstName || member.user?.lastName)
                ? `${member.user?.firstName || ''} ${member.user?.lastName || ''}`.trim()
                : (member.user?.email || member.participation?.email || 'Unknown');
            const displayEmail = member.user?.email || member.participation?.email || '';
            const roleBadge = member.participation?.isTeamAdmin
                ? '<span class="badge full" style="margin-left:6px;">Admin</span>'
                : '';

            const removeBtn = canDelete
                ? `<button class="btn-sm" style="color:#dc2626;border-color:#fca5a5;" onclick="removeTeamMember('${member.participation.id}', '${escapeHtml(displayName).replace(/'/g, "\\'")}', '${team.id}')">Remove</button>`
                : '';

            return `
                <tr>
                    <td><strong>${escapeHtml(displayName)}</strong>${roleBadge}</td>
                    <td style="color:#64748b;">${escapeHtml(displayEmail)}</td>
                    <td style="text-align:right;">${removeBtn}</td>
                </tr>
            `;
        }).join('');

        const pendingInvites = allInvitations.filter(i => i.teamId === team.id);
        const inviteRows = pendingInvites.map(invite => {
            const isExpiredInvite = invite.isExpired;
            const cancelBtn = canDelete
                ? `<button class="btn-sm" style="color:#dc2626;border-color:#fca5a5;" onclick="cancelInvitation('${invite.id}', '${escapeHtml(invite.email).replace(/'/g, "\\'")}', '${team.id}')">Cancel</button>`
                : '';
            return `
                <tr style="opacity:${isExpiredInvite ? '0.6' : '1'}">
                    <td><em style="color:#64748b;">${escapeHtml(invite.email)}</em></td>
                    <td><span class="badge partial" style="font-size:0.7rem;">${isExpiredInvite ? 'Expired' : 'Invited'}</span></td>
                    <td style="text-align:right;">${cancelBtn}</td>
                </tr>
            `;
        }).join('');

        const totalShown = members.length + pendingInvites.length;
        const detailsHtml = isExpanded ? `
            <tr class="member-details-row">
                <td colspan="6">
                    <div class="member-details-wrap">
                        <div class="member-title">Team Members (${members.length})${pendingInvites.length > 0 ? ` &nbsp;·&nbsp; <span style="color:#64748b;font-weight:normal;">${pendingInvites.length} pending invite${pendingInvites.length > 1 ? 's' : ''}</span>` : ''}</div>
                        ${totalShown === 0
                            ? '<div class="member-empty">No members or invitations yet.</div>'
                            : `<table class="member-list"><tbody>${memberRows}${inviteRows}</tbody></table>`}
                    </div>
                </td>
            </tr>
        ` : '';

        return `
            <tr class="team-main-row ${isExpanded ? 'expanded' : ''}">
                <td><strong>${escapeHtml(team.teamName)}</strong></td>
                <td>${event ? escapeHtml(event.name) : '<em style="color:#94a3b8">Unknown</em>'}</td>
                <td style="color: #64748b;">${escapeHtml(adminInfo.name || adminInfo.email || 'Unknown')}</td>
                <td><span class="badge ${countClass}" title="${memberCount} members${pendingCount > 0 ? ', ' + pendingCount + ' invited' : ''}">${memberCount}${pendingCount > 0 ? '+' + pendingCount : ''}/${committed}</span></td>
                <td style="color: #64748b;">${createdDate}</td>
                <td style="display: flex; gap: 6px; align-items: center;">
                    <button class="btn-sm expand-btn" onclick="toggleTeamMembers('${team.id}')">${isExpanded ? 'Hide' : 'Members'}</button>
                    <a href="${eventUrl}" class="btn-sm">View Event</a>
                    ${canDelete ? `<button class="btn-sm" style="color: #dc2626; border-color: #fca5a5;" onclick="deleteTeam('${team.id}', '${escapeHtml(team.teamName).replace(/'/g, "\\'")}')">🗑️</button>` : ''}
                </td>
            </tr>
            ${detailsHtml}
        `;
    }).join('');
}

function getTeamAdminInfo(teamId) {
    // Prefer explicit team-admin participation
    const adminParticipation = allParticipations.find(p =>
        (p.teamMemberships || []).some(m => m.teamId === teamId && m.isAdmin)
    ) || allParticipations.find(p => p.teamId === teamId && p.isTeamAdmin);

    if (!adminParticipation) {
        return { name: '', email: '' };
    }

    const user = allUsers.find(u => u.id === adminParticipation.userId);
    if (user) {
        const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        return { name, email: user.email || adminParticipation.email || '' };
    }

    return {
        name: '',
        email: adminParticipation.email || ''
    };
}

function getTeamMembers(teamId) {
    return allParticipations
        .filter(p => {
            if ((p.teamMemberships || []).some(m => m.teamId === teamId && m.isParticipant)) return true;
            return p.teamId === teamId && (p.roles || []).includes('participant');
        })
        .map(participation => {
            const user = allUsers.find(u => u.id === participation.userId) || null;
            return { participation, user };
        });
}

function toggleTeamMembers(teamId) {
    if (expandedTeams.has(teamId)) {
        expandedTeams.delete(teamId);
    } else {
        expandedTeams.add(teamId);
    }
    renderTeamsTable();
}

async function cancelInvitation(inviteId, email, teamId) {
    if (!confirm(`Cancel invitation for "${email}"?`)) return;
    try {
        await API.invitations.cancel(inviteId);
        allInvitations = allInvitations.filter(i => i.id !== inviteId);
        renderTeamsTable();
        updateStats();
    } catch (error) {
        console.error('Error cancelling invitation:', error);
        alert('Failed to cancel invitation: ' + error.message);
    }
}

async function removeTeamMember(participationId, memberName, teamId) {
    if (!confirm(`Remove "${memberName}" from this team?\n\nThis only removes their team assignment.`)) {
        return;
    }

    try {
        await API.participations.assignTeam(participationId, null, false);

        const idx = allParticipations.findIndex(p => p.id === participationId);
        if (idx >= 0) {
            allParticipations[idx] = {
                ...allParticipations[idx],
                teamId: null,
                isTeamAdmin: false,
                teamMemberships: []
            };
        }

        teamCounts[teamId] = getTeamMembers(teamId).length;
        renderTeamsTable();
        updateStats();
    } catch (error) {
        console.error('Error removing team member:', error);
        alert('Failed to remove team member: ' + error.message);
    }
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
    if (!confirm(`Are you sure you want to delete team "${teamName}"?\n\nThis will also remove:\n� Team memberships from all participants\n� Hotel bookings (for participants with no other role)\n� Badge claims for this team\n� Pending invitations\n\nThis action cannot be undone.`)) {
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
