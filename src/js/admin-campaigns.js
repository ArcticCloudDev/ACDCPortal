// Admin Campaigns - New Sequences Structure
let quill;
let allSequences = [];
let allEvents = [];
let currentSequence = null;
let currentSequenceId = null;
let currentEmails = [];
let copyingSequenceId = null;

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function init() {
    Auth.init();
    renderAdminSidebar('campaigns');
    await Auth.handleRedirect();

    if (!Auth.isLoggedIn()) {
        window.location.href = '/login.html';
        return;
    }

    // Initialize Quill editor
    quill = new Quill('#editor', {
        theme: 'snow',
        modules: {
            toolbar: [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                ['link', 'image'],
                ['clean']
            ],
            imageResize: {},
            imageDrop: true
        }
    });

    // Load data
    await loadEvents();
    await loadSequences();
    
    // Check for sequence in URL
    const urlParams = new URLSearchParams(window.location.search);
    const sequenceId = urlParams.get('sequence');
    if (sequenceId) {
        showSequenceDetail(sequenceId);
    }
}

async function loadEvents() {
    try {
        const response = await API.events.list();
        allEvents = response.events || response || [];
    } catch (err) {
        console.error('Failed to load events:', err);
    }
}

async function loadSequences() {
    try {
        const response = await API.sequences.list();
        allSequences = response.sequences || [];
        
        // Get all campaigns to count emails per sequence
        const campaignsResponse = await API.campaigns.list();
        const allCampaigns = campaignsResponse.campaigns || [];
        
        // Load stats for each sequence
        for (const seq of allSequences) {
            // Count emails
            seq.emailCount = allCampaigns.filter(c => c.sequenceId === seq.id).length;
            // Load delivery stats
            seq.stats = await getSequenceStats(seq.id);
        }
        
        renderSequences();
    } catch (err) {
        console.error('Failed to load sequences:', err);
    }
}

