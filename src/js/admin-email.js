let quill;
let selectedTemplate = 'announcement';
let recipients = [];
let allEvents = [];
let currentPermissions = null;

const TEMPLATE_NAMES = { announcement: 'Announcement', reminder: 'Reminder', sequence: 'Sequence' };

const urlParams = new URLSearchParams(window.location.search);
const isSequenceMode = urlParams.get('mode') === 'sequence';
const sequenceId = urlParams.get('sequenceId');
const eventId = urlParams.get('eventId');
const emailId = urlParams.get('emailId');
const emailOrder = parseInt(urlParams.get('order')) || 1;

document.addEventListener('DOMContentLoaded', async () => {
    currentPermissions = await Permissions.initAdminPage('email');

    if (!currentPermissions) return;

    quill = new Quill('#editor-container', {
        theme: 'snow',
        placeholder: 'Write your message here...',
        modules: {
            toolbar: [
                ['bold', 'italic', 'underline'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                ['link'],
                ['clean']
            ]
        }
    });
    labelRichEditor(quill, 'message-label');

    document.querySelectorAll('.template-card').forEach(card => {
        card.addEventListener('click', () => {
            selectTemplateCard(card);
            selectedTemplate = card.dataset.template;
            previewEmail();
        });
    });

    document.getElementById('event-select').addEventListener('change', () => {
        if (!isSequenceMode) {
            loadRecipients();
        }
    });

    document.getElementById('recipient-filter').addEventListener('change', (e) => {
        const customRecipients = document.getElementById('custom-recipients');
        customRecipients.classList.toggle('visible', e.target.value === 'custom');

        if (e.target.value !== 'custom' && !isSequenceMode) {
            loadRecipients();
        }
    });

    document.getElementById('custom-emails').addEventListener('input', parseCustomEmails);

    document.querySelectorAll('input[name="email-status"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === 'live') {
                document.getElementById('schedule-group').classList.remove('hidden');
                displayUserTimezone();
            } else {
                document.getElementById('schedule-group').classList.add('hidden');
                lockFormFields(false);
            }
        });
    });

    document.getElementById('scheduled-send-time').addEventListener('change', updateSchedulePreview);
    document.getElementById('scheduled-send-time').addEventListener('input', updateSchedulePreview);

    document.getElementById('preview-btn').addEventListener('click', previewEmail);
    document.getElementById('send-btn').addEventListener('click', sendEmail);
    document.getElementById('cancel-btn').addEventListener('click', cancelSequenceEdit);

    const debouncedPreview = debounce(previewEmail, 500);
    quill.on('text-change', debouncedPreview);
    document.getElementById('subject').addEventListener('input', debouncedPreview);
    document.getElementById('cta-url').addEventListener('input', debouncedPreview);
    document.getElementById('cta-text').addEventListener('input', debouncedPreview);

    await loadEvents();

    if (isSequenceMode) {
        const sendBtn = document.getElementById('send-btn');
        const cancelBtn = document.getElementById('cancel-btn');
        sendBtn.textContent = emailId ? 'Save changes' : 'Save email';
        cancelBtn.classList.remove('hidden');
        document.getElementById('status-group').classList.remove('hidden');
        showSequenceContext();

        await loadSequenceEmail();
    } else {
        // Quick emails go out immediately; draft/live scheduling only applies to sequence emails.
        document.getElementById('status-group').classList.add('hidden');
        await loadRecipients();
    }

    await loadHistory();

    previewEmail();
});

function cancelSequenceEdit() {
    window.location.href = `admin-events.html?event=${encodeURIComponent(eventId || '')}&tab=sequence`;
}

// Sequence mode is opened from an event's Sequence tab: title, breadcrumb and history say so.
function showSequenceContext() {
    const event = allEvents.find(e => sameId(e.id, eventId));
    const eventName = event ? event.name : 'Event';
    const eventParam = encodeURIComponent(eventId || '');

    document.getElementById('page-title').textContent = emailId ? 'Edit sequence email' : 'New sequence email';
    document.title = `${emailId ? 'Edit' : 'New'} sequence email - ACDC Admin`;
    document.getElementById('page-subtitle').textContent =
        `Part of the email sequence for ${eventName}. Save it as a draft to keep it from sending.`;

    const eventLink = document.getElementById('breadcrumb-event');
    eventLink.textContent = eventName;
    eventLink.href = `admin-events.html?event=${eventParam}`;
    document.getElementById('breadcrumb-sequence').href = `admin-events.html?event=${eventParam}&tab=sequence`;
    document.getElementById('sequence-breadcrumb').classList.remove('hidden');

    document.getElementById('sequence-recipients-hint').classList.remove('hidden');

    if (emailId) {
        document.getElementById('history-title-text').textContent = 'Deliveries';
        document.getElementById('history-meta').textContent = 'Everyone this email has been sent to';
    } else {
        // A new sequence email has no deliveries; the quick-email history is unrelated here.
        document.getElementById('history-panel').classList.add('hidden');
    }
}

