let currentUser = null;
let allBadges = [];
let allEvents = [];
let allEventBadges = [];
let allClaims = [];
let judgeUsers = [];
let selectedEventId = null;
let currentPermissions = null;
let allClaimsEventBadges = [];
let allJudgeUsers = [];

// Categories are labels, not statuses: they get a Lucide icon and neutral styling.
const CATEGORIES = {
    'soft': { label: 'Soft code', icon: 'handshake' },
    'low-code': { label: 'Low code', icon: 'zap' },
    'pro-code': { label: 'Pro code', icon: 'laptop' },
    'sponsor': { label: 'Sponsor', icon: 'building-2' }
};

const CATEGORY_ORDER = ['soft', 'low-code', 'pro-code', 'sponsor'];

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>');
        }
    }, 1200);
    const adminContent = document.getElementById('admin-content');

    currentPermissions = await Permissions.initAdminPage('badges', {
        loadingEl: loadingDiv,
        contentEl: adminContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        await loadAllData();

        setupEventListeners();

        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        adminContent.classList.remove('hidden');

        const isJudgeOnly = currentPermissions.highestRole === 'judge';
        if (isJudgeOnly) {
            document.querySelectorAll('.tab-btn[data-tab="master"], .tab-btn[data-tab="event-badges"]').forEach(t => t.classList.add('hidden'));
            document.getElementById('tab-master')?.classList.remove('active');
            document.querySelector('.tab-btn[data-tab="claims"]').classList.add('active');
            document.getElementById('tab-claims').classList.add('active');
            document.getElementById('badges-subtitle').textContent = 'Review the badge claims assigned to you and award exclusive badges.';
            renderClaims();
        } else {
            renderBadgeLibrary();
        }

    } catch (error) {
        console.error('Init error:', error);
        loadingDiv.innerHTML = `<div class="notice notice-danger">${icon('triangle-alert')}<div><div class="notice-title">Could not load badges</div><div class="notice-body">Please refresh the page.</div></div></div>`;
    }
});

async function loadAllData() {
    const [badges, events, claims] = await Promise.all([
        API.request('/badges'),
        API.request('/events'),
        API.request('/badge-claims')
    ]);

    allBadges = badges;
    allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
    allClaims = claims;

    try {
        const ebPromises = allEvents.map(e => API.request(`/events/${e.id}/badges`));
        const ebResults = await Promise.all(ebPromises);
        allClaimsEventBadges = ebResults.flat();
    } catch (e) {
        console.warn('Could not load event-badges for claims:', e);
        allClaimsEventBadges = [];
    }

    await loadJudgeUsersForClaims();
}

// Judges of an event, named. The event roster carries names for event staff, so judges see
// each other without access to the global people list.
async function loadEventJudges(eventId) {
    const participations = await API.participations.getByEvent(eventId, 'judge');
    return (participations || [])
        .filter(p => p.userId)
        .map(p => ({
            id: p.userId,
            name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.email || 'Unknown'
        }));
}

async function loadJudgeUsersForClaims() {
    const eventIds = [...new Set(allClaimsEventBadges.filter(eb => eb.judgeUserId).map(eb => eb.eventId))];
    if (eventIds.length === 0) { allJudgeUsers = []; return; }
    try {
        const judgesByEvent = await Promise.all(eventIds.map(loadEventJudges));
        const byId = new Map();
        for (const judge of judgesByEvent.flat()) byId.set(String(judge.id).toLowerCase(), judge);
        allJudgeUsers = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        console.warn('Could not load judge users:', e);
        allJudgeUsers = [];
    }
}

async function loadEventBadges(eventId) {
    allEventBadges = await API.request(`/events/${eventId}/badges`);

    judgeUsers = [];
    try {
        judgeUsers = (await loadEventJudges(eventId)).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        console.warn('Could not load judges:', e);
    }
}

