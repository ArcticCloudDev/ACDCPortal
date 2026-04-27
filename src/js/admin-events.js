// ACDC Portal - Admin Events Management

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

// Status workflow - defines valid transitions
const STATUS_ORDER = ['draft', 'pre-registration', 'registration', 'live', 'completed'];
const STATUS_LABELS = {
    draft: '📝 Draft',
    'pre-registration': '🔔 Pre-Registration',
    registration: '✅ Registration Open',
    live: '🚀 Live',
    completed: '✓ Completed'
};

// Valid status transitions (can only go forward one step, or back to previous)
function canTransitionTo(currentStatus, targetStatus) {
    const currentIndex = STATUS_ORDER.indexOf(currentStatus);
    const targetIndex = STATUS_ORDER.indexOf(targetStatus);
    
    // Can go forward one step or backward one step
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

    // Resolve permissions (handles auth check, sidebar render, access denied)
    currentPermissions = await Permissions.initAdminPage('events', {
        loadingEl: loadingDiv,
        accessDeniedEl: notCommitteeDiv,
        contentEl: adminContent
    });

    if (!currentPermissions) return;

    currentUser = currentPermissions.user;

    try {
        // Load events
        await loadEvents();

        // Setup event listeners
        setupEventListeners();

        // Check for action in URL
        const urlParams = new URLSearchParams(window.location.search);
        const eventId = urlParams.get('event');
        const tab = urlParams.get('tab');
        
        if (eventId) {
            const event = allEvents.find(e => e.id === eventId);
            if (event) {
                currentEventId = eventId;
                currentEvent = event;
                showForm(event);
                if (tab && tab !== 'general') {
                    // Switch to specific tab after a brief delay to ensure DOM is ready
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
        // Scope to permitted events for non-admin users
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');
        renderEventsList();
    } catch (error) {
        console.error('Error loading events:', error);
    }
}

// Email sequence is now a boolean checkbox
// Sequence content is configured in the Sequence tab

// Team welcome email is now a boolean checkbox
// Theme/content is configured in Email Templates page

function renderEventsList() {
    const eventsTableBody = document.getElementById('events-table-body');

    if (allEvents.length === 0) {
        eventsTableBody.innerHTML = `
            <tr><td colspan="6" class="empty-state">No events yet. Create your first event!</td></tr>
        `;
        return;
    }

    // Sort: by status priority (live > registration > waitlist > draft), then by date
    const statusPriority = { live: 0, registration: 1, waitlist: 2, draft: 3 };
    const sortedEvents = [...allEvents].sort((a, b) => {
        const statusA = a.status || 'draft';
        const statusB = b.status || 'draft';
        if (statusPriority[statusA] !== statusPriority[statusB]) {
            return statusPriority[statusA] - statusPriority[statusB];
        }
        return new Date(b.startDate) - new Date(a.startDate);
    });

    eventsTableBody.innerHTML = sortedEvents.map(event => {
        const startDate = new Date(event.startDate + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        const endDate = new Date(event.endDate + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });

        // Get status - migrate old events
        const status = event.status || (event.registrationOpen ? 'registration' : 'draft');
        const statusLabel = STATUS_LABELS[status] || status;
        
        // Registration type
        const regType = event.registrationType || 'team';
        const regTypeLabel = regType === 'team' ? '👥 Team' : '👤 Single';

        return `
            <tr>
                <td>
                    <strong>${escapeHtml(event.name)}</strong>
                </td>
                <td><span class="badge ${regType}">${regTypeLabel}</span></td>
                <td>${startDate} - ${endDate}</td>
                <td>${escapeHtml(event.location || 'TBD')}</td>
                <td><span class="badge ${status}">${statusLabel}</span></td>
                <td>
                    <a href="admin-event-participants.html?id=${event.id}" class="btn-sm">👥 Participants</a>
                    <button class="btn-sm primary edit-event-btn" data-id="${event.id}">✏️ Edit</button>
                </td>
            </tr>
        `;
    }).join('');

    // Add edit button listeners
    document.querySelectorAll('.edit-event-btn').forEach(btn => {
        btn.addEventListener('click', () => editEvent(btn.dataset.id));
    });
}

function setupEventListeners() {
    // Create button
    document.getElementById('create-event-btn').addEventListener('click', () => showForm());

    // Back to list
    document.getElementById('back-to-list').addEventListener('click', hideForm);
    document.getElementById('cancel-btn').addEventListener('click', hideForm);

    // Form submit
    document.getElementById('event-form').addEventListener('submit', handleFormSubmit);

    // Delete button
    document.getElementById('delete-btn').addEventListener('click', handleDelete);

    // Registration type radio buttons
    document.querySelectorAll('.radio-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.radio-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            option.querySelector('input').checked = true;
            
            // Toggle team fields visibility
            const regType = option.dataset.value;
            const teamFields = document.getElementById('team-fields');
            teamFields.classList.toggle('visible', regType === 'team');
        });
    });

    // Status buttons
    document.querySelectorAll('.status-step').forEach(step => {
        step.addEventListener('click', () => handleStatusChange(step.dataset.status));
    });

    // Tab navigation
    setupTabs();

    // Invitation buttons
    document.getElementById('invite-committee-btn').addEventListener('click', () => sendInvitation('committee'));
    document.getElementById('invite-judge-btn').addEventListener('click', () => sendInvitation('judge'));

    // Sponsor form
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
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('financial-modal').classList.contains('active')) {
            closeFinancialModal();
        }
    });
}

// Status display configuration
const STATUS_CONFIG = {
    draft: {
        icon: '📝',
        title: 'Draft',
        description: 'Event is in draft mode. Only visible to committee members.',
        bannerBg: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
        bannerBorder: '#64748b',
        titleColor: '#334155',
        descColor: '#64748b'
    },
    'pre-registration': {
        icon: '🔔',
        title: 'Pre-Registration',
        description: 'Theme announced. People can register interest, but team registration is not yet open.',
        bannerBg: 'linear-gradient(135deg, #fefce8 0%, #fef08a 100%)',
        bannerBorder: '#eab308',
        titleColor: '#a16207',
        descColor: '#ca8a04'
    },
    registration: {
        icon: '✅',
        title: 'Registration Open',
        description: 'Registration is open. Participants can create teams and register.',
        bannerBg: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
        bannerBorder: '#2563eb',
        titleColor: '#1e40af',
        descColor: '#3b82f6'
    },
    live: {
        icon: '🚀',
        title: 'Event Live',
        description: 'Event is running! No new registrations allowed.',
        bannerBg: 'linear-gradient(135deg, #ecfdf5 0%, #a7f3d0 100%)',
        bannerBorder: '#10b981',
        titleColor: '#047857',
        descColor: '#10b981'
    },
    completed: {
        icon: '✓',
        title: 'Completed',
        description: 'Event has ended. Read-only mode (only admins can edit).',
        bannerBg: 'linear-gradient(135deg, #faf5ff 0%, #e9d5ff 100%)',
        bannerBorder: '#8b5cf6',
        titleColor: '#6b21a8',
        descColor: '#8b5cf6'
    }
};