function selectTemplateCard(card) {
    document.querySelectorAll('.template-card').forEach(c => {
        c.classList.remove('selected');
        c.setAttribute('aria-pressed', 'false');
    });
    card.classList.add('selected');
    card.setAttribute('aria-pressed', 'true');
}

// Quill renders icon-only toolbar buttons and an unlabelled editable area; name them for screen readers.
function labelRichEditor(editor, labelId) {
    editor.root.setAttribute('role', 'textbox');
    editor.root.setAttribute('aria-multiline', 'true');
    editor.root.setAttribute('aria-labelledby', labelId);
    const names = { bold: 'Bold', italic: 'Italic', underline: 'Underline', link: 'Link', clean: 'Clear formatting' };
    editor.getModule('toolbar').container.querySelectorAll('button').forEach(button => {
        const format = [...button.classList].find(c => c.startsWith('ql-'))?.slice(3);
        const label = format === 'list' ? (button.value === 'ordered' ? 'Numbered list' : 'Bulleted list') : names[format];
        if (label) button.setAttribute('aria-label', label);
    });
}

async function loadSequenceEmail() {
    try {
        const eventSelect = document.getElementById('event-select');
        eventSelect.value = eventId;
        if (eventSelect.value !== eventId) {
            const match = Array.from(eventSelect.options).find(o => sameId(o.value, eventId));
            if (match) eventSelect.value = match.value;
        }
        eventSelect.disabled = true;

        const recipientFilter = document.getElementById('recipient-filter');
        recipientFilter.innerHTML = '<option value="event-contacts">All event contacts</option>';
        recipientFilter.disabled = true;

        await loadRecipients();

        if (emailId) {
            const response = await fetch(`${CONFIG.api.baseUrl}/email/campaigns/${encodeURIComponent(emailId)}`);
            if (response.ok) {
                const data = await response.json();
                const email = data.campaign;
                const sentCount = data.stats?.sent || 0;

                document.getElementById('subject').value = email.subject;
                quill.clipboard.dangerouslyPasteHTML(email.content || '');

                selectedTemplate = email.template || email.type || 'announcement';
                if (selectedTemplate === 'sequence') {
                    selectedTemplate = 'announcement';
                }
                const card = Array.from(document.querySelectorAll('.template-card')).find(c => c.dataset.template === selectedTemplate);
                if (card) {
                    selectTemplateCard(card);
                }

                if (email.ctaUrl) document.getElementById('cta-url').value = email.ctaUrl;
                if (email.ctaText) document.getElementById('cta-text').value = email.ctaText;

                if (email.status) {
                    const statusRadio = Array.from(document.querySelectorAll('input[name="email-status"]')).find(r => r.value === email.status);
                    if (statusRadio) statusRadio.checked = true;
                    if (email.status === 'live') {
                        document.getElementById('schedule-group').classList.remove('hidden');
                        displayUserTimezone();
                        if (sentCount > 0) {
                            lockFormFields(true);
                        }
                    }
                }

                if (email.scheduledSendTime) {
                    const localDate = new Date(email.scheduledSendTime);
                    const offset = localDate.getTimezoneOffset();
                    const localISO = new Date(localDate.getTime() - offset * 60000).toISOString().slice(0, 16);
                    document.getElementById('scheduled-send-time').value = localISO;
                    updateSchedulePreview();
                }
            }
        }
    } catch (error) {
        console.error('Error loading sequence email:', error);
        showStatus('Could not load this email', 'error');
    }
}

