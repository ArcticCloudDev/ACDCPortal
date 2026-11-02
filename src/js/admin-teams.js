let currentUser = null;
let allEvents = [];
let allTeams = [];
let teamCounts = {};
let allParticipations = [];
let allUsers = [];
let allInvitations = [];
const expandedTeams = new Set();
let currentPermissions = null;
let highlightedTeamId = null;

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

    currentPermissions = await Permissions.initAdminPage('teams', {
        loadingEl: loadingDiv,
        accessDeniedEl: notCommitteeDiv,
        contentEl: adminContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        await loadData();

        setupFilters();
        setupTableActions();

        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        adminContent.classList.remove('hidden');

        focusTeamFromUrl();

    } catch (error) {
        console.error('Error:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error: ${escapeHtml(error.message)}</p>`;
    }
});

// admin-events.html links here with ?team=<id>: show that team's event, expand it and scroll to it.
function focusTeamFromUrl() {
    const requested = new URLSearchParams(window.location.search).get('team');
    if (!requested) return;
    const team = allTeams.find(t => sameId(t.id, requested));
    if (!team) return;

    highlightedTeamId = team.id;
    expandedTeams.add(team.id);
    const eventFilter = document.getElementById('event-filter');
    const option = Array.from(eventFilter.options).find(o => sameId(o.value, team.eventId));
    if (option) eventFilter.value = option.value;
    renderTeamsTable();

    const row = document.querySelector('tr.team-main-row.highlighted');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
}

