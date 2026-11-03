let currentUser = null;
let allEvents = [];
let allSequences = [];
let allCampaigns = [];
let editingEventId = null;
let currentStatus = 'draft';
let currentEventSequence = null;
let emailEditor = null;
let currentPermissions = null;

function normalizeId(value) {
    return (value || '').toString().toLowerCase();
}

const STATUS_ORDER = ['draft', 'pre-registration', 'registration', 'live', 'completed'];
const STATUS_LABELS = {
    draft: 'Draft',
    'pre-registration': 'Pre-registration',
    registration: 'Registration open',
    live: 'Live',
    completed: 'Completed'
};

function formatEventDate(value) {
    if (!value) return '';
    return new Date(value + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function eventStatusOf(event) {
    return event.status || (event.registrationOpen ? 'registration' : 'draft');
}

function statusBadge(status) {
    return `<span class="badge badge-dot ${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

// Page header of the editor: breadcrumb, title, facts and the participants link follow the event.
function renderFormHeader(event) {
    const meta = document.getElementById('form-meta');
    const participantsLink = document.getElementById('view-participants-link');
    const saveBtn = document.getElementById('save-btn');

    if (event) {
        document.getElementById('form-title').textContent = 'Edit event';
        document.getElementById('breadcrumb-current').textContent = event.name || 'Untitled event';
        const dates = [formatEventDate(event.startDate), formatEventDate(event.endDate)].filter(Boolean).join(' – ');
        meta.innerHTML = `
            ${statusBadge(eventStatusOf(event))}
            <span class="meta-item">${icon('calendar')}${escapeHtml(dates || 'No dates')}</span>
            <span class="meta-item">${icon('map-pin')}${escapeHtml(event.location || 'Location TBD')}</span>
        `;
        participantsLink.href = `admin-event-participants.html?id=${encodeURIComponent(event.id)}`;
        participantsLink.classList.remove('hidden');
        saveBtn.innerHTML = `${icon('save')}Save event`;
    } else {
        document.getElementById('form-title').textContent = 'Create event';
        document.getElementById('breadcrumb-current').textContent = 'New event';
        meta.textContent = 'Save the event first; then you can add people, sponsors, budget and emails.';
        participantsLink.classList.add('hidden');
        saveBtn.innerHTML = `${icon('save')}Create event`;
    }
}

// One-line summaries shown on the collapsed settings groups of the General tab.
function updateDisclosureMeta() {
    const checked = id => document.getElementById(id).checked;
    const emailIds = ['event-team-registration-email', 'event-team-welcome-email', 'event-interest-acknowledgment',
        'event-judge-invitation-email', 'event-committee-invitation-email'];
    const emailsOn = emailIds.filter(checked).length;
    document.getElementById('email-notifications-meta').textContent = `${emailsOn} of ${emailIds.length} emails on`;

    const textIds = ['event-team-registration-terms', 'event-solo-queue-terms', 'event-single-registration-terms'];
    const textsSet = textIds.filter(id => document.getElementById(id).value.trim() !== '').length;
    document.getElementById('confirmation-texts-meta').textContent = textsSet === 0
        ? 'None set, no confirmation dialogs'
        : `${textsSet} of ${textIds.length} set`;

    let hotel = 'Off';
    if (checked('event-hotel-enabled')) {
        const before = parseInt(document.getElementById('event-hotel-days-before').value, 10) || 0;
        const after = parseInt(document.getElementById('event-hotel-days-after').value, 10) || 0;
        hotel = `On, ${before} ${before === 1 ? 'night' : 'nights'} before and ${after} after`;
        if (checked('event-hotel-mandatory')) hotel += ', event nights mandatory';
    }
    document.getElementById('hotel-booking-meta').textContent = hotel;
}

function canTransitionTo(currentStatus, targetStatus) {
    const currentIndex = STATUS_ORDER.indexOf(currentStatus);
    const targetIndex = STATUS_ORDER.indexOf(targetStatus);

    return Math.abs(targetIndex - currentIndex) === 1;
}

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>');
        }
    }, 1200);
    const notCommitteeDiv = document.getElementById('not-committee');
    const adminContent = document.getElementById('admin-content');

    currentPermissions = await Permissions.initAdminPage('events', {
        loadingEl: loadingDiv,
        accessDeniedEl: notCommitteeDiv,
        contentEl: adminContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        await loadEvents();

        setupEventListeners();

        const urlParams = new URLSearchParams(window.location.search);
        const eventId = urlParams.get('event');
        const tab = urlParams.get('tab');

        if (eventId) {
            const event = allEvents.find(e => sameId(e.id, eventId));
            if (event) {
                currentEventId = event.id;
                currentEvent = event;
                showForm(event);
                if (tab && tab !== 'general') {
                    setTimeout(() => {
                        const targetBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
                        if (targetBtn) targetBtn.click();
                    }, 100);
                }
            }
        } else if (urlParams.get('action') === 'create') {
            showForm();
        }

        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        adminContent.classList.remove('hidden');

    } catch (error) {
        console.error('Error:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error: ${error.message}</p>`;
    }
});

async function loadEvents() {
    try {
        let events = await API.events.list();
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        renderEventsList();
    } catch (error) {
        console.error('Error loading events:', error);
    }
}

