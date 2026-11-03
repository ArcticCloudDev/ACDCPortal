let allEvents = [];
let allUsers = [];
let currentPermissions = null;

document.addEventListener('DOMContentLoaded', async () => {
    currentPermissions = await Permissions.initAdminPage('person');

    if (!currentPermissions) return;

    // The breadcrumb leads to the People list; only show it to admins who can open that page.
    if ((currentPermissions.allowedPages || []).includes('users')) {
        document.getElementById('person-breadcrumb').classList.remove('hidden');
    }

    try {
        let [events, users] = await Promise.all([
            API.events.list(),
            API.users.list()
        ]);
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        allUsers = users || [];
    } catch (e) {
        console.error('Error loading reference data:', e);
    }

    document.getElementById('search-email').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchPerson();
    });
    document.getElementById('search-btn').addEventListener('click', searchPerson);

    const params = new URLSearchParams(window.location.search);
    const emailParam = params.get('email');
    if (emailParam) {
        document.getElementById('search-email').value = emailParam;
        searchPerson();
    }
});

async function searchPerson() {
    const email = document.getElementById('search-email').value.trim().toLowerCase();
    const container = document.getElementById('results-container');

    if (!email) {
        alert('Please enter an email address');
        return;
    }

    await withBusy(document.getElementById('search-btn'), 'Looking up…', async () => {
        container.innerHTML = '<div class="panel"><div class="empty-state"><p>Looking up…</p></div></div>';

        try {
            const participations = await API.participations.getByPerson(email);

            if (!participations || participations.length === 0) {
                container.innerHTML = `
                    <div class="panel">
                        <div class="empty-state">
                            <span class="empty-state-icon">${icon('user-round')}</span>
                            <h2 class="empty-state-title">No results found</h2>
                            <p>No events or roles are recorded for <strong>${escapeHtml(email)}</strong>.</p>
                        </div>
                    </div>`;
                return;
            }

            renderPersonResult(email, participations);
        } catch (error) {
            console.error('Error searching:', error);
            container.innerHTML = `
                <div class="notice notice-danger">
                    ${icon('triangle-alert')}
                    <div>
                        <div class="notice-title">Search failed</div>
                        <div class="notice-body">${escapeHtml(error.message)}</div>
                    </div>
                </div>`;
        }
    });
}

// Role badges: staff roles use the accent, everything else is neutral. The icon tells them apart.
const ROLE_META = {
    participant: { label: 'Participant', icon: 'user-check',     tone: '' },
    judge:       { label: 'Judge',       icon: 'scale',          tone: 'badge-accent' },
    committee:   { label: 'Committee',   icon: 'shield',         tone: 'badge-accent' },
    interest:    { label: 'Interest',    icon: 'clipboard-list', tone: '' },
    sponsor:     { label: 'Sponsor',     icon: 'gem',            tone: '' }
};

// Same status classes and labels as the admin events list.
const EVENT_STATUS_LABELS = {
    'draft': 'Draft',
    'pre-registration': 'Pre-registration',
    'registration': 'Registration open',
    'live': 'Live',
    'completed': 'Completed'
};

function roleBadge(role) {
    const meta = ROLE_META[role];
    if (!meta) return `<span class="badge">${escapeHtml(role)}</span>`;
    return `<span class="badge ${meta.tone}">${icon(meta.icon, 'icon-sm')}${meta.label}</span>`;
}

