// ACDC Portal - Admin Events Management

let currentUser = null;
let allEvents = [];
let allSequences = [];
let allCampaigns = [];
let editingEventId = null;
let currentStatus = 'draft';
let currentEventSequence = null;
let emailEditor = null;

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
    const notCommitteeDiv = document.getElementById('not-committee');
    const adminContent = document.getElementById('admin-content');

    // Initialize Auth
    Auth.init();
    renderAdminSidebar('events');

    try {
        await Auth.handleRedirect();

        if (!Auth.isLoggedIn()) {
            window.location.href = '/login.html';
            return;
        }

        const authUser = Auth.getUser();
        currentUser = await API.users.get(authUser.email);

        if (!currentUser.isPortalAdmin) {
            loadingDiv.classList.add('hidden');
            notCommitteeDiv.classList.remove('hidden');
            return;
        }

        // Load events
        await loadEvents();
        await loadSequences();
        await loadCampaigns();

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
        adminContent.classList.remove('hidden');

    } catch (error) {
        console.error('Error:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error: ${error.message}</p>`;
    }
});

async function loadEvents() {
    try {
        allEvents = await API.events.list();
        renderEventsList();
    } catch (error) {
        console.error('Error loading events:', error);
    }
}

async function loadSequences() {
    try {
        const response = await API.sequences.list();
        allSequences = response.sequences || [];
        populateSequencesDropdown();
    } catch (err) {
        console.error('Failed to load sequences:', err);
    }
}

async function loadCampaigns() {
    try {
        const response = await API.campaigns.list();
        allCampaigns = response.campaigns || [];
        populateCampaignsDropdown();
    } catch (err) {
        console.error('Failed to load campaigns:', err);
    }
}

function populateSequencesDropdown() {
    const select = document.getElementById('event-sequence');
    if (!select) return;
    select.innerHTML = '<option value="">No sequence (no automated emails)</option>';
    allSequences.forEach(seq => {
        select.innerHTML += `<option value="${seq.id}">${seq.name}</option>`;
    });
}