function updateStatusUI(status) {
    currentStatus = status;
    document.getElementById('event-status').value = status;
    
    const currentIndex = STATUS_ORDER.indexOf(status);
    const steps = document.querySelectorAll('.status-step');
    
    // Update step states
    steps.forEach((step, index) => {
        const indicator = step.querySelector('.step-indicator');
        step.classList.remove('completed', 'current', 'available', 'disabled');
        
        if (index < currentIndex) {
            // Completed steps
            step.classList.add('completed');
            indicator.innerHTML = '✓';
        } else if (index === currentIndex) {
            // Current step
            step.classList.add('current');
            indicator.innerHTML = index + 1;
        } else if (index === currentIndex + 1) {
            // Next available step
            step.classList.add('available');
            indicator.innerHTML = index + 1;
        } else {
            // Future disabled steps
            step.classList.add('disabled');
            indicator.innerHTML = index + 1;
        }
    });
    
    // Update progress line
    const progressLine = document.getElementById('progress-line');
    if (progressLine) {
        // Calculate progress percentage based on current step
        const progressPercent = currentIndex / (STATUS_ORDER.length - 1) * 100;
        const containerWidth = document.querySelector('.status-stepper').offsetWidth - 80; // Subtract padding
        progressLine.style.width = `${(containerWidth * progressPercent) / 100}px`;
    }
    
    // Update status banner
    const config = STATUS_CONFIG[status];
    if (config) {
        const banner = document.getElementById('status-banner');
        const icon = document.getElementById('status-icon');
        const title = document.getElementById('status-title');
        const description = document.getElementById('status-description');
        
        banner.style.background = config.bannerBg;
        banner.style.borderLeftColor = config.bannerBorder;
        icon.textContent = config.icon;
        title.textContent = config.title;
        title.style.color = config.titleColor;
        description.textContent = config.description;
        description.style.color = config.descColor;
    }
}

function handleStatusChange(newStatus) {
    // Ignore clicks on current status
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
    
    // Confirm status change
    const direction = STATUS_ORDER.indexOf(newStatus) > STATUS_ORDER.indexOf(currentStatus) ? 'advance to' : 'revert to';
    const confirmMsg = `${direction === 'advance to' ? '▶️' : '◀️'} ${direction.charAt(0).toUpperCase() + direction.slice(1)} "${STATUS_LABELS[newStatus]}"?\n\nCurrent: ${STATUS_LABELS[currentStatus]}`;
    if (!confirm(confirmMsg)) return;
    
    updateStatusUI(newStatus);
}

function showForm(event = null) {
    editingEventId = event?.id || null;
    currentEventId = event?.id || null; // Set for committee/judges tabs
    currentEvent = event || null; // Store full event object
    
    document.getElementById('events-list-view').classList.add('hidden');
    document.getElementById('event-form-view').classList.remove('hidden');

    const formTitle = document.getElementById('form-title');
    const deleteBtn = document.getElementById('delete-btn');
    const statusSection = document.getElementById('status-section');
    const committeeTab = document.getElementById('committee-tab-btn');
    const judgesTab = document.getElementById('judges-tab-btn');
    const leadsTab = document.getElementById('leads-tab-btn');
    const sponsorsTab = document.getElementById('sponsors-tab-btn');
    const budgetTab = document.getElementById('budget-tab-btn');
    const form = document.getElementById('event-form');

    // Disable committee/judges/leads tabs for new events
    if (event) {
        committeeTab.disabled = false;
        judgesTab.disabled = false;
        leadsTab.disabled = false;
        sponsorsTab.disabled = false;
        budgetTab.disabled = false;
    } else {
        committeeTab.disabled = true;
        judgesTab.disabled = true;
        leadsTab.disabled = true;
        sponsorsTab.disabled = true;
        budgetTab.disabled = true;
        resetSponsorForm();
    }

    // Reset to General tab
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="general"]').classList.add('active');
    document.getElementById('general-panel').classList.add('active');

    if (event) {
        formTitle.textContent = 'Edit Event';
        deleteBtn.classList.remove('hidden');
        statusSection.classList.remove('hidden');
        
        // Populate form
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
        // sequenceEnabled is managed automatically via the Sequence tab
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
        
        // Set registration type
        const regType = event.registrationType || 'team';
        document.querySelectorAll('.radio-option').forEach(option => {
            const isSelected = option.dataset.value === regType;
            option.classList.toggle('selected', isSelected);
            option.querySelector('input').checked = isSelected;
        });
        document.getElementById('team-fields').classList.toggle('visible', regType === 'team');
        
        // Set status (migrate old events)
        const status = event.status || (event.registrationOpen ? 'registration' : 'draft');
        updateStatusUI(status);
        
    } else {
        formTitle.textContent = 'Create Event';
        deleteBtn.classList.add('hidden');
        statusSection.classList.add('hidden');
        form.reset();
        document.getElementById('event-id').value = '';
        
        // Default email toggles for new events
        document.getElementById('event-judge-invitation-email').checked = true;
        document.getElementById('event-committee-invitation-email').checked = true;
        
        // Reset registration type to team
        document.querySelectorAll('.radio-option').forEach(option => {
            const isTeam = option.dataset.value === 'team';
            option.classList.toggle('selected', isTeam);
            option.querySelector('input').checked = isTeam;
        });
        document.getElementById('team-fields').classList.add('visible');
        
        // New events start as draft
        currentStatus = 'draft';
        document.getElementById('event-status').value = 'draft';
    }
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
    
    // Clear URL params
    window.history.replaceState({}, '', 'admin-events.html');
}

async function verifySharePointUrl() {
    const url = document.getElementById('event-sharepoint-url').value.trim();
    const resultDiv = document.getElementById('sharepoint-verify-result');
    const btn = document.getElementById('verify-sharepoint-btn');

    if (!url) {
        resultDiv.innerHTML = '<span style="color: var(--admin-warning-color, #e67e22);">⚠️ Please enter a URL first</span>';
        return;
    }

    try {
        const parsed = new URL(url);
        if (!parsed.hostname.endsWith('.sharepoint.com')) {
            resultDiv.innerHTML = '<span style="color: var(--admin-danger-color, #e74c3c);">❌ URL must be a SharePoint domain (*.sharepoint.com)</span>';
            return;
        }
    } catch {
        resultDiv.innerHTML = '<span style="color: var(--admin-danger-color, #e74c3c);">❌ Invalid URL format</span>';
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Checking...';
    resultDiv.innerHTML = '';

    // Open URL for manual verification
    window.open(url, '_blank', 'noopener,noreferrer');

    // Ensure FileCategory column exists on the document library
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
                resultDiv.innerHTML = '<span style="color: var(--admin-success-color, #27ae60);">✅ URL opened for verification. FileCategory column ensured on SharePoint library.</span>';
            } else {
                const err = await res.json().catch(() => ({}));
                resultDiv.innerHTML = `<span style="color: var(--admin-warning-color, #e67e22);">⚠️ URL opened, but column setup failed: ${err.error || err.details || 'Unknown error'}. Check SharePoint configuration.</span>`;
            }
        } catch (err) {
            resultDiv.innerHTML = `<span style="color: var(--admin-warning-color, #e67e22);">⚠️ URL opened, but could not reach the API to set up columns. Is the API running?</span>`;
        }
    } else {
        resultDiv.innerHTML = '<span style="color: var(--admin-success-color, #27ae60);">✅ URL opened for verification. Add File Upload Categories above and verify again to set up the SharePoint column.</span>';
    }

    btn.disabled = false;
    btn.textContent = '🔗 Verify';
}

function editEvent(eventId) {
    const event = allEvents.find(e => e.id === eventId);
    if (event) {
        currentEventId = eventId;
        currentEvent = event;
        showForm(event);
        updateURL();
    }
}

