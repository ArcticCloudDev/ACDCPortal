// ACDC Portal - Admin Badges Management

let currentUser = null;
let allBadges = [];
let allEvents = [];
let allEventBadges = [];
let allClaims = [];
let judgeUsers = [];
let selectedEventId = null;
let currentPermissions = null;

// Category display config
const CATEGORIES = {
    'soft': { label: 'Soft Code', emoji: '🟦', icon: '🤝' },
    'low-code': { label: 'Low Code', emoji: '🟩', icon: '⚡' },
    'pro-code': { label: 'Pro Code', emoji: '🟪', icon: '💻' },
    'sponsor': { label: 'Sponsor', emoji: '🟨', icon: '🏢' }
};

const CATEGORY_ORDER = ['soft', 'low-code', 'pro-code', 'sponsor'];

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const adminContent = document.getElementById('admin-content');

    // Resolve permissions (handles auth check, sidebar render, access denied)
    currentPermissions = await Permissions.initAdminPage('badges', {
        loadingEl: loadingDiv,
        contentEl: adminContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        // Load all data
        await loadAllData();

        // Setup event listeners
        setupEventListeners();

        loadingDiv.classList.add('hidden');
        adminContent.classList.remove('hidden');

        // Render initial view
        renderBadgeLibrary();

    } catch (error) {
        console.error('Init error:', error);
        loadingDiv.textContent = 'Error loading page. Please refresh.';
    }
});


// ============================================================
// DATA LOADING
// ============================================================

async function loadAllData() {
    const [badges, events, claims] = await Promise.all([
        API.request('/badges'),
        API.request('/events'),
        API.request('/badge-claims')
    ]);

    allBadges = badges;
    // Scope events to permitted events for non-admin users
    allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
    allClaims = claims;
}

async function loadEventBadges(eventId) {
    allEventBadges = await API.request(`/events/${eventId}/badges`);

    // Load judges for this event from participations (role-based)
    judgeUsers = [];
    try {
        const participations = await API.participations.getByEvent(eventId, 'judge');
        if (participations && participations.length > 0) {
            const allUsersData = await API.users.list();
            judgeUsers = participations
                .filter(p => p.userId)
                .map(p => {
                    const user = allUsersData.find(u => u.id === p.userId);
                    return {
                        id: p.userId,
                        name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email : (p.email || 'Unknown')
                    };
                })
                .sort((a, b) => a.name.localeCompare(b.name));
        }
    } catch (e) {
        console.warn('Could not load judges:', e);
    }
}


// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

            if (btn.dataset.tab === 'claims') renderClaims();
        });
    });

    // Badge library filters
    document.getElementById('filter-category').addEventListener('change', renderBadgeLibrary);
    document.getElementById('filter-search').addEventListener('input', renderBadgeLibrary);

    // Add badge button
    document.getElementById('add-badge-btn').addEventListener('click', () => openBadgeModal());

    // Event selector for Event Badges tab
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

    // Save event badges button
    document.getElementById('save-event-badges-btn').addEventListener('click', saveEventBadges);

    // Claims filters
    document.getElementById('claims-event-filter').addEventListener('change', renderClaims);
    document.getElementById('claims-status-filter').addEventListener('change', renderClaims);
    document.getElementById('claims-category-filter').addEventListener('change', renderClaims);

    // Review modal decision toggle
    document.getElementById('review-decision').addEventListener('change', (e) => {
        document.getElementById('decline-reason-group').style.display =
            e.target.value === 'declined' ? 'block' : 'none';
    });

    // Populate event selectors
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


// ============================================================
// TAB 1: BADGE LIBRARY
// ============================================================