function populateCampaignsDropdown() {
    const select = document.getElementById('event-team-welcome-email');
    if (!select) return;
    select.innerHTML = '<option value="">No welcome email</option>';
    allCampaigns.forEach(campaign => {
        select.innerHTML += `<option value="${campaign.id}">${campaign.subject}</option>`;
    });
}

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
        const startDate = new Date(event.startDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
        const endDate = new Date(event.endDate).toLocaleDateString('en-US', {
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
    const form = document.getElementById('event-form');

    // Disable committee/judges/leads tabs for new events
    if (event) {
        committeeTab.disabled = false;
        judgesTab.disabled = false;
        leadsTab.disabled = false;
    } else {
        committeeTab.disabled = true;
        judgesTab.disabled = true;
        leadsTab.disabled = true;
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
        document.getElementById('event-file-categories').value = (event.fileCategories || []).join(', ');
        document.getElementById('event-sequence').value = event.sequenceId || '';
        document.getElementById('event-team-welcome-email').value = event.teamWelcomeEmailId || '';
        
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

function updateURL() {
    if (currentEventId) {
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'general';
        window.history.replaceState({}, '', `admin-events.html?event=${currentEventId}&tab=${activeTab}`);
    } else {
        window.history.replaceState({}, '', 'admin-events.html');
    }
}

function hideForm() {
    document.getElementById('events-list-view').classList.remove('hidden');
    document.getElementById('event-form-view').classList.add('hidden');
    editingEventId = null;
    currentEventId = null;
    currentEvent = null;
    
    // Clear URL params
    window.history.replaceState({}, '', 'admin-events.html');
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
            sequenceId: document.getElementById('event-sequence').value || null,
            teamWelcomeEmailId: document.getElementById('event-team-welcome-email').value || null,
            fileCategories: document.getElementById('event-file-categories').value
                .split(',')
                .map(c => c.trim())
                .filter(c => c.length > 0)
        };
        
        // Only include team size if team type
        if (registrationType === 'team') {
            eventData.minTeamSize = parseInt(document.getElementById('min-team-size').value) || 3;
            eventData.maxTeamSize = parseInt(document.getElementById('max-team-size').value) || 5;
        }

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
            
            // If this is a new event, enable the committee/judges/leads tabs
            if (!eventId) {
                document.getElementById('committee-tab-btn').disabled = false;
                document.getElementById('judges-tab-btn').disabled = false;
                document.getElementById('leads-tab-btn').disabled = false;
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
            } else if (targetTab === 'teams') {
                loadEventTeams();
            } else if (targetTab === 'deliveries') {
                loadDeliveries();
            } else if (targetTab === 'sequence') {
                loadEventSequence();
            }
        });
    });
    
    // Leads tab button handlers
    document.getElementById('copy-interest-link')?.addEventListener('click', copyInterestLink);
    document.getElementById('export-leads-btn')?.addEventListener('click', exportLeadsCSV);
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

    if (!currentEvent.committeeTeamId) {
        document.getElementById('committee-members-body').innerHTML = 
            '<tr><td colspan="5" class="empty-state">Committee team not available for this event</td></tr>';
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

    if (!currentEvent.judgesTeamId) {
        document.getElementById('judges-members-body').innerHTML = 
            '<tr><td colspan="5" class="empty-state">Judges team not available for this event</td></tr>';
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
    
    if (!currentEvent?.committeeTeamId) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Committee team not available</td></tr>';
        return;
    }
    
    // Find participations for the committee team
    const committeeParticipations = allParticipations.filter(p => 
        p.eventId === currentEventId && 
        p.teamMemberships?.some(tm => tm.teamId === currentEvent.committeeTeamId)
    );

    // Find pending invitations for the committee team
    const pendingInvites = allInvitations.filter(i => 
        i.teamId === currentEvent.committeeTeamId &&
        i.status === 'pending'
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
                id: user.id
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

    tbody.innerHTML = members.map(m => `
        <tr>
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td><span class="badge ${m.status === 'registered' ? 'live' : 'waitlist'}">${m.status}</span></td>
            <td>${m.registeredDate}</td>
            <td>
                ${m.type === 'invite' ? 
                    `<button class="btn-sm danger" onclick="revokeInvite('${m.id}', 'committee')">✕ Revoke</button>` : 
                    ''}
            </td>
        </tr>
    `).join('');
}

function renderJudgesMembers() {
    const tbody = document.getElementById('judges-members-body');
    
    if (!currentEvent?.judgesTeamId) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Judges team not available</td></tr>';
        return;
    }
    
    // Find participations for the judges team
    const judgesParticipations = allParticipations.filter(p => 
        p.eventId === currentEventId && 
        p.teamMemberships?.some(tm => tm.teamId === currentEvent.judgesTeamId)
    );

    // Find pending invitations for the judges team
    const pendingInvites = allInvitations.filter(i => 
        i.teamId === currentEvent.judgesTeamId &&
        i.status === 'pending'
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
                id: user.id
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

    tbody.innerHTML = members.map(m => `
        <tr>
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td><span class="badge ${m.status === 'registered' ? 'live' : 'waitlist'}">${m.status}</span></td>
            <td>${m.registeredDate}</td>
            <td>
                ${m.type === 'invite' ? 
                    `<button class="btn-sm danger" onclick="revokeInvite('${m.id}', 'judge')">✕ Revoke</button>` : 
                    ''}
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

    const teamId = role === 'committee' ? currentEvent.committeeTeamId : currentEvent.judgesTeamId;
    
    if (!teamId) {
        alert(`${role === 'committee' ? 'Committee' : 'Judges'} team not available for this event`);
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
            teamId: teamId,
            inviterId: currentUser.id,
            inviterName: `${currentUser.firstName} ${currentUser.lastName}`,
            inviterEmail: currentUser.email,
            message: `You've been invited to join as ${role} for ${currentEvent.name}`
        });

        alert(`Invitation sent to ${email}`);
        emailInput.value = '';

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

// ===== Interest Leads Management =====
let allLeads = [];

async function loadInterestLeads() {
    if (!currentEventId) {
        document.getElementById('leads-table-body').innerHTML = 
            '<tr><td colspan="5" class="empty-state">Save the event first to view leads</td></tr>';
        return;
    }

    // Set the interest link
    const baseUrl = window.location.origin;
    const interestLink = `${baseUrl}/interest.html?event=${currentEventId}`;
    document.getElementById('interest-link').value = interestLink;

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads?eventId=${currentEventId}`);
        if (!response.ok) throw new Error('Failed to load leads');
        
        const data = await response.json();
        allLeads = data.leads || [];
        renderLeadsTable();
    } catch (error) {
        console.error('Error loading leads:', error);
        document.getElementById('leads-table-body').innerHTML = 
            '<tr><td colspan="5" class="empty-state">Error loading leads</td></tr>';
    }
}

function renderLeadsTable() {
    const tbody = document.getElementById('leads-table-body');
    
    if (allLeads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No interest leads yet. Share the interest link to collect leads!</td></tr>';
        return;
    }

    tbody.innerHTML = allLeads.map(lead => `
        <tr>
            <td><strong>${escapeHtml(lead.firstName)} ${escapeHtml(lead.lastName)}</strong></td>
            <td>${escapeHtml(lead.email)}</td>
            <td>${new Date(lead.verifiedAt || lead.createdAt).toLocaleDateString()}</td>
            <td>
                <button class="btn-sm" onclick="restartSequence('${lead.id}')">🔄 Restart Sequence</button>
                <button class="btn-sm danger" onclick="deleteLead('${lead.id}')">🗑️</button>
            </td>
        </tr>
    `).join('');
}

function copyInterestLink() {
    const linkInput = document.getElementById('interest-link');
    linkInput.select();
    document.execCommand('copy');
    
    const btn = document.getElementById('copy-interest-link');
    const originalText = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = originalText, 2000);
}

function exportLeadsCSV() {
    if (allLeads.length === 0) {
        alert('No leads to export');
        return;
    }

    const headers = ['First Name', 'Last Name', 'Email', 'Registered Date'];
    const rows = allLeads.map(lead => [
        lead.firstName,
        lead.lastName,
        lead.email,
        new Date(lead.verifiedAt || lead.createdAt).toISOString().split('T')[0]
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interest-leads-${currentEventId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

async function restartSequence(leadId) {
    if (!confirm('Restart sequence emails for this lead?\n\nThis will send all unsent sequence emails. Check the browser console for detailed logs.')) return;

    try {
        console.log('🔄 Restarting sequence for lead:', leadId);
        const response = await fetch(`${CONFIG.api.baseUrl}/interest/restart-sequence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leadId })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to restart sequence');
        }

        const result = await response.json();
        console.log('✅ Sequence restart result:', result);
        alert(`Sequence restarted successfully!\n${result.sent || 0} email(s) sent.\n\nCheck the browser console and server terminal for detailed logs.`);
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
        
        const adminName = adminMembership ? `${adminMembership.firstName} ${adminMembership.lastName}` : 'N/A';
        const createdDate = new Date(team.createdAt).toLocaleDateString();
        
        return `
            <tr>
                <td><strong>${escapeHtml(team.name)}</strong></td>
                <td>${escapeHtml(adminName)}</td>
                <td>${memberCount} / ${team.maxSize || 5}</td>
                <td>${createdDate}</td>
                <td>
                    <a href="admin-teams.html?team=${team.id}" class="btn-sm" style="text-decoration: none;">View →</a>
                </td>
            </tr>
        `;
    }).join('');
}