function setupEventListeners() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

            if (btn.dataset.tab === 'claims') renderClaims();
        });
    });

    // Category filter pills: exactly one is active ("All" has an empty category).
    document.getElementById('filter-category').addEventListener('click', (e) => {
        const pill = e.target.closest('.pill[data-category]');
        if (!pill) return;
        document.querySelectorAll('#filter-category .pill').forEach(p => {
            const on = p === pill;
            p.classList.toggle('active', on);
            p.setAttribute('aria-pressed', String(on));
        });
        renderBadgeLibrary();
    });
    document.getElementById('filter-search').addEventListener('input', debounce(renderBadgeLibrary, 250));

    document.getElementById('add-badge-btn').addEventListener('click', () => openBadgeModal());
    document.getElementById('badge-save-btn').addEventListener('click', saveBadge);
    document.getElementById('close-badge-modal-btn').addEventListener('click', closeBadgeModal);
    document.getElementById('cancel-badge-modal-btn').addEventListener('click', closeBadgeModal);
    document.getElementById('close-review-modal-btn').addEventListener('click', closeReviewModal);
    document.getElementById('cancel-review-modal-btn').addEventListener('click', closeReviewModal);
    document.getElementById('submit-review-btn').addEventListener('click', submitReview);

    // Generated markup only carries data-action attributes; these listeners dispatch them.
    document.getElementById('badges-container').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'edit-badge') openBadgeModal(btn.dataset.badgeId);
        if (btn.dataset.action === 'delete-badge') deleteBadge(btn.dataset.badgeId, btn);
    });
    document.getElementById('event-badges-list').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action="toggle-category"]');
        if (btn) toggleAllCategory(btn.dataset.category, btn.dataset.checked === 'true');
    });
    document.getElementById('claims-grouped-container').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'review-claim') openReviewModal(btn.dataset.claimId);
        if (btn.dataset.action === 'view-comments') viewDeclineComments(btn.dataset.claimId);
        if (btn.dataset.action === 'award-badge') awardBadgeInline(btn.dataset.eventBadgeId, btn);
    });

    document.getElementById('event-badge-selector').addEventListener('change', async (e) => {
        selectedEventId = e.target.value;
        if (selectedEventId) {
            await loadEventBadges(selectedEventId);
            renderEventBadges();
            document.getElementById('event-badges-content').classList.remove('hidden');
            document.getElementById('event-badges-empty').classList.add('hidden');
        } else {
            document.getElementById('event-badges-content').classList.add('hidden');
            document.getElementById('event-badges-empty').classList.remove('hidden');
        }
    });

    document.getElementById('save-event-badges-btn').addEventListener('click', saveEventBadges);

    document.getElementById('claims-event-filter').addEventListener('change', renderClaims);
    document.getElementById('claims-status-filter').addEventListener('change', renderClaims);
    document.getElementById('claims-category-filter').addEventListener('change', renderClaims);

    document.getElementById('review-decision').addEventListener('change', (e) => {
        document.getElementById('decline-reason-group').classList.toggle('hidden', e.target.value !== 'declined');
    });

    populateEventSelectors();
}

function populateEventSelectors() {
    const eventBadgeSelect = document.getElementById('event-badge-selector');
    const claimsEventFilter = document.getElementById('claims-event-filter');

    allEvents.forEach(event => {
        const opt1 = new Option(`${event.name} (${event.status})`, event.id);
        const opt2 = new Option(event.name, event.id);
        eventBadgeSelect.appendChild(opt1);
        claimsEventFilter.appendChild(opt2);
    });
}

function categoryBadge(category) {
    const catConfig = CATEGORIES[category];
    if (!catConfig) return category ? `<span class="badge">${escapeHtml(category)}</span>` : '';
    return `<span class="badge">${icon(catConfig.icon, 'icon-sm')}${catConfig.label}</span>`;
}

function renderBadgeLibrary() {
    const container = document.getElementById('badges-container');
    const filterCategory = document.querySelector('#filter-category .pill.active')?.dataset.category || '';
    const filterSearch = document.getElementById('filter-search').value.toLowerCase();

    let badges = [...allBadges];

    if (filterCategory) {
        badges = badges.filter(b => b.category === filterCategory);
    }
    if (filterSearch) {
        badges = badges.filter(b =>
            (b.name || '').toLowerCase().includes(filterSearch) ||
            (b.description || '').toLowerCase().includes(filterSearch)
        );
    }

    document.getElementById('stat-total').textContent = allBadges.length;
    document.getElementById('stat-soft').textContent = allBadges.filter(b => b.category === 'soft').length;
    document.getElementById('stat-lowcode').textContent = allBadges.filter(b => b.category === 'low-code').length;
    document.getElementById('stat-procode').textContent = allBadges.filter(b => b.category === 'pro-code').length;
    document.getElementById('stat-sponsor').textContent = allBadges.filter(b => b.category === 'sponsor').length;

    if (badges.length === 0) {
        container.innerHTML = `<div class="panel"><div class="empty-state"><span class="empty-state-icon">${icon('award')}</span><p>No badges found</p></div></div>`;
        return;
    }

    const grouped = {};
    for (const badge of badges) {
        if (!grouped[badge.category]) grouped[badge.category] = [];
        grouped[badge.category].push(badge);
    }

    let html = '';
    for (const cat of CATEGORY_ORDER) {
        if (!grouped[cat]) continue;
        const catConfig = CATEGORIES[cat];
        html += `
            <section class="badge-category">
                <div class="badge-category-header">
                    <h2>${icon(catConfig.icon)}${catConfig.label}</h2>
                    <span class="badge count">${grouped[cat].length} badge${grouped[cat].length !== 1 ? 's' : ''}</span>
                </div>
                <div class="badge-grid">
                    ${grouped[cat].map(badge => renderBadgeCard(badge)).join('')}
                </div>
            </section>
        `;
    }

    container.innerHTML = html;
}

