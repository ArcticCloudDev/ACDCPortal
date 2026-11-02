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
    const nightHeaders = NIGHT_LABELS.map(l => `<th class="night-cell">${l}</th>`).join('');
    const colCount = 4 + NIGHT_KEYS.length + 2;
    thead.innerHTML = `<tr>
        <th>Name</th><th>Email</th><th>Phone</th>
        ${nightHeaders}
        <th>Nights</th><th>Allergies / Dietary</th><th style="width:50px"></th>
    </tr>`;
    const body = document.getElementById('participants-body');
    body.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">Loading...</td></tr>`;
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
    document.getElementById('event-name-breadcrumb').textContent = currentEvent.name;
    document.getElementById('stat-event-name').textContent = currentEvent.name;

    const startDate = new Date(currentEvent.startDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endDate = new Date(currentEvent.endDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('stat-event-dates').textContent = `${startDate} - ${endDate}`;

    const status = currentEvent.status || 'draft';
    const statusLabels = { draft: 'Draft', 'pre-registration': 'Pre-Registration', waitlist: 'Waitlist', registration: 'Registration', live: 'Live', completed: 'Completed' };
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

    document.getElementById('participant-count').textContent = `${filtered.length} participants`;

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

    Object.entries(teamGroups).forEach(([teamId, group]) => {
        const teamNights = group.members.reduce((sum, m) => sum + countHotelNights(m.hotelNights), 0);
        html += `
            <tr class="team-header-row">
                <td colspan="${3 + NIGHT_KEYS.length}">
                    <span class="badge team" style="margin-right: 8px;">👥 Team</span>
                    ${escapeHtml(group.name)}
                    <span style="font-weight: normal; color: var(--admin-text-muted); margin-left: 8px;">(${group.members.length} members)</span>
                </td>
                <td><strong>${teamNights}</strong></td>
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
                <td colspan="${3 + NIGHT_KEYS.length}">
                    <span class="badge committee" style="margin-right: 8px;">🏛️ Committee</span>
                    Committee Members
                    <span style="font-weight: normal; color: var(--admin-text-muted); margin-left: 8px;">(${committee.length} members)</span>
                </td>
                <td><strong>${committeeNights}</strong></td>
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
                <td colspan="${3 + NIGHT_KEYS.length}">
                    <span class="badge judge" style="margin-right: 8px;">⚖️ Judges</span>
                    Judges Panel
                    <span style="font-weight: normal; color: var(--admin-text-muted); margin-left: 8px;">(${judges.length} members)</span>
                </td>
                <td><strong>${judgeNights}</strong></td>
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
                <td colspan="${3 + NIGHT_KEYS.length + 3}">
                    <span class="badge single" style="margin-right: 8px;">👤 No Team</span>
                    Individual Participants
                    <span style="font-weight: normal; color: var(--admin-text-muted); margin-left: 8px;">(${noTeam.length} participants)</span>
                </td>
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
        return `<td class="night-cell ${checked ? 'checked' : 'unchecked'}">${checked ? '✓' : '–'}</td>`;
    }).join('');

    const totalNights = countHotelNights(nights);

    const paidByLabels = { team: '👥 Team', committee: '🏛️ Org', self: '👤 Self' };
    const paidByColors = { team: '#3b82f6', committee: '#8b5cf6', self: '#f59e0b' };
    const paidByLabel = p.hotelPaidBy ? paidByLabels[p.hotelPaidBy] || p.hotelPaidBy : '';
    const paidByColor = p.hotelPaidBy ? paidByColors[p.hotelPaidBy] || '#94a3b8' : '';
    const paidByBadge = p.hotelPaidBy && totalNights > 0
        ? `<span style="display:inline-block;font-size:0.65rem;padding:1px 5px;border-radius:4px;background:${paidByColor}15;color:${paidByColor};border:1px solid ${paidByColor}40;margin-left:4px;">${escapeHtml(paidByLabel)}</span>`
        : '';

    let allergyHtml = '';
    if (p.allergies && p.allergies.trim()) {
        const items = p.allergies.split(/[,\n]/).map(s => s.trim()).filter(s => s);
        allergyHtml = items.map(a => `<span class="allergy-tag">⚠️ ${escapeHtml(a)}</span>`).join('');
    } else {
        allergyHtml = '<span class="no-allergy">None</span>';
    }

    const adminBadge = p.isTeamAdmin ? '<span class="badge admin" style="margin-left: 6px;">Admin</span>' : '';
    const roleBadge = roles.includes('judge')
        ? '<span class="badge judge" style="margin-left: 6px;">Judge</span>'
        : roles.includes('committee')
            ? '<span class="badge committee" style="margin-left: 6px;">Committee</span>'
            : '';

    const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');
    const isTeamMember = !!p.teamId;
    const deleteBtn = canDelete && !isTeamMember
        ? `<button type="button" class="btn-sm btn-delete-participant" data-id="${escapeHtml(p.id)}" title="Remove participation" style="color:#dc2626;border-color:#fca5a5;padding:2px 6px;font-size:0.75rem;">🗑️</button>`
        : '';

    return `
        <tr class="${isGrouped ? 'team-member-row' : ''}">
            <td>
                <strong>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</strong>
                ${adminBadge}${roleBadge}
            </td>
            <td>${escapeHtml(p.email)}</td>
            <td>${escapeHtml(p.phone)}</td>
            ${nightCells}
            <td><strong>${totalNights}</strong>${paidByBadge}</td>
            <td class="allergy-cell">${allergyHtml}</td>
            <td>${deleteBtn}</td>
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
            <div class="day">${NIGHT_ARROWS[key] || key}</div>
            <div class="count">${nightCounts[key]}</div>
            <div class="day">rooms</div>
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

        await withBusy(btn, '⏳', async () => {
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
