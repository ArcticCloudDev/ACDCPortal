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
        container.innerHTML = '<div class="empty-state">No sequences yet. Open an event in Events and use its Sequence tab to create one.</div>';
        return;
    }

    container.innerHTML = allSequences.map(seq => {
        const createdDate = new Date(seq.createdAt).toLocaleDateString();

        return `
            <div class="sequence-card">
                <div class="sequence-header" data-sequence-id="${escapeHtml(seq.id)}">
                    <div class="sequence-info">
                        <h3>${escapeHtml(seq.name)}</h3>
                        <div class="sequence-meta">
                            ${seq.emailCount || 0} email${(seq.emailCount || 0) !== 1 ? 's' : ''} ·
                            ${seq.stats?.sent || 0} sent ·
                            ${seq.stats?.failed || 0} failed ·
                            Created ${createdDate}
                        </div>
                    </div>
                </div>
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
            statsEl.innerHTML =
                `<p style="color: var(--admin-text-muted); font-size: 0.9rem;">
                    This sequence is not assigned to any events yet.
                    <strong>Assign it to exactly one event</strong> to start sending emails to interest leads.
                </p>`;
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
                name: event.name,
                leads: eventLeads.length,
                verified: verifiedLeads.length,
                teams: teamMemberCount
            };
        });

        statsEl.innerHTML = `
            <div style="background: var(--admin-bg-secondary); padding: 12px; border-radius: 4px; margin-bottom: 16px;">
                <strong style="color: var(--admin-accent);">📊 Sequence Recipients</strong>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 8px;">
                    <div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: var(--admin-success);">${verifiedInterestLeads}</div>
                        <div style="font-size: 0.85rem; color: var(--admin-text-muted);">Verified Interest Leads</div>
                    </div>
                    <div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: var(--admin-text-muted);">${totalInterestLeads - verifiedInterestLeads}</div>
                        <div style="font-size: 0.85rem; color: var(--admin-text-muted);">Unverified Leads</div>
                    </div>
                    <div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: var(--admin-info);">${totalTeamMembers}</div>
                        <div style="font-size: 0.85rem; color: var(--admin-text-muted);">Team Members</div>
                    </div>
                </div>
                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--admin-border);">
                    <strong style="font-size: 0.9rem;">Events using this sequence:</strong>
                    ${eventStats.map(e => `
                        <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-top: 4px;">
                            • ${escapeHtml(e.name)}: ${e.verified} verified leads, ${e.teams} team members
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

    } catch (err) {
        console.error('[STATS] Failed to load sequence stats:', err);
        statsEl.innerHTML =
            `<p style="color: var(--admin-danger); font-size: 0.9rem;">Failed to load recipient statistics: ${escapeHtml(err.message)}</p>`;
    }
}

function renderEmails() {
    const tbody = document.getElementById('emails-body');

    if (currentEmails.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state-small">No emails yet. Add emails from the event\'s Sequence tab.</td></tr>';
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

                    statusBadge = '<span class="badge" style="background: var(--admin-warning);">⏰ Scheduled</span>';
                    scheduleBadge = `<br><small style="color: var(--admin-text-muted);">
                        Sends: ${schedDate.toLocaleDateString()} ${schedDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        <span style="font-weight: bold;">${timezoneStr}</span>
                    </small>`;
                } else {
                    statusBadge = '<span class="badge" style="background: var(--admin-success);">✅ Live</span>';
                }
            } else {
                statusBadge = '<span class="badge" style="background: var(--admin-success);">✅ Live</span>';
            }
        } else {
            statusBadge = '<span class="badge" style="background: var(--admin-text-muted);">📝 Draft</span>';
        }

        return `
            <tr>
                <td><span class="badge sequence">#${Number(email.sequenceOrder ?? (index + 1))}</span></td>
                <td>
                    <strong>${escapeHtml(email.subject)}</strong>
                    ${scheduleBadge}
                </td>
                <td>${statusBadge}</td>
                <td><span style="color: var(--admin-success);">${Number(email.stats?.sent) || 0}</span></td>
                <td><span style="color: var(--admin-danger);">${Number(email.stats?.failed) || 0}</span></td>
                <td>${createdDate}</td>
                <td>
                    <span style="color: var(--admin-text-muted); font-size: 0.85rem;">View only</span>
                </td>
            </tr>
        `;
    }).join('');
}

document.addEventListener('DOMContentLoaded', init);