function renderBadgeCard(badge) {
    const catConfig = CATEGORIES[badge.category] || { label: badge.category, icon: 'award' };
    const isExclusive = (badge.claimType || 'common') === 'exclusive';
    const claimLabel = isExclusive
        ? `<span class="meta-item" title="Judges award it to one team">${icon('gem')}Exclusive</span>`
        : `<span class="meta-item" title="Teams claim it with a blog post">${icon('target')}Common</span>`;
    const name = escapeHtml(badge.name);
    return `
        <article class="badge-card">
            <div class="badge-card-top">
                <span class="badge-card-icon">${icon(catConfig.icon)}</span>
                <div class="badge-card-text">
                    <h3 class="badge-name">${name}</h3>
                    ${badge.description ? `<p class="badge-desc">${escapeHtml(badge.description)}</p>` : ''}
                </div>
                <div class="badge-actions">
                    <button type="button" class="btn-sm icon-only" data-action="edit-badge" data-badge-id="${escapeHtml(badge.id)}" aria-label="Edit ${name}" title="Edit">${icon('pencil')}</button>
                    <button type="button" class="btn-sm icon-only danger-ghost" data-action="delete-badge" data-badge-id="${escapeHtml(badge.id)}" aria-label="Delete ${name}" title="Delete">${icon('trash-2')}</button>
                </div>
            </div>
            <div class="meta-list badge-card-meta">
                <span class="meta-item badge-points">${icon('trophy')}${Number(badge.points) || 0} pts</span>
                ${claimLabel}
            </div>
        </article>
    `;
}

function renderEventBadges() {
    const container = document.getElementById('event-badges-list');

    const assignedBadgeIds = new Set(allEventBadges.map(eb => eb.badgeId));

    const judgesAssigned = allEventBadges.filter(eb => eb.judgeUserId).length;
    const eventClaims = allClaims.filter(c => c.eventId === selectedEventId);
    const maxPoints = allEventBadges.reduce((sum, eb) => {
        const badge = eb.badge || allBadges.find(b => b.id === eb.badgeId);
        return sum + (badge ? badge.points : 0);
    }, 0);

    document.getElementById('eb-stat-assigned').textContent = allEventBadges.length;
    document.getElementById('eb-stat-judges').textContent = judgesAssigned;
    document.getElementById('eb-stat-claims').textContent = eventClaims.length;
    document.getElementById('eb-stat-points').textContent = maxPoints;

    const judges = getJudgesForEvent(selectedEventId);

    let html = '';
    for (const cat of CATEGORY_ORDER) {
        const catBadges = allBadges.filter(b => b.category === cat);
        if (catBadges.length === 0) continue;

        const catConfig = CATEGORIES[cat];
        const assignedInCat = catBadges.filter(b => assignedBadgeIds.has(b.id)).length;

        html += `
            <section class="panel event-badge-panel">
                <div class="panel-header">
                    <h3 class="panel-title">${icon(catConfig.icon)}${catConfig.label}<span class="badge count">${assignedInCat}/${catBadges.length} offered</span></h3>
                    <div class="row-actions">
                        <button type="button" class="btn-sm ghost" data-action="toggle-category" data-category="${cat}" data-checked="true">Select all<span class="visually-hidden"> ${catConfig.label.toLowerCase()} badges</span></button>
                        <button type="button" class="btn-sm ghost" data-action="toggle-category" data-category="${cat}" data-checked="false">Clear<span class="visually-hidden"> ${catConfig.label.toLowerCase()} badges</span></button>
                    </div>
                </div>
                <div class="event-badge-list">
        `;

        for (const badge of catBadges) {
            const assignment = allEventBadges.find(eb => eb.badgeId === badge.id);
            const isAssigned = !!assignment;
            const currentJudge = assignment ? assignment.judgeUserId : '';
            const name = escapeHtml(badge.name);

            html += `
                <div class="event-badge-row">
                    <label class="event-badge-check">
                        <input type="checkbox" class="event-badge-toggle" data-badge-id="${escapeHtml(badge.id)}" ${isAssigned ? 'checked' : ''}>
                        <span class="event-badge-info">
                            <span class="name">${name}<span class="points">${Number(badge.points) || 0} pts</span></span>
                            ${badge.description ? `<span class="desc">${escapeHtml(badge.description)}</span>` : ''}
                        </span>
                    </label>
                    <div class="event-badge-judge">
                        <select data-badge-id="${escapeHtml(badge.id)}" class="judge-select" aria-label="Judge for ${name}" ${!isAssigned ? 'disabled' : ''}>
                            <option value="">No judge</option>
                            ${judges.map(j => `<option value="${escapeHtml(j.id)}" ${sameId(currentJudge, j.id) ? 'selected' : ''}>${escapeHtml(j.name)}</option>`).join('')}
                        </select>
                    </div>
                </div>
            `;
        }

        html += '</div></section>';
    }

    container.innerHTML = html;

    container.querySelectorAll('.event-badge-toggle').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const badgeId = e.target.dataset.badgeId;
            const judgeSelect = Array.from(container.querySelectorAll('.judge-select')).find(s => s.dataset.badgeId === badgeId);
            if (judgeSelect) {
                judgeSelect.disabled = !e.target.checked;
                if (!e.target.checked) judgeSelect.value = '';
            }
        });
    });
}

