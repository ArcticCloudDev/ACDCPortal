let bodyEditor, closingEditor;
let currentTemplate = 'welcome';
let currentEvent = null;
let allEvents = [];
let templateConfig = null;
let currentPermissions = null;

// Built-in defaults for the four system templates. Whatever is saved in the config is merged
// on top, so the page works from an empty database and an admin can configure from scratch.
const TEMPLATE_DEFAULTS = {
    'welcome': {
        name: 'Team Welcome',
        subject: 'Welcome to {{eventName}}',
        mergeFields: ['fullName', 'firstName', 'eventName', 'teamName', 'teamAdminName', 'portalUrl'],
        editableSections: {
            body: '<p>Hi {{firstName}},</p><p>We\'re excited to have you as part of {{eventName}}.</p>',
            closing: '<p>Good luck in the competition!</p>'
        },
        eventThemes: {},
        headerTitle: 'Welcome to {{eventName}}!',
        buttonText: 'Open Portal',
        buttonUrlField: 'portalUrl',
        features: ['teamBox']
    },
    'interest-acknowledgment': {
        name: 'Interest Acknowledgment',
        subject: 'Thanks for your interest in {{eventName}}',
        mergeFields: ['firstName', 'fullName', 'eventName', 'portalUrl', 'interestLink'],
        editableSections: {
            body: '<p>Hi {{firstName}},</p><p>Thanks for registering your interest in {{eventName}}. We will keep you posted as registration opens.</p>',
            closing: '<p>See you soon!</p>'
        },
        eventThemes: {},
        headerTitle: 'Thanks for your interest in {{eventName}}',
        buttonText: 'Visit the portal',
        buttonUrlField: 'portalUrl',
        features: []
    },
    'invitation-judge': {
        name: 'Judge Invitation',
        subject: 'You\'re invited to judge {{eventName}}!',
        mergeFields: ['firstName', 'fullName', 'eventName', 'inviterName', 'message', 'acceptUrl'],
        editableSections: {
            body: '<p>Hi {{firstName}},</p><p>You\'ve been selected to serve as a <strong>judge</strong> for {{eventName}}.</p><p>Please click the button below to accept.</p>',
            closing: '<p>We look forward to having you on the judging panel!</p>'
        },
        eventThemes: {},
        headerTitle: 'You\'re invited to judge {{eventName}}',
        buttonText: 'Accept Invitation',
        buttonUrlField: 'acceptUrl',
        features: ['expiryNotice']
    },
    'invitation-committee': {
        name: 'Committee Invitation',
        subject: 'You\'re invited to join the {{eventName}} committee!',
        mergeFields: ['firstName', 'fullName', 'eventName', 'inviterName', 'message', 'acceptUrl'],
        editableSections: {
            body: '<p>Hi {{firstName}},</p><p>You\'ve been invited to join the <strong>organizing committee</strong> for {{eventName}}.</p><p>Please click the button below to accept.</p>',
            closing: '<p>We look forward to working with you!</p>'
        },
        eventThemes: {},
        headerTitle: 'Join the {{eventName}} committee',
        buttonText: 'Accept Invitation',
        buttonUrlField: 'acceptUrl',
        features: ['expiryNotice']
    }
};

function mergeTemplateDefaults(saved) {
    const savedTemplates = (saved && saved.templates && typeof saved.templates === 'object') ? saved.templates : {};
    const templates = {};
    for (const [key, defaults] of Object.entries(TEMPLATE_DEFAULTS)) {
        const s = savedTemplates[key] || {};
        templates[key] = {
            ...defaults,
            ...s,
            name: s.name || defaults.name,
            subject: s.subject || defaults.subject,
            mergeFields: Array.isArray(s.mergeFields) && s.mergeFields.length ? s.mergeFields : defaults.mergeFields,
            editableSections: { ...defaults.editableSections, ...(s.editableSections || {}) },
            eventThemes: { ...(s.eventThemes || {}) },
            features: Array.isArray(s.features) ? s.features : defaults.features
        };
    }
    return { ...(saved || {}), templates };
}