async function getSequenceStats(sequenceId) {
    try {
        // Get campaigns for this sequence
        const campaignsResponse = await API.campaigns.list();
        const campaigns = campaignsResponse.campaigns || [];
        const sequenceCampaigns = campaigns.filter(c => c.sequenceId === sequenceId);
        
        if (sequenceCampaigns.length === 0) {
            return { sent: 0, failed: 0 };
        }
        
        // Get events using this sequence to fetch deliveries
        const eventsUsingSequence = allEvents.filter(e => e.sequenceId === sequenceId);
        
        if (eventsUsingSequence.length === 0) {
            return { sent: 0, failed: 0 };
        }
        
        // Fetch deliveries for all events
        let totalSent = 0;
        let totalFailed = 0;
        
        for (const event of eventsUsingSequence) {
            try {
                const deliveriesResponse = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${event.id}`);
                if (deliveriesResponse.ok) {
                    const data = await deliveriesResponse.json();
                    const deliveries = data.deliveries || [];
                    
                    totalSent += deliveries.filter(d => d.status === 'sent').length;
                    totalFailed += deliveries.filter(d => d.status === 'failed').length;
                }
            } catch (err) {
                console.error(`Failed to load deliveries for event ${event.id}:`, err);
            }
        }
        
        return { sent: totalSent, failed: totalFailed };
    } catch (err) {
        console.error('Failed to get sequence stats:', err);
        return { sent: 0, failed: 0 };
    }
}

function renderSequences() {
    const container = document.getElementById('sequences-list');
    
    if (allSequences.length === 0) {
        container.innerHTML = '<div class="empty-state">No sequences yet. Click "New Sequence" to create one!</div>';
        return;
    }
    
    container.innerHTML = allSequences.map(seq => {
        const createdDate = new Date(seq.createdAt).toLocaleDateString();
        
        return `
            <div class="sequence-card">
                <div class="sequence-header" onclick="showSequenceDetail('${seq.id}')">
                    <div class="sequence-info">
                        <h3>${escapeHtml(seq.name)}</h3>
                        <div class="sequence-meta">
                            ${seq.emailCount || 0} email${(seq.emailCount || 0) !== 1 ? 's' : ''} • 
                            ${seq.stats?.sent || 0} sent • 
                            ${seq.stats?.failed || 0} failed • 
                            Created ${createdDate}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Show/Hide Views
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
        
        // Load recipient statistics
        await loadSequenceStats(sequenceId);
        
        document.getElementById('detail-sequence-name').textContent = currentSequence.name;
        document.getElementById('detail-sequence-meta').textContent = 
            `${currentEmails.length} email${currentEmails.length !== 1 ? 's' : ''}`;
        
        renderEmails();
        showView('sequence-detail');
        window.history.replaceState({}, '', `admin-campaigns.html?sequence=${sequenceId}`);
    } catch (err) {
        console.error('Failed to load sequence:', err);
        alert('Failed to load sequence details');
    }
}

async function loadSequenceStats(sequenceId) {
    try {
        console.log('[STATS] Loading stats for sequence:', sequenceId);
        
        // Get all events - API returns array directly, not { events: [] }
        const events = await API.events.list();
        const eventsList = Array.isArray(events) ? events : (events.events || []);
        console.log('[STATS] All events:', eventsList.length);
        
        // Find events using this sequence
        const eventsUsingSequence = eventsList.filter(e => e.sequenceId === sequenceId);
        console.log('[STATS] Events using this sequence:', eventsUsingSequence.length, eventsUsingSequence);
        
        if (eventsUsingSequence.length === 0) {
            document.getElementById('sequence-stats').innerHTML = 
                `<p style="color: var(--admin-text-muted); font-size: 0.9rem;">
                    This sequence is not assigned to any events yet. 
                    <strong>Assign it to exactly one event</strong> to start sending emails to interest leads.
                </p>`;
            return;
        }
        
        // Get all interest leads
        const leadsResponse = await fetch(`${CONFIG.api.baseUrl}/interest/leads?verified=false`);
        const leadsData = await leadsResponse.json();
        const allLeads = leadsData.leads || [];
        console.log('[STATS] All leads:', allLeads.length, allLeads);
        
        // Get all team members
        const teamsResponse = await API.teams.list();
        const teams = teamsResponse.teams || [];
        console.log('[STATS] All teams:', teams.length);
        
        // Count recipients per event
        let totalInterestLeads = 0;
        let verifiedInterestLeads = 0;
        let totalTeamMembers = 0;
        
        const eventStats = eventsUsingSequence.map(event => {
            const eventLeads = allLeads.filter(l => l.eventId === event.id);
            const verifiedLeads = eventLeads.filter(l => l.verified);
            const eventTeams = teams.filter(t => t.eventId === event.id);
            const teamMemberCount = eventTeams.reduce((sum, t) => sum + (t.members?.length || 0), 0);
            
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
        
        console.log('[STATS] Event stats:', eventStats);
        console.log('[STATS] Totals - Interest leads:', totalInterestLeads, 'Verified:', verifiedInterestLeads, 'Team members:', totalTeamMembers);
        
        // Render stats
        let statsHtml = `
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
        
        document.getElementById('sequence-stats').innerHTML = statsHtml;
        
    } catch (err) {
        console.error('[STATS] Failed to load sequence stats:', err);
        document.getElementById('sequence-stats').innerHTML = 
            `<p style="color: var(--admin-danger); font-size: 0.9rem;">Failed to load recipient statistics: ${err.message}</p>`;
    }
}

function renderEmails() {
    const tbody = document.getElementById('emails-body');
    
    if (currentEmails.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state-small">No emails yet. Click "Add Email" to create the first email in this sequence.</td></tr>';
        return;
    }
    
    tbody.innerHTML = currentEmails.map(email => {
        const createdDate = new Date(email.createdAt).toLocaleDateString();
        const status = email.status || 'draft';
        
        let statusBadge = '';
        let scheduleBadge = '';
        
        if (status === 'live') {
            if (email.scheduledSendTime) {
                const schedDate = new Date(email.scheduledSendTime);
                const now = new Date();
                if (schedDate > now) {
                    // Get user's timezone offset for display
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
                <td><span class="badge sequence">#${email.sequenceOrder || 1}</span></td>
                <td>
                    <strong>${escapeHtml(email.subject)}</strong>
                    ${scheduleBadge}
                </td>
                <td>${statusBadge}</td>
                <td><span style="color: var(--admin-success);">${email.stats?.sent || 0}</span></td>
                <td><span style="color: var(--admin-danger);">${email.stats?.failed || 0}</span></td>
                <td>${createdDate}</td>
                <td>
                    <span style="color: var(--admin-text-muted); font-size: 0.85rem;">View only</span>
                </td>
            </tr>
        `;
    }).join('');
}

// Sequence Modal Functions
function showCreateSequenceModal() {
    document.getElementById('sequence-id').value = '';
    document.getElementById('sequence-modal-title').textContent = '📧 Create New Sequence';
    document.getElementById('sequence-name').value = '';
    document.getElementById('sequence-event').value = '';
    document.getElementById('sequence-description').value = '';
    document.getElementById('sequence-warning').style.display = 'none';
    document.getElementById('delete-sequence-btn').classList.add('hidden');
    document.getElementById('create-sequence-modal').classList.add('active');
}

function editSequence(sequenceId) {
    const seq = allSequences.find(s => s.id === sequenceId);
    if (!seq) return;
    
    document.getElementById('sequence-id').value = seq.id;
    document.getElementById('sequence-modal-title').textContent = '✏️ Edit Sequence';
    document.getElementById('sequence-name').value = seq.name;
    document.getElementById('sequence-event').value = seq.eventId;
    document.getElementById('sequence-description').value = seq.description || '';
    document.getElementById('sequence-warning').style.display = 'none';
    document.getElementById('delete-sequence-btn').classList.remove('hidden');
    document.getElementById('create-sequence-modal').classList.add('active');
}

function editCurrentSequence() {
    editSequence(currentSequenceId);
}

function closeSequenceModal() {
    document.getElementById('create-sequence-modal').classList.remove('active');
}

async function saveSequence() {
    const sequenceId = document.getElementById('sequence-id').value;
    const name = document.getElementById('sequence-name').value.trim();
    const description = document.getElementById('sequence-description').value.trim();
    
    if (!name) {
        alert('Please enter a sequence name');
        return;
    }
    
    try {
        if (sequenceId) {
            await API.sequences.update(sequenceId, { name, description });
        } else {
            await API.sequences.create({ name, description });
        }
        
        closeSequenceModal();
        await loadSequences();
        
        if (sequenceId && currentSequenceId === sequenceId) {
            // Refresh detail view if we're editing the current sequence
            showSequenceDetail(sequenceId);
        }
    } catch (err) {
        console.error('Failed to save sequence:', err);
        alert('Failed to save sequence: ' + (err.message || 'Unknown error'));
    }
}

async function deleteSequence() {
    const sequenceId = document.getElementById('sequence-id').value;
    if (!sequenceId) return;
    
    const seq = allSequences.find(s => s.id === sequenceId);
    if (!confirm(`Are you sure you want to delete "${seq.name}"?\n\nThis will delete the sequence and all ${seq.emailCount || 0} email(s) in it. This cannot be undone.`)) {
        return;
    }
    
    try {
        await API.sequences.delete(sequenceId);
        closeSequenceModal();
        await loadSequences();
        
        if (currentSequenceId === sequenceId) {
            showSequencesList();
        }
    } catch (err) {
        console.error('Failed to delete sequence:', err);
        alert('Failed to delete sequence');
    }
}

// Email Form Functions
function showCreateEmailForm() {
    if (!currentSequenceId) return;
    
    document.getElementById('email-id').value = '';
    document.getElementById('email-sequence-id').value = currentSequenceId;
    document.getElementById('email-form-title').textContent = 'Create Email';
    document.getElementById('email-subject').value = '';
    quill.setContents([]);
    document.getElementById('email-cta-url').value = '';
    document.getElementById('email-cta-text').value = '';
    document.getElementById('status-draft').checked = true;
    document.getElementById('email-schedule').value = '';
    document.getElementById('schedule-group').style.display = 'none';
    document.getElementById('delete-email-btn').classList.add('hidden');
    
    const nextOrder = currentEmails.length + 1;
    document.getElementById('email-order-info').innerHTML = `This will be email #<span id="email-number">${nextOrder}</span> in the sequence.`;
    
    setupStatusHandlers();
    showView('email-form');
}

async function editEmail(emailId) {
    try {
        const response = await API.campaigns.get(emailId);
        const email = response.campaign;
        
        document.getElementById('email-id').value = email.id;
        document.getElementById('email-sequence-id').value = email.sequenceId;
        document.getElementById('email-form-title').textContent = 'Edit Email';
        document.getElementById('email-subject').value = email.subject;
        quill.root.innerHTML = email.content;
        document.getElementById('email-cta-url').value = email.ctaUrl || '';
        document.getElementById('email-cta-text').value = email.ctaText || '';
        
        // Set status
        const status = email.status || 'draft';
        if (status === 'live') {
            document.getElementById('status-live').checked = true;
            document.getElementById('schedule-group').style.display = 'block';
        } else {
            document.getElementById('status-draft').checked = true;
            document.getElementById('schedule-group').style.display = 'none';
        }
        
        // Set schedule if exists
        if (email.scheduledSendTime) {
            const date = new Date(email.scheduledSendTime);
            // Format for datetime-local input
            const formatted = date.getFullYear() + '-' +
                String(date.getMonth() + 1).padStart(2, '0') + '-' +
                String(date.getDate()).padStart(2, '0') + 'T' +
                String(date.getHours()).padStart(2, '0') + ':' +
                String(date.getMinutes()).padStart(2, '0');
            document.getElementById('email-schedule').value = formatted;
            updateSchedulePreview();
        } else {
            document.getElementById('email-schedule').value = '';
        }
        
        document.getElementById('delete-email-btn').classList.remove('hidden');
        
        document.getElementById('email-order-info').innerHTML = `This is email #<span id="email-number">${email.sequenceOrder || 1}</span> of ${currentEmails.length} in the sequence.`;
        
        setupStatusHandlers();
        showView('email-form');
    } catch (err) {
        console.error('Failed to load email:', err);
        alert('Failed to load email');
    }
}

async function saveEmail() {
    const emailId = document.getElementById('email-id').value;
    const sequenceId = document.getElementById('email-sequence-id').value;
    const subject = document.getElementById('email-subject').value.trim();
    const content = quill.root.innerHTML;
    const ctaUrl = document.getElementById('email-cta-url').value.trim();
    const ctaText = document.getElementById('email-cta-text').value.trim();
    const status = document.querySelector('input[name="email-status"]:checked').value;
    const scheduleValue = document.getElementById('email-schedule').value;
    
    if (!subject || !content) {
        alert('Please fill in all required fields');
        return;
    }
    
    const data = { 
        sequenceId, 
        subject, 
        content, 
        ctaUrl, 
        ctaText,
        status
    };
    
    // Only include schedule if a value is set
    if (scheduleValue) {
        data.scheduledSendTime = new Date(scheduleValue).toISOString();
    } else {
        data.scheduledSendTime = null;
    }
    
    try {
        if (emailId) {
            await API.campaigns.update(emailId, data);
        } else {
            await API.campaigns.create(data);
        }
        
        showSequenceDetail(sequenceId);
    } catch (err) {
        console.error('Failed to save email:', err);
        alert('Failed to save email: ' + (err.message || 'Unknown error'));
    }
}

async function deleteEmail() {
    const emailId = document.getElementById('email-id').value;
    if (!emailId) return;
    
    const email = currentEmails.find(e => e.id === emailId);
    if (!confirm(`Are you sure you want to delete this email?\n\n"${email?.subject}"\n\nThis cannot be undone.`)) {
        return;
    }
    
    try {
        await API.campaigns.delete(emailId);
        showSequenceDetail(currentSequenceId);
    } catch (err) {
        console.error('Failed to delete email:', err);
        alert('Failed to delete email');
    }
}

function cancelEmailEdit() {
    showSequenceDetail(currentSequenceId);
}

function setupStatusHandlers() {
    const statusRadios = document.querySelectorAll('input[name="email-status"]');
    const scheduleGroup = document.getElementById('schedule-group');
    const scheduleInput = document.getElementById('email-schedule');
    
    // Display user's timezone
    displayUserTimezone();
    
    // Check initial state and show schedule if Live is selected
    const checkedRadio = document.querySelector('input[name="email-status"]:checked');
    if (checkedRadio && checkedRadio.value === 'live') {
        scheduleGroup.style.display = 'block';
        updateSchedulePreview(); // Update preview if there's already a value
    }
    
    statusRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === 'live') {
                scheduleGroup.style.display = 'block';
            } else {
                scheduleGroup.style.display = 'none';
            }
        });
    });
    
    scheduleInput.addEventListener('change', updateSchedulePreview);
}