function renderEventsList() {
    const eventsTableBody = document.getElementById('events-table-body');

    if (allEvents.length === 0) {
        eventsTableBody.innerHTML = `
            <tr><td colspan="6" class="empty-state">No events yet. Create the first one to get started.</td></tr>
        `;
        return;
    }

    const statusPriority = { live: 0, registration: 1, 'pre-registration': 2, waitlist: 2, draft: 3, completed: 4 };
    const priorityOf = (e) => statusPriority[e.status || 'draft'] ?? 5;
    const sortedEvents = [...allEvents].sort((a, b) => {
        const diff = priorityOf(a) - priorityOf(b);
        if (diff !== 0) return diff;
        return (new Date(b.startDate) - new Date(a.startDate)) || 0;
    });

    eventsTableBody.innerHTML = sortedEvents.map(event => {
        const status = eventStatusOf(event);
        const regType = event.registrationType || 'team';
        const regTypeLabel = regType === 'team' ? `${icon('users')}Team` : `${icon('user')}Single`;
        const location = event.location
            ? `${icon('map-pin')}${escapeHtml(event.location)}`
            : `${icon('map-pin')}<span class="text-muted">TBD</span>`;

        return `
            <tr>
                <td class="cell-name"><a class="event-name" href="admin-events.html?event=${encodeURIComponent(event.id)}">${escapeHtml(event.name)}</a></td>
                <td class="cell-type"><span class="meta-item">${regTypeLabel}</span></td>
                <td class="cell-dates"><span class="meta-item">${icon('calendar')}${escapeHtml(formatEventDate(event.startDate))} – ${escapeHtml(formatEventDate(event.endDate))}</span></td>
                <td class="cell-location"><span class="meta-item">${location}</span></td>
                <td class="cell-status">${statusBadge(status)}</td>
                <td class="cell-actions">
                    <div class="row-actions">
                        <a href="admin-event-participants.html?id=${encodeURIComponent(event.id)}" class="btn-sm ghost">${icon('users')}Participants</a>
                        <button type="button" class="btn-sm edit-event-btn" data-id="${escapeHtml(event.id)}">${icon('pencil')}Edit</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    document.querySelectorAll('.edit-event-btn').forEach(btn => {
        btn.addEventListener('click', () => editEvent(btn.dataset.id));
    });
}

function setupEventListeners() {
    document.getElementById('create-event-btn').addEventListener('click', () => showForm());

    document.getElementById('back-to-list').addEventListener('click', hideForm);
    document.getElementById('cancel-btn').addEventListener('click', hideForm);

    document.getElementById('event-form').addEventListener('submit', handleFormSubmit);

    document.getElementById('delete-btn').addEventListener('click', handleDelete);

    document.querySelectorAll('.radio-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.radio-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            option.querySelector('input').checked = true;

            const regType = option.dataset.value;
            const teamFields = document.getElementById('team-fields');
            teamFields.classList.toggle('visible', regType === 'team');
        });
    });

    document.querySelectorAll('.status-step').forEach(step => {
        step.addEventListener('click', () => handleStatusChange(step.dataset.status));
    });

    setupTabs();

    document.getElementById('invite-committee-btn').addEventListener('click', () => sendInvitation('committee'));
    document.getElementById('invite-judge-btn').addEventListener('click', () => sendInvitation('judge'));

    document.getElementById('sponsor-form').addEventListener('submit', handleSponsorSubmit);
    document.getElementById('open-sponsor-modal-btn').addEventListener('click', openSponsorCreateModal);
    document.getElementById('close-sponsor-modal-btn').addEventListener('click', closeSponsorModal);
    document.getElementById('sponsor-modal').addEventListener('click', (e) => {
        if (e.target.id === 'sponsor-modal') {
            closeSponsorModal();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('sponsor-modal').classList.contains('active')) {
            closeSponsorModal();
        }
    });
    document.getElementById('financial-form').addEventListener('submit', handleFinancialSubmit);
    document.getElementById('financial-modal').addEventListener('click', (e) => {
        if (e.target.id === 'financial-modal') closeFinancialModal();
    });

    document.getElementById('verify-sharepoint-btn').addEventListener('click', verifySharePointUrl);
    document.getElementById('save-rates-btn').addEventListener('click', saveEventRates);
    document.getElementById('recalculate-btn').addEventListener('click', recalculateFinancials);
    document.getElementById('open-financial-modal-btn').addEventListener('click', openFinancialModal);
    document.getElementById('close-financial-modal-btn').addEventListener('click', closeFinancialModal);
    document.getElementById('financial-type').addEventListener('change', toggleFinancialPaidBy);
    ['budget-hotel-rate', 'budget-hotel-nights'].forEach(id =>
        document.getElementById(id).addEventListener('input', () => updateRatePreview('hotel')));
    ['budget-food-rate', 'budget-food-days'].forEach(id =>
        document.getElementById(id).addEventListener('input', () => updateRatePreview('food')));
    document.getElementById('close-create-sequence-btn').addEventListener('click', closeCreateSequenceModal);
    document.getElementById('confirm-create-sequence-btn').addEventListener('click', confirmCreateSequence);

    // The close (x) button in each modal header does the same as that modal's Cancel button.
    const modalClosers = {
        'create-sequence-modal': closeCreateSequenceModal,
        'sponsor-modal': closeSponsorModal,
        'financial-modal': closeFinancialModal
    };
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => modalClosers[btn.dataset.closeModal]?.());
    });

    // Keep the collapsed settings summaries in step with the fields.
    document.getElementById('event-form').addEventListener('input', updateDisclosureMeta);
    document.getElementById('event-form').addEventListener('change', updateDisclosureMeta);

    // Generated rows carry data-action attributes; one listener per container dispatches them.
    const onAction = (containerId, handlers) => {
        document.getElementById(containerId).addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn || !handlers[btn.dataset.action]) return;
            handlers[btn.dataset.action](btn.dataset, btn);
        });
    };
    const staffActions = {
        'revoke-invite': (d, btn) => revokeInvite(d.inviteId, d.role, btn),
        'remove-member': (d, btn) => removeRegisteredMember(d.participationId, d.role, btn)
    };
    onAction('committee-members-body', staffActions);
    onAction('judges-members-body', staffActions);
    onAction('leads-table-body', {
        'restart-sequence': (d, btn) => restartSequence(d.leadId, null, btn),
        'delete-lead': (d, btn) => deleteLead(d.leadId, btn)
    });
    onAction('sponsors-table-body', {
        'edit-sponsor': (d) => startEditSponsor(d.sponsorId),
        'delete-sponsor': (d, btn) => deleteSponsor(d.sponsorId, btn)
    });
    document.getElementById('sponsors-table-body').addEventListener('change', (e) => {
        const select = e.target.closest('select.sponsor-status-select');
        if (select) saveSponsorStatus(select.dataset.sponsorId, select.value, select);
    });
    onAction('sequence-emails-list', {
        'move-up': (d, btn) => reorderEmail(d.emailId, -1, btn),
        'move-down': (d, btn) => reorderEmail(d.emailId, 1, btn),
        'edit-email': (d) => editSequenceEmailInline(d.emailId)
    });
    onAction('recipient-overview-body', {
        'restart-lead': (d, btn) => restartSequence(d.leadId, null, btn),
        'restart-user': (d, btn) => restartSequence(null, d.userId, btn),
        'clear-deliveries': (d, btn) => clearRecipientDeliveries(d.email, btn)
    });
    onAction('budget-table-body', {
        'edit-financial': (d) => startEditFinancial(d.rowId),
        'delete-financial': (d, btn) => deleteFinancialRow(d.rowId, btn)
    });
    document.getElementById('budget-table-body').addEventListener('change', (e) => {
        const select = e.target.closest('select.paidby-select[data-row-id]');
        if (select) savePaidBy(select.dataset.rowId, select.value, select);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('financial-modal').classList.contains('active')) {
            closeFinancialModal();
        }
    });
}

// Notice tones follow DESIGN.md: info = upcoming, success = open, violet = live; draft and completed are neutral.
const STATUS_CONFIG = {
    draft: {
        icon: 'square-pen',
        tone: '',
        title: 'Draft',
        description: 'Only committee members can see this event.'
    },
    'pre-registration': {
        icon: 'bell',
        tone: 'info',
        title: 'Pre-registration',
        description: 'The theme is announced. People can register interest, but team registration is not open yet.'
    },
    registration: {
        icon: 'user-plus',
        tone: 'success',
        title: 'Registration open',
        description: 'Participants can create teams and register.'
    },
    live: {
        icon: 'rocket',
        tone: 'violet',
        title: 'Live',
        description: 'The event is running. New registrations are closed.'
    },
    completed: {
        icon: 'circle-check',
        tone: '',
        title: 'Completed',
        description: 'The event has ended and is read-only. Only admins can edit it.'
    }
};

function updateStatusUI(status) {
    currentStatus = status;
    document.getElementById('event-status').value = status;

    const currentIndex = STATUS_ORDER.indexOf(status);
    const steps = document.querySelectorAll('.status-step');

    steps.forEach((step, index) => {
        const indicator = step.querySelector('.step-indicator');
        step.classList.remove('completed', 'current', 'available', 'disabled');
        step.removeAttribute('aria-current');

        if (index < currentIndex) {
            step.classList.add('completed');
            indicator.innerHTML = `${icon('check')}<span class="visually-hidden">Done:</span>`;
        } else if (index === currentIndex) {
            step.classList.add('current');
            step.setAttribute('aria-current', 'step');
            indicator.textContent = index + 1;
        } else if (index === currentIndex + 1) {
            step.classList.add('available');
            indicator.textContent = index + 1;
        } else {
            step.classList.add('disabled');
            indicator.textContent = index + 1;
        }
    });

    const config = STATUS_CONFIG[status];
    if (config) {
        const banner = document.getElementById('status-banner');
        banner.className = `notice status-notice${config.tone ? ` notice-${config.tone}` : ''}`;
        document.querySelector('#status-icon use').setAttribute('href', `/images/icons.svg#${config.icon}`);
        document.getElementById('status-title').textContent = config.title;
        document.getElementById('status-description').textContent = config.description;
    }

    // Flag a status that was picked on the stepper but not saved yet.
    const savedStatus = currentEvent ? eventStatusOf(currentEvent) : status;
    document.getElementById('status-unsaved').classList.toggle('hidden', status === savedStatus);

    // On narrow screens the stepper scrolls sideways: bring the current step into view.
    requestAnimationFrame(() => {
        const scroller = document.querySelector('.status-stepper-scroll');
        const currentStep = steps[currentIndex];
        if (!scroller || !currentStep || scroller.scrollWidth <= scroller.clientWidth) return;
        const stepBox = currentStep.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        scroller.scrollLeft += (stepBox.left + stepBox.width / 2) - (scrollerBox.left + scrollerBox.width / 2);
    });
}

function handleStatusChange(newStatus) {
    if (newStatus === currentStatus) return;

    if (!canTransitionTo(currentStatus, newStatus)) {
        const currentIndex = STATUS_ORDER.indexOf(currentStatus);
        const targetIndex = STATUS_ORDER.indexOf(newStatus);

        if (targetIndex > currentIndex) {
            alert(`You can only advance one step at a time.\nCurrent: ${STATUS_LABELS[currentStatus]}\nNext available: ${STATUS_LABELS[STATUS_ORDER[currentIndex + 1]]}`);
        } else {
            alert(`You can only go back one step at a time.\nCurrent: ${STATUS_LABELS[currentStatus]}\nPrevious: ${STATUS_LABELS[STATUS_ORDER[currentIndex - 1]]}`);
        }
        return;
    }

    const direction = STATUS_ORDER.indexOf(newStatus) > STATUS_ORDER.indexOf(currentStatus) ? 'Advance' : 'Move back';
    const confirmMsg = `${direction} to "${STATUS_LABELS[newStatus]}"?\n\nCurrent: ${STATUS_LABELS[currentStatus]}\nThe new status applies when you save the event.`;
    if (!confirm(confirmMsg)) return;

    updateStatusUI(newStatus);
}

function showForm(event = null) {
    editingEventId = event?.id || null;
    currentEventId = event?.id || null;
    currentEvent = event || null;

    document.getElementById('events-list-view').classList.add('hidden');
    document.getElementById('event-form-view').classList.remove('hidden');

    const deleteBtn = document.getElementById('delete-btn');
    const statusSection = document.getElementById('status-section');
    const committeeTab = document.getElementById('committee-tab-btn');
    const judgesTab = document.getElementById('judges-tab-btn');
    const leadsTab = document.getElementById('leads-tab-btn');
    const form = document.getElementById('event-form');

    setDataTabsEnabled(!!event);
    if (!event) resetSponsorForm();

    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="general"]').classList.add('active');
    document.getElementById('general-panel').classList.add('active');

    renderFormHeader(event);

    if (event) {
        deleteBtn.classList.remove('hidden');
        statusSection.classList.remove('hidden');

        document.getElementById('event-id').value = event.id;
        document.getElementById('event-name').value = event.name || '';
        document.getElementById('event-description').value = event.description || '';
        document.getElementById('event-start').value = event.startDate || '';
        document.getElementById('event-end').value = event.endDate || '';
        document.getElementById('event-location').value = event.location || '';
        document.getElementById('min-team-size').value = event.minTeamSize || 3;
        document.getElementById('max-team-size').value = event.maxTeamSize || 5;
        document.getElementById('event-cost-per-participant').value = event.costPerParticipant != null ? event.costPerParticipant : '';
        document.getElementById('event-currency').value = event.currency || 'NOK';
        document.getElementById('event-file-categories').value = (event.fileCategories || []).join(', ');
        document.getElementById('event-sharepoint-url').value = event.sharepointUrl || '';
        document.getElementById('sharepoint-verify-result').innerHTML = '';
        document.getElementById('event-team-registration-email').checked = event.sendTeamRegistrationEmail !== false;
        document.getElementById('event-team-welcome-email').checked = event.sendWelcomeEmail || false;
        document.getElementById('event-interest-acknowledgment').checked = event.sendInterestAcknowledgment || false;
        document.getElementById('event-judge-invitation-email').checked = event.sendJudgeInvitationEmail || false;
        document.getElementById('event-committee-invitation-email').checked = event.sendCommitteeInvitationEmail || false;
        document.getElementById('event-team-registration-terms').value = event.teamRegistrationTerms || '';
        document.getElementById('event-solo-queue-terms').value = event.soloQueueTerms || '';
        document.getElementById('event-single-registration-terms').value = event.singleRegistrationTerms || '';
        document.getElementById('event-hotel-enabled').checked = event.hotelEnabled || false;
        document.getElementById('event-hotel-mandatory').checked = event.hotelMandatory || false;
        document.getElementById('event-hotel-days-before').value = event.hotelDaysBefore ?? 0;
        document.getElementById('event-hotel-days-after').value = event.hotelDaysAfter ?? 0;

        const regType = event.registrationType || 'team';
        document.querySelectorAll('.radio-option').forEach(option => {
            const isSelected = option.dataset.value === regType;
            option.classList.toggle('selected', isSelected);
            option.querySelector('input').checked = isSelected;
        });
        document.getElementById('team-fields').classList.toggle('visible', regType === 'team');

        const status = event.status || (event.registrationOpen ? 'registration' : 'draft');
        updateStatusUI(status);

    } else {
        deleteBtn.classList.add('hidden');
        statusSection.classList.add('hidden');
        form.reset();
        document.getElementById('event-id').value = '';

        document.getElementById('event-judge-invitation-email').checked = true;
        document.getElementById('event-committee-invitation-email').checked = true;

        document.querySelectorAll('.radio-option').forEach(option => {
            const isTeam = option.dataset.value === 'team';
            option.classList.toggle('selected', isTeam);
            option.querySelector('input').checked = isTeam;
        });
        document.getElementById('team-fields').classList.add('visible');

        currentStatus = 'draft';
        document.getElementById('event-status').value = 'draft';
    }

    updateDisclosureMeta();
}