document.addEventListener('DOMContentLoaded', async () => {
    currentPermissions = await Permissions.initAdminPage('email-templates');

    if (!currentPermissions) return;

    bodyEditor = new Quill('#body-editor', {
        theme: 'snow',
        placeholder: 'Enter body text...',
        modules: {
            toolbar: [['bold', 'italic', 'underline'], [{ 'list': 'bullet' }], ['clean']]
        }
    });

    closingEditor = new Quill('#closing-editor', {
        theme: 'snow',
        placeholder: 'Enter signature...',
        modules: {
            toolbar: [['bold', 'italic', 'underline'], ['clean']]
        }
    });

    labelRichEditor(bodyEditor, 'body-label');
    labelRichEditor(closingEditor, 'closing-label');

    const debouncedPreview = debounce(updatePreview, 400);
    bodyEditor.on('text-change', debouncedPreview);
    closingEditor.on('text-change', debouncedPreview);
    document.getElementById('field-header-title').addEventListener('input', debouncedPreview);
    document.getElementById('field-button-text').addEventListener('input', debouncedPreview);

    document.querySelectorAll('.template-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.template-option').forEach(o => {
                o.classList.remove('selected');
                o.setAttribute('aria-pressed', 'false');
            });
            option.classList.add('selected');
            option.setAttribute('aria-pressed', 'true');
            currentTemplate = option.dataset.template;
            renderMergeFields();
            if (currentEvent) {
                loadTemplateForEvent();
                updatePreview();
            }
        });
    });

    document.getElementById('merge-fields').addEventListener('click', (e) => {
        const tag = e.target.closest('.merge-field-tag');
        if (tag) copyMergeField(tag.dataset.field);
    });

    document.getElementById('save-template-btn').addEventListener('click', saveTemplate);
    document.getElementById('send-test-email-btn').addEventListener('click', sendTestEmail);

    document.getElementById('event-select').addEventListener('change', (e) => {
        currentEvent = allEvents.find(ev => sameId(ev.id, e.target.value)) || null;
        if (currentEvent) {
            loadTemplateForEvent();
            updatePreview();
        }
    });

    await loadEvents();
    await loadTemplateConfig();
    renderMergeFields();
});

// Quill renders icon-only toolbar buttons and an unlabelled editable area; name them for screen readers.
function labelRichEditor(editor, labelId) {
    editor.root.setAttribute('role', 'textbox');
    editor.root.setAttribute('aria-multiline', 'true');
    editor.root.setAttribute('aria-labelledby', labelId);
    const names = { bold: 'Bold', italic: 'Italic', underline: 'Underline', list: 'Bulleted list', clean: 'Clear formatting' };
    editor.getModule('toolbar').container.querySelectorAll('button').forEach(button => {
        const format = [...button.classList].find(c => c.startsWith('ql-'))?.slice(3);
        if (names[format]) button.setAttribute('aria-label', names[format]);
    });
}

async function loadEvents() {
    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/events`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const events = await response.json();
        allEvents = Permissions.filterByEvent(currentPermissions, Array.isArray(events) ? events : [], 'id');

        const select = document.getElementById('event-select');
        select.innerHTML = '<option value="">Choose an event...</option>';
        allEvents.forEach(e => {
            const option = document.createElement('option');
            option.value = e.id;
            option.textContent = e.name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading events:', error);
    }
}

async function loadTemplateConfig() {
    let saved = null;
    try {
        const response = await fetch(`${CONFIG.api.baseUrl}/system-emails/config`);
        if (response.ok) {
            saved = await response.json();
        }
    } catch (error) {
        console.error('Error loading template config:', error);
    }
    templateConfig = mergeTemplateDefaults(saved);
}

function loadTemplateForEvent() {
    if (!currentEvent || !templateConfig) return;

    const template = templateConfig.templates[currentTemplate];
    if (!template) return;
    const globalDefaults = template.editableSections || {};
    const eventTheme = (template.eventThemes || {})[currentEvent.id] || {};

    bodyEditor.root.innerHTML = eventTheme.body || globalDefaults.body || '';
    closingEditor.root.innerHTML = eventTheme.closing || globalDefaults.closing || '';

    document.getElementById('field-header-title').value = eventTheme.headerTitle || template.headerTitle || '';

    const hasButton = !!template.buttonUrlField;
    document.getElementById('button-text-row').classList.toggle('hidden', !hasButton);
    if (hasButton) {
        document.getElementById('field-button-text').value = eventTheme.buttonText !== undefined ? (eventTheme.buttonText || '') : (template.buttonText || '');
    }
}

function renderMergeFields() {
    const template = templateConfig && templateConfig.templates[currentTemplate];
    const container = document.getElementById('merge-fields');
    if (!template) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = (template.mergeFields || []).map(field =>
        `<button type="button" class="merge-field-tag" data-field="${escapeHtml(field)}" title="Copy {{${escapeHtml(field)}}}">${icon('copy', 'icon-sm')}{{${escapeHtml(field)}}}</button>`
    ).join('');
}

function copyMergeField(field) {
    if (!field) return;
    const text = `{{${field}}}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
    showStatus(`Copied ${text} to clipboard`, 'success');
}