function renderPersonResult(email, participations) {
    const container = document.getElementById('results-container');

    const user = allUsers.find(u => u.email?.toLowerCase() === email);
    const firstName = user?.firstName || participations[0]?.interestFirstName || '';
    const lastName = user?.lastName || participations[0]?.interestLastName || '';
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || email;
    const initials = firstName && lastName
        ? (firstName[0] + lastName[0]).toUpperCase()
        : email.substring(0, 2).toUpperCase();

    const allRoles = new Set();
    participations.forEach(p => (p.roles || []).forEach(r => allRoles.add(r)));
    const eventCount = new Set(participations.map(p => p.eventId)).size;
    const roleCount = allRoles.size;

    const findEvent = (id) => allEvents.find(e => sameId(e.id, id));

    const sorted = [...participations].sort((a, b) => {
        const eventA = findEvent(a.eventId);
        const eventB = findEvent(b.eventId);
        const dateA = eventA?.startDate || a.createdAt;
        const dateB = eventB?.startDate || b.createdAt;
        return new Date(dateB) - new Date(dateA);
    });

    const timelineHTML = sorted.map(p => {
        const event = findEvent(p.eventId);
        const eventName = event?.name || p.eventName || 'Unknown event';
        const eventDates = event
            ? formatDateRange(event.startDate, event.endDate)
            : '';
        const roles = p.roles || [];

        // Event and team links stay in the admin area: the event editor and the teams list.
        const title = event
            ? `<a class="timeline-title" href="admin-events.html?event=${encodeURIComponent(event.id)}">${escapeHtml(eventName)}</a>`
            : `<span class="timeline-title">${escapeHtml(eventName)}</span>`;
        const status = event?.status;
        const statusBadge = status
            ? `<span class="badge ${escapeHtml(status)}">${escapeHtml(EVENT_STATUS_LABELS[status] || status)}</span>`
            : '';

        const metaParts = [];
        if (p.teamId) {
            metaParts.push(`<a class="meta-item" href="admin-teams.html?team=${encodeURIComponent(p.teamId)}">${icon('users')}View team</a>`);
        }
        if (p.isTeamAdmin) {
            metaParts.push(`<span class="meta-item">${icon('star')}Team admin</span>`);
        }
        if (p.interestDate) {
            metaParts.push(`<span class="meta-item">${icon('clipboard-list')}Interest ${formatDate(p.interestDate)}</span>`);
        }
        if (p.createdAt) {
            metaParts.push(`<span class="meta-item">${icon('calendar')}Joined ${formatDate(p.createdAt)}</span>`);
        }

        return `
            <div class="timeline-entry">
                <span class="timeline-dot">${icon('calendar-days')}</span>
                <div class="timeline-content">
                    <div class="timeline-heading">${title}${statusBadge}</div>
                    ${eventDates ? `<div class="timeline-sub">${escapeHtml(eventDates)}</div>` : ''}
                    ${roles.length ? `<div class="badge-list">${roles.map(roleBadge).join('')}</div>` : ''}
                    ${metaParts.length ? `<div class="meta-list">${metaParts.join('')}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');

    const contact = [`<a class="meta-item" href="mailto:${escapeHtml(email)}">${icon('mail')}${escapeHtml(email)}</a>`];
    if (user?.phone) {
        contact.push(`<a class="meta-item" href="tel:${escapeHtml(String(user.phone).replace(/[^\d+]/g, ''))}">${icon('phone')}${escapeHtml(user.phone)}</a>`);
    }

    container.innerHTML = `
        <section class="panel person-profile">
            <div class="person-profile-header">
                <span class="avatar avatar-lg" aria-hidden="true">${escapeHtml(initials)}</span>
                <div class="person-profile-info">
                    <h2>${escapeHtml(displayName)}</h2>
                    <div class="meta-list">${contact.join('')}</div>
                </div>
                <div class="person-profile-badges">
                    <span class="badge badge-dot ${user ? 'badge-success' : ''}">${user ? 'Registered user' : 'No account yet'}</span>
                    ${user?.isPortalAdmin ? `<span class="badge badge-accent">${icon('shield-check', 'icon-sm')}Portal admin</span>` : ''}
                </div>
            </div>
            <dl class="person-stats">
                <div class="person-stat"><dt>Events</dt><dd>${eventCount}</dd></div>
                <div class="person-stat"><dt>Roles</dt><dd>${roleCount}</dd></div>
                <div class="person-stat"><dt>Participations</dt><dd>${participations.length}</dd></div>
            </dl>
        </section>
        <section class="panel">
            <div class="panel-header">
                <h3 class="panel-title">${icon('calendar-days')}Participation history</h3>
                <span class="badge count">${participations.length}</span>
            </div>
            <div class="timeline person-history">
                ${timelineHTML}
            </div>
        </section>
    `;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
}

function formatDateRange(start, end) {
    if (!start) return '';
    const s = new Date(start);
    const e = end ? new Date(end) : null;
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (e) {
        return `${s.toLocaleDateString('en-US', opts)} — ${e.toLocaleDateString('en-US', opts)}`;
    }
    return s.toLocaleDateString('en-US', opts);
}
