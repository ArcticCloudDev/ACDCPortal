let allEvents = [];
let allUsers = [];
let currentPermissions = null;

document.addEventListener('DOMContentLoaded', async () => {
    currentPermissions = await Permissions.initAdminPage('person');

    if (!currentPermissions) return;

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

    await withBusy(document.getElementById('search-btn'), '⏳ Searching...', async () => {
        container.innerHTML = '<div class="empty-state"><p>Searching...</p></div>';

        try {
            const participations = await API.participations.getByPerson(email);

            if (!participations || participations.length === 0) {
                container.innerHTML = `
                    <div class="no-results">
                        <div style="font-size: 2rem; margin-bottom: 12px;">🚫</div>
                        <h3 style="margin: 0 0 6px; color: var(--admin-sidebar);">No results found</h3>
                        <p style="margin: 0; color: var(--admin-text-muted); font-size: 0.85rem;">
                            No participations found for <strong>${escapeHtml(email)}</strong>
                        </p>
                    </div>`;
                return;
            }

            renderPersonResult(email, participations);
        } catch (error) {
            console.error('Error searching:', error);
            container.innerHTML = `
                <div class="no-results">
                    <div style="font-size: 2rem; margin-bottom: 12px;">⚠️</div>
                    <h3 style="margin: 0 0 6px; color: var(--admin-sidebar);">Search failed</h3>
                    <p style="margin: 0; color: var(--admin-text-muted);">${escapeHtml(error.message)}</p>
                </div>`;
        }
    });
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
        const eventName = event?.name || 'Unknown Event';
        const eventDates = event
            ? formatDateRange(event.startDate, event.endDate)
            : '';
        const roles = p.roles || [];

        const rolePills = roles.map(r =>
            `<span class="role-pill ${escapeHtml(r)}">${getRoleIcon(r)} ${escapeHtml(r)}</span>`
        ).join('');

        const metaParts = [];
        if (p.teamId) {
            metaParts.push(`<span>👥 On a team</span>`);
        }
        if (p.interestDate) {
            metaParts.push(`<span>📋 Interest: ${formatDate(p.interestDate)}</span>`);
        }
        if (p.createdAt) {
            metaParts.push(`<span>📅 Joined: ${formatDate(p.createdAt)}</span>`);
        }

        return `
            <div class="timeline-event">
                <div class="timeline-dot">📅</div>
                <div class="timeline-content">
                    <div class="event-name">${escapeHtml(eventName)}</div>
                    <div class="event-dates">${escapeHtml(eventDates)}</div>
                    <div class="timeline-roles">${rolePills}</div>
                    <div class="timeline-meta">${metaParts.join('')}</div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="person-card">
            <div class="person-header">
                <div class="person-avatar">${escapeHtml(initials)}</div>
                <div class="person-info">
                    <h2>${escapeHtml(displayName)}</h2>
                    <div class="email">${escapeHtml(email)}</div>
                    <span class="user-status ${user ? 'registered' : 'unregistered'}">
                        ${user ? '✓ Registered user' : '○ No account yet'}
                    </span>
                </div>
            </div>
            <div class="person-stats">
                <div class="person-stat">
                    <div class="value">${eventCount}</div>
                    <div class="label">Events</div>
                </div>
                <div class="person-stat">
                    <div class="value">${roleCount}</div>
                    <div class="label">Unique Roles</div>
                </div>
                <div class="person-stat">
                    <div class="value">${participations.length}</div>
                    <div class="label">Participations</div>
                </div>
            </div>
            <div class="timeline">
                <div class="timeline-title">Participation History</div>
                ${timelineHTML}
            </div>
        </div>
    `;
}

function getRoleIcon(role) {
    const icons = {
        interest: '📋',
        participant: '🏃',
        judge: '⚖️',
        committee: '🛡️',
        sponsor: '💎'
    };
    return icons[role] || '●';
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