function renderBadgeLibrary() {
    const container = document.getElementById('badges-container');
    const filterCategory = document.getElementById('filter-category').value;
    const filterSearch = document.getElementById('filter-search').value.toLowerCase();

    let badges = [...allBadges];

    if (filterCategory) {
        badges = badges.filter(b => b.category === filterCategory);
    }
    if (filterSearch) {
        badges = badges.filter(b =>
            b.name.toLowerCase().includes(filterSearch) ||
            b.description.toLowerCase().includes(filterSearch)
        );
    }

    // Update stats
    document.getElementById('stat-total').textContent = allBadges.length;
    document.getElementById('stat-soft').textContent = allBadges.filter(b => b.category === 'soft').length;
    document.getElementById('stat-lowcode').textContent = allBadges.filter(b => b.category === 'low-code').length;
    document.getElementById('stat-procode').textContent = allBadges.filter(b => b.category === 'pro-code').length;
    document.getElementById('stat-sponsor').textContent = allBadges.filter(b => b.category === 'sponsor').length;

    if (badges.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No badges found</p></div>`;
        return;
    }

    // Group by category
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
            <div class="category-header">
                <h3>${catConfig.icon} ${catConfig.label}</h3>
                <span class="category-count">${grouped[cat].length} badge${grouped[cat].length !== 1 ? 's' : ''}</span>
            </div>
            <div class="badge-grid">
                ${grouped[cat].map(badge => renderBadgeCard(badge)).join('')}
            </div>
        `;
    }

    container.innerHTML = html;
}

function renderBadgeCard(badge) {
    const catConfig = CATEGORIES[badge.category] || { label: badge.category, emoji: '⬜' };
    const claimLabel = (badge.claimType || 'common') === 'exclusive' ? '🏆 Exclusive' : '🎯 Common';
    return `
        <div class="badge-card">
            <div class="badge-header">
                <span class="badge-name">${escapeHtml(badge.name)}</span>
                <span class="category-pill ${badge.category}">${catConfig.label}</span>
            </div>
            <div class="badge-desc">${escapeHtml(badge.description)}</div>
            <div class="badge-footer">
                <span class="badge-points">🏆 ${badge.points} pts</span>
                <span style="font-size: 0.75rem; color: var(--admin-text-muted);">${claimLabel}</span>
                <div class="badge-actions">
                    <button class="btn-sm" onclick="openBadgeModal('${badge.id}')" title="Edit">✏️</button>
                    <button class="btn-sm danger" onclick="deleteBadge('${badge.id}')" title="Delete">🗑️</button>
                </div>
            </div>
        </div>
    `;
}


// ============================================================
// TAB 2: EVENT BADGES
// ============================================================

