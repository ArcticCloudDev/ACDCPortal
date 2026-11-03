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
        loadingDiv.innerHTML = `<div class="notice notice-danger">${icon('triangle-alert')}<div><div class="notice-title">Could not load people</div><div class="notice-body">${escapeHtml(err.message)}</div></div></div>`;
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
            opt.textContent = e.name + (e.isActive ? ' (active)' : '');
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
        const card = e.target.closest('.pill[data-key]');
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

    document.addEventListener('keydown', e => {
        if (!document.getElementById('person-drawer').classList.contains('open')) return;
        if (e.key === 'Escape') closeDrawer();
        if (e.key === 'Tab') keepFocusInDrawer(e);
    });
}

function setView(v) {
    currentView = v;
    document.getElementById('view-flat') .classList.toggle('active', v === 'flat');
    document.getElementById('view-event').classList.toggle('active', v === 'event');
    document.getElementById('view-flat') .setAttribute('aria-pressed', String(v === 'flat'));
    document.getElementById('view-event').setAttribute('aria-pressed', String(v === 'event'));
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
        { key: 'all',         label: 'All',          value: c.all },
        { key: 'participant', label: 'Participants', value: c.participant },
        { key: 'judge',       label: 'Judges',       value: c.judge },
        { key: 'committee',   label: 'Committee',    value: c.committee },
        { key: 'interest',    label: 'Interest',     value: c.interest },
        { key: 'invited',     label: 'Invited',      value: c.invited },
    ];

    // Quick filters mirror the role filter: the active pill is whichever group filters the list.
    const current = document.getElementById('filter-group').value || activeStatFilter || 'all';
    document.getElementById('stats-row').innerHTML = defs.map(s => {
        const on = current === s.key;
        const roleIcon = ROLE_META[s.key] ? icon(ROLE_META[s.key].icon, 'icon-sm') : '';
        return `<button type="button" class="pill${on ? ' active' : ''}" data-key="${s.key}" aria-pressed="${on}">${roleIcon}${s.label}<span class="pill-count">${s.value}</span></button>`;
    }).join('');
}

function toggleStatFilter(key) {
    activeStatFilter = (activeStatFilter === key || key === 'all') ? null : key;
    document.getElementById('filter-group').value = '';
    render();
}

function renderShareBar() {
    const gk = document.getElementById('filter-group').value || activeStatFilter || '';
    document.getElementById('interest-share-bar').classList.toggle('hidden', gk !== 'interest');
}

function personCell(r) {
    return `<div class="person-cell">
        <span class="avatar" aria-hidden="true">${escapeHtml(getInitials(r.displayName, r.email))}</span>
        <div class="person-text">
            <div class="person-name">${escapeHtml(r.displayName)}</div>
            <div class="person-email">${escapeHtml(r.email)}</div>
        </div>
    </div>`;
}

// Opens the person drawer (the row click handler does the work); gives keyboard users a control.
function viewButton(r) {
    return `<button type="button" class="btn-sm ghost">View<span class="visually-hidden"> ${escapeHtml(r.displayName)}</span>${icon('chevron-right', 'icon-sm')}</button>`;
}