function displayUserTimezone() {
    const now = new Date();
    const offsetMinutes = now.getTimezoneOffset();
    const offsetHours = Math.abs(offsetMinutes / 60);
    const offsetSign = offsetMinutes <= 0 ? '+' : '-';
    const timezoneStr = `GMT${offsetSign}${Math.floor(offsetHours)}${offsetMinutes % 60 !== 0 ? ':' + Math.abs(offsetMinutes % 60) : ''}`;
    
    // Try to get timezone name
    let timezoneName = '';
    try {
        timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
        // Fallback if timezone name is not available
    }
    
    const display = document.getElementById('user-timezone-display');
    if (display) {
        display.textContent = `(${timezoneStr}${timezoneName ? ' - ' + timezoneName : ''})`;
    }
}

function updateSchedulePreview() {
    const scheduleValue = document.getElementById('email-schedule').value;
    const preview = document.getElementById('schedule-preview');
    
    if (scheduleValue) {
        const date = new Date(scheduleValue);
        const now = new Date();
        
        // Get timezone offset
        const offsetMinutes = date.getTimezoneOffset();
        const offsetHours = Math.abs(offsetMinutes / 60);
        const offsetSign = offsetMinutes <= 0 ? '+' : '-';
        const timezoneStr = `GMT${offsetSign}${Math.floor(offsetHours)}${offsetMinutes % 60 !== 0 ? ':' + Math.abs(offsetMinutes % 60) : ''}`;
        
        if (date <= now) {
            preview.innerHTML = `⚠️ This date is in the past. Email will send immediately when saved as Live.<br>
                <small style="color: var(--admin-text-muted);">Your timezone: ${timezoneStr}</small>`;
            preview.style.color = 'var(--danger)';
        } else {
            const options = { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
            };
            const localTime = date.toLocaleDateString('en-US', options);
            const utcTime = date.toUTCString();
            
            preview.innerHTML = `📅 Will send on ${localTime}<br>
                <small style="color: var(--admin-text-muted);">
                    Your timezone: <strong>${timezoneStr}</strong> | 
                    UTC time: ${new Date(date).toISOString().replace('T', ' ').substring(0, 16)}
                </small>`;
            preview.style.color = 'var(--admin-accent)';
        }
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
}

async function previewEmail() {
    const subject = document.getElementById('email-subject').value.trim();
    const content = quill.root.innerHTML;
    const ctaUrl = document.getElementById('email-cta-url').value.trim();
    const ctaText = document.getElementById('email-cta-text').value.trim();

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/email/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                templateId: 'announcement',
                data: {
                    subject,
                    firstName: 'Preview User',
                    content,
                    ctaUrl,
                    ctaText
                }
            })
        });

        if (response.ok) {
            const data = await response.json();
            const frame = document.getElementById('preview-frame');
            frame.srcdoc = data.html;
        }
    } catch (err) {
        console.error('Preview error:', err);
    }
}

// Duplicate Sequence Function
async function duplicateSequence(sequenceId) {
    const sequence = allSequences.find(s => s.id === sequenceId);
    
    if (!sequence) return;
    
    if (!confirm(`Duplicate sequence "${sequence.name}"?\n\nThis will create a copy of the sequence with all its emails.`)) {
        return;
    }
    
    try {
        await API.sequences.copy(sequenceId);
        
        await loadSequences();
        
        alert(`Sequence duplicated successfully!`);
    } catch (err) {
        console.error('Failed to duplicate sequence:', err);
        alert('Failed to duplicate sequence: ' + (err.message || 'Unknown error'));
    }
}

document.addEventListener('DOMContentLoaded', init);