async function loadEvents() {
    const select = document.getElementById('event-select');
    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/events`);
        if (response.ok) {
            let events = await response.json();
            allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');

            allEvents.sort((a, b) => {
                if (a.isActive && !b.isActive) return -1;
                if (!a.isActive && b.isActive) return 1;
                return new Date(b.startDate) - new Date(a.startDate);
            });

            select.innerHTML = '';
            allEvents.forEach(event => {
                const option = document.createElement('option');
                option.value = event.id;
                option.textContent = `${event.name}${event.isActive ? ' (Active)' : ''}`;
                option.selected = !!event.isActive;
                select.appendChild(option);
            });

            if (allEvents.length === 0) {
                select.innerHTML = '<option value="">No events found</option>';
            }
        }
    } catch (error) {
        console.error('Error loading events:', error);
        select.innerHTML = '<option value="">Error loading events</option>';
    }
}

function setRecipients(list) {
    recipients = Array.isArray(list) ? list : [];
    document.getElementById('recipient-count').textContent = recipients.length;
}

// Each load gets a number. A response is applied only if it is still the latest load and the
// filter has not changed meanwhile; otherwise a slow default load (e.g. while the database wakes up)
// could overwrite custom recipients typed in the meantime, and the email would go to the whole event.
let recipientsLoadSeq = 0;

async function loadRecipients() {
    const seq = ++recipientsLoadSeq;
    const selectedEventId = document.getElementById('event-select').value;
    const filter = document.getElementById('recipient-filter').value;
    const apply = (list) => {
        if (seq !== recipientsLoadSeq) return;
        if (document.getElementById('recipient-filter').value !== filter) return;
        setRecipients(list);
    };

    if (filter === 'event-contacts') {
        if (!selectedEventId) {
            apply([]);
            return;
        }
        try {
            const response = await fetch(`${CONFIG.api.baseUrl}/email/recipients?eventId=${encodeURIComponent(selectedEventId)}&filter=all-event-contacts`);
            if (!response.ok) throw new Error('Failed to load');
            apply(await response.json());
        } catch (error) {
            console.error('Error loading event contacts:', error);
            apply([]);
        }
        return;
    }

    if (filter === 'interest-queue') {
        try {
            const response = await fetch(`${CONFIG.api.baseUrl}/interest/leads`);
            if (!response.ok) throw new Error('Failed to load');
            const data = await response.json();
            const leads = data.leads || [];
            apply(leads
                .filter(l => l.verified)
                .map(l => ({
                    email: l.email,
                    firstName: l.firstName,
                    lastName: l.lastName,
                    displayName: [l.firstName, l.lastName].filter(Boolean).join(' ') || l.email
                })));
        } catch (error) {
            console.error('Error loading interest leads:', error);
            apply([]);
        }
        return;
    }

    if (filter === 'custom') {
        parseCustomEmails();
        return;
    }

    if (!selectedEventId) {
        apply([]);
        return;
    }

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/email/recipients?eventId=${encodeURIComponent(selectedEventId)}&filter=${encodeURIComponent(filter)}`);
        if (!response.ok) throw new Error('Failed to load');
        apply(await response.json());
    } catch (error) {
        console.error('Error loading recipients:', error);
        apply([]);
    }
}

function parseCustomEmails() {
    recipientsLoadSeq++;
    const text = document.getElementById('custom-emails').value;
    const emails = text.split('\n')
        .map(e => e.trim())
        .filter(e => e && e.includes('@'));
    setRecipients(emails.map(email => ({ email })));
}

function composeData() {
    return {
        subject: document.getElementById('subject').value,
        content: quill.root.innerHTML,
        ctaUrl: document.getElementById('cta-url').value,
        ctaText: document.getElementById('cta-text').value || 'Learn More'
    };
}

async function previewEmail() {
    const data = composeData();

    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/email/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                templateId: selectedTemplate,
                data: {
                    ...data,
                    subject: data.subject || 'Email Subject',
                    firstName: 'Preview User'
                }
            })
        });

        if (response.ok) {
            const result = await response.json();
            renderSandboxedHtml(document.getElementById('preview-frame'), result.html);
        }
    } catch (error) {
        console.error('Error previewing email:', error);
    }
}

