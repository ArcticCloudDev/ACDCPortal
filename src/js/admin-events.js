// ACDC Portal - Admin Events Management

let currentUser = null;
let allEvents = [];
let editingEventId = null;
let currentStatus = 'draft';

// Status workflow - defines valid transitions
const STATUS_ORDER = ['draft', 'waitlist', 'registration', 'live'];
const STATUS_LABELS = {
    draft: '📝 Draft',
    waitlist: '📋 Waiting List',
    registration: '✅ Registration Open',
    live: '🚀 Live'
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

        // Setup event listeners
        setupEventListeners();

        // Check for action in URL
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('action') === 'create') {
            showForm();
        } else if (urlParams.get('edit')) {
            const eventId = urlParams.get('edit');
            editEvent(eventId);
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
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.addEventListener('click', () => handleStatusChange(btn.dataset.status));
    });

    // Tab navigation
    setupTabs();

    // Invitation buttons
    document.getElementById('invite-committee-btn').addEventListener('click', () => sendInvitation('committee'));
    document.getElementById('invite-judge-btn').addEventListener('click', () => sendInvitation('judge'));
}

function updateStatusUI(status) {
    currentStatus = status;
    document.getElementById('event-status').value = status;
    
    // Update button states
    document.querySelectorAll('.status-btn').forEach(btn => {
        const btnStatus = btn.dataset.status;
        btn.classList.remove('current', 'available');
        
        if (btnStatus === status) {
            btn.classList.add('current');
        } else if (canTransitionTo(status, btnStatus)) {
            btn.classList.add('available');
        }
    });
    
    // Update help text
    const helpText = document.getElementById('status-help');
    
    if (status === 'draft') {
        helpText.textContent = 'Event is in draft mode. Only visible to committee members.';
    } else if (status === 'waitlist') {
        helpText.textContent = 'Waiting list is open. People can express interest but not fully register yet.';
    } else if (status === 'registration') {
        helpText.textContent = 'Registration is open. Participants can create teams and register.';
    } else if (status === 'live') {
        helpText.textContent = 'Event is live! No new registrations allowed.';
    }
}

function handleStatusChange(newStatus) {
    if (!canTransitionTo(currentStatus, newStatus)) {
        const direction = STATUS_ORDER.indexOf(newStatus) > STATUS_ORDER.indexOf(currentStatus) ? 'forward' : 'back';
        alert(`You can only move one step ${direction} at a time. Current status: ${STATUS_LABELS[currentStatus]}`);
        return;
    }
    
    // Confirm status change
    const confirmMsg = `Change status from "${STATUS_LABELS[currentStatus]}" to "${STATUS_LABELS[newStatus]}"?`;
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
    const form = document.getElementById('event-form');

    // Disable committee/judges tabs for new events
    if (event) {
        committeeTab.disabled = false;
        judgesTab.disabled = false;
    } else {
        committeeTab.disabled = true;
        judgesTab.disabled = true;
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

function hideForm() {
    document.getElementById('events-list-view').classList.remove('hidden');
    document.getElementById('event-form-view').classList.add('hidden');
    editingEventId = null;
    currentEventId = null; // Clear current event ID
    currentEvent = null; // Clear current event object
    
    // Clear URL params
    window.history.replaceState({}, '', 'admin-events.html');
}

function editEvent(eventId) {
    const event = allEvents.find(e => e.id === eventId);
    if (event) {
        currentEventId = eventId; // Set current event ID for committee/judges tabs
        currentEvent = event; // Set full event object
        showForm(event);
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
            status: document.getElementById('event-status').value || 'draft'
        };
        
        // Only include team size if team type
        if (registrationType === 'team') {
            eventData.minTeamSize = parseInt(document.getElementById('min-team-size').value) || 3;
            eventData.maxTeamSize = parseInt(document.getElementById('max-team-size').value) || 5;
        }
        
        // Derive registrationOpen from status for backwards compatibility
        eventData.registrationOpen = eventData.status === 'registration';

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
            
            // If this is a new event, enable the committee/judges tabs
            if (!eventId) {
                document.getElementById('committee-tab-btn').disabled = false;
                document.getElementById('judges-tab-btn').disabled = false;
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
            
            // Load data for committee/judges tabs when opened
            if (targetTab === 'committee') {
                loadCommitteeMembers();
            } else if (targetTab === 'judges') {
                loadJudgesMembers();
            }
        });
    });
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

console.log('Admin Events page loaded');