// Committee, judges, leads, sponsors, budget, teams and sequence all need a saved event.
function setDataTabsEnabled(enabled) {
    document.querySelectorAll('.tab-btn[data-tab]:not([data-tab="general"])').forEach(btn => {
        btn.disabled = !enabled;
    });
}

function updateURL() {
    if (currentEventId) {
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'general';
        window.history.replaceState({}, '', `admin-events.html?event=${currentEventId}&tab=${activeTab}`);
    } else {
        window.history.replaceState({}, '', 'admin-events.html');
    }
}

function hideForm() {
    closeSponsorModal();
    document.getElementById('events-list-view').classList.remove('hidden');
    document.getElementById('event-form-view').classList.add('hidden');
    editingEventId = null;
    currentEventId = null;
    currentEvent = null;

    window.history.replaceState({}, '', 'admin-events.html');
}

async function verifySharePointUrl() {
    const url = document.getElementById('event-sharepoint-url').value.trim();
    const resultDiv = document.getElementById('sharepoint-verify-result');
    const btn = document.getElementById('verify-sharepoint-btn');

    const verifyMessage = (tone, iconName, text) =>
        `<p class="inline-status is-${tone}">${icon(iconName)}<span>${text}</span></p>`;

    if (!url) {
        resultDiv.innerHTML = verifyMessage('warning', 'triangle-alert', 'Enter a URL first.');
        return;
    }

    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.sharepoint.com')) {
            resultDiv.innerHTML = verifyMessage('danger', 'circle-x', 'The URL must be on a SharePoint domain (*.sharepoint.com).');
            return;
        }
    } catch {
        resultDiv.innerHTML = verifyMessage('danger', 'circle-x', 'That is not a valid URL.');
        return;
    }

    const btnMarkup = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    resultDiv.innerHTML = '';

    window.open(url, '_blank', 'noopener,noreferrer');

    const categoriesInput = document.getElementById('event-file-categories').value;
    const categories = categoriesInput.split(',').map(c => c.trim()).filter(c => c.length > 0);

    if (categories.length > 0) {
        try {
            const res = await fetch('/api/files/setup-columns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categories })
            });
            if (res.ok) {
                resultDiv.innerHTML = verifyMessage('success', 'circle-check', 'Folder opened in a new tab. The file category column is set up on the SharePoint library.');
            } else {
                const err = await res.json().catch(() => ({}));
                resultDiv.innerHTML = verifyMessage('warning', 'triangle-alert', `Folder opened, but setting up the column failed: ${escapeHtml(err.error || err.details || 'Unknown error')}. Check the SharePoint configuration.`);
            }
        } catch (err) {
            resultDiv.innerHTML = verifyMessage('warning', 'triangle-alert', 'Folder opened, but the API could not be reached to set up the column. Is the API running?');
        }
    } else {
        resultDiv.innerHTML = verifyMessage('success', 'circle-check', 'Folder opened in a new tab. Add file upload categories above and verify again to set up the SharePoint column.');
    }

    btn.disabled = false;
    btn.innerHTML = btnMarkup;
}

function editEvent(eventId) {
    const event = allEvents.find(e => sameId(e.id, eventId));
    if (event) {
        currentEventId = event.id;
        currentEvent = event;
        showForm(event);
        updateURL();
    }
}

async function handleFormSubmit(e) {
    e.preventDefault();

    const saveBtn = document.getElementById('save-btn');
    const saveBtnMarkup = saveBtn.innerHTML;
    let relabelled = false;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
        const registrationType = document.querySelector('input[name="registration-type"]:checked').value;

        const eventData = {
            name: document.getElementById('event-name').value.trim(),
            description: document.getElementById('event-description').value.trim(),
            startDate: document.getElementById('event-start').value,
            endDate: document.getElementById('event-end').value,
            location: document.getElementById('event-location').value.trim(),
            registrationType: registrationType,
            status: document.getElementById('event-status').value || 'draft',
            sendTeamRegistrationEmail: document.getElementById('event-team-registration-email').checked,
            sendWelcomeEmail: document.getElementById('event-team-welcome-email').checked,
            sendInterestAcknowledgment: document.getElementById('event-interest-acknowledgment').checked,
            sendJudgeInvitationEmail: document.getElementById('event-judge-invitation-email').checked,
            sendCommitteeInvitationEmail: document.getElementById('event-committee-invitation-email').checked,
            fileCategories: document.getElementById('event-file-categories').value
                .split(',')
                .map(c => c.trim())
                .filter(c => c.length > 0),
            sharepointUrl: document.getElementById('event-sharepoint-url').value.trim() || null,
            teamRegistrationTerms: document.getElementById('event-team-registration-terms').value.trim() || null,
            soloQueueTerms: document.getElementById('event-solo-queue-terms').value.trim() || null,
            singleRegistrationTerms: document.getElementById('event-single-registration-terms').value.trim() || null,
            hotelEnabled: document.getElementById('event-hotel-enabled').checked,
            hotelMandatory: document.getElementById('event-hotel-mandatory').checked,
            hotelDaysBefore: parseInt(document.getElementById('event-hotel-days-before').value) || 0,
            hotelDaysAfter: parseInt(document.getElementById('event-hotel-days-after').value) || 0,
        };

        if (registrationType === 'team') {
            eventData.minTeamSize = parseInt(document.getElementById('min-team-size').value) || 3;
            eventData.maxTeamSize = parseInt(document.getElementById('max-team-size').value) || 5;
        }

        const costRaw = document.getElementById('event-cost-per-participant').value.trim();
        eventData.costPerParticipant = costRaw !== '' ? parseFloat(costRaw) : null;
        eventData.currency = document.getElementById('event-currency').value;

        const eventId = document.getElementById('event-id').value;

        let savedEvent;
        if (eventId) {
            savedEvent = await API.events.update(eventId, eventData);
        } else {
            savedEvent = await API.events.create(eventData);
        }

        await loadEvents();

        if (savedEvent) {
            currentEvent = savedEvent;
            currentEventId = savedEvent.id;

            if (!eventId) {
                setDataTabsEnabled(true);
                document.getElementById('event-id').value = savedEvent.id;
                updateURL();
                // The new event now exists: show the controls an existing event has.
                document.getElementById('delete-btn').classList.remove('hidden');
                document.getElementById('status-section').classList.remove('hidden');
            }
            renderFormHeader(savedEvent); // also relabels the save button ("Save event")
            updateStatusUI(document.getElementById('event-status').value || 'draft');
            relabelled = true;
        } else {
            hideForm();
        }

    } catch (error) {
        console.error('Error saving event:', error);
        alert('Error saving event: ' + error.message);
    } finally {
        saveBtn.disabled = false;
        if (!relabelled) saveBtn.innerHTML = saveBtnMarkup;
    }
}

async function handleDelete() {
    const eventId = document.getElementById('event-id').value;
    if (!eventId) return;

    if (!confirm('Are you sure you want to delete this event? This action cannot be undone.')) {
        return;
    }

    await withBusy(document.getElementById('delete-btn'), 'Deleting…', async () => {
        try {
            await API.events.delete(eventId);
            await loadEvents();
            hideForm();
        } catch (error) {
            console.error('Error deleting event:', error);
            alert('Error deleting event: ' + error.message);
        }
    });
}

function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');

            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            tabPanels.forEach(panel => panel.classList.remove('active'));
            document.getElementById(`${targetTab}-panel`).classList.add('active');

            if (currentEventId) {
                updateURL();
            }

            if (targetTab === 'committee') {
                loadCommitteeMembers();
            } else if (targetTab === 'judges') {
                loadJudgesMembers();
            } else if (targetTab === 'leads') {
                loadInterestLeads();
            } else if (targetTab === 'sponsors') {
                loadEventSponsors();
            } else if (targetTab === 'teams') {
                loadEventTeams();
            } else if (targetTab === 'sequence') {
                loadEventSequence();
            } else if (targetTab === 'budget') {
                loadEventBudget();
            }
        });
    });

}

let currentEventId = null;
let currentEvent = null;
let allParticipations = [];
let allUsers = [];
let allInvitations = [];

async function loadCommitteeMembers() {
    if (!currentEventId || !currentEvent) {
        document.getElementById('committee-members-body').innerHTML =
            '<tr><td colspan="5" class="empty-state">Save the event first to add committee members</td></tr>';
        return;
    }

    try {
        [allParticipations, allUsers, allInvitations] = await Promise.all([
            API.participations.list(),
            API.users.list(),
            API.invitations.list()
        ]);

        renderCommitteeMembers();
    } catch (error) {
        console.error('Error loading committee members:', error);
    }
}

async function loadJudgesMembers() {
    if (!currentEventId || !currentEvent) {
        document.getElementById('judges-members-body').innerHTML =
            '<tr><td colspan="5" class="empty-state">Save the event first to add judges</td></tr>';
        return;
    }

    try {
        if (allParticipations.length === 0) {
            [allParticipations, allUsers, allInvitations] = await Promise.all([
                API.participations.list(),
                API.users.list(),
                API.invitations.list()
            ]);
        }

        renderJudgesMembers();
    } catch (error) {
        console.error('Error loading judges:', error);
    }
}

function renderCommitteeMembers() {
    const tbody = document.getElementById('committee-members-body');

    const committeeParticipations = allParticipations.filter(p =>
        sameId(p.eventId, currentEventId) &&
        p.roles?.includes('committee')
    );

    const pendingInvites = allInvitations.filter(i =>
        i.status === 'pending' &&
        i.role === 'committee' &&
        sameId(i.eventId, currentEventId)
    );

    const members = [];

    committeeParticipations.forEach(p => {
        const user = allUsers.find(u => sameId(u.id, p.userId));
        if (user) {
            members.push({
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
                status: 'registered',
                registeredDate: new Date(p.createdAt).toLocaleDateString(),
                type: 'user',
                id: user.id,
                participationId: p.id
            });
        }
    });

    pendingInvites.forEach(inv => {
        members.push({
            name: '-',
            email: inv.email,
            status: 'invited',
            registeredDate: '-',
            type: 'invite',
            id: inv.id
        });
    });

    if (members.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No committee members yet</td></tr>';
        return;
    }

    const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');

    tbody.innerHTML = members.map(m => staffRow(m, 'committee', canDelete)).join('');
}

