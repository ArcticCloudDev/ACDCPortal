let currentEvent = null;
let currentUser = null;
let allParticipants = [];
let allTeams = [];
let allUsers = [];
let currentPermissions = null;

let NIGHT_KEYS = [];
let NIGHT_LABELS = [];
let NIGHT_ARROWS = {};

function computeHotelColumns(startDate, endDate) {
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const start = new Date(startDate + 'T12:00:00');
    start.setDate(start.getDate() - 1);
    const end = new Date(endDate + 'T12:00:00');
    end.setDate(end.getDate() + 1);

    const dates = [];
    const current = new Date(start);
    while (current <= end) {
        dates.push({ dayLabel: dayLabels[current.getDay()] });
        current.setDate(current.getDate() + 1);
    }

    NIGHT_KEYS = [];
    NIGHT_LABELS = [];
    NIGHT_ARROWS = {};
    for (let i = 0; i < dates.length - 1; i++) {
        const from = dates[i].dayLabel;
        const to = dates[i + 1].dayLabel;
        const key = `${from.toLowerCase()}-${to.toLowerCase()}`;
        NIGHT_KEYS.push(key);
        NIGHT_LABELS.push(from);
        NIGHT_ARROWS[key] = `${from} → ${to}`;
    }
}

function buildTableHeaders() {
    const thead = document.getElementById('participants-thead');
    const nightHeaders = NIGHT_KEYS.map((key, i) =>
        `<th scope="col" class="night-cell" title="Night ${escapeHtml(NIGHT_ARROWS[key] || key)}">${escapeHtml(NIGHT_LABELS[i])}</th>`
    ).join('');
    const colCount = 4 + NIGHT_KEYS.length + 2;
    thead.innerHTML = `<tr>
        <th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th>
        ${nightHeaders}
        <th scope="col">Nights</th><th scope="col">Allergies and diet</th><th scope="col" class="col-actions"><span class="visually-hidden">Actions</span></th>
    </tr>`;
    const body = document.getElementById('participants-body');
    body.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">Loading participants...</td></tr>`;
}