let previewRequestSeq = 0;

async function updatePreview() {
    if (!currentEvent) return;

    const previewEl = document.getElementById('preview-content');
    const requestId = ++previewRequestSeq;

    try {
        const resp = await fetch(`${CONFIG.api.baseUrl}/system-emails/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                templateType: currentTemplate,
                eventId: currentEvent.id,
                bodyText: bodyEditor.root.innerHTML,
                closingText: closingEditor.root.innerHTML
            })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const response = await resp.json();
        if (requestId !== previewRequestSeq) return; // a newer preview is already in flight

        let iframe = previewEl.querySelector('iframe');
        if (!iframe) {
            previewEl.innerHTML = '<div class="email-preview-stage"></div>';
            iframe = document.createElement('iframe');
            iframe.id = 'template-preview-frame';
            iframe.className = 'email-preview-frame';
            iframe.title = 'Email preview';
            previewEl.firstElementChild.appendChild(iframe);
        }

        // The template HTML is rendered without scripts and without access to this page.
        renderSandboxedHtml(iframe, response.html);
    } catch (err) {
        if (requestId !== previewRequestSeq) return;
        previewEl.innerHTML = `<div class="notice notice-danger preview-error">${icon('circle-alert')}<div>Preview failed: ${escapeHtml(err.message)}</div></div>`;
    }
}

async function saveTemplate() {
    if (!currentEvent) {
        showStatus('Choose an event first', 'error');
        return;
    }

    await withBusy(document.getElementById('save-template-btn'), 'Saving...', async () => {
        try {
            const template = templateConfig.templates[currentTemplate];

            if (!template.eventThemes) template.eventThemes = {};
            if (!template.eventThemes[currentEvent.id]) {
                template.eventThemes[currentEvent.id] = {};
            }

            template.eventThemes[currentEvent.id].body = bodyEditor.root.innerHTML;
            template.eventThemes[currentEvent.id].closing = closingEditor.root.innerHTML;
            const headerVal = document.getElementById('field-header-title').value || null;
            template.eventThemes[currentEvent.id].headerTitle = headerVal;
            template.eventThemes[currentEvent.id].subject = headerVal;

            if (template.buttonUrlField) {
                const buttonTextVal = document.getElementById('field-button-text').value.trim();
                if (!buttonTextVal) {
                    showStatus('Button text is required', 'error');
                    return;
                }
                template.eventThemes[currentEvent.id].buttonText = buttonTextVal;
            }

            if (headerVal) template.subject = headerVal;

            const response = await fetch(`${CONFIG.api.baseUrl}/system-emails/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(templateConfig)
            });

            if (response.ok) {
                showStatus('Template saved successfully!', 'success');
            } else {
                const err = await response.json().catch(() => ({}));
                showStatus('Failed to save template' + (err.error ? `: ${err.error}` : ''), 'error');
            }
        } catch (error) {
            console.error('Error saving template:', error);
            showStatus('Error saving template', 'error');
        }
    });
}

async function sendTestEmail() {
    if (!currentEvent) {
        showStatus('Choose an event first', 'error');
        return;
    }

    const email = prompt('Send a test of this email to which address?');
    if (!email) return;

    await withBusy(document.getElementById('send-test-email-btn'), 'Sending...', async () => {
        try {
            const response = await fetch(`${CONFIG.api.baseUrl}/system-emails/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    templateType: currentTemplate,
                    eventId: currentEvent.id,
                    testEmail: email,
                    data: {
                        teamName: 'Sample Team Alpha',
                        fullName: 'Test User',
                        teamAdminName: 'Admin User'
                    }
                })
            });

            if (response.ok) {
                showStatus('Test email sent!', 'success');
            } else {
                showStatus('Failed to send test email', 'error');
            }
        } catch (error) {
            console.error('Error sending test:', error);
            showStatus('Error sending test email', 'error');
        }
    });
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
