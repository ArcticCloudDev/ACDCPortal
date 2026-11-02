let currentPermissions = null;
let allUsers           = [];
let allParticipations  = [];
let allEvents          = [];
let allTeams           = [];
let allInvitations     = [];
let currentView        = 'flat';
let activeStatFilter   = null;
let displayRows        = [];

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const contentDiv = document.getElementById('admin-content');

    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend',
                '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>'
            );
        }
    }, 1200);

    currentPermissions = await Permissions.initAdminPage('users', {
        loadingEl: loadingDiv,
        contentEl: contentDiv
    });
    if (!currentPermissions) return;

    try {
        await loadAllData();
        document.getElementById('share-link').value = window.location.origin + '/register.html?intent=interest';
        setupFilters();
        setupActions();
        render();
        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        contentDiv.classList.remove('hidden');
    } catch (err) {
        console.error(err);
        loadingDiv.innerHTML = `<p style="color:var(--admin-danger);padding:40px;">Error loading data: ${escapeHtml(err.message)}</p>`;
    }
});

async function loadAllData() {
    const [users, participations, events, teams, invitations] = await Promise.all([
        API.users.list(),
        API.participations.list(),
        API.events.list(),
        API.teams.list(),
        API.invitations.list()
    ]);

    allUsers          = users          || [];
    allParticipations = participations || [];
    allEvents         = Permissions.filterByEvent(currentPermissions, events || [], 'id');
    allTeams          = teams          || [];
    allInvitations    = invitations    || [];

    const evtSel = document.getElementById('filter-event');
    allEvents
        .sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || new Date(b.startDate) - new Date(a.startDate))
        .forEach(e => {
            const opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = e.name + (e.isActive ? ' (Active)' : '');
            evtSel.appendChild(opt);
        });

    const tmSel = document.getElementById('filter-team');
    allTeams
        .sort((a, b) => (a.teamName || '').localeCompare(b.teamName || ''))
        .forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.teamName;
            tmSel.appendChild(opt);
        });
}

function setupFilters() {
    ['filter-event', 'filter-group', 'filter-team'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => { activeStatFilter = null; render(); });
    });
    document.getElementById('filter-search').addEventListener('input', debounce(render, 200));
}

