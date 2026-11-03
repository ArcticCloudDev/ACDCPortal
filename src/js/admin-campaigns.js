// Read-only view of email sequences. Sequences and their emails are managed from the
// Sequence tab of an event in admin-events.html.
let allSequences = [];
let allEvents = [];
let currentSequence = null;
let currentSequenceId = null;
let currentEmails = [];
let currentPermissions = null;

async function init() {
    currentPermissions = await Permissions.initAdminPage('campaigns', {
        loadingEl: document.getElementById('loading')
    });

    if (!currentPermissions) return;

    document.getElementById('back-to-sequences').addEventListener('click', (e) => {
        e.preventDefault();
        showSequencesList();
    });

    document.getElementById('sequences-list').addEventListener('click', (e) => {
        const header = e.target.closest('.sequence-header[data-sequence-id]');
        if (header) showSequenceDetail(header.dataset.sequenceId);
    });

    await loadEvents();
    await loadSequences();

    const urlParams = new URLSearchParams(window.location.search);
    const sequenceId = urlParams.get('sequence');
    if (sequenceId) {
        showSequenceDetail(sequenceId);
    }
}

async function loadEvents() {
    try {
        const response = await API.events.list();
        let events = response.events || response || [];
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
    } catch (err) {
        console.error('Failed to load events:', err);
    }
}