function initials(name) {
    return (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('');
}

// One row of the committee or judges table: a registered person or a pending invitation.
function staffRow(m, role, canDelete) {
    const isInvite = m.type === 'invite';
    const nameCell = isInvite
        ? `<span class="person-cell"><span class="avatar" aria-hidden="true">${icon('mail')}</span><span class="text-muted">Not registered yet</span></span>`
        : `<span class="person-cell"><span class="avatar" aria-hidden="true">${escapeHtml(initials(m.name))}</span><strong>${escapeHtml(m.name)}</strong></span>`;
    const statusCell = isInvite
        ? '<span class="badge badge-warning">Invited</span>'
        : '<span class="badge badge-success">Registered</span>';
    let action = '';
    if (isInvite) {
        action = `<button type="button" class="btn-sm danger-ghost" data-action="revoke-invite" data-invite-id="${escapeHtml(m.id)}" data-role="${role}">${icon('x')}Revoke invitation</button>`;
    } else if (canDelete) {
        action = `<button type="button" class="btn-sm danger-ghost" data-action="remove-member" data-participation-id="${escapeHtml(m.participationId)}" data-role="${role}">${icon('trash-2')}Remove</button>`;
    }

    return `
        <tr>
            <td>${nameCell}</td>
            <td>${escapeHtml(m.email)}</td>
            <td>${statusCell}</td>
            <td class="text-muted">${escapeHtml(m.registeredDate)}</td>
            <td class="cell-actions"><div class="row-actions">${action}</div></td>
        </tr>
    `;
}

function renderJudgesMembers() {
    const tbody = document.getElementById('judges-members-body');

    const judgesParticipations = allParticipations.filter(p =>
        sameId(p.eventId, currentEventId) &&
        p.roles?.includes('judge')
    );

    const pendingInvites = allInvitations.filter(i =>
        i.status === 'pending' &&
        i.role === 'judge' &&
        sameId(i.eventId, currentEventId)
    );

    const members = [];

    judgesParticipations.forEach(p => {
        const user = allUsers.find(u => sameId(u.id, p.userId));
        if (user) {
            members.push({
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
                status: 'registered',
                registeredDate: new Date(p.createdAt).toLocaleDateString(),
                type: 'user',
                id: user.id,
                participationId: p.id
            });
        }
    });

    pendingInvites.forEach(inv => {
        members.push({
            name: '-',
            email: inv.email,
            status: 'invited',
            registeredDate: '-',
            type: 'invite',
            id: inv.id
        });
    });

    if (members.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No judges yet</td></tr>';
        return;
    }

    const canDelete = currentPermissions && (currentPermissions.isPortalAdmin || currentPermissions.highestRole === 'committee');

    tbody.innerHTML = members.map(m => staffRow(m, 'judge', canDelete)).join('');
}

async function sendInvitation(role) {
    const emailInput = document.getElementById(`${role === 'committee' ? 'committee' : 'judge'}-email`);
    const email = emailInput.value.trim();

    if (!email) {
        alert('Please enter an email address');
        return;
    }

    if (!currentEventId || !currentEvent) {
        alert('Please save the event first');
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('Please enter a valid email address');
        return;
    }

    const inviteBtn = document.getElementById(role === 'committee' ? 'invite-committee-btn' : 'invite-judge-btn');
    await withBusy(inviteBtn, 'Sending…', async () => {
        try {
            await API.invitations.create({
                email: email,
                eventId: currentEventId,
                role: role,
                inviterId: currentUser.id,
                inviterName: `${currentUser.firstName} ${currentUser.lastName}`,
                inviterEmail: currentUser.email,
                message: `You've been invited to join as ${role} for ${currentEvent.name}`
            });

            alert(`Invitation sent to ${email}`);
            emailInput.value = '';

            allParticipations = [];

            if (role === 'committee') {
                await loadCommitteeMembers();
            } else {
                await loadJudgesMembers();
            }

        } catch (error) {
            console.error('Error sending invitation:', error);
            alert('Error sending invitation: ' + error.message);
        }
    });
}

async function revokeInvite(inviteId, role, button) {
    if (!confirm('Are you sure you want to revoke this invitation?')) {
        return;
    }

    await withBusy(button, '…', async () => {
        try {
            await API.invitations.delete(inviteId);

            allParticipations = [];

            if (role === 'committee') {
                await loadCommitteeMembers();
            } else {
                await loadJudgesMembers();
            }

        } catch (error) {
            console.error('Error revoking invitation:', error);
            alert('Error revoking invitation: ' + error.message);
        }
    });
}

async function removeRegisteredMember(participationId, role, button) {
    const roleLabel = role === 'committee' ? 'committee member' : 'judge';
    const participation = allParticipations.find(p => sameId(p.id, participationId));
    const user = participation ? allUsers.find(u => sameId(u.id, participation.userId)) : null;
    const name = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email : 'this person';
    if (!confirm(`Remove ${roleLabel} "${name}" from this event?\n\nThis will delete their participation record including hotel bookings.`)) {
        return;
    }

    await withBusy(button, '…', async () => {
        try {
            await API.participations.delete(participationId);

            allParticipations = [];

            if (role === 'committee') {
                await loadCommitteeMembers();
            } else {
                await loadJudgesMembers();
            }

        } catch (error) {
            console.error('Error removing member:', error);
            alert('Error removing member: ' + error.message);
        }
    });
}

let allLeads = [];
let allSoloQueueForEvent = [];

async function loadInterestLeads() {
    if (!currentEventId) {
        document.getElementById('leads-table-body').innerHTML =
            '<tr><td colspan="5" class="empty-state">Save the event first to view leads</td></tr>';
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads?eventId=${encodeURIComponent(currentEventId)}`);
        if (!response.ok) throw new Error('Failed to load leads');

        const data = await response.json();
        allLeads = data.leads || [];

        const loaders = [];
        if (allParticipations.length === 0) loaders.push(API.participations.list().then(r => { allParticipations = r; }));
        if (allUsers.length === 0) loaders.push(API.users.list().then(r => { allUsers = r; }));
        if (allTeams.length === 0) loaders.push(
            fetch(`${CONFIG.api.baseUrl}/teams`).then(r => r.json()).then(teams => {
                allTeams = (Array.isArray(teams) ? teams : (teams.teams || [])).filter(t => sameId(t.eventId, currentEventId));
            })
        );
        loaders.push(
            fetch(`${CONFIG.api.baseUrl}/solo-queue?eventId=${encodeURIComponent(currentEventId)}`)
                .then(r => r.json())
                .then(entries => { allSoloQueueForEvent = Array.isArray(entries) ? entries : []; })
                .catch(() => { allSoloQueueForEvent = []; })
        );
        if (loaders.length > 0) await Promise.all(loaders);

        renderLeadsTable();
    } catch (error) {
        console.error('Error loading leads:', error);
        document.getElementById('leads-table-body').innerHTML =
            '<tr><td colspan="5" class="empty-state">Could not load the leads. Reload the page to try again.</td></tr>';
    }
}

function renderLeadsTable() {
    const tbody = document.getElementById('leads-table-body');

    if (allLeads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No interest leads yet. Share the event\'s interest link to collect them.</td></tr>';
        return;
    }

    tbody.innerHTML = allLeads.map(lead => {
        const matchedUser = allUsers.find(u => (u.email || '').toLowerCase() === (lead.email || '').toLowerCase());
        const displayFirst = lead.firstName || matchedUser?.firstName || '';
        const displayLast = lead.lastName || matchedUser?.lastName || '';

        let statusCell;
        let isConverted = false;
        let convertedDetail = '';

        if (matchedUser) {
            const participation = allParticipations.find(p =>
                sameId(p.userId, matchedUser.id) && sameId(p.eventId, currentEventId)
            );
            if (participation) {
                const roles = participation.roles || [];
                const teamMembership = (participation.teamMemberships || []).find(m => m.isParticipant);
                isConverted = roles.includes('committee') || roles.includes('judge') || !!teamMembership;

                if (isConverted) {
                    const team = teamMembership ? allTeams.find(t => sameId(t.id, teamMembership.teamId)) : null;
                    const teamName = team ? (team.teamName || team.name || '') : '';
                    let roleLabel = 'Participant';
                    if (roles.includes('committee')) roleLabel = 'Committee';
                    else if (roles.includes('judge')) roleLabel = 'Judge';
                    convertedDetail = teamName ? `<div class="cell-sub">${escapeHtml(teamName)}</div>` : '';
                    statusCell = `<span class="badge badge-success">${icon('user-check')}${roleLabel}</span>${convertedDetail}`;
                }
            }

            if (!isConverted) {
                const inQueue = allSoloQueueForEvent.find(q => sameId(q.userId, matchedUser.id));
                if (inQueue) {
                    const pos = allSoloQueueForEvent
                        .sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt))
                        .findIndex(q => sameId(q.userId, matchedUser.id)) + 1;
                    statusCell = `<span class="badge badge-info">${icon('dices')}In solo queue</span><div class="cell-sub">Position ${pos} of ${allSoloQueueForEvent.length}</div>`;
                }
            }
        }

        if (!statusCell) {
            statusCell = `<span class="badge">${icon('bell')}Interested</span>`;
        }

        return `
        <tr>
            <td><strong>${escapeHtml(displayFirst)} ${escapeHtml(displayLast)}</strong></td>
            <td>${escapeHtml(lead.email)}</td>
            <td class="text-muted">${new Date(lead.verifiedAt || lead.createdAt).toLocaleDateString()}</td>
            <td>${statusCell}</td>
            <td class="cell-actions">
                <div class="row-actions">
                    <button type="button" class="btn-sm" data-action="restart-sequence" data-lead-id="${escapeHtml(lead.id)}">${icon('refresh-cw')}Restart sequence</button>
                    <button type="button" class="btn-sm icon-only danger-ghost" data-action="delete-lead" data-lead-id="${escapeHtml(lead.id)}" aria-label="Delete lead" title="Delete lead">${icon('trash-2')}</button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

async function deleteLead(leadId, button) {
    if (!confirm('Are you sure you want to delete this lead?')) {
        return;
    }

    await withBusy(button, '…', async () => {
        try {
            const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads/${encodeURIComponent(leadId)}`, {
                method: 'DELETE'
            });

            if (!response.ok) throw new Error('Failed to delete lead');

            await loadInterestLeads();
        } catch (error) {
            console.error('Error deleting lead:', error);
            alert('Error deleting lead: ' + error.message);
        }
    });
}

async function clearRecipientDeliveries(email, button) {
    if (!confirm(`Clear all sequence delivery records for ${email}?\n\nThis will NOT resend emails. Use this to remove stale records so the recipient shows as fresh.`)) return;
    await withBusy(button, '…', async () => {
        try {
            const response = await fetch(`${CONFIG.api.baseUrl}/deliveries/recipient`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Failed to clear deliveries');
            alert(`Cleared ${result.count} delivery record(s) for ${email}`);
            loadRecipientDeliveryOverview();
        } catch (error) {
            console.error('Error clearing deliveries:', error);
            alert('Failed to clear deliveries: ' + error.message);
        }
    });
}

async function restartSequence(leadId, userId, button) {
    if (!confirm('Restart sequence emails for this recipient?\n\nThis will send all unsent sequence emails. Check the browser console for detailed logs.')) return;

    await withBusy(button, '…', () => restartSequenceRequest(leadId, userId));
}

async function restartSequenceRequest(leadId, userId) {
    try {
        const payload = leadId ? { leadId } : { userId, eventId: currentEventId };
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/restart-sequence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to restart sequence');
        }

        const result = await response.json();

        const sentCount = result.sent || 0;
        if (sentCount > 0) {
            alert(`Sequence restarted successfully!\n${sentCount} email(s) sent.\n\nCheck the browser console and server terminal for detailed logs.`);
            return;
        }

        const reasonMap = {
            'sequence-disabled': 'Sequence is disabled for this event.',
            'no-sequence-assigned': 'No sequence is assigned to this event.',
            'no-sequence-campaigns': 'No sequence emails exist for the assigned sequence.',
            'already-sent': 'All sequence emails are already marked as sent for this recipient.',
            'send-failed': 'Send attempt failed. Check API logs for mail provider errors.',
            'trigger-error': 'Sequence trigger failed unexpectedly. Check API logs.'
        };

        const reasonKey = result.details?.reason;
        const reason = reasonMap[reasonKey] || 'No eligible sequence emails were sent.';
        alert(`Sequence restart completed with 0 emails sent.\n\nReason: ${reason}`);
    } catch (error) {
        console.error('❌ Error restarting sequence:', error);
        alert('Failed to restart sequence: ' + error.message);
    }
}

let allTeams = [];

async function loadEventTeams() {
    if (!currentEventId) {
        document.getElementById('teams-table-body').innerHTML =
            '<tr><td colspan="5" class="empty-state">Save the event first to view teams</td></tr>';
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/teams`);
        if (!response.ok) throw new Error('Failed to load teams');

        const teams = await response.json();
        allTeams = (Array.isArray(teams) ? teams : []).filter(t => sameId(t.eventId, currentEventId));

        const partResponse = await fetch(`${CONFIG.api.baseUrl}/participations/event/${encodeURIComponent(currentEventId)}`);
        if (partResponse.ok) {
            allParticipations = await partResponse.json();
        }

        try {
            allUsers = await API.users.list();
        } catch (e) {
            allUsers = [];
        }

        renderTeamsTable();
    } catch (error) {
        console.error('Error loading teams:', error);
        document.getElementById('teams-table-body').innerHTML =
            '<tr><td colspan="5" class="empty-state">Error loading teams</td></tr>';
    }
}

function renderTeamsTable() {
    const tbody = document.getElementById('teams-table-body');

    if (allTeams.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No teams registered yet</td></tr>';
        return;
    }

    tbody.innerHTML = allTeams.map(team => {
        const memberships = allParticipations.filter(p =>
            (p.teamMemberships || []).some(m => sameId(m.teamId, team.id) && m.isParticipant)
        );
        const memberCount = memberships.length;

        const adminMembership = allParticipations.find(p =>
            (p.teamMemberships || []).some(m => sameId(m.teamId, team.id) && m.isAdmin)
        );

        const adminUser = adminMembership ? allUsers.find(u => sameId(u.id, adminMembership.userId)) : null;
        const adminName = adminUser
            ? `${adminUser.firstName || ''} ${adminUser.lastName || ''}`.trim() || adminUser.email || 'No admin'
            : (adminMembership?.email || 'No admin');
        const teamDisplayName = team.teamName || team.name || 'Unnamed Team';
        const maxMembers = team.numberOfParticipants || team.maxSize || 5;
        const createdDate = new Date(team.createdAt).toLocaleDateString();

        return `
            <tr>
                <td><strong>${escapeHtml(teamDisplayName)}</strong></td>
                <td class="text-muted">${escapeHtml(adminName)}</td>
                <td><span class="badge count" title="Members / committed team size">${memberCount} / ${Number(maxMembers) || 0}</span></td>
                <td class="text-muted">${createdDate}</td>
                <td class="cell-actions">
                    <a href="admin-teams.html?team=${encodeURIComponent(team.id)}" class="btn-sm">View team</a>
                </td>
            </tr>
        `;
    }).join('');
}

function eventCurrency() {
    return currentEvent?.currency || 'NOK';
}

function resetSponsorForm() {
    const form = document.getElementById('sponsor-form');
    if (!form) return;

    form.reset();
    document.getElementById('sponsor-id').value = '';
    document.getElementById('sponsor-status').value = 'reached-out';
    document.getElementById('sponsor-modal-title').textContent = 'Add sponsor';
    document.getElementById('save-sponsor-btn').textContent = 'Add sponsor';
}

function openSponsorCreateModal() {
    if (!currentEventId) {
        alert('Save the event first before adding sponsors.');
        return;
    }

    resetSponsorForm();
    document.getElementById('sponsor-modal').classList.add('active');
    document.getElementById('sponsor-company-name').focus();
}

function closeSponsorModal() {
    document.getElementById('sponsor-modal').classList.remove('active');
    resetSponsorForm();
}

async function loadEventSponsors() {
    const tbody = document.getElementById('sponsors-table-body');
    if (!currentEventId) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Save the event first to manage sponsors</td></tr>';
        return;
    }
    try {
        allFinancials = await API.events.financials.list(currentEventId) || [];
        renderSponsorsTable();
    } catch (error) {
        console.error('Error loading sponsors:', error);
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Error loading sponsors</td></tr>';
    }
}

function renderSponsorsTable() {
    const tbody = document.getElementById('sponsors-table-body');
    const sponsorRows = (allFinancials || []).filter(r => r.category === 'sponsorship');

    if (sponsorRows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No sponsors added yet</td></tr>';
        return;
    }

    const statusOptions = [
        { value: 'reached-out', label: 'Reached out' },
        { value: 'negotiating',  label: 'Negotiating' },
        { value: 'confirmed',    label: 'Confirmed' },
        { value: 'declined',     label: 'Declined' }
    ];
    const currency = eventCurrency();
    const fmt = (val) => val != null && Number(val) !== 0 ? Number(val).toLocaleString(currencyLocale(currency)) + '\u00a0' + currency : '\u2014';

    tbody.innerHTML = sponsorRows.map((row) => {
        const status = row.sponsorStatus || 'reached-out';

        const parts = [];
        if (row.contactPerson) parts.push(`<span class="contact-name">${escapeHtml(row.contactPerson)}</span>`);
        if (row.phoneNumber)   parts.push(`<span class="meta-item">${icon('phone')}${escapeHtml(row.phoneNumber)}</span>`);
        const contactEmail = row.contactEmail || row.email;
        if (contactEmail)      parts.push(`<a class="meta-item" href="mailto:${escapeHtml(contactEmail)}">${icon('mail')}${escapeHtml(contactEmail)}</a>`);
        if (row.notes) {
            const preview = row.notes.length > 80 ? row.notes.slice(0, 80) + '…' : row.notes;
            parts.push(`<span class="contact-note" title="${escapeHtml(row.notes)}">${escapeHtml(preview)}</span>`);
        }
        const contactCell = parts.length ? `<div class="contact-lines">${parts.join('')}</div>` : '<span class="text-muted">—</span>';

        const company = escapeHtml(row.description || '');
        const statusSelect = `<select class="paidby-select sponsor-status-select ${escapeHtml(status)}" data-sponsor-id="${escapeHtml(row.id)}" aria-label="Status for ${company}">
            ${statusOptions.map(o => `<option value="${o.value}"${o.value === status ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>`;

        return `
            <tr>
                <td><strong>${company}</strong></td>
                <td>${contactCell}</td>
                <td class="cell-num">${fmt(row.amount)}</td>
                <td>${statusSelect}</td>
                <td class="cell-actions">
                    <div class="row-actions">
                        <button type="button" class="btn-sm" data-action="edit-sponsor" data-sponsor-id="${escapeHtml(row.id)}">${icon('pencil')}Edit</button>
                        <button type="button" class="btn-sm icon-only danger-ghost" data-action="delete-sponsor" data-sponsor-id="${escapeHtml(row.id)}" aria-label="Delete sponsor ${company}" title="Delete sponsor">${icon('trash-2')}</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function startEditSponsor(sponsorId) {
    const row = (allFinancials || []).find(r => sameId(r.id, sponsorId));
    if (!row) return;

    document.getElementById('sponsor-modal-title').textContent = 'Edit sponsor';
    document.getElementById('sponsor-id').value = sponsorId;
    document.getElementById('sponsor-company-name').value = row.description || '';
    document.getElementById('sponsor-contact-person').value = row.contactPerson || '';
    document.getElementById('sponsor-phone-number').value = row.phoneNumber || '';
    document.getElementById('sponsor-email').value = row.contactEmail || row.email || '';
    document.getElementById('sponsor-amount').value = row.amount == null || row.amount === 0 ? '' : row.amount;
    document.getElementById('sponsor-status').value = row.sponsorStatus || 'reached-out';
    document.getElementById('sponsor-notes').value = row.notes || '';
    document.getElementById('save-sponsor-btn').textContent = 'Save sponsor';
    document.getElementById('sponsor-modal').classList.add('active');
    document.getElementById('sponsor-company-name').focus();
}

async function handleSponsorSubmit(e) {
    e.preventDefault();

    if (!currentEventId) {
        alert('Save the event first before adding sponsors.');
        return;
    }

    const sponsorId = document.getElementById('sponsor-id').value;
    const saveBtn = document.getElementById('save-sponsor-btn');
    saveBtn.disabled = true;

    const payload = {
        companyName: document.getElementById('sponsor-company-name').value.trim(),
        contactPerson: document.getElementById('sponsor-contact-person').value.trim(),
        phoneNumber: document.getElementById('sponsor-phone-number').value.trim(),
        email: document.getElementById('sponsor-email').value.trim(),
        amount: document.getElementById('sponsor-amount').value.trim(),
        status: document.getElementById('sponsor-status').value,
        notes: document.getElementById('sponsor-notes').value.trim()
    };

    try {
        if (!payload.companyName) {
            alert('Company name is required.');
            return;
        }

        if (sponsorId) {
            await API.events.sponsors.update(currentEventId, sponsorId, payload);
        } else {
            await API.events.sponsors.create(currentEventId, payload);
        }

        await loadEventSponsors();
        renderBudgetTable();
        closeSponsorModal();
    } catch (error) {
        console.error('Error saving sponsor:', error);
        alert(`Error saving sponsor: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
    }
}

async function deleteSponsor(sponsorId, button) {
    if (!confirm('Delete this sponsor entry?')) return;

    await withBusy(button, '…', async () => {
        try {
            await API.events.sponsors.delete(currentEventId, sponsorId);
            await loadEventSponsors();
            renderBudgetTable();
            const editingId = document.getElementById('sponsor-id').value;
            const modal = document.getElementById('sponsor-modal');
            if (sameId(editingId, sponsorId) && modal.classList.contains('active')) {
                closeSponsorModal();
            }
        } catch (error) {
            console.error('Error deleting sponsor:', error);
            alert(`Error deleting sponsor: ${error.message}`);
        }
    });
}

async function saveSponsorStatus(sponsorId, status, select) {
    if (select) select.disabled = true;
    try {
        await API.events.sponsors.update(currentEventId, sponsorId, { sponsorStatus: status });
        allFinancials = await API.events.financials.list(currentEventId) || [];
        renderSponsorsTable();
        renderBudgetTable();
    } catch (error) {
        console.error('Error updating sponsor status:', error);
        alert(`Error: ${error.message}`);
        renderSponsorsTable();
    }
}

function setNoSequenceStateMessage(message, isError = false) {
    const stateEl = document.getElementById('no-sequence-state');
    const descriptionEl = stateEl?.querySelector('p');
    if (!descriptionEl) return;

    descriptionEl.textContent = message;
    descriptionEl.classList.toggle('is-error', isError);
}

function showSequenceState(exists) {
    document.getElementById('no-sequence-state').classList.toggle('hidden', exists);
    document.getElementById('sequence-exists-state').classList.toggle('hidden', !exists);
}

async function loadEventSequence() {
    if (!currentEvent || !currentEvent.sequenceId) {
        showSequenceState(false);
        setNoSequenceStateMessage('Create an email sequence to send automated emails to interest leads for this event.');
        currentEventSequence = null;
        return;
    }

    try {
        const response = await API.sequences.get(currentEvent.sequenceId);
        currentEventSequence = response.sequence;
        currentEventSequence.emails = response.emails || [];

        showSequenceState(true);
        setNoSequenceStateMessage('Create an email sequence to send automated emails to interest leads for this event.');

        renderSequenceEmails();
    } catch (error) {
        console.error('Failed to load sequence:', error);
        showSequenceState(false);
        currentEventSequence = null;

        if (error.status === 404) {
            setNoSequenceStateMessage('This event is linked to a sequence that no longer exists. Create a new sequence for this event.', true);
            return;
        }

        setNoSequenceStateMessage(`Failed to load sequence: ${error.message || 'Unknown error'}. Please refresh and try again.`, true);
    }
}

function renderSequenceEmails() {
    const container = document.getElementById('sequence-emails-list');

    if (!currentEventSequence || !currentEventSequence.emails || currentEventSequence.emails.length === 0) {
        container.innerHTML = '<div class="empty-state">No emails in this sequence yet. Add the first one to start it.</div>';
        document.getElementById('recipient-delivery-overview').classList.add('hidden');
        return;
    }

    const emails = currentEventSequence.emails.sort((a, b) => (a.sequenceOrder || a.order || 0) - (b.sequenceOrder || b.order || 0));

    loadEmailDeliveryStats(emails).then(emailStats => {
        container.innerHTML = emails.map(email => {
            const order = email.sequenceOrder || email.order || 1;
            const isLive = email.status === 'live';
            const statusBadge = isLive
                ? '<span class="badge badge-violet badge-dot">Live</span>'
                : '<span class="badge badge-dot">Draft</span>';
            const schedule = email.scheduledSendTime
                ? `<span class="meta-item">${icon('clock')}${escapeHtml(new Date(email.scheduledSendTime).toLocaleString())}</span>`
                : '';

            const stats = emailStats[email.id] || { sent: 0, total: 0 };
            const delivery = stats.total > 0
                ? `<span class="meta-item">${icon('send')}Sent to ${stats.sent} of ${stats.total}</span>`
                : '';

            const editButton = isLive ? `${icon('eye')}View` : `${icon('pencil')}Edit`;
            const subject = escapeHtml(email.subject);

            const emailIdAttr = escapeHtml(email.id);
            return `
                <div class="email-card sequence-email">
                    <span class="sequence-order"><span class="visually-hidden">Email </span>${Number(order) || 1}</span>
                    <div class="sequence-email-body">
                        <div class="email-card-title sequence-email-subject">${subject}</div>
                        <div class="meta-list email-card-meta">${statusBadge}${schedule}${delivery}</div>
                    </div>
                    <div class="row-actions email-card-actions">
                        ${order > 1
                            ? `<button type="button" class="btn-sm icon-only" data-action="move-up" data-email-id="${emailIdAttr}" aria-label="Move earlier: ${subject}" title="Move earlier">${icon('arrow-up')}</button>`
                            : `<button type="button" class="btn-sm icon-only" disabled aria-label="Already the first email" title="Already the first email">${icon('arrow-up')}</button>`}
                        ${order < emails.length
                            ? `<button type="button" class="btn-sm icon-only" data-action="move-down" data-email-id="${emailIdAttr}" aria-label="Move later: ${subject}" title="Move later">${icon('arrow-down')}</button>`
                            : `<button type="button" class="btn-sm icon-only" disabled aria-label="Already the last email" title="Already the last email">${icon('arrow-down')}</button>`}
                        <button type="button" class="btn-sm" data-action="edit-email" data-email-id="${emailIdAttr}">${editButton}</button>
                    </div>
                </div>
            `;
        }).join('');
    });

    loadRecipientDeliveryOverview();
}

async function loadEmailDeliveryStats(emails) {
    if (!currentEvent || !emails || emails.length === 0) {
        return {};
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${encodeURIComponent(currentEvent.id)}`);
        if (!response.ok) return {};

        const data = await response.json();
        const { deliveries = [], leads = [], recipients = [] } = data;
        const verifiedLeads = leads.filter(l => l.verified);
        const totalRecipients = verifiedLeads.length + recipients.length;

        const stats = {};
        emails.forEach(email => {
            const emailId = normalizeId(email.id);
            const emailDeliveries = deliveries.filter(d => normalizeId(d.campaignId) === emailId);
            const sentCount = emailDeliveries.filter(d => d.status === 'sent').length;
            stats[email.id] = {
                sent: sentCount,
                total: totalRecipients
            };
        });

        return stats;
    } catch (error) {
        console.error('Failed to load email delivery stats:', error);
        return {};
    }
}

async function loadRecipientDeliveryOverview() {
    const overviewSection = document.getElementById('recipient-delivery-overview');
    const headerEl = document.getElementById('recipient-overview-header');
    const bodyEl = document.getElementById('recipient-overview-body');

    if (!currentEvent || !currentEvent.sequenceId) {
        overviewSection.classList.add('hidden');
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${encodeURIComponent(currentEvent.id)}`);
        if (!response.ok) throw new Error('Failed to load deliveries');

        const data = await response.json();
        const { deliveries = [], leads = [], recipients = [], campaigns } = data;

        if (!campaigns || campaigns.length === 0) {
            overviewSection.classList.add('hidden');
            return;
        }

        overviewSection.classList.remove('hidden');

        const sortedCampaigns = campaigns.sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
        headerEl.innerHTML = `
            <tr>
                <th scope="col">Recipient</th>
                ${sortedCampaigns.map((c, i) => `<th scope="col" class="cell-center"${c.subject ? ` title="${escapeHtml(c.subject)}"` : ''}><span class="visually-hidden">Email </span>#${i + 1}</th>`).join('')}
                <th scope="col" class="cell-center">Total</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
        `;

        const verifiedLeads = leads.filter(l => l.verified);

        const allRecipients = [
            ...verifiedLeads.map(lead => ({
                id: lead.id,
                name: lead.firstName && lead.lastName ? `${lead.firstName} ${lead.lastName}` : lead.email,
                email: lead.email,
                type: 'interest',
                leadId: lead.id,
                matchField: 'leadId'
            })),
            ...recipients.map(r => ({
                id: r.id,
                name: r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : r.email,
                email: r.email,
                type: r.type,
                leadId: null,
                matchField: 'userId'
            }))
        ];

        if (allRecipients.length === 0) {
            bodyEl.innerHTML = '<tr><td colspan="' + (campaigns.length + 3) + '" class="empty-state">No recipients yet</td></tr>';
            return;
        }

        const rows = allRecipients.map(recipient => {
            const recipientDeliveries = deliveries.filter(d =>
                (d.email || '').toLowerCase() === (recipient.email || '').toLowerCase()
            );

            const emailStatuses = sortedCampaigns.map(campaign => {
                const campaignId = normalizeId(campaign.id);
                const delivery = recipientDeliveries.find(d => normalizeId(d.campaignId) === campaignId);
                if (!delivery) return { sent: false, mark: '<span class="delivery-mark" aria-hidden="true">–</span><span class="visually-hidden">Not sent</span>' };
                if (delivery.status === 'sent') return { sent: true, mark: `<span class="delivery-mark is-sent">${icon('check')}</span><span class="visually-hidden">Sent</span>` };
                if (delivery.status === 'failed') return { sent: false, mark: `<span class="delivery-mark is-failed">${icon('x')}</span><span class="visually-hidden">Failed</span>` };
                return { sent: false, mark: `<span class="delivery-mark">${icon('hourglass')}</span><span class="visually-hidden">Pending</span>` };
            });

            const sentCount = emailStatuses.filter(s => s.sent).length;
            const totalCount = sortedCampaigns.length;
            const completion = totalCount > 0 ? Math.round((sentCount / totalCount) * 100) : 0;

            const typeLabels = {
                'interest': '<span class="badge">Interest</span>',
                'judge': '<span class="badge">Judge</span>',
                'committee': '<span class="badge">Committee</span>',
                'participant': '<span class="badge">Participant</span>'
            };
            const typeLabel = typeLabels[recipient.type] || '';

            return {
                name: recipient.name,
                email: recipient.email,
                typeLabel,
                leadId: recipient.leadId,
                userId: recipient.leadId ? null : recipient.id,
                statuses: emailStatuses,
                sentCount,
                totalCount,
                completion
            };
        });

        rows.sort((a, b) => a.completion - b.completion);

        // Names and emails come from the public interest form: always rendered as text.
        bodyEl.innerHTML = rows.map(row => `
            <tr>
                <td>
                    <div class="recipient-name"><strong>${escapeHtml(row.name)}</strong>${row.typeLabel || ''}</div>
                    <div class="cell-sub">${escapeHtml(row.email)}</div>
                </td>
                ${row.statuses.map(s => `<td class="cell-center">${s.mark}</td>`).join('')}
                <td class="cell-center cell-total">${row.sentCount}/${row.totalCount}</td>
                <td class="cell-actions">
                    <div class="row-actions">
                    ${row.leadId
                        ? `<button type="button" class="btn-sm" data-action="restart-lead" data-lead-id="${escapeHtml(row.leadId)}" title="Send this recipient every sequence email they have not received">${icon('refresh-cw')}Restart</button>`
                        : `<button type="button" class="btn-sm" data-action="restart-user" data-user-id="${escapeHtml(row.userId)}" title="Send this recipient every sequence email they have not received">${icon('refresh-cw')}Restart</button>`}
                    <button type="button" class="btn-sm danger-ghost" data-action="clear-deliveries" data-email="${escapeHtml(row.email)}" title="Remove the delivery records for this recipient (sends nothing)">${icon('trash-2')}Clear records</button>
                    </div>
                </td>
            </tr>
        `).join('');

    } catch (error) {
        console.error('Failed to load recipient delivery overview:', error);
        overviewSection.classList.add('hidden');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('create-sequence-btn')?.addEventListener('click', () => {
        showCreateSequenceModal();
    });

    document.getElementById('add-sequence-email-btn')?.addEventListener('click', () => {
        showAddEmailModal();
    });

    document.querySelectorAll('input[name="sequence-create-option"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const copySection = document.getElementById('copy-from-event-section');
            if (e.target.value === 'copy') {
                copySection.classList.remove('hidden');
                loadEventsWithSequences();
            } else {
                copySection.classList.add('hidden');
            }
        });
    });

});

function showCreateSequenceModal() {
    document.getElementById('create-sequence-modal').classList.add('active');
}

function closeCreateSequenceModal() {
    document.getElementById('create-sequence-modal').classList.remove('active');
}

async function loadEventsWithSequences() {
    const select = document.getElementById('copy-from-event-select');
    select.innerHTML = '<option value="">Loading events...</option>';

    try {
        const eventsWithSeq = allEvents.filter(e => e.sequenceId && !sameId(e.id, currentEvent.id));

        if (eventsWithSeq.length === 0) {
            select.innerHTML = '<option value="">No other events have sequences yet</option>';
            return;
        }

        select.innerHTML = '<option value="">Select an event...</option>';
        eventsWithSeq.forEach(e => {
            const option = document.createElement('option');
            option.value = e.id;
            option.textContent = e.name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load events:', error);
        select.innerHTML = '<option value="">Error loading events</option>';
    }
}

async function confirmCreateSequence() {
    await withBusy(document.getElementById('confirm-create-sequence-btn'), 'Creating…', createSequenceFromModal);
}

async function createSequenceFromModal() {
    const option = document.querySelector('input[name="sequence-create-option"]:checked').value;

    try {
        if (option === 'scratch') {
            const response = await API.sequences.create({
                name: `${currentEvent.name} ${currentEvent.startDate} - ${currentEvent.endDate}`,
                description: `Email sequence for ${currentEvent.name}`,
                emails: []
            });

            await API.events.update(currentEvent.id, {
                sequenceId: response.sequence.id,
                sequenceEnabled: true
            });

            currentEvent.sequenceId = response.sequence.id;
            currentEvent.sequenceEnabled = true;
            currentEventSequence = response.sequence;

        } else {
            const sourceEventId = document.getElementById('copy-from-event-select').value;
            if (!sourceEventId) {
                alert('Please select an event to copy from');
                return;
            }

            const sourceEvent = allEvents.find(e => sameId(e.id, sourceEventId));
            if (!sourceEvent || !sourceEvent.sequenceId) {
                alert('Selected event has no sequence');
                return;
            }

            // POST /sequences/{id}/copy duplicates the sequence and its emails for the target event.
            const response = await API.sequences.copy(sourceEvent.sequenceId, currentEvent.id);

            await API.sequences.update(response.sequence.id, {
                name: `${currentEvent.name} ${currentEvent.startDate} - ${currentEvent.endDate}`,
                description: `Copied from ${sourceEvent.name} ${sourceEvent.startDate} - ${sourceEvent.endDate}`
            });

            await API.events.update(currentEvent.id, {
                sequenceId: response.sequence.id,
                sequenceEnabled: true
            });

            currentEvent.sequenceId = response.sequence.id;
            currentEvent.sequenceEnabled = true;

            const seqResponse = await API.sequences.get(response.sequence.id);
            currentEventSequence = seqResponse.sequence;
        }

        closeCreateSequenceModal();
        loadEventSequence();

    } catch (error) {
        console.error('Failed to create sequence:', error);
        alert(`Failed to create sequence: ${error.message || 'Please try again.'}`);
    }
}

function showAddEmailModal() {
    const nextOrder = currentEventSequence.emails ? currentEventSequence.emails.length + 1 : 1;
    const url = `admin-email.html?mode=sequence&sequenceId=${currentEventSequence.id}&eventId=${currentEvent.id}&order=${nextOrder}`;
    window.location.href = url;
}

function editSequenceEmailInline(emailId) {
    const email = currentEventSequence.emails.find(e => sameId(e.id, emailId));
    if (!email) return;

    const url = `admin-email.html?mode=sequence&sequenceId=${encodeURIComponent(currentEventSequence.id)}&eventId=${encodeURIComponent(currentEvent.id)}&emailId=${encodeURIComponent(email.id)}`;
    window.location.href = url;
}

async function reorderEmail(emailId, direction, button) {
    const sorted = [...currentEventSequence.emails].sort(
        (a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0)
    );

    const idx = sorted.findIndex(e => sameId(e.id, emailId));
    if (idx === -1) return;

    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];

    await withBusy(button, '…', async () => {
        try {
            await Promise.all([
                API.campaigns.update(sorted[idx].id,    { sequenceOrder: idx + 1 }),
                API.campaigns.update(sorted[swapIdx].id, { sequenceOrder: swapIdx + 1 })
            ]);

            sorted[idx].sequenceOrder    = idx + 1;
            sorted[swapIdx].sequenceOrder = swapIdx + 1;
            currentEventSequence.emails = sorted;
            renderSequenceEmails();

        } catch (error) {
            console.error('Failed to reorder emails:', error);
            alert('Failed to reorder emails. Please try again.');
        }
    });
}


let allFinancials = [];

async function loadEventBudget() {
    const tbody = document.getElementById('budget-table-body');
    if (!currentEventId) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Save the event first to manage the budget</td></tr>';
        return;
    }

    if (currentEvent) {
        document.getElementById('budget-hotel-rate').value = currentEvent.hotelRatePerNight ?? '';
        document.getElementById('budget-hotel-nights').value = '';
        document.getElementById('budget-food-rate').value = currentEvent.foodRatePerDay ?? '';
        document.getElementById('budget-food-days').value = currentEvent.foodDays ?? '';
        updateRatePreview('hotel');
        updateRatePreview('food');
    }

    try {
        const [rows, summary] = await Promise.all([
            API.events.financials.list(currentEventId),
            API.events.financials.summary(currentEventId)
        ]);
        allFinancials = rows || [];
        renderBudgetSummary(summary);
        renderBudgetTable();
    } catch (error) {
        console.error('Error loading budget:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Could not load the budget. Reload the page to try again.</td></tr>';
    }
}

function renderBudgetSummary(summary) {
    const currency = eventCurrency();
    const fmt = (val) => val != null ? Number(val).toLocaleString(currencyLocale(currency), { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '0';
    const show = (id, val) => {
        document.getElementById(id).innerHTML = `${escapeHtml(fmt(val))} <span class="stat-unit">${escapeHtml(currency)}</span>`;
    };
    show('budget-total-income', summary?.totalIncome);
    show('budget-total-org-expense', summary?.totalOrgExpense);
    show('budget-total-participant-expense', summary?.totalParticipantExpense);
    const net = summary?.netBalance ?? 0;
    show('budget-net-balance', net);
    const netCard = document.getElementById('budget-net-card');
    netCard.classList.toggle('positive', net >= 0);
    netCard.classList.toggle('negative', net < 0);
}

function renderBudgetTable() {
    const tbody = document.getElementById('budget-table-body');
    if (!allFinancials || allFinancials.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No financial rows yet</td></tr>';
        return;
    }

    const currency = eventCurrency();
    const fmt = (val) => val != null ? Number(val).toLocaleString(currencyLocale(currency)) : '\u2014';

    const paidBySelect = (row) => {
        const opts = [
            `<option value="participant"${row.paidBy === 'participant' ? ' selected' : ''}>Participant pays</option>`,
            `<option value="event"${row.paidBy === 'event' ? ' selected' : ''}>Event pays</option>`
        ].join('');
        return `<select class="paidby-select" data-row-id="${escapeHtml(row.id)}" aria-label="Paid by">${opts}</select>`;
    };

    const typeLabel = (row) => row.type === 'income'
        ? '<span class="badge badge-success">Income</span>'
        : '<span class="badge">Expense</span>';

    const CATEGORY_LABELS = {
        venue: 'Venue', food: 'Food', hotel: 'Hotel', activity: 'Activity',
        sponsorship: 'Sponsorship', registration: 'Registration fee', other: 'Other'
    };

    const amountCell = (row) => {
        const sign = row.type === 'income' ? '+' : '−';
        const cls = row.type === 'income' ? 'financial-amount-income' : 'financial-amount-expense';
        return `<span class="${cls}">${sign}${fmt(row.amount)} ${escapeHtml(currency)}</span>`;
    };

    const actionCell = (row) => {
        if (row.source === 'manual') {
            const label = escapeHtml(row.description || 'row');
            return `<div class="row-actions">
                    <button type="button" class="btn-sm icon-only" data-action="edit-financial" data-row-id="${escapeHtml(row.id)}" aria-label="Edit ${label}" title="Edit row">${icon('pencil')}</button>
                    <button type="button" class="btn-sm icon-only danger-ghost" data-action="delete-financial" data-row-id="${escapeHtml(row.id)}" aria-label="Delete ${label}" title="Delete row">${icon('trash-2')}</button>
                </div>`;
        }
        return '<span class="text-muted" title="Generated by Recalculate rows">Automatic</span>';
    };

    const SPONSOR_STATUS = {
        'reached-out': ['', 'Reached out'],
        negotiating: ['badge-warning', 'Negotiating'],
        declined: ['badge-danger', 'Declined']
    };

    const descCell = (row) => {
        let desc = escapeHtml(row.description || '');
        if (row.unitCost != null && row.days != null) {
            desc += ` <span class="cell-note">(${fmt(row.unitCost)} × ${Number(row.days) || 0})</span>`;
        }
        if (row.category === 'sponsorship' && row.sponsorStatus && row.sponsorStatus !== 'confirmed') {
            const [tone, label] = SPONSOR_STATUS[row.sponsorStatus] || ['', row.sponsorStatus];
            desc += ` <span class="badge ${tone}">${escapeHtml(label)}</span>`;
        }
        return desc;
    };

    const dataRow = (row) => `
        <tr class="${row.source === 'auto' ? 'financial-auto-row' : ''}">
            <td>${typeLabel(row)}</td>
            <td>${escapeHtml(CATEGORY_LABELS[row.category] || row.category || '')}</td>
            <td>${descCell(row)}</td>
            <td class="cell-num">${amountCell(row)}</td>
            <td>${paidBySelect(row)}</td>
            <td class="cell-actions">${actionCell(row)}</td>
        </tr>`;

    const participantMap = new Map();
    const eventRows = [];

    for (const row of allFinancials) {
        if (row.participationId) {
            if (!participantMap.has(row.participationId)) {
                participantMap.set(row.participationId, {
                    email: row.participationEmail || row.participationId,
                    roles: row.participationRoles || '',
                    rows: []
                });
            }
            participantMap.get(row.participationId).rows.push(row);
        } else {
            eventRows.push(row);
        }
    }

    const groupTotal = (rows) => {
        let net = 0;
        for (const r of rows) net += r.type === 'income' ? r.amount : -r.amount;
        const cls = net >= 0 ? 'financial-amount-income' : 'financial-amount-expense';
        const sign = net >= 0 ? '+' : '−';
        return `<span class="${cls}">${sign}${fmt(Math.abs(net))} ${escapeHtml(currency)}</span>`;
    };

    let html = '';

    for (const [, group] of participantMap) {
        const roleLabel = group.roles ? ` <span class="budget-group-roles">${escapeHtml(group.roles)}</span>` : '';
        html += `<tr class="budget-group-header">
            <td colspan="6"><span class="budget-group-name">${icon('user')}${escapeHtml(group.email)}</span>${roleLabel}
                <span class="budget-group-total">Net ${groupTotal(group.rows)}</span>
            </td>
        </tr>`;
        html += group.rows.map(dataRow).join('');
    }

    if (eventRows.length > 0) {
        html += `<tr class="budget-group-header">
            <td colspan="6"><span class="budget-group-name">${icon('building-2')}Event-level rows</span>
                <span class="budget-group-total">Net ${groupTotal(eventRows)}</span>
            </td>
        </tr>`;
        html += eventRows.map(dataRow).join('');
    }

    tbody.innerHTML = html || '<tr><td colspan="6" class="empty-state">No financial rows yet</td></tr>';
}

function openFinancialModal() {
    if (!currentEventId) {
        alert('Save the event first before adding financial rows.');
        return;
    }
    document.getElementById('financial-modal-title').textContent = 'Add financial row';
    document.getElementById('financial-id').value = '';
    document.getElementById('financial-form').reset();
    document.getElementById('save-financial-btn').textContent = 'Add row';
    document.getElementById('financial-modal').classList.add('active');
    toggleFinancialPaidBy();
}

function closeFinancialModal() {
    document.getElementById('financial-modal').classList.remove('active');
}

function toggleFinancialPaidBy() {
    const type = document.getElementById('financial-type').value;
    document.getElementById('financial-paidby-group').classList.toggle('hidden', type !== 'expense');
}

function startEditFinancial(rowId) {
    const row = allFinancials.find(r => sameId(r.id, rowId));
    if (!row) return;

    document.getElementById('financial-modal-title').textContent = 'Edit financial row';
    document.getElementById('financial-id').value = row.id;
    document.getElementById('financial-type').value = row.type;
    document.getElementById('financial-category').value = row.category;
    document.getElementById('financial-description').value = row.description || '';
    document.getElementById('financial-amount').value = row.amount;
    document.getElementById('financial-paid-by').value = row.paidBy || 'event';
    document.getElementById('financial-notes').value = row.notes || '';
    document.getElementById('save-financial-btn').textContent = 'Save row';
    document.getElementById('financial-modal').classList.add('active');
    toggleFinancialPaidBy();
}

async function handleFinancialSubmit(e) {
    e.preventDefault();
    if (!currentEventId) return;

    const rowId = document.getElementById('financial-id').value;
    const saveBtn = document.getElementById('save-financial-btn');
    saveBtn.disabled = true;

    const type = document.getElementById('financial-type').value;
    const payload = {
        type,
        category: document.getElementById('financial-category').value,
        description: document.getElementById('financial-description').value.trim(),
        amount: parseFloat(document.getElementById('financial-amount').value),
        paidBy: type === 'income' ? 'event' : (document.getElementById('financial-paid-by').value),
        unitCost: null,
        days: null,
        notes: document.getElementById('financial-notes').value.trim() || null
    };

    try {
        if (rowId) {
            await API.events.financials.update(currentEventId, rowId, payload);
        } else {
            await API.events.financials.create(currentEventId, payload);
        }
        closeFinancialModal();
        await loadEventBudget();
    } catch (error) {
        console.error('Error saving financial row:', error);
        alert(`Error saving row: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
    }
}

async function deleteFinancialRow(rowId, button) {
    if (!confirm('Delete this financial row?')) return;
    await withBusy(button, '…', async () => {
        try {
            await API.events.financials.delete(currentEventId, rowId);
            await loadEventBudget();
        } catch (error) {
            console.error('Error deleting financial row:', error);
            alert(`Error deleting row: ${error.message}`);
        }
    });
}

async function savePaidBy(rowId, paidBy, select) {
    if (select) select.disabled = true;
    try {
        await API.events.financials.patchPaidBy(currentEventId, rowId, paidBy);
        const row = allFinancials.find(r => sameId(r.id, rowId));
        if (row) row.paidBy = paidBy;
        const summary = await API.events.financials.summary(currentEventId);
        renderBudgetSummary(summary);
        if (select) select.disabled = false;
    } catch (error) {
        console.error('Error updating paidBy:', error);
        alert(`Error: ${error.message}`);
        renderBudgetTable();
    }
}

async function recalculateFinancials() {
    if (!currentEventId) return;

    const btn = document.getElementById('recalculate-btn');
    const btnMarkup = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Recalculating…';

    try {
        const result = await API.events.financials.recalculate(currentEventId);
        await loadEventBudget();

        const errMsg = result.errors && result.errors.length
            ? `\n\n${result.errors.length} participant(s) had errors.`
            : '';
        alert(`Recalculated ${result.updated} of ${result.total} participants.${errMsg}`);
    } catch (error) {
        console.error('Recalculate failed:', error);
        alert(`Error recalculating: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = btnMarkup;
    }
}

async function saveEventRates() {
    if (!currentEventId) return;
    const hotelRate   = document.getElementById('budget-hotel-rate').value;
    const foodRate    = document.getElementById('budget-food-rate').value;
    const foodDays    = document.getElementById('budget-food-days').value;

    // Only Events columns are sent; the "default nights" field drives the per-person preview only.
    const payload = {
        hotelRatePerNight: hotelRate !== '' ? parseFloat(hotelRate) : null,
        foodRatePerDay:    foodRate  !== '' ? parseFloat(foodRate)  : null,
        foodDays:          foodDays  !== '' ? parseInt(foodDays, 10) : null
    };

    await withBusy(document.getElementById('save-rates-btn'), 'Saving…', async () => {
        try {
            const updated = await API.events.update(currentEventId, payload);
            if (updated) {
                currentEvent = { ...currentEvent, ...payload };
            }
            alert('Rates saved. Select Recalculate rows to regenerate the automatic rows with the new rates.');
        } catch (error) {
            console.error('Error saving rates:', error);
            alert(`Error saving rates: ${error.message}`);
        }
    });
}

function updateRatePreview(type) {
    const currency = eventCurrency();
    const locale = currencyLocale(currency);
    if (type === 'hotel') {
        const rate = parseFloat(document.getElementById('budget-hotel-rate').value) || 0;
        const nights = parseInt(document.getElementById('budget-hotel-nights').value, 10) || 0;
        const el = document.getElementById('hotel-rate-preview');
        if (el) el.textContent = rate && nights ? `${(rate * nights).toLocaleString(locale)}\u00a0${currency} per person` : '';
    } else {
        const rate = parseFloat(document.getElementById('budget-food-rate').value) || 0;
        const days = parseInt(document.getElementById('budget-food-days').value, 10) || 0;
        const el = document.getElementById('food-rate-preview');
        if (el) el.textContent = rate && days ? `${(rate * days).toLocaleString(locale)}\u00a0${currency} per person` : '';
    }
}