async function handleFormSubmit(e) {
    e.preventDefault();
    
    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

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
            // sequenceEnabled is not sent from this form — managed by Sequence tab
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
        
        // Only include team size if team type
        if (registrationType === 'team') {
            eventData.minTeamSize = parseInt(document.getElementById('min-team-size').value) || 3;
            eventData.maxTeamSize = parseInt(document.getElementById('max-team-size').value) || 5;
        }

        const costRaw = document.getElementById('event-cost-per-participant').value.trim();
        eventData.costPerParticipant = costRaw !== '' ? parseFloat(costRaw) : null;
        eventData.currency = document.getElementById('event-currency').value || 'NOK';

        const eventId = document.getElementById('event-id').value;

        let savedEvent;
        if (eventId) {
            // Update existing
            savedEvent = await API.events.update(eventId, eventData);
        } else {
            // Create new
            savedEvent = await API.events.create(eventData);
        }

        // Reload events list
        await loadEvents();
        
        // If we're editing, update the current event object with the new data (including team IDs)
        if (savedEvent) {
            currentEvent = savedEvent;
            currentEventId = savedEvent.id;
            
            // If this is a new event, enable the related tabs
            if (!eventId) {
                document.getElementById('committee-tab-btn').disabled = false;
                document.getElementById('judges-tab-btn').disabled = false;
                document.getElementById('leads-tab-btn').disabled = false;
                document.getElementById('sponsors-tab-btn').disabled = false;
                document.getElementById('budget-tab-btn').disabled = false;
                // Update the hidden event ID field
                document.getElementById('event-id').value = savedEvent.id;
            }
        } else {
            hideForm();
        }

    } catch (error) {
        console.error('Error saving event:', error);
        alert('Error saving event: ' + error.message);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Event';
    }
}

async function handleDelete() {
    const eventId = document.getElementById('event-id').value;
    if (!eventId) return;

    if (!confirm('Are you sure you want to delete this event? This action cannot be undone.')) {
        return;
    }

    try {
        await API.events.delete(eventId);
        await loadEvents();
        hideForm();
    } catch (error) {
        console.error('Error deleting event:', error);
        alert('Error deleting event: ' + error.message);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Tab Navigation =====
function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');
            
            // Update button states
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            
            // Update panel visibility
            tabPanels.forEach(panel => panel.classList.remove('active'));
            document.getElementById(`${targetTab}-panel`).classList.add('active');
            
            // Update URL
            if (currentEventId) {
                updateURL();
            }
            
            // Load data for committee/judges/leads tabs when opened
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
            } else if (targetTab === 'deliveries') {
                loadDeliveries();
            } else if (targetTab === 'sequence') {
                loadEventSequence();
            } else if (targetTab === 'budget') {
                loadEventBudget();
            }
        });
    });
    
    // Leads tab button handlers
}