function toggleAllCategory(category, checked) {
    const catBadges = allBadges.filter(b => b.category === category);
    for (const badge of catBadges) {
        const cb = Array.from(document.querySelectorAll('.event-badge-toggle')).find(el => el.dataset.badgeId === badge.id);
        if (cb) {
            cb.checked = checked;
            const judgeSelect = Array.from(document.querySelectorAll('.judge-select')).find(el => el.dataset.badgeId === badge.id);
            if (judgeSelect) {
                judgeSelect.disabled = !checked;
                if (!checked) judgeSelect.value = '';
            }
        }
    }
}

async function saveEventBadges() {
    const btn = document.getElementById('save-event-badges-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        const selectedBadgeIds = [];
        document.querySelectorAll('.event-badge-toggle:checked').forEach(cb => {
            selectedBadgeIds.push(cb.dataset.badgeId);
        });

        await API.request(`/events/${selectedEventId}/badges/bulk`, {
            method: 'POST',
            body: JSON.stringify({ selectedBadgeIds })
        });

        await loadEventBadges(selectedEventId);

        for (const eb of allEventBadges) {
            const judgeSelect = Array.from(document.querySelectorAll('.judge-select')).find(el => el.dataset.badgeId === eb.badgeId);
            if (judgeSelect) {
                const judgeUserId = judgeSelect.value || null;
                if (judgeUserId !== eb.judgeUserId) {
                    await API.request(`/events/${selectedEventId}/badges/${eb.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ judgeUserId })
                    });
                }
            }
        }

        await loadEventBadges(selectedEventId);
        renderEventBadges();

        btn.textContent = 'Saved';
        setTimeout(() => { btn.textContent = 'Save assignments'; btn.disabled = false; }, 2000);

    } catch (error) {
        console.error('Save event badges error:', error);
        alert('Failed to save: ' + error.message);
        btn.textContent = 'Save assignments';
        btn.disabled = false;
    }
}

function getJudgesForEvent(eventId) {
    return judgeUsers;
}

function renderClaims() {
    const container = document.getElementById('claims-grouped-container');
    const emptyState = document.getElementById('claims-empty');

    const eventFilter = document.getElementById('claims-event-filter').value;
    const statusFilter = document.getElementById('claims-status-filter').value;
    const categoryFilter = document.getElementById('claims-category-filter').value;

    let claims = [...allClaims];

    if (eventFilter) claims = claims.filter(c => c.eventId === eventFilter);
    if (statusFilter) claims = claims.filter(c => c.status === statusFilter);
    if (categoryFilter) claims = claims.filter(c => c.badge && c.badge.category === categoryFilter);

    let statClaims = eventFilter ? allClaims.filter(c => c.eventId === eventFilter) : allClaims;
    document.getElementById('cl-stat-total').textContent = statClaims.length;
    document.getElementById('cl-stat-pending').textContent = statClaims.filter(c => c.status === 'pending').length;
    document.getElementById('cl-stat-approved').textContent = statClaims.filter(c => c.status === 'approved').length;
    document.getElementById('cl-stat-declined').textContent = statClaims.filter(c => c.status === 'declined').length;

    const isPortalAdmin = currentPermissions?.isPortalAdmin;
    const isCommittee = currentPermissions?.highestRole === 'committee' || currentPermissions?.highestRole === 'portalAdmin';

    let html = '';

    if (!statusFilter || statusFilter === 'approved') {
        const exclusiveBadges = getExclusiveBadgesForUser(eventFilter);
        if (exclusiveBadges.length > 0) {
            const awardedCount = exclusiveBadges.filter(b => b.awardedTeamId).length;
            html += `
                <section class="panel claims-group exclusive-group">
                    <div class="panel-header">
                        <h2 class="panel-title">${icon('gem')}Exclusive badges</h2>
                        <div class="claims-group-stats">
                            <span class="badge">${exclusiveBadges.length} badge${exclusiveBadges.length !== 1 ? 's' : ''}</span>
                            ${awardedCount ? `<span class="badge badge-success">${icon('circle-check', 'icon-sm')}${awardedCount} awarded</span>` : ''}
                        </div>
                    </div>
                    <div class="panel-body">
                        <table class="data-table stack-sm">
                            <thead>
                                <tr>
                                    <th scope="col">Badge</th>
                                    <th scope="col">Category</th>
                                    <th scope="col">Points</th>
                                    <th scope="col">Awarded to</th>
                                    <th scope="col"><span class="visually-hidden">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${exclusiveBadges.map(b => renderExclusiveRow(b)).join('')}
                            </tbody>
                        </table>
                    </div>
                </section>
            `;
        }
    }

    if (claims.length === 0 && !html) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    const grouped = {};
    for (const claim of claims) {
        const eb = allClaimsEventBadges.find(e => e.id === claim.eventBadgeId);
        const judgeId = eb?.judgeUserId || '__unassigned__';
        if (!grouped[judgeId]) grouped[judgeId] = [];
        grouped[judgeId].push(claim);
    }

    const currentUserId = currentUser?.id;
    const groupOrder = Object.keys(grouped).sort((a, b) => {
        if (a === currentUserId) return -1;
        if (b === currentUserId) return 1;
        if (a === '__unassigned__') return 1;
        if (b === '__unassigned__') return -1;
        const nameA = allJudgeUsers.find(j => sameId(j.id, a))?.name || '';
        const nameB = allJudgeUsers.find(j => sameId(j.id, b))?.name || '';
        return nameA.localeCompare(nameB);
    });

    for (const judgeId of groupOrder) {
        const groupClaims = grouped[judgeId];
        const isMyGroup = judgeId === currentUserId;
        const canReview = isMyGroup || isPortalAdmin || isCommittee;

        let judgeName;
        let judgeIcon = 'scale';
        if (judgeId === '__unassigned__') {
            judgeName = 'No judge assigned';
            judgeIcon = 'circle-dot';
        } else if (isMyGroup) {
            judgeName = 'Assigned to you';
            judgeIcon = 'user-check';
        } else {
            const judge = allJudgeUsers.find(j => sameId(j.id, judgeId));
            judgeName = judge ? judge.name : 'Unknown judge';
        }

        const pendingCount = groupClaims.filter(c => c.status === 'pending').length;
        const approvedCount = groupClaims.filter(c => c.status === 'approved').length;
        const declinedCount = groupClaims.filter(c => c.status === 'declined').length;

        html += `
            <section class="panel claims-group ${isMyGroup ? 'my-group' : ''}">
                <div class="panel-header">
                    <h2 class="panel-title">${icon(judgeIcon)}${escapeHtml(judgeName)}</h2>
                    <div class="claims-group-stats">
                        <span class="badge">${groupClaims.length} claim${groupClaims.length !== 1 ? 's' : ''}</span>
                        ${pendingCount ? `<span class="badge badge-warning">${icon('hourglass', 'icon-sm')}${pendingCount} pending</span>` : ''}
                        ${approvedCount ? `<span class="badge badge-success">${icon('circle-check', 'icon-sm')}${approvedCount} approved</span>` : ''}
                        ${declinedCount ? `<span class="badge badge-danger">${icon('circle-x', 'icon-sm')}${declinedCount} declined</span>` : ''}
                    </div>
                </div>
                <div class="panel-body">
                    <table class="data-table stack-sm">
                        <thead>
                            <tr>
                                <th scope="col">Badge</th>
                                <th scope="col">Category</th>
                                <th scope="col">Team</th>
                                <th scope="col">Evidence</th>
                                <th scope="col">Status</th>
                                <th scope="col">Claimed</th>
                                <th scope="col"><span class="visually-hidden">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${groupClaims.map(claim => renderClaimRow(claim, canReview)).join('')}
                        </tbody>
                    </table>
                </div>
            </section>
        `;
    }

    container.innerHTML = html;
    loadTeamsForExclusiveDropdowns();
}

// Evidence is usually the team's blog post URL; link it so judges can open it in one tap.
function evidenceLink(claim, className) {
    const text = claim.evidence || '';
    const href = safeHttpUrl(claim.evidence) || safeHttpUrl(claim.blogUrl);
    if (!text) return '';
    if (!href) return `<span class="${className}" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
    return `<a class="${className}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(text)}">${escapeHtml(text)}</a>`;
}

function claimStatusBadge(status) {
    const meta = {
        pending: { tone: 'badge-warning', icon: 'hourglass' },
        approved: { tone: 'badge-success', icon: 'circle-check' },
        declined: { tone: 'badge-danger', icon: 'circle-x' }
    }[status];
    if (!meta) return `<span class="badge">${escapeHtml(capitalize(status))}</span>`;
    return `<span class="badge ${meta.tone}">${icon(meta.icon, 'icon-sm')}${escapeHtml(capitalize(status))}</span>`;
}

function renderClaimRow(claim, canReview) {
    const badgeName = claim.badge ? claim.badge.name : 'Unknown';
    const badgeCategory = claim.badge ? claim.badge.category : '';
    const teamName = claim.team ? claim.team.teamName : 'Unknown';
    const claimedDate = claim.claimedAt ? new Date(claim.claimedAt).toLocaleDateString() : '';

    let actions = '';
    if (claim.status === 'pending' && canReview) {
        actions = `<button type="button" class="btn-sm" data-action="review-claim" data-claim-id="${escapeHtml(claim.id)}">${icon('square-pen', 'icon-sm')}Review<span class="visually-hidden"> ${escapeHtml(badgeName)} for ${escapeHtml(teamName)}</span></button>`;
    } else if (claim.status === 'pending') {
        actions = '<span class="text-muted">Awaiting review</span>';
    } else if (claim.status === 'declined' && claim.declineReason) {
        actions = `<button type="button" class="btn-sm ghost" data-action="view-comments" data-claim-id="${escapeHtml(claim.id)}">${icon('message-square', 'icon-sm')}View reason</button>`;
    }

    return `
        <tr>
            <td class="cell-title" data-label="Badge"><strong>${escapeHtml(badgeName)}</strong></td>
            <td data-label="Category">${categoryBadge(badgeCategory)}</td>
            <td data-label="Team">${escapeHtml(teamName)}</td>
            <td data-label="Evidence">${evidenceLink(claim, 'claim-evidence') || '<span class="text-muted">—</span>'}</td>
            <td data-label="Status">${claimStatusBadge(claim.status)}</td>
            <td data-label="Claimed" class="text-muted">${claimedDate}</td>
            <td class="cell-actions">${actions}</td>
        </tr>
    `;
}

function openBadgeModal(badgeId = null) {
    const modal = document.getElementById('badge-modal');
    const title = document.getElementById('badge-modal-title');

    if (badgeId) {
        const badge = allBadges.find(b => sameId(b.id, badgeId));
        if (!badge) return;

        title.textContent = 'Edit badge';
        document.getElementById('badge-edit-id').value = badge.id;
        document.getElementById('badge-name').value = badge.name;
        document.getElementById('badge-category').value = badge.category;
        document.getElementById('badge-claimType').value = badge.claimType || 'common';
        document.getElementById('badge-description').value = badge.description || '';
        document.getElementById('badge-points').value = badge.points;
        document.getElementById('badge-imageUrl').value = badge.imageUrl || '';
    } else {
        title.textContent = 'Add badge';
        document.getElementById('badge-edit-id').value = '';
        document.getElementById('badge-name').value = '';
        document.getElementById('badge-category').value = '';
        document.getElementById('badge-claimType').value = 'common';
        document.getElementById('badge-description').value = '';
        document.getElementById('badge-points').value = '';
        document.getElementById('badge-imageUrl').value = '';
    }

    modal.classList.add('visible');
}

function closeBadgeModal() {
    document.getElementById('badge-modal').classList.remove('visible');
}

async function saveBadge() {
    const id = document.getElementById('badge-edit-id').value;
    const data = {
        name: document.getElementById('badge-name').value.trim(),
        category: document.getElementById('badge-category').value,
        claimType: document.getElementById('badge-claimType').value || 'common',
        description: document.getElementById('badge-description').value.trim(),
        points: parseInt(document.getElementById('badge-points').value) || 0,
        imageUrl: document.getElementById('badge-imageUrl').value.trim()
    };

    if (!data.name) return alert('Badge name is required');
    if (!data.category) return alert('Category is required');

    const btn = document.getElementById('badge-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        if (id) {
            await API.request(`/badges/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        } else {
            await API.request('/badges', { method: 'POST', body: JSON.stringify(data) });
        }

        await loadAllData();
        renderBadgeLibrary();
        closeBadgeModal();
    } catch (error) {
        alert('Failed to save: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save badge';
    }
}

async function deleteBadge(badgeId, button) {
    const badge = allBadges.find(b => sameId(b.id, badgeId));
    if (!badge) return;

    if (!confirm(`Delete "${badge.name}"? This will also remove it from all event assignments.`)) return;

    // No busy label: the button is icon-only, so it just stays disabled while the request runs.
    await withBusy(button, null, async () => {
        try {
            await API.request(`/badges/${encodeURIComponent(badge.id)}`, { method: 'DELETE' });
            await loadAllData();
            renderBadgeLibrary();
        } catch (error) {
            alert('Failed to delete: ' + error.message);
        }
    });
}

// Fills the claim summary at the top of the review dialog.
function fillReviewSummary(claim) {
    document.getElementById('review-badge-name').textContent = claim.badge ? claim.badge.name : 'Unknown badge';
    document.getElementById('review-team-name').textContent = claim.team ? claim.team.teamName : 'Unknown team';
    const link = evidenceLink(claim, 'review-evidence-link');
    document.getElementById('review-evidence').innerHTML = link
        ? `<div class="review-label">Evidence</div>${link}`
        : '<div class="review-label">Evidence</div><span class="text-muted">No evidence provided</span>';
}

function setReviewComments(title, reason) {
    const commentsEl = document.getElementById('review-previous-comments');
    commentsEl.innerHTML = `${icon('message-square')}<div><div class="notice-title">${title}</div><div class="notice-body">${escapeHtml(reason)}</div></div>`;
    commentsEl.classList.remove('hidden');
}

function openReviewModal(claimId) {
    const claim = allClaims.find(c => sameId(c.id, claimId));
    if (!claim) return;

    document.getElementById('review-claim-id').value = claimId;
    document.getElementById('review-modal-title').textContent = 'Review claim';
    document.getElementById('cancel-review-modal-btn').textContent = 'Cancel';
    fillReviewSummary(claim);

    if (claim.declineReason) {
        setReviewComments('Previous reviewer comments', claim.declineReason);
    } else {
        document.getElementById('review-previous-comments').classList.add('hidden');
    }

    document.getElementById('review-decision').value = '';
    document.getElementById('review-decline-reason').value = '';
    document.getElementById('decline-reason-group').classList.add('hidden');

    document.getElementById('review-modal').classList.add('visible');
}

function viewDeclineComments(claimId) {
    const claim = allClaims.find(c => sameId(c.id, claimId));
    if (!claim || !claim.declineReason) return;

    document.getElementById('review-claim-id').value = claimId;
    document.getElementById('review-modal-title').textContent = 'Declined claim';
    document.getElementById('cancel-review-modal-btn').textContent = 'Close';
    fillReviewSummary(claim);
    setReviewComments('Reason for declining', claim.declineReason);

    document.getElementById('review-decision').parentElement.classList.add('hidden');
    document.getElementById('decline-reason-group').classList.add('hidden');
    document.querySelector('#review-modal .modal-footer .primary').classList.add('hidden');

    document.getElementById('review-modal').classList.add('visible');
}

function closeReviewModal() {
    document.getElementById('review-modal').classList.remove('visible');
    document.getElementById('review-decision').parentElement.classList.remove('hidden');
    document.querySelector('#review-modal .modal-footer .primary').classList.remove('hidden');
}

async function submitReview() {
    const claimId = document.getElementById('review-claim-id').value;
    const status = document.getElementById('review-decision').value;
    const declineReason = document.getElementById('review-decline-reason').value.trim();

    if (!status) return alert('Please select a decision');
    if (status === 'declined' && !declineReason) return alert('Please provide a reason for declining');

    await withBusy(document.getElementById('submit-review-btn'), 'Submitting…', async () => {
        try {
            await API.request(`/badge-claims/${encodeURIComponent(claimId)}/review`, {
                method: 'PUT',
                body: JSON.stringify({
                    status,
                    declineReason: status === 'declined' ? declineReason : null,
                    reviewedBy: currentUser.id
                })
            });

            await loadAllData();
            renderClaims();
            closeReviewModal();
        } catch (error) {
            alert('Failed to submit review: ' + error.message);
        }
    });
}

let awardTeamsCache = {};

function getExclusiveBadgesForUser(eventFilter) {
    const isPortalAdmin = currentPermissions?.isPortalAdmin;
    const isCommittee = currentPermissions?.highestRole === 'committee' || currentPermissions?.highestRole === 'portalAdmin';

    let eventBadges = [...allClaimsEventBadges].filter(eb => eb.isActive);
    if (eventFilter) eventBadges = eventBadges.filter(eb => eb.eventId === eventFilter);

    const exclusiveEBs = eventBadges.filter(eb => {
        const badge = allBadges.find(b => b.id === eb.badgeId);
        if (!badge || (badge.claimType || 'common') !== 'exclusive') return false;
        if (isPortalAdmin || isCommittee) return true;
        return eb.judgeUserId === currentUser?.id;
    });

    return exclusiveEBs.map(eb => {
        const badge = allBadges.find(b => b.id === eb.badgeId) || {};
        const existingClaim = allClaims.find(c =>
            c.eventBadgeId === eb.id && c.status === 'approved'
        );
        const event = allEvents.find(e => e.id === eb.eventId);
        return {
            eventBadgeId: eb.id,
            eventId: eb.eventId,
            eventName: event?.name || '',
            badgeName: badge.name || 'Unknown',
            category: badge.category || '',
            points: badge.points || 0,
            awardedTeamId: existingClaim?.teamId || null,
            awardedTeamName: existingClaim?.team?.teamName || null
        };
    });
}

function renderExclusiveRow(badge) {
    const title = `
        <td class="cell-title" data-label="Badge">
            <strong>${escapeHtml(badge.badgeName)}</strong>
            ${badge.eventName ? `<div class="cell-sub">${escapeHtml(badge.eventName)}</div>` : ''}
        </td>`;

    if (badge.awardedTeamId) {
        return `
            <tr>
                ${title}
                <td data-label="Category">${categoryBadge(badge.category)}</td>
                <td data-label="Points">${Number(badge.points) || 0} pts</td>
                <td data-label="Awarded to"><span class="awarded-team">${icon('trophy')}${escapeHtml(badge.awardedTeamName || 'Unknown')}</span></td>
                <td class="cell-actions"><span class="badge badge-success">${icon('circle-check', 'icon-sm')}Awarded</span></td>
            </tr>
        `;
    }

    return `
        <tr>
            ${title}
            <td data-label="Category">${categoryBadge(badge.category)}</td>
            <td data-label="Points">${Number(badge.points) || 0} pts</td>
            <td data-label="Award to">
                <select class="award-team-select" data-event-badge-id="${escapeHtml(badge.eventBadgeId)}" aria-label="Team to award ${escapeHtml(badge.badgeName)}">
                    <option value="">Choose a team</option>
                </select>
            </td>
            <td class="cell-actions">
                <button type="button" class="btn-sm" data-action="award-badge" data-event-badge-id="${escapeHtml(badge.eventBadgeId)}">Award</button>
            </td>
        </tr>
    `;
}

async function loadTeamsForExclusiveDropdowns() {
    const selects = document.querySelectorAll('.award-team-select');
    if (selects.length === 0) return;

    const eventIds = [...new Set(
        getExclusiveBadgesForUser(document.getElementById('claims-event-filter').value)
            .filter(b => !b.awardedTeamId)
            .map(b => b.eventId)
    )];

    for (const eventId of eventIds) {
        if (!awardTeamsCache[eventId]) {
            try {
                const allTeams = await API.teams.list();
                awardTeamsCache[eventId] = allTeams.filter(t => t.eventId === eventId);
            } catch (e) {
                console.error('Failed to load teams:', e);
                awardTeamsCache[eventId] = [];
            }
        }
    }

    const exclusiveBadges = getExclusiveBadgesForUser(document.getElementById('claims-event-filter').value);
    for (const badge of exclusiveBadges) {
        if (badge.awardedTeamId) continue;
        const select = findAwardSelect(badge.eventBadgeId);
        if (!select) continue;
        const teams = awardTeamsCache[badge.eventId] || [];
        teams.forEach(t => {
            select.appendChild(new Option(t.teamName, t.id));
        });
    }
}

function findAwardSelect(eventBadgeId) {
    return Array.from(document.querySelectorAll('.award-team-select')).find(s => sameId(s.dataset.eventBadgeId, eventBadgeId)) || null;
}

async function awardBadgeInline(eventBadgeId, btn) {
    const teamSelect = findAwardSelect(eventBadgeId);
    if (!teamSelect) return;
    const teamId = teamSelect.value;

    if (!teamId) {
        alert('Please select a team to award');
        return;
    }
    // An exclusive badge goes to one team only and the award has no undo.
    const badgeName = getExclusiveBadgesForUser('').find(b => sameId(b.eventBadgeId, eventBadgeId))?.badgeName || 'this badge';
    const teamName = teamSelect.options[teamSelect.selectedIndex]?.text || 'this team';
    if (!confirm(`Award "${badgeName}" to ${teamName}? Only one team can get it, and it can't be undone here.`)) return;

    await withBusy(btn, 'Awarding…', async () => {
        try {
            await API.request('/badge-claims/award', {
                method: 'POST',
                body: JSON.stringify({
                    eventBadgeId,
                    teamId,
                    awardedBy: currentUser?.id
                })
            });

            await loadAllData();
            renderClaims();
        } catch (error) {
            alert('Failed to award badge: ' + (error.message || 'Unknown error'));
        }
    });
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