function setupActions() {
    document.getElementById('view-flat').addEventListener('click', () => setView('flat'));
    document.getElementById('view-event').addEventListener('click', () => setView('event'));
    document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
    document.getElementById('copy-share-link-btn').addEventListener('click', copyShareLink);
    document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
    document.getElementById('drawer-close-btn').addEventListener('click', closeDrawer);

    document.getElementById('stats-row').addEventListener('click', (e) => {
        const card = e.target.closest('.stat-card[data-key]');
        if (card) toggleStatFilter(card.dataset.key);
    });

    document.getElementById('main-tbody').addEventListener('click', (e) => {
        const groupRow = e.target.closest('tr[data-group]');
        if (groupRow) {
            toggleGroup(groupRow.dataset.group);
            return;
        }
        const row = e.target.closest('tr[data-row-index]');
        if (row) openDrawer(Number(row.dataset.rowIndex));
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}

function setView(v) {
    currentView = v;
    document.getElementById('view-flat') .classList.toggle('active', v === 'flat');
    document.getElementById('view-event').classList.toggle('active', v === 'event');
    render();
}

function findEvent(id) {
    return allEvents.find(e => sameId(e.id, id));
}

function findTeam(id) {
    return id ? allTeams.find(t => sameId(t.id, id)) : null;
}

function buildRows() {
    const eventId  = document.getElementById('filter-event').value;
    const groupKey = document.getElementById('filter-group').value || activeStatFilter || '';
    const teamId   = document.getElementById('filter-team').value;
    const search   = document.getElementById('filter-search').value.toLowerCase().trim();

    const userByEmail = {};
    for (const u of allUsers) {
        if (u.email) userByEmail[u.email.toLowerCase()] = u;
    }

    const rows = [];

    let parts = allParticipations;
    if (eventId) parts = parts.filter(p => sameId(p.eventId, eventId));
    if (teamId)  parts = parts.filter(p => sameId(p.teamId, teamId));

    for (const p of parts) {
        const event = findEvent(p.eventId);
        const team  = findTeam(p.teamId);
        const user  = userByEmail[p.email?.toLowerCase()];
        const roles = p.roles || [];
        const firstName = user?.firstName || p.interestFirstName || '';
        const lastName  = user?.lastName  || p.interestLastName  || '';

        let primaryGroup;
        if (roles.includes('committee'))       primaryGroup = 'committee';
        else if (roles.includes('judge'))       primaryGroup = 'judge';
        else if (roles.includes('participant')) primaryGroup = 'participant';
        else if (roles.includes('interest'))    primaryGroup = 'interest';
        else                                    primaryGroup = 'participant';

        rows.push({
            type: 'participation',
            id: p.id,
            email: p.email?.toLowerCase() || '',
            firstName, lastName,
            displayName: [firstName, lastName].filter(Boolean).join(' ') || p.email,
            roles, primaryGroup,
            eventId: p.eventId,
            eventName: event?.name || '—',
            eventActive: !!event?.isActive,
            teamId: p.teamId || null,
            teamName: team?.teamName || null,
            hasAccount: !!user,
            isPortalAdmin: !!user?.isPortalAdmin,
            createdAt: p.createdAt,
            user,
        });
    }

    if (!teamId) {
        for (const u of allUsers.filter(u2 => u2.isPortalAdmin)) {
            const email = u.email?.toLowerCase();
            if (!email) continue;
            const inParts = parts.some(p => p.email?.toLowerCase() === email);
            if (!inParts) {
                rows.push({
                    type: 'portal-admin',
                    id: u.id,
                    email,
                    firstName: u.firstName || '', lastName: u.lastName || '',
                    displayName: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
                    roles: ['committee'], primaryGroup: 'committee',
                    eventId: null, eventName: '—', eventActive: false,
                    teamId: null, teamName: null,
                    hasAccount: true, isPortalAdmin: true,
                    createdAt: u.createdAt,
                    user: u,
                });
            }
        }
    }

    let invs = allInvitations.filter(inv => inv.status === 'pending');
    if (eventId) invs = invs.filter(inv => sameId(inv.eventId, eventId));
    if (teamId)  invs = invs.filter(inv => sameId(inv.teamId, teamId));

    for (const inv of invs) {
        const email = inv.email?.toLowerCase();
        const already = rows.some(r => r.email === email && sameId(r.eventId, inv.eventId));
        if (already) continue;
        const event = findEvent(inv.eventId);
        const team  = findTeam(inv.teamId);
        rows.push({
            type: 'invitation',
            id: inv.id,
            email: email || '',
            firstName: inv.firstName || '', lastName: inv.lastName || '',
            displayName: [inv.firstName, inv.lastName].filter(Boolean).join(' ') || inv.email,
            roles: ['invited'], primaryGroup: 'invited',
            eventId: inv.eventId || null,
            eventName: event?.name || '—', eventActive: !!event?.isActive,
            teamId: inv.teamId || null,
            teamName: team?.teamName || null,
            hasAccount: !!userByEmail[email],
            isPortalAdmin: false,
            createdAt: inv.createdAt,
            user: userByEmail[email] || null,
        });
    }

    let filtered = rows;
    if      (groupKey === 'participant')  filtered = rows.filter(r => r.primaryGroup === 'participant');
    else if (groupKey === 'judge')        filtered = rows.filter(r => r.primaryGroup === 'judge');
    else if (groupKey === 'committee')    filtered = rows.filter(r => r.primaryGroup === 'committee');
    else if (groupKey === 'interest')     filtered = rows.filter(r => r.primaryGroup === 'interest');
    else if (groupKey === 'invited')      filtered = rows.filter(r => r.primaryGroup === 'invited');
    else if (groupKey === 'no-account')   filtered = rows.filter(r => !r.hasAccount);

    if (search) {
        filtered = filtered.filter(r =>
            (r.displayName || '').toLowerCase().includes(search) ||
            r.email.includes(search) ||
            (r.teamName  || '').toLowerCase().includes(search) ||
            (r.eventName || '').toLowerCase().includes(search)
        );
    }

    return filtered;
}

function render() {
    displayRows = buildRows();
    renderStats(displayRows);
    renderShareBar();
    if (currentView === 'event') renderByEvent(displayRows);
    else                         renderFlat(displayRows);
}

function renderStats(rows) {
    const c = {
        all:         rows.length,
        participant: rows.filter(r => r.primaryGroup === 'participant').length,
        judge:       rows.filter(r => r.primaryGroup === 'judge').length,
        committee:   rows.filter(r => r.primaryGroup === 'committee').length,
        interest:    rows.filter(r => r.primaryGroup === 'interest').length,
        invited:     rows.filter(r => r.primaryGroup === 'invited').length,
    };

    const defs = [
        { key: 'all',         icon: '👤', color: 'blue',   label: 'Total',        value: c.all },
        { key: 'participant', icon: '🏃', color: 'green',  label: 'Participants',  value: c.participant },
        { key: 'judge',       icon: '⚖️', color: 'purple', label: 'Judges',        value: c.judge },
        { key: 'committee',   icon: '🛡️', color: 'slate',  label: 'Committee',     value: c.committee },
        { key: 'interest',    icon: '📋', color: 'amber',  label: 'Interest',      value: c.interest },
        { key: 'invited',     icon: '✉️', color: 'rose',   label: 'Invited',       value: c.invited },
    ];

    document.getElementById('stats-row').innerHTML = defs.map(s => `
        <div class="stat-card ${activeStatFilter === s.key ? 'active' : ''}" data-key="${s.key}">
            <div class="stat-icon ${s.color}">${s.icon}</div>
            <div class="stat-info">
                <div class="value">${s.value}</div>
                <div class="label">${s.label}</div>
            </div>
        </div>
    `).join('');
}

function toggleStatFilter(key) {
    activeStatFilter = (activeStatFilter === key || key === 'all') ? null : key;
    document.getElementById('filter-group').value = '';
    render();
}

function renderShareBar() {
    const gk = document.getElementById('filter-group').value || activeStatFilter || '';
    document.getElementById('interest-share-bar').style.display = gk === 'interest' ? 'flex' : 'none';
}

function avatarClass(r) {
    return r.primaryGroup === 'committee' ? 'committee'
         : r.primaryGroup === 'judge'     ? 'judge'
         : r.primaryGroup === 'interest'  ? 'interest'
         : r.primaryGroup === 'invited'   ? 'invited' : '';
}

function personCell(r) {
    return `<div class="person-cell">
        <div class="avatar ${avatarClass(r)}">${escapeHtml(getInitials(r.displayName, r.email))}</div>
        <div>
            <div class="person-name">${escapeHtml(r.displayName)}</div>
            <div class="person-email">${escapeHtml(r.email)}</div>
        </div>
    </div>`;
}

function renderFlat(rows) {
    const noEventFilter = !document.getElementById('filter-event').value;
    document.getElementById('panel-title').textContent = buildPanelTitle();
    document.getElementById('panel-count').textContent = `${rows.length} people`;

    document.getElementById('main-thead').innerHTML = `<tr>
        <th>Person</th>
        ${noEventFilter ? '<th>Event</th>' : ''}
        <th>Roles</th>
        <th>Team</th>
        <th>Since</th>
        <th></th>
    </tr>`;

    const span = noEventFilter ? 6 : 5;

    if (!rows.length) {
        document.getElementById('main-tbody').innerHTML =
            `<tr><td colspan="${span}" class="empty-state">No people match the current filters</td></tr>`;
        return;
    }

    document.getElementById('main-tbody').innerHTML = rows.map((r, idx) => `<tr data-row-index="${idx}">
            <td>${personCell(r)}</td>
            ${noEventFilter ? `<td style="font-size:0.82rem;color:var(--admin-text-muted);">${escapeHtml(r.eventName)}</td>` : ''}
            <td>${r.roles.map(rolePill).join('')}</td>
            <td style="font-size:0.82rem;color:var(--admin-text-muted);">${escapeHtml(r.teamName || '—')}</td>
            <td style="font-size:0.8rem;color:var(--admin-text-muted);">${formatDate(r.createdAt)}</td>
            <td><button type="button" class="btn-sm">👤 View</button></td>
        </tr>`).join('');
}

function renderByEvent(rows) {
    document.getElementById('panel-title').textContent = buildPanelTitle();
    document.getElementById('panel-count').textContent = `${rows.length} people`;

    document.getElementById('main-thead').innerHTML = `<tr>
        <th>Person</th><th>Roles</th><th>Team</th><th>Since</th><th></th>
    </tr>`;

    if (!rows.length) {
        document.getElementById('main-tbody').innerHTML =
            `<tr><td colspan="5" class="empty-state">No people match the current filters</td></tr>`;
        return;
    }

    const GROUP_ORDER = ['committee','judge','participant','interest','invited'];
    const GROUP_LABEL = {
        committee:   '🛡️ Committee',
        judge:       '⚖️ Judges',
        participant: '🏃 Participants',
        interest:    '📋 Interest',
        invited:     '✉️ Invited (pending)',
    };

    const eventOrder = allEvents
        .sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || new Date(b.startDate) - new Date(a.startDate))
        .map(e => e.id);

    const byEvent = {};
    for (const r of rows) {
        const eid = r.eventId || '__none__';
        (byEvent[eid] = byEvent[eid] || []).push(r);
    }

    const rowIndexMap = new Map(rows.map((r, i) => [r, i]));

    let html = '';
    const keys = [...eventOrder.filter(k => byEvent[k]),
                  ...Object.keys(byEvent).filter(k => !eventOrder.includes(k))];

    // Group ids are derived from array positions so no data ever ends up inside a selector.
    keys.forEach((eid, eventIndex) => {
        const eventRows = byEvent[eid];
        if (!eventRows) return;
        const evtNode = `evt-${eventIndex}`;
        const eventName = eventRows[0].eventName;

        html += `<tr class="group-header-row" data-group="${evtNode}">
            <td colspan="5">📅 ${escapeHtml(eventName)}<span class="group-toggle" id="arrow-${evtNode}">▾</span></td>
        </tr>`;

        const byGroup = {};
        for (const r of eventRows) (byGroup[r.primaryGroup] = byGroup[r.primaryGroup] || []).push(r);

        for (const gk of GROUP_ORDER) {
            const gRows = byGroup[gk];
            if (!gRows?.length) continue;
            const grpNode = `${evtNode}-${gk}`;

            html += `<tr class="group-header-row group-member-${evtNode}" style="background:#f8fafc;" data-group="${grpNode}">
                <td colspan="5" style="padding-left:32px;">
                    ${GROUP_LABEL[gk]} <span style="font-weight:400;opacity:.7;">(${gRows.length})</span>
                    <span class="group-toggle" id="arrow-${grpNode}">▾</span>
                </td>
            </tr>`;

            for (const r of gRows) {
                const idx = rowIndexMap.get(r);
                html += `<tr class="group-member-${evtNode} group-member-${grpNode}" data-row-index="${idx}">
                    <td style="padding-left:48px;">${personCell(r)}</td>
                    <td>${r.roles.map(rolePill).join('')}</td>
                    <td style="font-size:0.82rem;color:var(--admin-text-muted);">${escapeHtml(r.teamName || '—')}</td>
                    <td style="font-size:0.8rem;color:var(--admin-text-muted);">${formatDate(r.createdAt)}</td>
                    <td><button type="button" class="btn-sm">👤 View</button></td>
                </tr>`;
            }
        }
    });

    document.getElementById('main-tbody').innerHTML = html;
}

function toggleGroup(groupId) {
    if (!/^[\w-]+$/.test(groupId || '')) return;
    const members = document.querySelectorAll(`.group-member-${groupId}`);
    const arrow   = document.getElementById(`arrow-${groupId}`);
    if (!members.length) return;
    const isCollapsed = members[0].classList.contains('group-collapsed');
    members.forEach(el => el.classList.toggle('group-collapsed', !isCollapsed));
    if (arrow) arrow.textContent = isCollapsed ? '▾' : '▸';
}

async function openDrawer(idx) {
    const row = displayRows[idx];
    if (!row) return;

    document.getElementById('drawer-backdrop').classList.add('open');
    document.getElementById('person-drawer').classList.add('open');

    document.getElementById('drawer-avatar').textContent = getInitials(row.displayName, row.email);
    document.getElementById('drawer-name').textContent   = row.displayName || row.email;
    document.getElementById('drawer-email').textContent  = row.email;

    const pill = document.getElementById('drawer-status-pill');
    pill.className = 'drawer-status-pill ' + (row.hasAccount ? 'registered' : 'no-account');
    pill.textContent = row.hasAccount ? '✓ Registered user' : '○ No account yet';

    document.getElementById('drawer-stats').innerHTML = '';
    document.getElementById('drawer-body').innerHTML  = '<div class="drawer-loading">Loading history…</div>';

    try {
        const participations = (await API.participations.getByPerson(row.email)) || [];
        const invitations = allInvitations.filter(inv => inv.email?.toLowerCase() === row.email);

        const uniqueEvents = new Set(participations.map(p => String(p.eventId || '').toLowerCase())).size;
        const allRoles     = new Set(participations.flatMap(p => p.roles || []));

        document.getElementById('drawer-stats').innerHTML = `
            <div class="drawer-stat"><div class="value">${uniqueEvents}</div><div class="label">Events</div></div>
            <div class="drawer-stat"><div class="value">${allRoles.size}</div><div class="label">Roles</div></div>
            <div class="drawer-stat"><div class="value">${participations.length}</div><div class="label">Participations</div></div>
            <div class="drawer-stat"><div class="value">${invitations.length}</div><div class="label">Invitations</div></div>
        `;

        const sorted = [...participations].sort((a, b) => {
            const ea = findEvent(a.eventId);
            const eb = findEvent(b.eventId);
            return new Date(eb?.startDate || b.createdAt) - new Date(ea?.startDate || a.createdAt);
        });

        let body = '';

        if (sorted.length) {
            body += '<div class="drawer-section-title">Participation History</div>';
            body += sorted.map(p => {
                const ev   = findEvent(p.eventId);
                const tm   = findTeam(p.teamId);
                const meta = [];
                if (tm)            meta.push(`👥 ${escapeHtml(tm.teamName)}`);
                if (p.isTeamAdmin) meta.push('⭐ Team Admin');
                if (p.createdAt)   meta.push(`📅 Joined ${formatDate(p.createdAt)}`);
                return `<div class="timeline-entry">
                    <div class="tl-dot">📅</div>
                    <div>
                        <div class="tl-event-name">${escapeHtml(ev?.name || '—')}</div>
                        <div class="tl-event-date">${ev ? escapeHtml(formatDateRange(ev.startDate, ev.endDate)) : ''}</div>
                        <div class="tl-roles">${(p.roles || []).map(rolePill).join('')}</div>
                        <div class="tl-meta">${meta.join(' · ')}</div>
                    </div>
                </div>`;
            }).join('');
        }

        if (invitations.length) {
            body += '<div class="drawer-section-title">Invitations</div>';
            body += invitations.map(inv => {
                const ev = findEvent(inv.eventId);
                const tm = findTeam(inv.teamId);
                const statusBadge = { pending: 'pending', accepted: 'accepted', declined: 'declined' }[inv.status] || '';
                return `<div class="timeline-entry">
                    <div class="tl-dot">✉️</div>
                    <div>
                        <div class="tl-event-name">${escapeHtml(ev?.name || '—')} <span class="badge ${statusBadge}">${escapeHtml(inv.status)}</span></div>
                        ${tm ? `<div class="tl-event-date">Team: ${escapeHtml(tm.teamName)}</div>` : ''}
                        <div class="tl-meta">Invited ${formatDate(inv.createdAt)}</div>
                    </div>
                </div>`;
            }).join('');
        }

        if (!body) {
            body = '<div style="padding:40px 0;text-align:center;color:var(--admin-text-muted);">No history found</div>';
        }

        document.getElementById('drawer-body').innerHTML = body;

    } catch (err) {
        document.getElementById('drawer-body').innerHTML =
            `<div style="padding:20px;color:var(--admin-danger);">Error loading: ${escapeHtml(err.message)}</div>`;
    }
}

function closeDrawer() {
    document.getElementById('drawer-backdrop').classList.remove('open');
    document.getElementById('person-drawer').classList.remove('open');
}

function exportCSV() {
    if (!displayRows.length) return;
    const q = s => `"${String(s || '').replace(/"/g, '""')}"`;
    const lines = [
        'Name,Email,Event,Roles,Team,Account,Since',
        ...displayRows.map(r => [
            q(r.displayName), q(r.email), q(r.eventName),
            q(r.roles.join(';')), q(r.teamName || ''),
            r.hasAccount ? 'Yes' : 'No',
            (r.createdAt || '').split('T')[0]
        ].join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `people-${new Date().toISOString().split('T')[0]}.csv`
    });
    a.click();
    URL.revokeObjectURL(a.href);
}

function buildPanelTitle() {
    const gk = document.getElementById('filter-group').value || activeStatFilter || '';
    const eid = document.getElementById('filter-event').value;
    const labels = {
        participant: 'Participants', judge: 'Judges', committee: 'Committee',
        interest: 'Interest Leads', invited: 'Invited (Pending)', 'no-account': 'No Account',
    };
    const parts = [];
    if (labels[gk]) parts.push(labels[gk]);
    if (eid) {
        const ev = findEvent(eid);
        if (ev) parts.push(ev.name);
    }
    return parts.length ? parts.join(' — ') : 'All People';
}

function rolePill(role) {
    const label = { participant: '🏃 Participant', judge: '⚖️ Judge', committee: '🛡️ Committee', interest: '📋 Interest', sponsor: '💎 Sponsor', invited: '✉️ Invited' };
    return `<span class="role-pill ${escapeHtml(role)}">${escapeHtml(label[role] || role)}</span>`;
}

function getInitials(name, email) {
    const parts = (name || email || '').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || '?').substring(0, 2).toUpperCase();
}

function formatDate(str) {
    if (!str) return '—';
    return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRange(start, end) {
    if (!start) return '';
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    const s = new Date(start).toLocaleDateString('en-US', opts);
    return end ? `${s} — ${new Date(end).toLocaleDateString('en-US', opts)}` : s;
}

function copyShareLink() {
    const inp = document.getElementById('share-link');
    inp.select();
    document.execCommand('copy');
    const btn = document.getElementById('copy-share-link-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
}