// ===== Sequence Management =====
async function loadEventSequence() {
    if (!currentEvent || !currentEvent.sequenceId) {
        document.getElementById('no-sequence-state').style.display = 'block';
        document.getElementById('sequence-exists-state').style.display = 'none';
        currentEventSequence = null;
        return;
    }

    try {
        const response = await API.sequences.get(currentEvent.sequenceId);
        currentEventSequence = response.sequence;
        currentEventSequence.emails = response.emails || []; // API returns emails separately
        
        document.getElementById('no-sequence-state').style.display = 'none';
        document.getElementById('sequence-exists-state').style.display = 'block';
        
        renderSequenceEmails();
        loadSequenceStatsForEvent();
    } catch (error) {
        console.error('Failed to load sequence:', error);
        document.getElementById('no-sequence-state').style.display = 'block';
        document.getElementById('sequence-exists-state').style.display = 'none';
    }
}

function renderSequenceEmails() {
    const container = document.getElementById('sequence-emails-list');
    
    if (!currentEventSequence || !currentEventSequence.emails || currentEventSequence.emails.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--admin-text-muted); padding: 40px;">No emails yet. Click "Add Email" to create the first email.</p>';
        return;
    }

    const emails = currentEventSequence.emails.sort((a, b) => (a.sequenceOrder || a.order || 0) - (b.sequenceOrder || b.order || 0));
    
    container.innerHTML = emails.map(email => {
        const order = email.sequenceOrder || email.order || 1;
        const statusBadge = email.status === 'live' ? '✅ Live' : '📝 Draft';
        const scheduleText = email.scheduledSendTime 
            ? `⏰ Scheduled: ${new Date(email.scheduledSendTime).toLocaleString()}`
            : '';
        
        return `
            <div class="email-card">
                <div class="email-card-header">
                    <div>
                        <div class="email-card-title">#${order}: ${email.subject}</div>
                        <div class="email-card-meta">
                            ${statusBadge} ${scheduleText}
                        </div>
                    </div>
                    <div class="email-card-actions">
                        ${order > 1 ? `<button class="btn-sm" onclick="moveEmailUp('${email.id}')">↑</button>` : ''}
                        ${order < emails.length ? `<button class="btn-sm" onclick="moveEmailDown('${email.id}')">↓</button>` : ''}
                        <button class="btn-sm" onclick="editSequenceEmailInline('${email.id}')">✏️ Edit</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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
            // Create new empty sequence
            const response = await API.sequences.create({
                name: `${currentEvent.name} - Email Sequence`,
                description: `Automated email sequence for ${currentEvent.name}`,
                emails: []
            });
            
            // Link sequence to event
            await API.events.update(currentEvent.id, {
                sequenceId: response.sequence.id
            });
            
            currentEvent.sequenceId = response.sequence.id;
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
            
            // Rename it for this event
            await API.sequences.update(response.sequence.id, {
                name: `${currentEvent.name} - Email Sequence (copied from ${sourceEvent.name})`
            });
            
            // Link to current event
            await API.events.update(currentEvent.id, {
                sequenceId: response.sequence.id
            });
            
            currentEvent.sequenceId = response.sequence.id;
            
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
    const email = currentEventSequence.emails.find(e => e.id === emailId);
    if (!email) return;
    
    const newOrder = email.order + direction;
    const emails = [...currentEventSequence.emails];
    const otherEmail = emails.find(e => e.order === newOrder);
    
    if (!otherEmail) return;
    
    try {
        // Swap orders
        await API.sequences.updateEmail(currentEventSequence.id, email.id, { order: newOrder });
        await API.sequences.updateEmail(currentEventSequence.id, otherEmail.id, { order: email.order });
        
        // Reload sequence
        const response = await API.sequences.get(currentEventSequence.id);
        currentEventSequence = response.sequence;
        renderSequenceEmails();
        
    } catch (error) {
        console.error('Failed to reorder emails:', error);
        alert('Failed to reorder emails. Please try again.');
    }
}

console.log('Admin Events page loaded');