// ===== Committee & Judges Management =====
let currentEventId = null;
let currentEvent = null; // Store the full event object
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
        // Load all data
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
        // Load all data (reuse if already loaded)
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
    
    // Find participations with 'committee' role for this event
    const committeeParticipations = allParticipations.filter(p => 
        p.eventId === currentEventId && 
        p.roles?.includes('committee')
    );

    // Find pending invitations for committee
    const pendingInvites = allInvitations.filter(i => 
        i.status === 'pending' && 
        i.role === 'committee' && 
        i.eventId === currentEventId
    );

    const members = [];

    // Add registered users
    committeeParticipations.forEach(p => {
        const user = allUsers.find(u => u.id === p.userId);
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

    // Add pending invites
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

    tbody.innerHTML = members.map(m => `
        <tr>
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td><span class="badge ${m.status === 'registered' ? 'live' : 'waitlist'}">${m.status}</span></td>
            <td>${m.registeredDate}</td>
            <td>
                ${m.type === 'invite' ? 
                    `<button class="btn-sm danger" onclick="revokeInvite('${m.id}', 'committee')">✕ Revoke</button>` : 
                    (canDelete ? `<button class="btn-sm danger" onclick="removeRegisteredMember('${m.participationId}', '${escapeHtml(m.name)}', 'committee')">🗑️ Remove</button>` : '')}
            </td>
        </tr>
    `).join('');
}

function renderJudgesMembers() {
    const tbody = document.getElementById('judges-members-body');
    
    // Find participations with 'judge' role for this event
    const judgesParticipations = allParticipations.filter(p => 
        p.eventId === currentEventId && 
        p.roles?.includes('judge')
    );

    // Find pending invitations for judges
    const pendingInvites = allInvitations.filter(i => 
        i.status === 'pending' && 
        i.role === 'judge' && 
        i.eventId === currentEventId
    );

    const members = [];

    // Add registered users
    judgesParticipations.forEach(p => {
        const user = allUsers.find(u => u.id === p.userId);
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

    // Add pending invites
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

    tbody.innerHTML = members.map(m => `
        <tr>
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td><span class="badge ${m.status === 'registered' ? 'live' : 'waitlist'}">${m.status}</span></td>
            <td>${m.registeredDate}</td>
            <td>
                ${m.type === 'invite' ? 
                    `<button class="btn-sm danger" onclick="revokeInvite('${m.id}', 'judge')">✕ Revoke</button>` : 
                    (canDelete ? `<button class="btn-sm danger" onclick="removeRegisteredMember('${m.participationId}', '${escapeHtml(m.name)}', 'judge')">🗑️ Remove</button>` : '')}
            </td>
        </tr>
    `).join('');
}

// Send invitation
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

    try {
        await API.invitations.create({
            email: email,
            eventId: currentEventId,
            role: role, // 'committee' or 'judge'
            inviterId: currentUser.id,
            inviterName: `${currentUser.firstName} ${currentUser.lastName}`,
            inviterEmail: currentUser.email,
            message: `You've been invited to join as ${role} for ${currentEvent.name}`
        });

        alert(`Invitation sent to ${email}`);
        emailInput.value = '';

        // Clear cached data so reload fetches fresh
        allParticipations = [];

        // Reload the members list
        if (role === 'committee') {
            await loadCommitteeMembers();
        } else {
            await loadJudgesMembers();
        }

    } catch (error) {
        console.error('Error sending invitation:', error);
        alert('Error sending invitation: ' + error.message);
    }
}

// Revoke invitation
async function revokeInvite(inviteId, role) {
    if (!confirm('Are you sure you want to revoke this invitation?')) {
        return;
    }

    try {
        await API.invitations.delete(inviteId);
        
        // Clear cached data so reload fetches fresh
        allParticipations = [];

        // Reload the members list
        if (role === 'committee') {
            await loadCommitteeMembers();
        } else {
            await loadJudgesMembers();
        }

    } catch (error) {
        console.error('Error revoking invitation:', error);
        alert('Error revoking invitation: ' + error.message);
    }
}

async function removeRegisteredMember(participationId, name, role) {
    const roleLabel = role === 'committee' ? 'committee member' : 'judge';
    if (!confirm(`Remove ${roleLabel} "${name}" from this event?\n\nThis will delete their participation record including hotel bookings.`)) {
        return;
    }

    try {
        await API.participations.delete(participationId);
        
        // Clear cached data so reload fetches fresh
        allParticipations = [];
        
        // Reload the members list
        if (role === 'committee') {
            await loadCommitteeMembers();
        } else {
            await loadJudgesMembers();
        }

    } catch (error) {
        console.error('Error removing member:', error);
        alert('Error removing member: ' + error.message);
    }
}

// ===== Interest Leads Management =====
let allLeads = [];
let allSoloQueueForEvent = [];

async function loadInterestLeads() {
    if (!currentEventId) {
        document.getElementById('leads-table-body').innerHTML = 
            '<tr><td colspan="5" class="empty-state">Save the event first to view leads</td></tr>';
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads?eventId=${currentEventId}`);
        if (!response.ok) throw new Error('Failed to load leads');
        
        const data = await response.json();
        allLeads = data.leads || [];

        // Ensure participations, users, teams and solo queue are loaded
        const loaders = [];
        if (allParticipations.length === 0) loaders.push(API.participations.list().then(r => { allParticipations = r; }));
        if (allUsers.length === 0) loaders.push(API.users.list().then(r => { allUsers = r; }));
        if (allTeams.length === 0) loaders.push(
            fetch(`${CONFIG.api.baseUrl}/teams`).then(r => r.json()).then(teams => {
                allTeams = (Array.isArray(teams) ? teams : (teams.teams || [])).filter(t => t.eventId === currentEventId);
            })
        );
        // Always refresh solo queue so it's up to date
        loaders.push(
            fetch(`${CONFIG.api.baseUrl}/solo-queue?eventId=${currentEventId}`)
                .then(r => r.json())
                .then(entries => { allSoloQueueForEvent = Array.isArray(entries) ? entries : []; })
                .catch(() => { allSoloQueueForEvent = []; })
        );
        if (loaders.length > 0) await Promise.all(loaders);

        renderLeadsTable();
    } catch (error) {
        console.error('Error loading leads:', error);
        document.getElementById('leads-table-body').innerHTML = 
            '<tr><td colspan="6" class="empty-state">Error loading leads</td></tr>';
    }
}

function renderLeadsTable() {
    const tbody = document.getElementById('leads-table-body');
    
    if (allLeads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No interest leads yet. Share the interest link to collect leads!</td></tr>';
        return;
    }

    tbody.innerHTML = allLeads.map(lead => {
        const matchedUser = allUsers.find(u => u.email.toLowerCase() === lead.email.toLowerCase());
        const displayFirst = lead.firstName || matchedUser?.firstName || '';
        const displayLast = lead.lastName || matchedUser?.lastName || '';

        // Determine status: Converted > In Queue > Interest
        let statusCell;
        let isConverted = false;
        let convertedDetail = '';

        if (matchedUser) {
            const participation = allParticipations.find(p =>
                p.userId === matchedUser.id && p.eventId === currentEventId
            );
            if (participation) {
                const roles = participation.roles || [];
                const teamMembership = (participation.teamMemberships || []).find(m => m.isParticipant);
                isConverted = roles.includes('committee') || roles.includes('judge') || !!teamMembership;

                if (isConverted) {
                    const team = teamMembership ? allTeams.find(t => t.id === teamMembership.teamId) : null;
                    const teamName = team ? (team.teamName || team.name || '') : '';
                    let roleLabel = 'Participant';
                    if (roles.includes('committee')) roleLabel = 'Committee';
                    else if (roles.includes('judge')) roleLabel = 'Judge';
                    convertedDetail = teamName ? `<br><small style="color:var(--admin-text-muted);">${escapeHtml(teamName)}</small>` : '';
                    statusCell = `<span class="lead-status-pill status-converted">✅ ${roleLabel}</span>${convertedDetail}`;
                }
            }

            if (!isConverted) {
                // Check solo queue
                const inQueue = allSoloQueueForEvent.find(q => q.userId === matchedUser.id);
                if (inQueue) {
                    const pos = allSoloQueueForEvent
                        .sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt))
                        .findIndex(q => q.userId === matchedUser.id) + 1;
                    statusCell = `<span class="lead-status-pill status-queued">🎲 In Queue</span><br><small style="color:var(--admin-text-muted);">Position ${pos} of ${allSoloQueueForEvent.length}</small>`;
                }
            }
        }

        if (!statusCell) {
            statusCell = `<span class="lead-status-pill status-interest">🔔 Interest</span>`;
        }

        return `
        <tr>
            <td><strong>${escapeHtml(displayFirst)} ${escapeHtml(displayLast)}</strong></td>
            <td>${escapeHtml(lead.email)}</td>
            <td>${new Date(lead.verifiedAt || lead.createdAt).toLocaleDateString()}</td>
            <td>${statusCell}</td>
            <td>
                <button class="btn-sm" onclick="restartSequence('${lead.id}')">🔄 Restart Sequence</button>
                <button class="btn-sm danger" onclick="deleteLead('${lead.id}')">🗑️</button>
            </td>
        </tr>
    `;
    }).join('');
}

async function deleteLead(leadId) {
    if (!confirm('Are you sure you want to delete this lead?')) {
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads/${leadId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) throw new Error('Failed to delete lead');
        
        await loadInterestLeads();
    } catch (error) {
        console.error('Error deleting lead:', error);
        alert('Error deleting lead: ' + error.message);
    }
}

async function clearRecipientDeliveries(email) {
    if (!confirm(`Clear all sequence delivery records for ${email}?\n\nThis will NOT resend emails. Use this to remove stale records so the recipient shows as fresh.`)) return;
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
}

async function restartSequence(leadId, userId) {
    if (!confirm('Restart sequence emails for this recipient?\n\nThis will send all unsent sequence emails. Check the browser console for detailed logs.')) return;

    try {
        const payload = leadId ? { leadId } : { userId, eventId: currentEventId };
        console.log('🔄 Restarting sequence for:', payload);
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
        console.log('✅ Sequence restart result:', result);

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

// ===== Teams Management =====
let allTeams = [];

async function loadEventTeams() {
    if (!currentEventId) {
        document.getElementById('teams-table-body').innerHTML = 
            '<tr><td colspan="5" class="empty-state">Save the event first to view teams</td></tr>';
        return;
    }

    try {
        // Load teams for this event
        const response = await fetch(`${CONFIG.api.baseUrl}/teams`);
        if (!response.ok) throw new Error('Failed to load teams');
        
        const teams = await response.json();
        allTeams = teams.filter(t => t.eventId === currentEventId);
        
        // Load participations to get member counts
        const partResponse = await fetch(`${CONFIG.api.baseUrl}/participations/event/${currentEventId}`);
        if (partResponse.ok) {
            allParticipations = await partResponse.json();
        }

        // Load users so we can resolve admin names from participation.userId
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
        // Count team members
        const memberships = allParticipations.filter(p => 
            (p.teamMemberships || []).some(m => m.teamId === team.id && m.isParticipant)
        );
        const memberCount = memberships.length;
        
        // Find team admin
        const adminMembership = allParticipations.find(p =>
            (p.teamMemberships || []).some(m => m.teamId === team.id && m.isAdmin)
        );

        const adminUser = adminMembership ? allUsers.find(u => u.id === adminMembership.userId) : null;
        const adminName = adminUser
            ? `${adminUser.firstName || ''} ${adminUser.lastName || ''}`.trim() || adminUser.email || 'N/A'
            : (adminMembership?.email || 'N/A');
        const teamDisplayName = team.teamName || team.name || 'Unnamed Team';
        const maxMembers = team.numberOfParticipants || team.maxSize || 5;
        const createdDate = new Date(team.createdAt).toLocaleDateString();
        
        return `
            <tr>
                <td><strong>${escapeHtml(teamDisplayName)}</strong></td>
                <td>${escapeHtml(adminName)}</td>
                <td>${memberCount} / ${maxMembers}</td>
                <td>${createdDate}</td>
                <td>
                    <a href="admin-teams.html?team=${team.id}" class="btn-sm" style="text-decoration: none;">View →</a>
                </td>
            </tr>
        `;
    }).join('');
}

// ===== Sponsors Management =====
function formatSponsorAmount(amount) {
    if (amount === null || amount === undefined || amount === '') return '-';
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) return '-';
    const currency = (currentEvent && currentEvent.currency) ? currentEvent.currency : 'NOK';
    return `${numeric.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
}

function resetSponsorForm() {
    const form = document.getElementById('sponsor-form');
    if (!form) return;

    form.reset();
    document.getElementById('sponsor-id').value = '';
    document.getElementById('sponsor-status').value = 'reached-out';
    document.getElementById('sponsor-modal-title').textContent = '➕ Add Sponsor';
    document.getElementById('save-sponsor-btn').textContent = '➕ Add Sponsor';
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
        // Sponsors are category='sponsorship' rows in EventFinancials
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
    const currency = currentEvent?.currency || 'NOK';
    const fmt = (val) => val != null && Number(val) !== 0 ? Number(val).toLocaleString('nb-NO') + ' ' + currency : '—';

    tbody.innerHTML = sponsorRows.map((row) => {
        const status = row.sponsorStatus || 'reached-out';

        const parts = [];
        if (row.contactPerson) parts.push(`<span style="font-weight:600">${escapeHtml(row.contactPerson)}</span>`);
        if (row.phoneNumber)   parts.push(`<span style="color:var(--admin-text-muted);font-size:0.82rem">📞 ${escapeHtml(row.phoneNumber)}</span>`);
        if (row.email)         parts.push(`<a href="mailto:${escapeHtml(row.email)}" style="font-size:0.82rem">✉️ ${escapeHtml(row.email)}</a>`);
        if (row.notes) {
            const preview = row.notes.length > 80 ? row.notes.slice(0, 80) + '…' : row.notes;
            parts.push(`<span style="color:var(--admin-text-muted);font-size:0.8rem;font-style:italic" title="${escapeHtml(row.notes)}">${escapeHtml(preview)}</span>`);
        }
        const contactCell = parts.length ? parts.join('<br>') : '<span style="color:var(--admin-text-muted)">—</span>';

        const statusSelect = `<select class="paidby-select sponsor-status-select ${status}" onchange="saveSponsorStatus('${row.id}', this.value)">
            ${statusOptions.map(o => `<option value="${o.value}"${o.value === status ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>`;

        return `
            <tr>
                <td><strong>${escapeHtml(row.description || '')}</strong></td>
                <td>${contactCell}</td>
                <td>${fmt(row.amount)}</td>
                <td>${statusSelect}</td>
                <td style="white-space:nowrap">
                    <button class="btn-sm" onclick="startEditSponsor('${row.id}')">✏️ Edit</button>
                    <button class="btn-sm danger" onclick="deleteSponsor('${row.id}')">🗑️</button>
                </td>
            </tr>
        `;
    }).join('');
}

function startEditSponsor(sponsorId) {
    const row = (allFinancials || []).find(r => r.id === sponsorId);
    if (!row) return;

    document.getElementById('sponsor-modal-title').textContent = '✏️ Edit Sponsor';
    document.getElementById('sponsor-id').value = sponsorId;
    document.getElementById('sponsor-company-name').value = row.description || '';
    document.getElementById('sponsor-contact-person').value = row.contactPerson || '';
    document.getElementById('sponsor-phone-number').value = row.phoneNumber || '';
    document.getElementById('sponsor-email').value = row.email || '';
    document.getElementById('sponsor-amount').value = row.amount == null || row.amount === 0 ? '' : row.amount;
    document.getElementById('sponsor-status').value = row.sponsorStatus || 'reached-out';
    document.getElementById('sponsor-notes').value = row.notes || '';
    document.getElementById('save-sponsor-btn').textContent = '💾 Update Sponsor';
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
        renderBudgetTable(); // keep budget tab in sync if it was already open
        closeSponsorModal();
    } catch (error) {
        console.error('Error saving sponsor:', error);
        alert(`Error saving sponsor: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
    }
}

async function deleteSponsor(sponsorId) {
    if (!confirm('Delete this sponsor entry?')) return;

    try {
        await API.events.sponsors.delete(currentEventId, sponsorId);
        await loadEventSponsors();
        renderBudgetTable(); // keep budget tab in sync
        const editingId = document.getElementById('sponsor-id').value;
        const modal = document.getElementById('sponsor-modal');
        if (editingId === sponsorId && modal.classList.contains('active')) {
            closeSponsorModal();
        }
    } catch (error) {
        console.error('Error deleting sponsor:', error);
        alert(`Error deleting sponsor: ${error.message}`);
    }
}

async function saveSponsorStatus(sponsorId, status) {
    try {
        await API.events.sponsors.update(currentEventId, sponsorId, { sponsorStatus: status });
        // Refresh allFinancials so status is current in both tabs
        allFinancials = await API.events.financials.list(currentEventId) || [];
        renderSponsorsTable();
        renderBudgetTable();
    } catch (error) {
        console.error('Error updating sponsor status:', error);
        alert(`Error: ${error.message}`);
        renderSponsorsTable(); // revert
    }
}

// ===== Sequence Management =====
function setNoSequenceStateMessage(message, isError = false) {
    const stateEl = document.getElementById('no-sequence-state');
    const descriptionEl = stateEl?.querySelector('p');
    if (!descriptionEl) return;

    descriptionEl.textContent = message;
    descriptionEl.style.color = isError ? '#dc2626' : 'var(--admin-text-muted)';
}

async function loadEventSequence() {
    // Show sequence if it exists, regardless of whether it's currently enabled
    if (!currentEvent || !currentEvent.sequenceId) {
        document.getElementById('no-sequence-state').style.display = 'block';
        document.getElementById('sequence-exists-state').style.display = 'none';
        setNoSequenceStateMessage('Create an email sequence to send automated emails to interest leads for this event.');
        currentEventSequence = null;
        return;
    }

    try {
        const response = await API.sequences.get(currentEvent.sequenceId);
        currentEventSequence = response.sequence;
        currentEventSequence.emails = response.emails || []; // API returns emails separately
        
        document.getElementById('no-sequence-state').style.display = 'none';
        document.getElementById('sequence-exists-state').style.display = 'block';
        setNoSequenceStateMessage('Create an email sequence to send automated emails to interest leads for this event.');
        
        renderSequenceEmails();
    } catch (error) {
        console.error('Failed to load sequence:', error);
        document.getElementById('no-sequence-state').style.display = 'block';
        document.getElementById('sequence-exists-state').style.display = 'none';
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
        container.innerHTML = '<p style="text-align: center; color: var(--admin-text-muted); padding: 40px;">No emails yet. Click "Add Email" to create the first email.</p>';
        document.getElementById('recipient-delivery-overview').style.display = 'none';
        return;
    }

    const emails = currentEventSequence.emails.sort((a, b) => (a.sequenceOrder || a.order || 0) - (b.sequenceOrder || b.order || 0));
    
    // Load delivery stats for all emails
    loadEmailDeliveryStats(emails).then(emailStats => {
        container.innerHTML = emails.map(email => {
            const order = email.sequenceOrder || email.order || 1;
            const statusBadge = email.status === 'live' ? '✅ Live' : '📝 Draft';
            const scheduleText = email.scheduledSendTime 
                ? `⏰ ${new Date(email.scheduledSendTime).toLocaleString()}`
                : '';
            
            // Get delivery stats for this email
            const stats = emailStats[email.id] || { sent: 0, total: 0 };
            const deliveryBadge = stats.total > 0 
                ? `📊 Sent: ${stats.sent}/${stats.total}` 
                : '';
            
            const isLive = email.status === 'live';
            const editButtonText = isLive ? '👁️ View' : '✏️ Edit';
            
            return `
                <div class="email-card">
                    <div class="email-card-header">
                        <div>
                            <div class="email-card-title">#${order}: ${email.subject}</div>
                            <div class="email-card-meta">
                                ${statusBadge} ${scheduleText} ${deliveryBadge}
                            </div>
                        </div>
                        <div class="email-card-actions">
                            ${order > 1 ? `<button class="btn-sm" onclick="moveEmailUp('${email.id}')">↑</button>` : ''}
                            ${order < emails.length ? `<button class="btn-sm" onclick="moveEmailDown('${email.id}')">↓</button>` : ''}
                            <button class="btn-sm" onclick="editSequenceEmailInline('${email.id}')">${editButtonText}</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    });
    
    // Load recipient delivery overview
    loadRecipientDeliveryOverview();
}

async function loadSequenceStatsForEvent() {
    const statsContainer = document.getElementById('sequence-stats-section');
    
    if (!currentEvent) {
        statsContainer.innerHTML = '';
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads?eventId=${currentEvent.id}`);
        if (!response.ok) throw new Error('Failed to load leads');
        
        const data = await response.json();
        const leads = data.leads || [];
        const verifiedCount = leads.filter(l => l.isVerified).length;
        const unverifiedCount = leads.filter(l => !l.isVerified).length;

        statsContainer.innerHTML = `
            <div style="background: var(--admin-bg); padding: 16px; border-radius: 6px; border: 1px solid var(--admin-border);">
                <div style="font-size: 0.85rem; color: var(--admin-text-muted); margin-bottom: 8px;">📊 Sequence Recipients for this Event</div>
                <div style="font-size: 0.9rem; color: var(--admin-sidebar);">
                    ✅ ${verifiedCount} verified leads will receive these emails
                    ${unverifiedCount > 0 ? `<span style="color: var(--admin-text-muted);"> (${unverifiedCount} unverified won't receive)</span>` : ''}
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Failed to load sequence stats:', error);
        statsContainer.innerHTML = '';
    }
}

async function loadEmailDeliveryStats(emails) {
    if (!currentEvent || !emails || emails.length === 0) {
        return {};
    }
    
    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${currentEvent.id}`);
        if (!response.ok) return {};
        
        const data = await response.json();
        const { deliveries, leads, recipients = [] } = data;
        const verifiedLeads = leads.filter(l => l.verified);
        const totalRecipients = verifiedLeads.length + recipients.length;
        
        // Calculate stats for each email — match by email address
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
    
    // Show delivery stats if sequence exists, regardless of whether it's currently enabled
    if (!currentEvent || !currentEvent.sequenceId) {
        overviewSection.style.display = 'none';
        return;
    }
    
    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${currentEvent.id}`);
        if (!response.ok) throw new Error('Failed to load deliveries');
        
        const data = await response.json();
        const { deliveries, leads, recipients = [], campaigns } = data;
        
        if (!campaigns || campaigns.length === 0) {
            overviewSection.style.display = 'none';
            return;
        }
        
        // Show the section
        overviewSection.style.display = 'block';
        
        // Build header with email columns
        const sortedCampaigns = campaigns.sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
        headerEl.innerHTML = `
            <tr>
                <th style="text-align: left;">Recipient</th>
                ${sortedCampaigns.map((c, i) => `<th style="text-align: center;">#${i+1}</th>`).join('')}
                <th style="text-align: center;">Total</th>
                <th style="text-align: center;">Action</th>
            </tr>
        `;
        
        // Get verified leads
        const verifiedLeads = leads.filter(l => l.verified);
        
        // Combine leads and recipients (judges/committee/participants) into unified list
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
            bodyEl.innerHTML = '<tr><td colspan="' + (campaigns.length + 3) + '" style="text-align: center; padding: 20px; color: var(--admin-text-muted);">No recipients yet</td></tr>';
            return;
        }
        
        // Build rows for each recipient
        const rows = allRecipients.map(recipient => {
            // Match deliveries by email (reliable across all recipient types)
            const recipientDeliveries = deliveries.filter(d =>
                d.email?.toLowerCase() === recipient.email.toLowerCase()
            );
            
            // Check each campaign
            const emailStatuses = sortedCampaigns.map(campaign => {
                const campaignId = normalizeId(campaign.id);
                const delivery = recipientDeliveries.find(d => normalizeId(d.campaignId) === campaignId);
                if (!delivery) return { sent: false, symbol: '-', style: 'color: var(--admin-text-muted);' };
                if (delivery.status === 'sent') return { sent: true, symbol: '✓', style: 'color: #10b981;' };
                if (delivery.status === 'failed') return { sent: false, symbol: '✗', style: 'color: #ef4444;' };
                return { sent: false, symbol: '⏳', style: 'color: var(--admin-text-muted);' };
            });
            
            const sentCount = emailStatuses.filter(s => s.sent).length;
            const totalCount = sortedCampaigns.length;
            const completion = totalCount > 0 ? Math.round((sentCount / totalCount) * 100) : 0;
            
            const typeLabels = {
                'interest': '<span style="font-size: 0.75rem; background: #fef3c7; color: #92400e; padding: 1px 6px; border-radius: 3px;">Interest</span>',
                'judge': '<span style="font-size: 0.75rem; background: #ede9fe; color: #6d28d9; padding: 1px 6px; border-radius: 3px;">Judge</span>',
                'committee': '<span style="font-size: 0.75rem; background: #e0e7ff; color: #4338ca; padding: 1px 6px; border-radius: 3px;">Committee</span>',
                'participant': '<span style="font-size: 0.75rem; background: #d1fae5; color: #065f46; padding: 1px 6px; border-radius: 3px;">Participant</span>'
            };
            const typeLabel = typeLabels[recipient.type] ? ' ' + typeLabels[recipient.type] : '';
            
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
        
        // Sort by completion (lowest first to highlight gaps)
        rows.sort((a, b) => a.completion - b.completion);
        
        bodyEl.innerHTML = rows.map(row => `
            <tr>
                <td style="text-align: left;">
                    <div style="font-weight: 500;">${row.name}${row.typeLabel || ''}</div>
                    <div style="font-size: 0.85rem; color: var(--admin-text-muted);">${row.email}</div>
                </td>
                ${row.statuses.map(s => `<td style="text-align: center; ${s.style}">${s.symbol}</td>`).join('')}
                <td style="text-align: center; font-weight: 600;">${row.sentCount}/${row.totalCount}</td>
                <td style="text-align: center;">
                    <div style="display:flex;gap:4px;justify-content:center;">
                    ${row.leadId 
                        ? `<button class="btn-sm" onclick="restartSequence('${row.leadId}')">🔄 Restart</button>` 
                        : `<button class="btn-sm" onclick="restartSequence(null, '${row.userId}')">🔄 Restart</button>`}
                    <button class="btn-sm" style="background:var(--admin-danger,#dc2626);color:#fff;" onclick="clearRecipientDeliveries('${row.email}')">🗑 Clear</button>
                    </div>
                </td>
            </tr>
        `).join('');
        
    } catch (error) {
        console.error('Failed to load recipient delivery overview:', error);
        overviewSection.style.display = 'none';
    }
}

// Create sequence button handler
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('create-sequence-btn')?.addEventListener('click', () => {
        showCreateSequenceModal();
    });
    
    document.getElementById('add-sequence-email-btn')?.addEventListener('click', () => {
        showAddEmailModal();
    });
    
    // Radio button handler for create sequence modal
    document.querySelectorAll('input[name="sequence-create-option"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const copySection = document.getElementById('copy-from-event-section');
            if (e.target.value === 'copy') {
                copySection.style.display = 'block';
                loadEventsWithSequences();
            } else {
                copySection.style.display = 'none';
            }
        });
    });
    
    // Status radio button handler for email modal
    document.querySelectorAll('input[name="edit-email-status"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const scheduleGroup = document.getElementById('edit-email-schedule-group');
            if (e.target.value === 'live') {
                scheduleGroup.style.display = 'block';
                updateSchedulePreviewInline();
            } else {
                scheduleGroup.style.display = 'none';
            }
        });
    });
    
    // Schedule input handler
    document.getElementById('edit-email-schedule')?.addEventListener('input', updateSchedulePreviewInline);
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
        const eventsWithSeq = allEvents.filter(e => e.sequenceId && e.id !== currentEvent.id);
        
        if (eventsWithSeq.length === 0) {
            select.innerHTML = '<option value="">No other events have sequences yet</option>';
            return;
        }
        
        select.innerHTML = '<option value="">Select an event...</option>' + 
            eventsWithSeq.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    } catch (error) {
        console.error('Failed to load events:', error);
        select.innerHTML = '<option value="">Error loading events</option>';
    }
}

async function confirmCreateSequence() {
    const option = document.querySelector('input[name="sequence-create-option"]:checked').value;
    
    try {
        if (option === 'scratch') {
            // Create new empty sequence (1:1 relationship with event, user never sees this)
            const response = await API.sequences.create({
                name: `${currentEvent.name} ${currentEvent.startDate} - ${currentEvent.endDate}`,
                description: `Email sequence for ${currentEvent.name}`,
                emails: []
            });
            
            // Link sequence to event and enable it by default
            await API.events.update(currentEvent.id, {
                sequenceId: response.sequence.id,
                sequenceEnabled: true
            });
            
            currentEvent.sequenceId = response.sequence.id;
            currentEvent.sequenceEnabled = true;
            currentEventSequence = response.sequence;
            
        } else {
            // Copy from another event
            const sourceEventId = document.getElementById('copy-from-event-select').value;
            if (!sourceEventId) {
                alert('Please select an event to copy from');
                return;
            }
            
            const sourceEvent = allEvents.find(e => e.id === sourceEventId);
            if (!sourceEvent || !sourceEvent.sequenceId) {
                alert('Selected event has no sequence');
                return;
            }
            
            // Duplicate the sequence
            const response = await API.sequences.duplicate(sourceEvent.sequenceId);
            
            // Update sequence name for this event
            await API.sequences.update(response.sequence.id, {
                name: `${currentEvent.name} ${currentEvent.startDate} - ${currentEvent.endDate}`,
                description: `Copied from ${sourceEvent.name} ${sourceEvent.startDate} - ${sourceEvent.endDate}`
            });
            
            // Link to current event and enable it by default
            await API.events.update(currentEvent.id, {
                sequenceId: response.sequence.id,
                sequenceEnabled: true
            });
            
            currentEvent.sequenceId = response.sequence.id;
            currentEvent.sequenceEnabled = true;
            
            // Reload the sequence
            const seqResponse = await API.sequences.get(response.sequence.id);
            currentEventSequence = seqResponse.sequence;
        }
        
        closeCreateSequenceModal();
        loadEventSequence();
        
    } catch (error) {
        console.error('Failed to create sequence:', error);
        alert('Failed to create sequence. Please try again.');
    }
}

// Navigate to admin-email.html for adding new sequence email
function showAddEmailModal() {
    const nextOrder = currentEventSequence.emails ? currentEventSequence.emails.length + 1 : 1;
    const url = `admin-email.html?mode=sequence&sequenceId=${currentEventSequence.id}&eventId=${currentEvent.id}&order=${nextOrder}`;
    window.location.href = url;
}

// Navigate to admin-email.html for editing existing sequence email
function editSequenceEmailInline(emailId) {
    const email = currentEventSequence.emails.find(e => e.id === emailId);
    if (!email) return;
    
    const url = `admin-email.html?mode=sequence&sequenceId=${currentEventSequence.id}&eventId=${currentEvent.id}&emailId=${emailId}`;
    window.location.href = url;
}

async function moveEmailUp(emailId) {
    await reorderEmail(emailId, -1);
}

async function moveEmailDown(emailId) {
    await reorderEmail(emailId, 1);
}

async function reorderEmail(emailId, direction) {
    // Sort by current display order (handles null sequenceOrder gracefully)
    const sorted = [...currentEventSequence.emails].sort(
        (a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0)
    );

    const idx = sorted.findIndex(e => e.id === emailId);
    if (idx === -1) return;

    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    // Swap the two elements
    [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];

    try {
        // Update both in parallel with their new 1-based positions
        await Promise.all([
            API.campaigns.update(sorted[idx].id,    { sequenceOrder: idx + 1 }),
            API.campaigns.update(sorted[swapIdx].id, { sequenceOrder: swapIdx + 1 })
        ]);

        // Apply new order locally and re-render immediately (no server round-trip needed)
        sorted[idx].sequenceOrder    = idx + 1;
        sorted[swapIdx].sequenceOrder = swapIdx + 1;
        currentEventSequence.emails = sorted;
        renderSequenceEmails();

    } catch (error) {
        console.error('Failed to reorder emails:', error);
        alert('Failed to reorder emails. Please try again.');
    }
}

console.log('Admin Events page loaded');

// ===== Budget / Financials Management =====

let allFinancials = [];

async function loadEventBudget() {
    const tbody = document.getElementById('budget-table-body');
    if (!currentEventId) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Save the event first to manage budget</td></tr>';
        return;
    }

    // Populate rate fields from currentEvent
    if (currentEvent) {
        document.getElementById('budget-hotel-rate').value = currentEvent.hotelRatePerNight ?? '';
        document.getElementById('budget-hotel-nights').value = currentEvent.hotelNights ?? '';
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
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Error loading budget</td></tr>';
    }
}

function renderBudgetSummary(summary) {
    const fmt = (val) => val != null ? Number(val).toLocaleString('nb-NO', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '0';
    document.getElementById('budget-total-income').textContent = fmt(summary?.totalIncome);
    document.getElementById('budget-total-org-expense').textContent = fmt(summary?.totalOrgExpense);
    document.getElementById('budget-total-participant-expense').textContent = fmt(summary?.totalParticipantExpense);
    const net = summary?.netOrgBalance ?? 0;
    document.getElementById('budget-net-balance').textContent = fmt(net);
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

    const fmt = (val) => val != null ? Number(val).toLocaleString('nb-NO') : '—';
    const currency = currentEvent?.currency || 'NOK';

    const paidBySelect = (row) => {
        const opts = [
            `<option value="participant"${row.paidBy === 'participant' ? ' selected' : ''}>Participant pays</option>`,
            `<option value="event"${row.paidBy === 'event' ? ' selected' : ''}>Event pays</option>`
        ].join('');
        return `<select class="paidby-select" onchange="savePaidBy('${row.id}', this.value)">${opts}</select>`;
    };

    const typeLabel = (row) => row.type === 'income'
        ? '<span style="color:#166534;font-size:0.75rem;font-weight:700;">INCOME</span>'
        : '<span style="color:#991b1b;font-size:0.75rem;font-weight:700;">EXPENSE</span>';

    const amountCell = (row) => {
        const sign = row.type === 'income' ? '+' : '−';
        const cls = row.type === 'income' ? 'financial-amount-income' : 'financial-amount-expense';
        return `<span class="${cls}">${sign}${fmt(row.amount)} ${currency}</span>`;
    };

    const actionCell = (row) => {
        if (row.source === 'manual') {
            return `<button class="btn-sm" onclick="startEditFinancial('${row.id}')">✏️</button>
                    <button class="btn-sm danger" onclick="deleteFinancialRow('${row.id}')">🗑️</button>`;
        }
        return `<span style="color:var(--admin-text-muted);font-size:0.75rem;">auto</span>`;
    };

    const descCell = (row) => {
        let desc = escapeHtml(row.description || '');
        if (row.unitCost != null && row.days != null) {
            desc += `<span style="color:var(--admin-text-muted);font-size:0.75rem;margin-left:6px;">(${fmt(row.unitCost)} × ${row.days})</span>`;
        }
        // Show status badge for non-confirmed sponsor rows
        if (row.category === 'sponsorship' && row.sponsorStatus && row.sponsorStatus !== 'confirmed') {
            const statusColors = { 'reached-out': '#64748b', negotiating: '#d97706', declined: '#dc2626' };
            const color = statusColors[row.sponsorStatus] || '#64748b';
            desc += ` <span style="color:${color};font-size:0.75rem;font-style:italic;white-space:nowrap">(${row.sponsorStatus})</span>`;
        }
        return desc;
    };

    const dataRow = (row) => `
        <tr class="${row.source === 'auto' ? 'financial-auto-row' : ''}">
            <td>${typeLabel(row)}</td>
            <td>${escapeHtml(row.category || '')}</td>
            <td>${descCell(row)}</td>
            <td>${amountCell(row)}</td>
            <td>${paidBySelect(row)}</td>
            <td style="white-space:nowrap;">${actionCell(row)}</td>
        </tr>`;

    // Split into participant groups and event-level rows
    const participantMap = new Map(); // participationId -> { email, roles, rows[] }
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
        return `<span class="${cls}">${sign}${fmt(Math.abs(net))} ${currency}</span>`;
    };

    let html = '';

    // Participant groups
    for (const [, group] of participantMap) {
        const roleLabel = group.roles ? ` — ${escapeHtml(group.roles)}` : '';
        html += `<tr class="budget-group-header">
            <td colspan="6">👤 ${escapeHtml(group.email)}${roleLabel}
                <span class="budget-group-total">Net: ${groupTotal(group.rows)}</span>
            </td>
        </tr>`;
        html += group.rows.map(dataRow).join('');
    }

    // Event-level rows (sponsorships, venue, etc.)
    if (eventRows.length > 0) {
        html += `<tr class="budget-group-header">
            <td colspan="6">🏢 Event-level rows
                <span class="budget-group-total">Net: ${groupTotal(eventRows)}</span>
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
    document.getElementById('financial-modal-title').textContent = '➕ Add Financial Row';
    document.getElementById('financial-id').value = '';
    document.getElementById('financial-form').reset();
    document.getElementById('save-financial-btn').textContent = '➕ Add Row';
    document.getElementById('financial-modal').classList.add('active');
    toggleFinancialPaidBy();
}

function closeFinancialModal() {
    document.getElementById('financial-modal').classList.remove('active');
}

function toggleFinancialPaidBy() {
    const type = document.getElementById('financial-type').value;
    document.getElementById('financial-paidby-group').style.display = type === 'expense' ? '' : 'none';
}

function startEditFinancial(rowId) {
    const row = allFinancials.find(r => r.id === rowId);
    if (!row) return;

    document.getElementById('financial-modal-title').textContent = '✏️ Edit Financial Row';
    document.getElementById('financial-id').value = row.id;
    document.getElementById('financial-type').value = row.type;
    document.getElementById('financial-category').value = row.category;
    document.getElementById('financial-description').value = row.description || '';
    document.getElementById('financial-amount').value = row.amount;
    document.getElementById('financial-unit-cost').value = row.unitCost ?? '';
    document.getElementById('financial-days').value = row.days ?? '';
    document.getElementById('financial-paid-by').value = row.paidBy || 'event';
    document.getElementById('financial-notes').value = row.notes || '';
    document.getElementById('save-financial-btn').textContent = '💾 Update Row';
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
        unitCost: document.getElementById('financial-unit-cost').value !== '' ? parseFloat(document.getElementById('financial-unit-cost').value) : null,
        days: document.getElementById('financial-days').value !== '' ? parseInt(document.getElementById('financial-days').value, 10) : null,
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

async function deleteFinancialRow(rowId) {
    if (!confirm('Delete this financial row?')) return;
    try {
        await API.events.financials.delete(currentEventId, rowId);
        await loadEventBudget();
    } catch (error) {
        console.error('Error deleting financial row:', error);
        alert(`Error deleting row: ${error.message}`);
    }
}

async function savePaidBy(rowId, paidBy) {
    try {
        await API.events.financials.patchPaidBy(currentEventId, rowId, paidBy);
        // Update local cache and re-render summary without full reload
        const row = allFinancials.find(r => r.id === rowId);
        if (row) row.paidBy = paidBy;
        const summary = await API.events.financials.summary(currentEventId);
        renderBudgetSummary(summary);
    } catch (error) {
        console.error('Error updating paidBy:', error);
        alert(`Error: ${error.message}`);
        // Re-render to restore original value in the dropdown
        renderBudgetTable();
    }
}

async function recalculateFinancials() {
    if (!currentEventId) return;

    const btn = document.getElementById('recalculate-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Recalculating...';

    try {
        const result = await API.events.financials.recalculate(currentEventId);
        await loadEventBudget();

        const errMsg = result.errors && result.errors.length
            ? `\n\n${result.errors.length} participant(s) had errors.`
            : '';
        alert(`✅ Recalculated ${result.updated} of ${result.total} participants.${errMsg}`);
    } catch (error) {
        console.error('Recalculate failed:', error);
        alert(`Error recalculating: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = '♻️ Recalculate';
    }
}

async function saveEventRates() {
    if (!currentEventId) return;
    const hotelRate   = document.getElementById('budget-hotel-rate').value;
    const hotelNights = document.getElementById('budget-hotel-nights').value;
    const foodRate    = document.getElementById('budget-food-rate').value;
    const foodDays    = document.getElementById('budget-food-days').value;

    const payload = {
        hotelRatePerNight: hotelRate   !== '' ? parseFloat(hotelRate)   : null,
        hotelNights:       hotelNights !== '' ? parseInt(hotelNights, 10) : null,
        foodRatePerDay:    foodRate    !== '' ? parseFloat(foodRate)    : null,
        foodDays:          foodDays    !== '' ? parseInt(foodDays, 10)  : null
    };

    try {
        const updated = await API.events.update(currentEventId, payload);
        if (updated) {
            currentEvent = { ...currentEvent, ...payload };
        }
        alert('Rates saved. Auto rows will update on next participation sync.');
    } catch (error) {
        console.error('Error saving rates:', error);
        alert(`Error saving rates: ${error.message}`);
    }
}

function updateRatePreview(type) {
    const currency = currentEvent?.currency || 'NOK';
    if (type === 'hotel') {
        const rate = parseFloat(document.getElementById('budget-hotel-rate').value) || 0;
        const nights = parseInt(document.getElementById('budget-hotel-nights').value, 10) || 0;
        const el = document.getElementById('hotel-rate-preview');
        if (el) el.textContent = rate && nights ? `= ${(rate * nights).toLocaleString('nb-NO')} ${currency}` : '';
    } else {
        const rate = parseFloat(document.getElementById('budget-food-rate').value) || 0;
        const days = parseInt(document.getElementById('budget-food-days').value, 10) || 0;
        const el = document.getElementById('food-rate-preview');
        if (el) el.textContent = rate && days ? `= ${(rate * days).toLocaleString('nb-NO')} ${currency}` : '';
    }
}
