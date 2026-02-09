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
        renderSequences();
    } catch (err) {
        console.error('Failed to load sequences:', err);
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
                    <div class="sequence-actions" onclick="event.stopPropagation()">
                        <button class="btn btn-sm btn-secondary" onclick="editSequence('${seq.id}')">✏️ Edit</button>
                        <button class="btn btn-sm btn-secondary" onclick="duplicateSequence('${seq.id}')">📋 Duplicate</button>
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

function renderEmails() {
    const tbody = document.getElementById('emails-body');
    
    if (currentEmails.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state-small">No emails yet. Click "Add Email" to create the first email in this sequence.</td></tr>';
        return;
    }
    
    tbody.innerHTML = currentEmails.map(email => {
        const createdDate = new Date(email.createdAt).toLocaleDateString();
        
        return `
            <tr>
                <td><span class="badge sequence">#${email.sequenceOrder || 1}</span></td>
                <td><strong>${escapeHtml(email.subject)}</strong></td>
                <td><span style="color: var(--admin-success);">${email.stats?.sent || 0}</span></td>
                <td><span style="color: var(--admin-danger);">${email.stats?.failed || 0}</span></td>
                <td>${createdDate}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="editEmail('${email.id}')">✏️ Edit</button>
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
    document.getElementById('delete-email-btn').classList.add('hidden');
    
    const nextOrder = currentEmails.length + 1;
    document.getElementById('email-order-info').innerHTML = `This will be email #<span id="email-number">${nextOrder}</span> in the sequence.`;
    
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
        document.getElementById('delete-email-btn').classList.remove('hidden');
        
        document.getElementById('email-order-info').innerHTML = `This is email #<span id="email-number">${email.sequenceOrder || 1}</span> of ${currentEmails.length} in the sequence.`;
        
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
    
    if (!subject || !content) {
        alert('Please fill in all required fields');
        return;
    }
    
    try {
        const data = { sequenceId, subject, content, ctaUrl, ctaText };
        
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