function renderFlat(rows) {
    const noEventFilter = !document.getElementById('filter-event').value;
    document.getElementById('panel-title').textContent = buildPanelTitle();
    document.getElementById('panel-count').textContent = `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;

    document.getElementById('main-thead').innerHTML = `<tr>
        <th scope="col">Person</th>
        ${noEventFilter ? '<th scope="col">Event</th>' : ''}
        <th scope="col">Roles</th>
        <th scope="col">Team</th>
        <th scope="col">Since</th>
        <th scope="col"><span class="visually-hidden">Actions</span></th>
    </tr>`;

    const span = noEventFilter ? 6 : 5;

    if (!rows.length) {
        document.getElementById('main-tbody').innerHTML =
            `<tr><td colspan="${span}" class="empty-state">No people match the current filters</td></tr>`;
        return;
    }

    document.getElementById('main-tbody').innerHTML = rows.map((r, idx) => `<tr data-row-index="${idx}">
            <td class="cell-person">${personCell(r)}</td>
            ${noEventFilter ? `<td class="cell-meta text-muted">${escapeHtml(r.eventName)}</td>` : ''}
            <td class="cell-meta"><div class="badge-list">${r.roles.map(rolePill).join('')}</div></td>
            <td class="cell-meta text-muted">${escapeHtml(r.teamName || '—')}</td>
            <td class="cell-since text-muted">${formatDate(r.createdAt)}</td>
            <td class="cell-actions">${viewButton(r)}</td>
        </tr>`).join('');
}

function renderByEvent(rows) {
    document.getElementById('panel-title').textContent = buildPanelTitle();
    document.getElementById('panel-count').textContent = `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;

    document.getElementById('main-thead').innerHTML = `<tr>
        <th scope="col">Person</th><th scope="col">Roles</th><th scope="col">Team</th><th scope="col">Since</th><th scope="col"><span class="visually-hidden">Actions</span></th>
    </tr>`;

    if (!rows.length) {
        document.getElementById('main-tbody').innerHTML =
            `<tr><td colspan="5" class="empty-state">No people match the current filters</td></tr>`;
        return;
    }

    const GROUP_ORDER = ['committee','judge','participant','interest','invited'];
    const GROUP_LABEL = {
        committee:   'Committee',
        judge:       'Judges',
        participant: 'Participants',
        interest:    'Interest',
        invited:     'Invited (pending)',
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
        const eventName = eid === '__none__' ? 'Not linked to an event' : eventRows[0].eventName;

        html += `<tr class="group-header-row group-event" data-group="${evtNode}">
            <td colspan="5"><button type="button" class="group-toggle-btn" id="arrow-${evtNode}" aria-expanded="true">${icon('chevron-down', 'icon-sm group-chevron')}${icon('calendar-days')}<span class="group-label">${escapeHtml(eventName)}</span><span class="group-count">${eventRows.length}</span></button></td>
        </tr>`;

        const byGroup = {};
        for (const r of eventRows) (byGroup[r.primaryGroup] = byGroup[r.primaryGroup] || []).push(r);

        for (const gk of GROUP_ORDER) {
            const gRows = byGroup[gk];
            if (!gRows?.length) continue;
            const grpNode = `${evtNode}-${gk}`;

            html += `<tr class="group-header-row group-role group-member-${evtNode}" data-group="${grpNode}">
                <td colspan="5"><button type="button" class="group-toggle-btn" id="arrow-${grpNode}" aria-expanded="true">${icon('chevron-down', 'icon-sm group-chevron')}${icon(ROLE_META[gk].icon)}<span class="group-label">${GROUP_LABEL[gk]}</span><span class="group-count">${gRows.length}</span></button></td>
            </tr>`;

            for (const r of gRows) {
                const idx = rowIndexMap.get(r);
                html += `<tr class="group-member-${evtNode} group-member-${grpNode}" data-row-index="${idx}">
                    <td class="cell-person indent">${personCell(r)}</td>
                    <td class="cell-meta"><div class="badge-list">${r.roles.map(rolePill).join('')}</div></td>
                    <td class="cell-meta text-muted">${escapeHtml(r.teamName || '—')}</td>
                    <td class="cell-since text-muted">${formatDate(r.createdAt)}</td>
                    <td class="cell-actions">${viewButton(r)}</td>
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
    if (arrow) arrow.setAttribute('aria-expanded', String(isCollapsed));
}

async function openDrawer(idx) {
    const row = displayRows[idx];
    if (!row) return;

    // aria-modal dialog: focus moves in, stays in, and returns to the row's button on close.
    drawerOpener = document.activeElement;
    document.getElementById('drawer-backdrop').classList.add('open');
    document.getElementById('person-drawer').classList.add('open');
    document.getElementById('drawer-close-btn').focus();

    document.getElementById('drawer-avatar').textContent = getInitials(row.displayName, row.email);
    document.getElementById('drawer-name').textContent   = row.displayName || row.email;
    document.getElementById('drawer-email').textContent  = row.email;
    document.getElementById('drawer-person-link').href   = `admin-person.html?email=${encodeURIComponent(row.email)}`;

    const pill = document.getElementById('drawer-status-pill');
    pill.className = 'badge badge-dot' + (row.hasAccount ? ' badge-success' : '');
    pill.textContent = row.hasAccount ? 'Registered user' : 'No account yet';

    document.getElementById('drawer-stats').innerHTML = '';
    document.getElementById('drawer-body').innerHTML  = '<div class="empty-state">Loading history…</div>';

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
            body += '<h3 class="drawer-section-title">Participation history</h3><div class="timeline">';
            body += sorted.map(p => {
                const ev   = findEvent(p.eventId);
                const tm   = findTeam(p.teamId);
                const meta = [];
                if (tm)            meta.push(`<a class="meta-item" href="admin-teams.html?team=${encodeURIComponent(tm.id)}">${icon('users')}${escapeHtml(tm.teamName)}</a>`);
                if (p.isTeamAdmin) meta.push(`<span class="meta-item">${icon('star')}Team admin</span>`);
                if (p.createdAt)   meta.push(`<span class="meta-item">${icon('calendar')}Joined ${formatDate(p.createdAt)}</span>`);
                const title = ev
                    ? `<a class="timeline-title" href="admin-events.html?event=${encodeURIComponent(ev.id)}">${escapeHtml(ev.name)}</a>`
                    : '<span class="timeline-title">—</span>';
                return `<div class="timeline-entry">
                    <span class="timeline-dot">${icon('calendar-days')}</span>
                    <div class="timeline-content">
                        ${title}
                        <div class="timeline-sub">${ev ? escapeHtml(formatDateRange(ev.startDate, ev.endDate)) : ''}</div>
                        <div class="badge-list">${(p.roles || []).map(rolePill).join('')}</div>
                        ${meta.length ? `<div class="meta-list">${meta.join('')}</div>` : ''}
                    </div>
                </div>`;
            }).join('');
            body += '</div>';
        }

        if (invitations.length) {
            body += '<h3 class="drawer-section-title">Invitations</h3><div class="timeline">';
            body += invitations.map(inv => {
                const ev = findEvent(inv.eventId);
                const tm = findTeam(inv.teamId);
                // pending = needs attention, accepted = done; declined or expired stay neutral.
                const statusTone = { pending: 'badge-warning', accepted: 'badge-success' }[inv.status] || '';
                const meta = [];
                if (tm) meta.push(`<a class="meta-item" href="admin-teams.html?team=${encodeURIComponent(tm.id)}">${icon('users')}${escapeHtml(tm.teamName)}</a>`);
                meta.push(`<span class="meta-item">${icon('calendar')}Invited ${formatDate(inv.createdAt)}</span>`);
                return `<div class="timeline-entry">
                    <span class="timeline-dot is-muted">${icon('mail')}</span>
                    <div class="timeline-content">
                        <div class="timeline-heading"><span class="timeline-title">${escapeHtml(ev?.name || '—')}</span><span class="badge ${statusTone}">${escapeHtml(capitalize(inv.status))}</span></div>
                        <div class="meta-list">${meta.join('')}</div>
                    </div>
                </div>`;
            }).join('');
            body += '</div>';
        }

        if (!body) {
            body = '<div class="empty-state">No events or invitations yet</div>';
        }

        document.getElementById('drawer-body').innerHTML = body;

    } catch (err) {
        document.getElementById('drawer-body').innerHTML =
            `<div class="notice notice-danger">${icon('triangle-alert')}<div><div class="notice-title">Could not load the history</div><div class="notice-body">${escapeHtml(err.message)}</div></div></div>`;
    }
}

let drawerOpener = null;

function closeDrawer() {
    const drawer = document.getElementById('person-drawer');
    if (!drawer.classList.contains('open')) return;
    document.getElementById('drawer-backdrop').classList.remove('open');
    drawer.classList.remove('open');
    if (drawerOpener && drawerOpener.isConnected) drawerOpener.focus();
    drawerOpener = null;
}

function keepFocusInDrawer(e) {
    const focusable = [...document.getElementById('person-drawer')
        .querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function exportCSV() {
    // Rendering is debounced; export always reflects the filters as they are right now.
    const exportRows = buildRows();
    if (!exportRows.length) return;
    const q = csvCell;
    const lines = [
        'Name,Email,Event,Roles,Team,Account,Since',
        ...exportRows.map(r => [
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
        interest: 'Interest leads', invited: 'Invited (pending)', 'no-account': 'No account yet',
    };
    const parts = [];
    if (labels[gk]) parts.push(labels[gk]);
    if (eid) {
        const ev = findEvent(eid);
        if (ev) parts.push(ev.name);
    }
    return parts.length ? parts.join(' — ') : 'All people';
}

// Role badges: staff roles use the accent, a pending invitation needs attention (warning),
// everything else is neutral. The icon tells the roles apart.
const ROLE_META = {
    participant: { label: 'Participant', icon: 'user-check',     tone: '' },
    judge:       { label: 'Judge',       icon: 'scale',          tone: 'badge-accent' },
    committee:   { label: 'Committee',   icon: 'shield',         tone: 'badge-accent' },
    interest:    { label: 'Interest',    icon: 'clipboard-list', tone: '' },
    sponsor:     { label: 'Sponsor',     icon: 'gem',            tone: '' },
    invited:     { label: 'Invited',     icon: 'mail',           tone: 'badge-warning' },
};

function rolePill(role) {
    const meta = ROLE_META[role];
    if (!meta) return `<span class="badge">${escapeHtml(role)}</span>`;
    return `<span class="badge ${meta.tone}">${icon(meta.icon, 'icon-sm')}${meta.label}</span>`;
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
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
    btn.textContent = 'Copied';
    setTimeout(() => btn.textContent = 'Copy link', 2000);
}
