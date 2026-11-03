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
        loadingDiv.innerHTML = `
            <div class="notice notice-danger">${icon('triangle-alert')}<div><div class="notice-title">Could not load teams</div><div class="notice-body">${escapeHtml(error.message)}</div></div></div>
        `;
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
        'pre-registration': 'Pre-registration',
        'registration': 'Registration open',
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

        // Full team = success (done), no members yet = warning (needs attention), in between = neutral.
        let countTone = '';
        if (memberCount >= committed) {
            countTone = ' badge-success';
        } else if (memberCount === 0) {
            countTone = ' badge-warning';
        }

        const members = getTeamMembers(team.id);
        const teamAdmin = getTeamAdminMember(team);
        const displayedMembers = teamAdmin && !members.some(member => sameId(member.participation.userId, teamAdmin.participation.userId))
            ? [teamAdmin, ...members]
            : members;
        const isExpanded = expandedTeams.has(team.id);
        const adminInfo = getTeamAdminInfo(team.id);
        const teamIdAttr = escapeHtml(team.id);
        const teamName = team.teamName || 'Unnamed team';
        const detailsId = `team-members-${teamIdAttr}`;

        const memberRows = displayedMembers.map(member => {
            const displayName = (member.user?.firstName || member.user?.lastName)
                ? `${member.user?.firstName || ''} ${member.user?.lastName || ''}`.trim()
                : (member.user?.email || member.participation?.email || 'Unknown');
            const displayEmail = member.user?.email || member.participation?.email || '';
            const roleBadge = member.isRegisteredAdmin || member.participation?.isTeamAdmin
                ? '<span class="badge badge-accent">Team admin</span>'
                : '';

            const removeBtn = canDelete && !member.isRegisteredAdmin
                ? `<button type="button" class="btn-sm danger-ghost" data-action="remove-member" data-participation-id="${escapeHtml(member.participation.id)}" data-team-id="${teamIdAttr}" aria-label="Remove ${escapeHtml(displayName)} from ${escapeHtml(teamName)}">Remove</button>`
                : '';

            return `
                <tr>
                    <td>
                        <div class="member-person">
                            <span class="avatar" aria-hidden="true">${escapeHtml(initialsFor(member.user, displayEmail))}</span>
                            <span class="member-text">
                                <span class="member-name"><strong>${escapeHtml(displayName)}</strong>${roleBadge}</span>
                                ${displayEmail && displayEmail !== displayName ? `<span class="member-email">${escapeHtml(displayEmail)}</span>` : ''}
                            </span>
                        </div>
                    </td>
                    <td class="member-action">${removeBtn}</td>
                </tr>
            `;
        }).join('');

        const inviteRows = pendingInvites.map(invite => {
            const isExpiredInvite = invite.isExpired;
            const cancelBtn = canDelete
                ? `<button type="button" class="btn-sm danger-ghost" data-action="cancel-invite" data-invite-id="${escapeHtml(invite.id)}" data-team-id="${teamIdAttr}" aria-label="Cancel the invitation for ${escapeHtml(invite.email)}">Cancel invite</button>`
                : '';
            return `
                <tr class="member-invite${isExpiredInvite ? ' is-expired' : ''}">
                    <td>
                        <div class="member-person">
                            <span class="avatar avatar-invite" aria-hidden="true">${icon('mail', 'icon-sm')}</span>
                            <span class="member-text">
                                <span class="member-name">${escapeHtml(invite.email)}${isExpiredInvite
                                    ? '<span class="badge">Invitation expired</span>'
                                    : '<span class="badge badge-warning">Invitation pending</span>'}</span>
                            </span>
                        </div>
                    </td>
                    <td class="member-action">${cancelBtn}</td>
                </tr>
            `;
        }).join('');

        const totalShown = displayedMembers.length + pendingInvites.length;
        const detailsHtml = isExpanded ? `
            <tr class="member-details-row" id="${detailsId}">
                <td colspan="6">
                    <div class="member-details-wrap">
                        <div class="member-title">Team members (${members.length})${pendingInvites.length > 0 ? `<span class="member-title-meta">${pendingInvites.length} pending invite${pendingInvites.length > 1 ? 's' : ''}</span>` : ''}</div>
                        ${totalShown === 0
                            ? '<div class="member-empty">No members or invitations yet.</div>'
                            : `<table class="member-list"><tbody>${memberRows}${inviteRows}</tbody></table>`}
                    </div>
                </td>
            </tr>
        ` : '';

        const highlighted = highlightedTeamId && sameId(highlightedTeamId, team.id) ? ' highlighted' : '';
        const adminLabel = adminInfo.name || adminInfo.email;
        // The event name opens that event in the event editor, like event names elsewhere in admin.
        const eventCell = event
            ? `<a class="table-link" href="admin-events.html?event=${encodeURIComponent(event.id)}" title="Open ${escapeHtml(event.name)} in the event editor">${icon('calendar-days', 'icon-sm cell-icon')}${escapeHtml(event.name)}</a>`
            : `<span class="text-muted">${icon('calendar-days', 'icon-sm cell-icon')}Unknown event</span>`;

        return `
            <tr class="team-main-row ${isExpanded ? 'expanded' : ''}${highlighted}" data-team-id="${teamIdAttr}">
                <td class="col-team"><strong>${escapeHtml(teamName)}</strong></td>
                <td class="col-event">${eventCell}</td>
                <td class="col-admin${adminLabel ? '' : ' text-muted'}">${icon('user', 'icon-sm cell-icon')}${escapeHtml(adminLabel || (team.adminUserId ? 'Unknown' : 'No admin'))}</td>
                <td class="col-members"><span class="badge${countTone} team-count" title="${memberCount} of ${committed} places filled">${memberCount} / ${committed}</span>${pendingCount > 0 ? `<span class="team-invited">+${pendingCount} invited</span>` : ''}</td>
                <td class="col-created text-muted"><span class="cell-label">Created </span>${createdDate}</td>
                <td class="col-actions">
                    <div class="row-actions">
                        <button type="button" class="btn-sm expand-btn" data-action="toggle-members" data-team-id="${teamIdAttr}" aria-expanded="${isExpanded}"${isExpanded ? ` aria-controls="${detailsId}"` : ''}>Members${icon('chevron-down', 'icon-sm expand-chevron')}</button>
                        ${canDelete ? `<button type="button" class="btn-sm icon-only danger-ghost" data-action="delete-team" data-team-id="${teamIdAttr}" aria-label="Delete team ${escapeHtml(teamName)}" title="Delete team">${icon('trash-2', 'icon-sm')}</button>` : ''}
                    </div>
                </td>
            </tr>
            ${detailsHtml}
        `;
    }).join('');
}

// Avatar initials for the member list; falls back to the first letter of the email.
function initialsFor(user, email) {
    const letters = `${(user?.firstName || '').trim().charAt(0)}${(user?.lastName || '').trim().charAt(0)}`;
    return letters || (email || '?').trim().charAt(0) || '?';
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
    // The table re-renders; keep keyboard focus on the toggle that was used.
    const toggle = document.querySelector(`.expand-btn[data-team-id="${CSS.escape(String(key))}"]`);
    if (toggle) toggle.focus();
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

    // No busy label: the button is icon-only, so it shows its disabled/busy state instead.
    await withBusy(button, '', async () => {
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