function renderEventBadges() {
    const container = document.getElementById('event-badges-list');

    // Get current assignments for this event
    const assignedBadgeIds = new Set(allEventBadges.map(eb => eb.badgeId));

    // Calculate stats
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

    // Get judges list (users on the judges team for this event)
    const judges = getJudgesForEvent(selectedEventId);

    // Group all badges by category, show toggle for assignment
    let html = '';
    for (const cat of CATEGORY_ORDER) {
        const catBadges = allBadges.filter(b => b.category === cat);
        if (catBadges.length === 0) continue;

        const catConfig = CATEGORIES[cat];
        const assignedInCat = catBadges.filter(b => assignedBadgeIds.has(b.id)).length;

        html += `
            <div class="panel" style="margin-bottom: 16px;">
                <div class="panel-header">
                    <span class="panel-title">${catConfig.icon} ${catConfig.label} <span class="category-count">(${assignedInCat}/${catBadges.length} assigned)</span></span>
                    <div>
                        <button class="btn-sm" onclick="toggleAllCategory('${cat}', true)">Select All</button>
                        <button class="btn-sm" onclick="toggleAllCategory('${cat}', false)">Deselect All</button>
                    </div>
                </div>
                <div class="panel-body">
        `;

        for (const badge of catBadges) {
            const assignment = allEventBadges.find(eb => eb.badgeId === badge.id);
            const isAssigned = !!assignment;
            const currentJudge = assignment ? assignment.judgeUserId : '';

            html += `
                <div class="event-badge-row">
                    <input type="checkbox" class="event-badge-toggle" data-badge-id="${badge.id}"
                        ${isAssigned ? 'checked' : ''} style="width: auto; cursor: pointer;">
                    <div class="event-badge-info">
                        <div class="name">${escapeHtml(badge.name)} <span style="color: var(--admin-primary); font-size: 0.75rem;">${badge.points} pts</span></div>
                        <div class="desc">${escapeHtml(badge.description)}</div>
                    </div>
                    <div class="event-badge-judge">
                        <select data-badge-id="${badge.id}" class="judge-select" ${!isAssigned ? 'disabled' : ''}>
                            <option value="">No judge</option>
                            ${judges.map(j => `<option value="${j.id}" ${currentJudge === j.id ? 'selected' : ''}>${escapeHtml(j.name)}</option>`).join('')}
                        </select>
                    </div>
                </div>
            `;
        }

        html += '</div></div>';
    }

    container.innerHTML = html;

    // Wire up checkbox change to enable/disable judge dropdown
    container.querySelectorAll('.event-badge-toggle').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const badgeId = e.target.dataset.badgeId;
            const judgeSelect = container.querySelector(`.judge-select[data-badge-id="${badgeId}"]`);
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
        const cb = document.querySelector(`.event-badge-toggle[data-badge-id="${badge.id}"]`);
        if (cb) {
            cb.checked = checked;
            const judgeSelect = document.querySelector(`.judge-select[data-badge-id="${badge.id}"]`);
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
    btn.textContent = 'Saving...';

    try {
        // Collect selected badge IDs
        const selectedBadgeIds = [];
        document.querySelectorAll('.event-badge-toggle:checked').forEach(cb => {
            selectedBadgeIds.push(cb.dataset.badgeId);
        });

        // Bulk update assignments
        await API.request(`/events/${selectedEventId}/badges/bulk`, {
            method: 'POST',
            body: JSON.stringify({ selectedBadgeIds })
        });

        // Reload event badges to get new IDs
        await loadEventBadges(selectedEventId);

        // Now update judge assignments
        for (const eb of allEventBadges) {
            const judgeSelect = document.querySelector(`.judge-select[data-badge-id="${eb.badgeId}"]`);
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

        // Reload and re-render
        await loadEventBadges(selectedEventId);
        renderEventBadges();

        btn.textContent = '✅ Saved!';
        setTimeout(() => { btn.textContent = '💾 Save Changes'; btn.disabled = false; }, 2000);

    } catch (error) {
        console.error('Save event badges error:', error);
        alert('Failed to save: ' + error.message);
        btn.textContent = '💾 Save Changes';
        btn.disabled = false;
    }
}

function getJudgesForEvent(eventId) {
    // Return members of the judges team for this event (loaded in loadEventBadges)
    return judgeUsers;
}


// ============================================================
// TAB 3: BADGE CLAIMS
// ============================================================

function renderClaims() {
    const tbody = document.getElementById('claims-tbody');
    const emptyState = document.getElementById('claims-empty');

    const eventFilter = document.getElementById('claims-event-filter').value;
    const statusFilter = document.getElementById('claims-status-filter').value;
    const categoryFilter = document.getElementById('claims-category-filter').value;

    let claims = [...allClaims];

    if (eventFilter) claims = claims.filter(c => c.eventId === eventFilter);
    if (statusFilter) claims = claims.filter(c => c.status === statusFilter);
    if (categoryFilter) claims = claims.filter(c => c.badge && c.badge.category === categoryFilter);

    // Update stats (based on filtered claims with event filter only for consistency)
    let statClaims = eventFilter ? allClaims.filter(c => c.eventId === eventFilter) : allClaims;
    document.getElementById('cl-stat-total').textContent = statClaims.length;
    document.getElementById('cl-stat-pending').textContent = statClaims.filter(c => c.status === 'pending').length;
    document.getElementById('cl-stat-approved').textContent = statClaims.filter(c => c.status === 'approved').length;
    document.getElementById('cl-stat-declined').textContent = statClaims.filter(c => c.status === 'declined').length;

    if (claims.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    tbody.innerHTML = claims.map(claim => {
        const badgeName = claim.badge ? claim.badge.name : 'Unknown';
        const badgeCategory = claim.badge ? claim.badge.category : '';
        const teamName = claim.team ? claim.team.teamName : 'Unknown';
        const catConfig = CATEGORIES[badgeCategory] || { label: badgeCategory };
        const claimedDate = claim.claimedAt ? new Date(claim.claimedAt).toLocaleDateString() : '';

        return `
            <tr>
                <td><strong>${escapeHtml(badgeName)}</strong></td>
                <td><span class="category-pill ${badgeCategory}">${catConfig.label || badgeCategory}</span></td>
                <td>${escapeHtml(teamName)}</td>
                <td class="claim-evidence" title="${escapeHtml(claim.evidence || '')}">${escapeHtml(claim.evidence || '—')}</td>
                <td><span class="status-pill ${claim.status}">${statusIcon(claim.status)} ${capitalize(claim.status)}</span></td>
                <td style="font-size: 0.8rem; color: var(--admin-text-muted);">${claimedDate}</td>
                <td>
                    <div class="claim-actions">
                        ${claim.status === 'pending' ? `<button class="btn-sm primary" onclick="openReviewModal('${claim.id}')">Review</button>` : ''}
                        ${claim.status === 'declined' ? `<span style="font-size: 0.75rem; color: var(--admin-text-muted);" title="${escapeHtml(claim.declineReason || '')}">💬 ${escapeHtml(truncate(claim.declineReason || '', 30))}</span>` : ''}
                        ${claim.status === 'approved' ? `<span style="font-size: 0.75rem; color: var(--admin-success);">✅</span>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}


// ============================================================
// BADGE MODAL (Create/Edit)
// ============================================================

function openBadgeModal(badgeId = null) {
    const modal = document.getElementById('badge-modal');
    const title = document.getElementById('badge-modal-title');

    if (badgeId) {
        const badge = allBadges.find(b => b.id === badgeId);
        if (!badge) return;

        title.textContent = 'Edit Badge';
        document.getElementById('badge-edit-id').value = badge.id;
        document.getElementById('badge-name').value = badge.name;
        document.getElementById('badge-category').value = badge.category;
        document.getElementById('badge-claimType').value = badge.claimType || 'common';
        document.getElementById('badge-description').value = badge.description;
        document.getElementById('badge-points').value = badge.points;
        document.getElementById('badge-imageUrl').value = badge.imageUrl || '';
    } else {
        title.textContent = 'Add Badge';
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
    btn.textContent = 'Saving...';

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
        btn.textContent = 'Save Badge';
    }
}

async function deleteBadge(badgeId) {
    const badge = allBadges.find(b => b.id === badgeId);
    if (!badge) return;

    if (!confirm(`Delete "${badge.name}"? This will also remove it from all event assignments.`)) return;

    try {
        await API.request(`/badges/${badgeId}`, { method: 'DELETE' });
        await loadAllData();
        renderBadgeLibrary();
    } catch (error) {
        alert('Failed to delete: ' + error.message);
    }
}


// ============================================================
// REVIEW MODAL
// ============================================================

function openReviewModal(claimId) {
    const claim = allClaims.find(c => c.id === claimId);
    if (!claim) return;

    document.getElementById('review-claim-id').value = claimId;
    document.getElementById('review-badge-name').textContent = `🏅 ${claim.badge ? claim.badge.name : 'Unknown Badge'}`;
    document.getElementById('review-team-name').textContent = `Team: ${claim.team ? claim.team.teamName : 'Unknown'}`;
    document.getElementById('review-evidence').innerHTML = claim.evidence
        ? `<strong>Evidence:</strong><br>${escapeHtml(claim.evidence)}`
        : '<em>No evidence provided</em>';
    document.getElementById('review-decision').value = '';
    document.getElementById('review-decline-reason').value = '';
    document.getElementById('decline-reason-group').style.display = 'none';

    document.getElementById('review-modal').classList.add('visible');
}

function closeReviewModal() {
    document.getElementById('review-modal').classList.remove('visible');
}

async function submitReview() {
    const claimId = document.getElementById('review-claim-id').value;
    const status = document.getElementById('review-decision').value;
    const declineReason = document.getElementById('review-decline-reason').value.trim();

    if (!status) return alert('Please select a decision');
    if (status === 'declined' && !declineReason) return alert('Please provide a reason for declining');

    try {
        await API.request(`/badge-claims/${claimId}/review`, {
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
}


// ============================================================
// HELPERS
// ============================================================

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function statusIcon(status) {
    switch (status) {
        case 'pending': return '⏳';
        case 'approved': return '✅';
        case 'declined': return '❌';
        default: return '';
    }
}