async function loadData() {
    try {
        const [events, teams, participations, users, invitations] = await Promise.all([
            API.events.list(),
            API.teams.list(),
            API.participations.list(),
            API.users.list(),
            API.invitations.list()
        ]);

        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        allTeams = Permissions.filterByEvent(currentPermissions, teams);
        allParticipations = Permissions.filterByEvent(currentPermissions, participations);
        allUsers = users || [];
        allInvitations = (invitations || []).filter(i => i.status === 'pending');

        populateEventFilter();

        teamCounts = {};
        allTeams.forEach(team => {
            teamCounts[team.id] = getTeamMembers(team.id).length;
        });

        renderTeamsTable();
        updateStats();

    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function populateEventFilter() {
    const eventFilter = document.getElementById('event-filter');

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

// All row buttons carry data-action/data-* attributes; one listener on the table handles them.
function setupTableActions() {
    document.getElementById('teams-table-body').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const { action, teamId, participationId, inviteId } = btn.dataset;
        switch (action) {
            case 'toggle-members':
                toggleTeamMembers(teamId);
                break;
            case 'remove-member':
                removeTeamMember(participationId, teamId, btn);
                break;
            case 'cancel-invite':
                cancelInvitation(inviteId, teamId, btn);
                break;
            case 'delete-team':
                deleteTeam(teamId, btn);
                break;
        }
    });
}

function committedSize(team) {
    // Team size lives in numberOfParticipants (there is no committedParticipants column).
    const n = Number(team.numberOfParticipants);
    return Number.isFinite(n) && n > 0 ? n : 3;
}

function renderTeamsTable() {
    const tbody = document.getElementById('teams-table-body');
    const eventFilter = document.getElementById('event-filter').value;
    const searchQuery = document.getElementById('search-teams').value.toLowerCase().trim();

    let filteredTeams = [...allTeams];

    if (eventFilter) {
        filteredTeams = filteredTeams.filter(t => sameId(t.eventId, eventFilter));
    }

    if (searchQuery) {
        filteredTeams = filteredTeams.filter(t => {
            const adminInfo = getTeamAdminInfo(t.id);
            return (t.teamName || '').toLowerCase().includes(searchQuery) ||
                adminInfo.name.toLowerCase().includes(searchQuery) ||
                adminInfo.email.toLowerCase().includes(searchQuery);
        });
    }

    filteredTeams.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (filteredTeams.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="6" class="empty-state">${searchQuery || eventFilter ? 'No teams match your filters' : 'No teams registered yet'}</td></tr>
        `;
        return;
    }

    const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');

    tbody.innerHTML = filteredTeams.map(team => {
        const event = allEvents.find(e => sameId(e.id, team.eventId));
        const createdDate = new Date(team.createdAt).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });

        const memberCount = teamCounts[team.id] || 0;
        const pendingInvites = allInvitations.filter(i => sameId(i.teamId, team.id));
        const pendingCount = pendingInvites.length;
        const committed = committedSize(team);

        let countClass = 'partial';
        if (memberCount >= committed) {
            countClass = 'full';
        } else if (memberCount === 0) {
            countClass = 'empty';
        }

        const members = getTeamMembers(team.id);
        const teamAdmin = getTeamAdminMember(team);
        const displayedMembers = teamAdmin && !members.some(member => sameId(member.participation.userId, teamAdmin.participation.userId))
            ? [teamAdmin, ...members]
            : members;
        const isExpanded = expandedTeams.has(team.id);
        const eventUrl = `admin-events.html?event=${encodeURIComponent(team.eventId)}&tab=teams`;
        const adminInfo = getTeamAdminInfo(team.id);
        const teamIdAttr = escapeHtml(team.id);

        const memberRows = displayedMembers.map(member => {
            const displayName = (member.user?.firstName || member.user?.lastName)
                ? `${member.user?.firstName || ''} ${member.user?.lastName || ''}`.trim()
                : (member.user?.email || member.participation?.email || 'Unknown');
            const displayEmail = member.user?.email || member.participation?.email || '';
            const roleBadge = member.isRegisteredAdmin || member.participation?.isTeamAdmin
                ? '<span class="badge full" style="margin-left:6px;">Admin</span>'
                : '';

            const removeBtn = canDelete && !member.isRegisteredAdmin
                ? `<button type="button" class="btn-sm" style="color:#dc2626;border-color:#fca5a5;" data-action="remove-member" data-participation-id="${escapeHtml(member.participation.id)}" data-team-id="${teamIdAttr}">Remove</button>`
                : '';

            return `
                <tr>
                    <td><strong>${escapeHtml(displayName)}</strong>${roleBadge}</td>
                    <td style="color:#64748b;">${escapeHtml(displayEmail)}</td>
                    <td style="text-align:right;">${removeBtn}</td>
                </tr>
            `;
        }).join('');

        const inviteRows = pendingInvites.map(invite => {
            const isExpiredInvite = invite.isExpired;
            const cancelBtn = canDelete
                ? `<button type="button" class="btn-sm" style="color:#dc2626;border-color:#fca5a5;" data-action="cancel-invite" data-invite-id="${escapeHtml(invite.id)}" data-team-id="${teamIdAttr}">Cancel</button>`
                : '';
            return `
                <tr style="opacity:${isExpiredInvite ? '0.6' : '1'}">
                    <td><em style="color:#64748b;">${escapeHtml(invite.email)}</em></td>
                    <td><span class="badge partial" style="font-size:0.7rem;">${isExpiredInvite ? 'Expired' : 'Invited'}</span></td>
                    <td style="text-align:right;">${cancelBtn}</td>
                </tr>
            `;
        }).join('');

        const totalShown = displayedMembers.length + pendingInvites.length;
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

        const highlighted = highlightedTeamId && sameId(highlightedTeamId, team.id) ? ' highlighted' : '';

        return `
            <tr class="team-main-row ${isExpanded ? 'expanded' : ''}${highlighted}" data-team-id="${teamIdAttr}">
                <td><strong>${escapeHtml(team.teamName)}</strong></td>
                <td>${event ? escapeHtml(event.name) : '<em style="color:#94a3b8">Unknown</em>'}</td>
                <td style="color: #64748b;">${escapeHtml(adminInfo.name || adminInfo.email || 'Unknown')}</td>
                <td><span class="badge ${countClass}" title="${memberCount} members${pendingCount > 0 ? ', ' + pendingCount + ' invited' : ''}">${memberCount}${pendingCount > 0 ? '+' + pendingCount : ''}/${committed}</span></td>
                <td style="color: #64748b;">${createdDate}</td>
                <td style="display: flex; gap: 6px; align-items: center;">
                    <button type="button" class="btn-sm expand-btn" data-action="toggle-members" data-team-id="${teamIdAttr}">${isExpanded ? 'Hide' : 'Members'}</button>
                    <a href="${eventUrl}" class="btn-sm">View Event</a>
                    ${canDelete ? `<button type="button" class="btn-sm" style="color: #dc2626; border-color: #fca5a5;" data-action="delete-team" data-team-id="${teamIdAttr}">🗑️</button>` : ''}
                </td>
            </tr>
            ${detailsHtml}
        `;
    }).join('');
}

function getTeamAdminInfo(teamId) {
    const team = allTeams.find(t => sameId(t.id, teamId));
    const adminUser = team?.adminUserId ? allUsers.find(u => sameId(u.id, team.adminUserId)) : null;
    if (adminUser) {
        return {
            name: `${adminUser.firstName || ''} ${adminUser.lastName || ''}`.trim(),
            email: adminUser.email || ''
        };
    }

    const adminParticipation = allParticipations.find(p =>
        p.userId && sameId(p.userId, team?.adminUserId)
    ) || allParticipations.find(p =>
        (p.teamMemberships || []).some(m => sameId(m.teamId, teamId) && m.isAdmin)
    ) || allParticipations.find(p => sameId(p.teamId, teamId) && p.isTeamAdmin);

    if (!adminParticipation) {
        return { name: '', email: '' };
    }

    const user = allUsers.find(u => sameId(u.id, adminParticipation.userId));
    if (user) {
        const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        return { name, email: user.email || adminParticipation.email || '' };
    }

    return {
        name: '',
        email: adminParticipation.email || ''
    };
}

function getTeamAdminMember(team) {
    if (!team?.adminUserId) return null;

    const user = allUsers.find(u => sameId(u.id, team.adminUserId));
    const participation = allParticipations.find(p =>
        sameId(p.userId, team.adminUserId) && sameId(p.eventId, team.eventId)
    );

    if (!user && !participation) return null;

    return {
        participation: participation || {
            id: `admin-${team.id}`,
            userId: team.adminUserId,
            email: user?.email || ''
        },
        user,
        isRegisteredAdmin: true
    };
}

function getTeamMembers(teamId) {
    return allParticipations
        .filter(p => {
            if ((p.teamMemberships || []).some(m => sameId(m.teamId, teamId) && m.isParticipant)) return true;
            return sameId(p.teamId, teamId) && (p.roles || []).includes('participant');
        })
        .map(participation => {
            const user = allUsers.find(u => sameId(u.id, participation.userId)) || null;
            return { participation, user };
        });
}

function toggleTeamMembers(teamId) {
    const team = allTeams.find(t => sameId(t.id, teamId));
    const key = team ? team.id : teamId;
    if (expandedTeams.has(key)) {
        expandedTeams.delete(key);
    } else {
        expandedTeams.add(key);
    }
    renderTeamsTable();
}

async function cancelInvitation(inviteId, teamId, button) {
    const invite = allInvitations.find(i => sameId(i.id, inviteId));
    const email = invite?.email || 'this address';
    if (!confirm(`Cancel invitation for "${email}"?`)) return;
    await withBusy(button, 'Cancelling...', async () => {
        try {
            await API.invitations.cancel(inviteId);
            allInvitations = allInvitations.filter(i => !sameId(i.id, inviteId));
            renderTeamsTable();
            updateStats();
        } catch (error) {
            console.error('Error cancelling invitation:', error);
            alert('Failed to cancel invitation: ' + error.message);
        }
    });
}

async function removeTeamMember(participationId, teamId, button) {
    const member = allParticipations.find(p => sameId(p.id, participationId));
    const user = member ? allUsers.find(u => sameId(u.id, member.userId)) : null;
    const memberName = (user?.firstName || user?.lastName)
        ? `${user?.firstName || ''} ${user?.lastName || ''}`.trim()
        : (user?.email || member?.email || 'this member');

    if (!confirm(`Remove "${memberName}" from this team?\n\nThis only removes their team assignment.`)) {
        return;
    }

    await withBusy(button, 'Removing...', async () => {
        try {
            await API.participations.assignTeam(participationId, null, false);

            const idx = allParticipations.findIndex(p => sameId(p.id, participationId));
            if (idx >= 0) {
                allParticipations[idx] = {
                    ...allParticipations[idx],
                    teamId: null,
                    isTeamAdmin: false,
                    teamMemberships: []
                };
            }

            const team = allTeams.find(t => sameId(t.id, teamId));
            if (team) teamCounts[team.id] = getTeamMembers(team.id).length;
            renderTeamsTable();
            updateStats();
        } catch (error) {
            console.error('Error removing team member:', error);
            alert('Failed to remove team member: ' + error.message);
        }
    });
}

function updateStats() {
    const totalTeams = allTeams.length;
    let totalParticipants = 0;
    let totalCommitted = 0;

    allTeams.forEach(team => {
        totalParticipants += teamCounts[team.id] || 0;
        totalCommitted += committedSize(team);
    });

    const fillRate = totalCommitted > 0
        ? Math.round((totalParticipants / totalCommitted) * 100)
        : 0;

    document.getElementById('total-teams').textContent = totalTeams;
    document.getElementById('total-participants').textContent = totalParticipants;
    document.getElementById('total-committed').textContent = totalCommitted;
    document.getElementById('fill-rate').textContent = fillRate + '%';
}

async function deleteTeam(teamId, button) {
    const team = allTeams.find(t => sameId(t.id, teamId));
    const teamName = team?.teamName || 'this team';
    if (!confirm(`Are you sure you want to delete team "${teamName}"?\n\nThis will also remove:\n• Team memberships from all participants\n• Hotel bookings (for participants with no other role)\n• Badge claims for this team\n• Pending invitations\n\nThis action cannot be undone.`)) {
        return;
    }

    await withBusy(button, '⏳', async () => {
        try {
            await API.teams.delete(teamId);
            allTeams = allTeams.filter(t => !sameId(t.id, teamId));
            if (team) delete teamCounts[team.id];
            renderTeamsTable();
            updateStats();
        } catch (error) {
            console.error('Error deleting team:', error);
            alert('Failed to delete team: ' + error.message);
        }
    });
}