async function init() {
    currentPermissions = await Permissions.initAdminPage('event-participants', {
        contentEl: document.getElementById('admin-content'),
        accessDeniedEl: document.getElementById('not-committee')
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        const urlParams = new URLSearchParams(window.location.search);
        const eventId = urlParams.get('id');

        if (!eventId) {
            window.location.href = 'admin-events.html';
            return;
        }

        if (!Permissions.canAccessEvent(currentPermissions, eventId)) {
            document.getElementById('admin-content').classList.add('hidden');
            document.getElementById('not-committee').classList.remove('hidden');
            return;
        }

        await loadEventData(eventId);
        setupFilters();
    } catch (err) {
        console.error('Init error:', err);
    }
}

async function loadEventData(eventId) {
    try {
        const [eventsRes, teamsRes, usersRes, participationsRes] = await Promise.all([
            API.events.list(),
            API.teams.list(),
            API.users.list(),
            API.participations.list()
        ]);

        const events = eventsRes.events || eventsRes || [];
        allTeams = teamsRes.teams || teamsRes || [];
        allUsers = usersRes.users || usersRes || [];
        const participations = participationsRes.participations || participationsRes || [];

        currentEvent = events.find(e => sameId(e.id, eventId));
        if (!currentEvent) {
            document.getElementById('participants-body').innerHTML =
                '<tr><td colspan="20" class="empty-state">Event not found</td></tr>';
            return;
        }

        allTeams = allTeams.filter(t => sameId(t.eventId, currentEvent.id));

        computeHotelColumns(currentEvent.startDate, currentEvent.endDate);
        buildTableHeaders();

        const eventParticipations = participations.filter(p => sameId(p.eventId, currentEvent.id));

        allParticipants = eventParticipations.map(p => {
            const user = allUsers.find(u => sameId(u.id, p.userId)) || {};

            const team = p.teamId ? allTeams.find(t => sameId(t.id, p.teamId)) : null;

            return {
                id: p.id,
                userId: p.userId,
                firstName: user.firstName || 'Unknown',
                lastName: user.lastName || '',
                email: user.email || p.email || '',
                phone: user.phone || '',
                allergies: user.allergies || '',
                teamId: team?.id || null,
                teamName: team?.teamName || null,
                isTeamAdmin: p.isTeamAdmin || false,
                hotelNights: p.hotelNights || {},
                hotelPaidBy: p.hotelPaidBy || null,
                roles: normalizeRoles(p.roles)
            };
        });

        updateUI();

    } catch (err) {
        console.error('Failed to load data:', err);
        document.getElementById('participants-body').innerHTML =
            '<tr><td colspan="20" class="empty-state">Failed to load data</td></tr>';
    }
}

function updateUI() {
    updateSummary();
    renderParticipants();
    renderHotelSummary();
}

function updateSummary() {
    const breadcrumb = document.getElementById('event-name-breadcrumb');
    breadcrumb.textContent = currentEvent.name;
    // The event crumb opens this event in the event editor (its parent page).
    breadcrumb.href = `admin-events.html?event=${encodeURIComponent(currentEvent.id)}`;
    document.getElementById('stat-event-name').textContent = currentEvent.name;

    const startDate = new Date(currentEvent.startDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endDate = new Date(currentEvent.endDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('stat-event-dates').textContent = `${startDate} – ${endDate}`;

    const status = currentEvent.status || 'draft';
    const statusLabels = { draft: 'Draft', 'pre-registration': 'Pre-registration', waitlist: 'Waitlist', registration: 'Registration open', live: 'Live', completed: 'Completed' };
    document.getElementById('stat-status').innerHTML = `<span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>`;

    document.getElementById('stat-teams').textContent = allTeams.length;
    document.getElementById('stat-participants').textContent = allParticipants.length;

    const withAllergies = allParticipants.filter(p => p.allergies && p.allergies.trim()).length;
    document.getElementById('stat-allergies').textContent = withAllergies;
}

function renderParticipants() {
    const tbody = document.getElementById('participants-body');
    const groupBy = document.getElementById('group-filter').value;
    const showFilter = document.getElementById('show-filter').value;

    let filtered = [...allParticipants];
    if (showFilter === 'with-hotel') {
        filtered = filtered.filter(p => countHotelNights(p.hotelNights) > 0);
    } else if (showFilter === 'with-allergies') {
        filtered = filtered.filter(p => p.allergies && p.allergies.trim());
    }

    document.getElementById('participant-count').textContent = `${filtered.length} participant${filtered.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
        const colCount = 3 + NIGHT_KEYS.length + 3;
        tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">No participants match the filter</td></tr>`;
        return;
    }

    if (groupBy === 'team') {
        renderGroupedByTeam(tbody, filtered);
    } else {
        renderFlatList(tbody, filtered);
    }
}

function renderGroupedByTeam(tbody, participants) {
    const teamGroups = {};
    const committee = [];
    const judges = [];
    const noTeam = [];

    participants.forEach(p => {
        if (p.teamId) {
            if (!teamGroups[p.teamId]) {
                teamGroups[p.teamId] = { name: p.teamName, members: [] };
            }
            teamGroups[p.teamId].members.push(p);
        } else if (p.roles.includes('committee')) {
            committee.push(p);
        } else if (p.roles.includes('judge')) {
            judges.push(p);
        } else {
            noTeam.push(p);
        }
    });

    let html = '';
    const countLabel = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const groupLabel = (iconName, kind, name, count) => `
        <span class="roster-group">
            <span class="roster-group-icon" aria-hidden="true">${icon(iconName, 'icon-sm')}</span>
            <span class="visually-hidden">${kind}: </span><strong>${name}</strong>
            <span class="roster-group-count">${count}</span>
        </span>`;

    Object.entries(teamGroups).forEach(([teamId, group]) => {
        const teamNights = group.members.reduce((sum, m) => sum + countHotelNights(m.hotelNights), 0);
        html += `
            <tr class="team-header-row">
                <td colspan="${3 + NIGHT_KEYS.length}">${groupLabel('users', 'Team', escapeHtml(group.name), countLabel(group.members.length, 'member'))}</td>
                <td class="nights-total">${teamNights}</td>
                <td></td>
                <td></td>
            </tr>
        `;
        group.members.forEach(p => {
            html += renderParticipantRow(p, true);
        });
    });

    if (committee.length > 0) {
        const committeeNights = committee.reduce((sum, m) => sum + countHotelNights(m.hotelNights), 0);
        html += `
            <tr class="team-header-row committee-section">
                <td colspan="${3 + NIGHT_KEYS.length}">${groupLabel('landmark', 'Group', 'Committee', countLabel(committee.length, 'member'))}</td>
                <td class="nights-total">${committeeNights}</td>
                <td></td>
                <td></td>
            </tr>
        `;
        committee.forEach(p => {
            html += renderParticipantRow(p, true);
        });
    }

    if (judges.length > 0) {
        const judgeNights = judges.reduce((sum, m) => sum + countHotelNights(m.hotelNights), 0);
        html += `
            <tr class="team-header-row judge-section">
                <td colspan="${3 + NIGHT_KEYS.length}">${groupLabel('scale', 'Group', 'Judges', countLabel(judges.length, 'judge'))}</td>
                <td class="nights-total">${judgeNights}</td>
                <td></td>
                <td></td>
            </tr>
        `;
        judges.forEach(p => {
            html += renderParticipantRow(p, true);
        });
    }

    if (noTeam.length > 0) {
        html += `
            <tr class="team-header-row no-team-section">
                <td colspan="${3 + NIGHT_KEYS.length + 3}">${groupLabel('user', 'Group', 'No team', countLabel(noTeam.length, 'participant'))}</td>
            </tr>
        `;
        noTeam.forEach(p => {
            html += renderParticipantRow(p, true);
        });
    }

    tbody.innerHTML = html;
}

function renderFlatList(tbody, participants) {
    const sorted = [...participants].sort((a, b) =>
        `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`)
    );

    tbody.innerHTML = sorted.map(p => renderParticipantRow(p, false)).join('');
}

function normalizeRoles(roles) {
    if (Array.isArray(roles)) return roles;
    if (typeof roles === 'string') {
        return roles.split(',').map(r => r.trim()).filter(Boolean);
    }
    return [];
}

function renderParticipantRow(p, isGrouped) {
    const roles = normalizeRoles(p.roles);
    const nights = p.hotelNights || {};
    const nightCells = NIGHT_KEYS.map(key => {
        const checked = nights[key];
        return checked
            ? `<td class="night-cell checked">${icon('check', 'icon-sm')}<span class="visually-hidden">Booked</span></td>`
            : `<td class="night-cell unchecked"><span aria-hidden="true">–</span><span class="visually-hidden">Not booked</span></td>`;
    }).join('');

    const totalNights = countHotelNights(nights);

    // Who pays the hotel: neutral badge, the wallet icon says what it is about.
    const paidByLabels = { team: 'Team', committee: 'ACDC', self: 'Self' };
    const paidByLabel = p.hotelPaidBy ? paidByLabels[p.hotelPaidBy] || p.hotelPaidBy : '';
    const paidByBadge = p.hotelPaidBy && totalNights > 0
        ? `<span class="badge paid-by" title="Hotel paid by: ${escapeHtml(paidByLabel)}">${icon('wallet', 'icon-sm')}<span class="visually-hidden">Paid by </span>${escapeHtml(paidByLabel)}</span>`
        : '';

    let allergyHtml = '';
    if (p.allergies && p.allergies.trim()) {
        const items = p.allergies.split(/[,\n]/).map(s => s.trim()).filter(s => s);
        allergyHtml = items.map(a => `<span class="badge badge-warning allergy-tag">${escapeHtml(a)}</span>`).join('');
    } else {
        allergyHtml = '<span class="no-allergy">None</span>';
    }

    const adminBadge = p.isTeamAdmin ? '<span class="badge badge-accent">Team admin</span>' : '';
    const roleBadge = roles.includes('judge')
        ? '<span class="badge">Judge</span>'
        : roles.includes('committee')
            ? '<span class="badge">Committee</span>'
            : '';

    const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');
    const isTeamMember = !!p.teamId;
    const fullName = `${p.firstName} ${p.lastName}`.trim();
    const deleteBtn = canDelete && !isTeamMember
        ? `<button type="button" class="btn-sm icon-only danger-ghost btn-delete-participant" data-id="${escapeHtml(p.id)}" title="Remove from event" aria-label="Remove ${escapeHtml(fullName)} from this event">${icon('trash-2', 'icon-sm')}</button>`
        : '';

    return `
        <tr class="${isGrouped ? 'team-member-row' : ''}">
            <td class="roster-name">
                <strong>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</strong>
                ${adminBadge}${roleBadge}
            </td>
            <td>${escapeHtml(p.email)}</td>
            <td class="roster-phone">${escapeHtml(p.phone)}</td>
            ${nightCells}
            <td class="nights-total">${totalNights}${paidByBadge}</td>
            <td class="allergy-cell">${allergyHtml}</td>
            <td class="col-actions">${deleteBtn}</td>
        </tr>
    `;
}

function countHotelNights(nights) {
    if (!nights) return 0;
    return NIGHT_KEYS.filter(key => nights[key]).length;
}

function renderHotelSummary() {
    const summary = document.getElementById('hotel-summary');

    const nightCounts = {};
    NIGHT_KEYS.forEach(key => nightCounts[key] = 0);

    allParticipants.forEach(p => {
        NIGHT_KEYS.forEach(key => {
            if (p.hotelNights && p.hotelNights[key]) {
                nightCounts[key]++;
            }
        });
    });

    summary.innerHTML = NIGHT_KEYS.map(key => `
        <div class="hotel-night-stat">
            <div class="day">${escapeHtml(NIGHT_ARROWS[key] || key)}</div>
            <div class="count">${nightCounts[key]}</div>
            <div class="unit">room${nightCounts[key] === 1 ? '' : 's'}</div>
        </div>
    `).join('');
}

function setupFilters() {
    document.getElementById('group-filter').addEventListener('change', renderParticipants);
    document.getElementById('show-filter').addEventListener('change', renderParticipants);
    document.getElementById('export-btn').addEventListener('click', exportCSV);
    document.getElementById('print-btn').addEventListener('click', () => window.print());

    document.getElementById('participants-body').addEventListener('click', async (e) => {
        const btn = e.target.closest('.btn-delete-participant');
        if (!btn) return;

        const id = btn.dataset.id;
        const participant = allParticipants.find(p => sameId(p.id, id));
        if (!participant) return;
        const name = `${participant.firstName} ${participant.lastName}`.trim();
        const role = participant.roles.join(', ');

        if (!confirm(`Remove "${name}" (${role || 'participant'}) from this event?\n\nThis will delete their participation record including hotel bookings.`)) {
            return;
        }

        // No busy label: the button is icon-only, so it shows its disabled/busy state instead.
        await withBusy(btn, '', async () => {
            try {
                await API.participations.delete(participant.id);
                allParticipants = allParticipants.filter(p => !sameId(p.id, id));
                updateUI();
            } catch (error) {
                console.error('Error deleting participation:', error);
                alert('Failed to delete: ' + error.message);
            }
        });
    });
}

function exportCSV() {
    const nightHeaders = NIGHT_KEYS.map(k => NIGHT_ARROWS[k] || k);
    const rows = [
        ['Group', 'Role', 'Name', 'Email', 'Phone', ...nightHeaders, 'Total Nights', 'Paid By', 'Allergies']
    ];

    allParticipants.forEach(p => {
        const nights = p.hotelNights || {};
        const group = p.teamName || (p.roles.includes('committee') ? 'Committee' : p.roles.includes('judge') ? 'Judges' : 'Individual');
        const role = p.roles.includes('judge') ? 'Judge' : p.roles.includes('committee') ? 'Committee' : p.isTeamAdmin ? 'Team Admin' : 'Participant';
        const nightValues = NIGHT_KEYS.map(k => nights[k] ? 'Yes' : 'No');
        const paidBy = p.hotelPaidBy || '';
        rows.push([
            group,
            role,
            `${p.firstName} ${p.lastName}`,
            p.email,
            p.phone,
            ...nightValues,
            countHotelNights(nights),
            paidBy,
            p.allergies || ''
        ]);
    });

    const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentEvent.name.replace(/\s+/g, '_')}_participants.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', init);
