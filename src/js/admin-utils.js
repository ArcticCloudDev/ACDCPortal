// Shared helpers for the admin pages. Loaded after config.js and before each page script.
// Everything here is a plain global so the existing page scripts can call it directly.

// Escapes text for safe interpolation into HTML, including attribute values.
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Returns the URL only when it is an absolute http(s) URL; anything else becomes ''.
// Use before putting user-supplied URLs into href/src.
function safeHttpUrl(value) {
    if (!value) return '';
    try {
        const url = new URL(String(value).trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
}

// SQL returns UNIQUEIDENTIFIERs upper-case while some API responses echo lower-case.
function sameId(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Disables a button while an async action runs so a double click cannot fire two requests.
// The button is re-enabled afterwards (also on error, which is rethrown to the caller).
async function withBusy(button, busyLabel, action) {
    if (!button) return action();
    if (button.disabled) return undefined;
    // Keep the original nodes (icon + label) so they come back intact after the busy label.
    const originalNodes = Array.from(button.childNodes);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.textContent = busyLabel;
    try {
        return await action();
    } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (busyLabel) button.replaceChildren(...originalNodes);
    }
}

// Renders untrusted email HTML in an iframe that cannot run scripts or reach the parent page.
function renderSandboxedHtml(iframe, html) {
    if (!iframe) return;
    iframe.setAttribute('sandbox', '');
    iframe.removeAttribute('src');
    iframe.srcdoc = html || '';
}