async function sendEmail() {
    const sendBtn = document.getElementById('send-btn');

    if (isSequenceMode) {
        return withBusy(sendBtn, 'Saving...', saveSequenceEmail);
    }

    if (recipients.length === 0) {
        showStatus('Choose who to send to first', 'error');
        return;
    }

    const data = composeData();
    if (!data.subject) {
        showStatus('Please enter a subject', 'error');
        return;
    }

    if (!confirm(`Send email to ${recipients.length} recipient(s)?`)) {
        return;
    }

    await withBusy(sendBtn, 'Sending...', async () => {
        try {
            // Contract: templateId + subject + recipients at the top level, the template merge
            // fields (subject, content, ctaUrl, ctaText) under `data`.
            const response = await fetch(`${CONFIG.api.baseUrl}/email/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    templateId: selectedTemplate,
                    subject: data.subject,
                    recipients: recipients.map(r => {
                        const out = { email: r.email };
                        if (r.firstName) out.firstName = r.firstName;
                        if (r.lastName) out.lastName = r.lastName;
                        return out;
                    }),
                    data
                })
            });

            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(result.error || result.message || `HTTP ${response.status}`);
            }

            if (result.results.failed === 0) {
                showStatus(`Successfully sent to ${result.results.sent} recipient(s)`, 'success');
            } else {
                showStatus(`Sent to ${result.results.sent} recipient(s), failed for ${result.results.failed}`, 'warning');
            }

            await loadHistory();
        } catch (error) {
            console.error('Error sending email:', error);
            showStatus('Error sending email: ' + error.message, 'error');
        }
    });
}

async function saveSequenceEmail() {
    const subject = document.getElementById('subject').value;
    if (!subject) {
        showStatus('Please enter a subject', 'error');
        return;
    }

    const content = quill.root.innerHTML;
    if (!content || content === '<p><br></p>') {
        showStatus('Please enter email content', 'error');
        return;
    }

    const status = document.querySelector('input[name="email-status"]:checked').value;
    const scheduleInput = document.getElementById('scheduled-send-time').value;
    const scheduledSendTime = scheduleInput ? new Date(scheduleInput).toISOString() : null;

    const emailData = {
        sequenceId: sequenceId,
        subject: subject,
        content: content,
        template: selectedTemplate,
        type: 'sequence',
        status: status,
        scheduledSendTime: scheduledSendTime,
        ctaUrl: document.getElementById('cta-url').value,
        ctaText: document.getElementById('cta-text').value || 'Learn More'
    };
    if (!emailId) {
        emailData.sequenceOrder = emailOrder;
    }

    try {
        let response;
        if (emailId) {
            response = await fetch(`${CONFIG.api.baseUrl}/email/campaigns/${encodeURIComponent(emailId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emailData)
            });
        } else {
            response = await fetch(`${CONFIG.api.baseUrl}/email/campaigns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emailData)
            });
        }

        if (response.ok) {
            showStatus('Email saved successfully. Returning to the sequence...', 'success');

            setTimeout(() => {
                window.location.href = `admin-events.html?event=${encodeURIComponent(eventId || '')}&tab=sequence`;
            }, 1000);
        } else {
            const error = await response.json().catch(() => ({}));
            showStatus('Could not save the email: ' + (error.error || 'Unknown error'), 'error');
        }
    } catch (error) {
        console.error('Error saving sequence email:', error);
        showStatus('Could not save the email: ' + error.message, 'error');
    }
}

async function loadHistory() {
    const tbody = document.getElementById('history-body');
    const thead = document.getElementById('history-header');
    try {
        if (isSequenceMode && emailId) {

            thead.innerHTML = `
                <tr>
                    <th scope="col">Date and time</th>
                    <th scope="col">Recipient</th>
                    <th scope="col">Status</th>
                </tr>
            `;

            const response = await fetch(`${CONFIG.api.baseUrl}/deliveries/event/${encodeURIComponent(eventId)}`);

            if (!response.ok) {
                throw new Error(`Deliveries not available: ${response.status}`);
            }

            const data = await response.json();

            const thisEmailDeliveries = (data.deliveries || []).filter(d => sameId(d.campaignId, emailId));

            if (thisEmailDeliveries.length === 0) {
                tbody.innerHTML = `<tr><td colspan="3" class="empty-state">Not sent to anyone yet</td></tr>`;
                return;
            }

            tbody.innerHTML = thisEmailDeliveries.map(delivery => {
                const date = new Date(delivery.sentAt || delivery.createdAt).toLocaleDateString();
                const time = new Date(delivery.sentAt || delivery.createdAt).toLocaleTimeString();
                const statusClass = delivery.status === 'sent' ? 'success' :
                                  delivery.status === 'failed' ? 'danger' : 'info';
                const statusText = delivery.status === 'sent' ? 'Sent' :
                                 delivery.status === 'failed' ? 'Failed' : 'Pending';

                return `
                    <tr>
                        <td class="text-muted">${date} ${time}</td>
                        <td>${escapeHtml(delivery.email)}</td>
                        <td><span class="badge badge-${statusClass}">${statusText}</span></td>
                    </tr>
                `;
            }).join('');

            return;
        }

        thead.innerHTML = `
            <tr>
                <th scope="col">Date</th>
                <th scope="col">Subject</th>
                <th scope="col">Template</th>
                <th scope="col" class="num">Delivered</th>
                <th scope="col">Status</th>
            </tr>
        `;

        const response = await fetch(`${CONFIG.api.baseUrl}/email/history`);

        if (!response.ok) {
            throw new Error(`History not available: ${response.status}`);
        }

        const history = await response.json();

        if (!history || history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No emails sent yet</td></tr>`;
            return;
        }

        tbody.innerHTML = history.slice(0, 10).map(email => {
            const date = new Date(email.sentAt).toLocaleDateString();
            const statusClass = email.status === 'completed' ? 'success' :
                               email.status === 'completed-with-errors' ? 'warning' : 'danger';
            const statusText = email.status === 'completed' ? 'Sent' :
                              email.status === 'completed-with-errors' ? 'Partial' : email.status;

            const templateName = TEMPLATE_NAMES[email.templateId] || email.templateId || '-';

            return `
                <tr>
                    <td class="text-muted">${date}</td>
                    <td><strong>${escapeHtml(email.subject || '-')}</strong></td>
                    <td>${escapeHtml(templateName)}</td>
                    <td class="num">${Number(email.results?.sent) || 0} / ${Number(email.recipientCount) || 0}</td>
                    <td><span class="badge badge-${statusClass}">${escapeHtml(statusText)}</span></td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('[loadHistory] Error loading history:', error);
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No emails sent yet</td></tr>`;
    }
}

function displayUserTimezone() {
    const offset = new Date().getTimezoneOffset();
    const hours = Math.abs(Math.floor(offset / 60));
    const minutes = Math.abs(offset % 60);
    const sign = offset <= 0 ? '+' : '-';
    const tzDisplay = `(GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')})`;
    const tzElement = document.getElementById('timezone-display');
    if (tzElement) {
        tzElement.textContent = tzDisplay;
    }
}

function updateSchedulePreview() {
    const scheduleInput = document.getElementById('scheduled-send-time').value;
    const preview = document.getElementById('schedule-preview');

    if (!scheduleInput) {
        preview.classList.add('hidden');
        return;
    }

    const localDate = new Date(scheduleInput);
    if (Number.isNaN(localDate.getTime())) {
        preview.classList.add('hidden');
        return;
    }
    const utcDate = localDate.toISOString();

    const offset = localDate.getTimezoneOffset();
    const hours = Math.abs(Math.floor(offset / 60));
    const minutes = Math.abs(offset % 60);
    const sign = offset <= 0 ? '+' : '-';
    const gmtOffset = `GMT${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    preview.innerHTML = `${icon('clock')}<div>Sends on <strong>${escapeHtml(localDate.toLocaleString())}</strong> (${gmtOffset})<div class="notice-body">UTC: ${escapeHtml(utcDate)}</div></div>`;
    preview.classList.remove('hidden');
}

function lockFormFields(lock) {
    document.getElementById('subject').readOnly = lock;
    document.getElementById('cta-url').readOnly = lock;
    document.getElementById('cta-text').readOnly = lock;
    document.getElementById('scheduled-send-time').disabled = lock;
    quill.enable(!lock);

    const editorContainer = document.getElementById('editor-container');
    if (lock) {
        let overlay = document.getElementById('editor-lock-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'editor-lock-overlay';
            overlay.className = 'editor-lock-overlay';
            editorContainer.appendChild(overlay);
        }
        overlay.classList.remove('hidden');
    } else {
        const overlay = document.getElementById('editor-lock-overlay');
        if (overlay) overlay.classList.add('hidden');
    }

    document.querySelectorAll('.template-card').forEach(card => {
        card.disabled = lock;
    });

    if (lock) {
        showStatus('This email is live and has been sent. Switch it to draft to make changes.', 'warning');
    }
}

const STATUS_TONES = {
    success: ['success', 'circle-check'],
    warning: ['warning', 'triangle-alert'],
    error: ['danger', 'circle-alert']
};

function showStatus(message, type) {
    const bar = document.getElementById('status-bar');
    const [tone, iconName] = STATUS_TONES[type] || ['info', 'info'];
    bar.innerHTML = `${icon(iconName)}<div>${escapeHtml(message)}</div>`;
    bar.className = `status-bar notice notice-${tone}`;

    if (type === 'success') {
        setTimeout(() => {
            bar.className = 'status-bar';
        }, 5000);
    }
}