// One request for the campaigns and one per event that uses a sequence, instead of
// re-fetching the campaign list and every event's deliveries once per sequence.
async function loadSequences() {
    try {
        const response = await API.sequences.list();
        allSequences = response.sequences || [];

        const campaignsResponse = await API.campaigns.list();
        const allCampaigns = campaignsResponse.campaigns || [];

        const eventsWithSequence = allEvents.filter(e => e.sequenceId);
        const deliveriesByEvent = await Promise.all(eventsWithSequence.map(async event => {
            try {
                const res = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${encodeURIComponent(event.id)}`);
                if (!res.ok) return { event, deliveries: [] };
                const data = await res.json();
                return { event, deliveries: data.deliveries || [] };
            } catch (err) {
                console.error(`Failed to load deliveries for event ${event.id}:`, err);
                return { event, deliveries: [] };
            }
        }));

        for (const seq of allSequences) {
            seq.emailCount = allCampaigns.filter(c => sameId(c.sequenceId, seq.id)).length;
            const stats = { sent: 0, failed: 0 };
            if (seq.emailCount > 0) {
                for (const { event, deliveries } of deliveriesByEvent) {
                    if (!sameId(event.sequenceId, seq.id)) continue;
                    stats.sent += deliveries.filter(d => d.status === 'sent').length;
                    stats.failed += deliveries.filter(d => d.status === 'failed').length;
                }
            }
            seq.stats = stats;
        }

        renderSequences();
    } catch (err) {
        console.error('Failed to load sequences:', err);
    }
}

function renderSequences() {
    const container = document.getElementById('sequences-list');

    if (allSequences.length === 0) {
        container.innerHTML = '<div class="empty-state">No sequences yet. Open an event in <a href="admin-events.html">Events</a> and use its Sequence tab to create one.</div>';
        return;
    }

    container.innerHTML = allSequences.map(seq => {
        const createdDate = new Date(seq.createdAt).toLocaleDateString();
        const emailCount = seq.emailCount || 0;
        const failed = Number(seq.stats?.failed) || 0;
        const usedBy = allEvents.filter(e => sameId(e.sequenceId, seq.id)).map(e => e.name);
        const usage = usedBy.length
            ? `<span class="badge badge-accent">${icon('calendar-days')}${escapeHtml(usedBy.join(', '))}</span>`
            : '<span class="badge">Not assigned to an event</span>';

        return `
            <div class="sequence-card">
                <button type="button" class="sequence-header" data-sequence-id="${escapeHtml(seq.id)}">
                    <span class="sequence-info">
                        <span class="sequence-name">${escapeHtml(seq.name)}</span>
                        <span class="sequence-meta meta-list">
                            <span class="meta-item">${icon('mail')}${emailCount} email${emailCount !== 1 ? 's' : ''}</span>
                            <span class="meta-item">${icon('send')}${Number(seq.stats?.sent) || 0} sent</span>
                            ${failed ? `<span class="meta-item failed-count">${icon('circle-x')}${failed} failed</span>` : ''}
                            <span class="meta-item">${icon('calendar')}Created ${createdDate}</span>
                        </span>
                    </span>
                    <span class="sequence-usage">${usage}</span>
                    ${icon('chevron-right', 'sequence-chevron')}
                </button>
            </div>
        `;
    }).join('');
}

function showView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(`view-${viewName}`).classList.remove('hidden');
}

function showSequencesList() {
    showView('sequences');
    loadSequences();
    window.history.replaceState({}, '', 'admin-campaigns.html');
}

async function showSequenceDetail(sequenceId) {
    try {
        const response = await API.sequences.get(sequenceId);
        currentSequence = response.sequence;
        currentSequenceId = sequenceId;
        currentEmails = response.emails || [];

        await loadSequenceStats(sequenceId);

        document.getElementById('detail-sequence-name').textContent = currentSequence.name;
        document.getElementById('detail-sequence-meta').textContent =
            `${currentEmails.length} email${currentEmails.length !== 1 ? 's' : ''}`;

        renderEmails();
        showView('sequence-detail');
        window.history.replaceState({}, '', `admin-campaigns.html?sequence=${encodeURIComponent(sequenceId)}`);
    } catch (err) {
        console.error('Failed to load sequence:', err);
        alert('Failed to load sequence details');
    }
}

// Team members per event, derived from participations (GET /teams returns no members).
function countTeamMembersByEvent(participations, teams) {
    const eventByTeam = {};
    for (const t of teams) eventByTeam[String(t.id).toLowerCase()] = String(t.eventId || '').toLowerCase();
    const counts = {};
    for (const p of participations) {
        let teamKey = null;
        if (p.teamId && (p.roles || []).includes('participant')) {
            teamKey = String(p.teamId).toLowerCase();
        } else {
            const m = (p.teamMemberships || []).find(x => x.isParticipant && x.teamId);
            if (m) teamKey = String(m.teamId).toLowerCase();
        }
        if (!teamKey) continue;
        const eventKey = eventByTeam[teamKey];
        if (!eventKey) continue;
        counts[eventKey] = (counts[eventKey] || 0) + 1;
    }
    return counts;
}

async function loadSequenceStats(sequenceId) {
    const statsEl = document.getElementById('sequence-stats');
    try {
        const eventsUsingSequence = allEvents.filter(e => sameId(e.sequenceId, sequenceId));

        if (eventsUsingSequence.length === 0) {
            statsEl.innerHTML = `
                <div class="notice notice-warning">
                    ${icon('triangle-alert')}
                    <div>
                        <div class="notice-title">Not assigned to an event</div>
                        <div class="notice-body">This sequence sends nothing yet. Assign it to exactly one event, in that event's Sequence tab, to start sending emails to interest leads.</div>
                    </div>
                </div>`;
            return;
        }

        const [leadsData, teamsResponse, participationsResponse] = await Promise.all([
            fetch(`${CONFIG.api.baseUrl}/interest/leads?verified=false`).then(r => r.ok ? r.json() : { leads: [] }),
            API.teams.list(),
            API.participations.list().catch(() => [])
        ]);
        const allLeads = leadsData.leads || [];
        const teams = Array.isArray(teamsResponse) ? teamsResponse : (teamsResponse.teams || []);
        const participations = Array.isArray(participationsResponse) ? participationsResponse : (participationsResponse.participations || []);
        const membersByEvent = countTeamMembersByEvent(participations, teams);

        let totalInterestLeads = 0;
        let verifiedInterestLeads = 0;
        let totalTeamMembers = 0;

        const eventStats = eventsUsingSequence.map(event => {
            const eventLeads = allLeads.filter(l => sameId(l.eventId, event.id));
            const verifiedLeads = eventLeads.filter(l => l.verified);
            const teamMemberCount = membersByEvent[String(event.id).toLowerCase()] || 0;

            totalInterestLeads += eventLeads.length;
            verifiedInterestLeads += verifiedLeads.length;
            totalTeamMembers += teamMemberCount;

            return {
                id: event.id,
                name: event.name,
                leads: eventLeads.length,
                verified: verifiedLeads.length,
                teams: teamMemberCount
            };
        });

        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        statsEl.innerHTML = `
            <div class="stats-row">
                <div class="stat-card">
                    <div class="stat-icon tone-accent">${icon('mail-check')}</div>
                    <div class="stat-content">
                        <div class="stat-value">${verifiedInterestLeads}</div>
                        <div class="stat-label">Verified interest leads</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon tone-neutral">${icon('hourglass')}</div>
                    <div class="stat-content">
                        <div class="stat-value">${totalInterestLeads - verifiedInterestLeads}</div>
                        <div class="stat-label">Unverified leads (not emailed)</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon tone-accent">${icon('users')}</div>
                    <div class="stat-content">
                        <div class="stat-value">${totalTeamMembers}</div>
                        <div class="stat-label">Team members</div>
                    </div>
                </div>
            </div>
            <section class="panel" aria-labelledby="sequence-events-title">
                <div class="panel-header">
                    <h2 class="panel-title" id="sequence-events-title">${icon('calendar-days')}Used by</h2>
                </div>
                ${eventStats.map(e => `
                    <div class="event-row">
                        <div class="event-info">
                            <a class="event-name" href="admin-events.html?event=${encodeURIComponent(e.id)}">${escapeHtml(e.name)}</a>
                            <div class="event-meta">
                                <span>${icon('mail-check')}${plural(e.verified, 'verified lead')}</span>
                                <span>${icon('users')}${plural(e.teams, 'team member')}</span>
                            </div>
                        </div>
                        <div class="row-actions">
                            <a class="btn-sm" href="admin-events.html?event=${encodeURIComponent(e.id)}&amp;tab=sequence">${icon('pencil')}Edit sequence</a>
                        </div>
                    </div>
                `).join('')}
            </section>
        `;

    } catch (err) {
        console.error('[STATS] Failed to load sequence stats:', err);
        statsEl.innerHTML = `
            <div class="notice notice-danger">
                ${icon('circle-alert')}
                <div>Failed to load recipient statistics: ${escapeHtml(err.message)}</div>
            </div>`;
    }
}

function renderEmails() {
    const tbody = document.getElementById('emails-body');

    if (currentEmails.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No emails yet. Add emails from the event\'s Sequence tab.</td></tr>';
        return;
    }

    tbody.innerHTML = currentEmails.map((email, index) => {
        const createdDate = new Date(email.createdAt).toLocaleDateString();
        const status = email.status || 'draft';

        let statusBadge = '';
        let scheduleBadge = '';

        if (status === 'live') {
            if (email.scheduledSendTime) {
                const schedDate = new Date(email.scheduledSendTime);
                const now = new Date();
                if (schedDate > now) {
                    const offsetMinutes = schedDate.getTimezoneOffset();
                    const offsetHours = Math.abs(offsetMinutes / 60);
                    const offsetSign = offsetMinutes <= 0 ? '+' : '-';
                    const timezoneStr = `GMT${offsetSign}${Math.floor(offsetHours)}`;

                    statusBadge = `<span class="badge badge-info">${icon('clock')}Scheduled</span>`;
                    scheduleBadge = `<div class="sequence-email-schedule">
                        Sends ${schedDate.toLocaleDateString()} ${schedDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        <strong>${timezoneStr}</strong>
                    </div>`;
                } else {
                    statusBadge = '<span class="badge badge-violet badge-dot">Live</span>';
                }
            } else {
                statusBadge = '<span class="badge badge-violet badge-dot">Live</span>';
            }
        } else {
            statusBadge = '<span class="badge">Draft</span>';
        }

        const failed = Number(email.stats?.failed) || 0;

        return `
            <tr>
                <td><span class="badge sequence">#${Number(email.sequenceOrder ?? (index + 1))}</span></td>
                <td>
                    <strong>${escapeHtml(email.subject)}</strong>
                    ${scheduleBadge}
                </td>
                <td>${statusBadge}</td>
                <td class="num">${Number(email.stats?.sent) || 0}</td>
                <td class="num${failed ? ' failed-count' : ' text-muted'}">${failed}</td>
                <td class="text-muted">${createdDate}</td>
            </tr>
        `;
    }).join('');
}

document.addEventListener('DOMContentLoaded', init);
