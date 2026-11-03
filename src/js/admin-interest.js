let allEntries = [];
let allEvents = [];
let currentPermissions = null;

document.addEventListener('DOMContentLoaded', async () => {
    // Same gate as before; these elements only decide where "Access denied" is shown.
    currentPermissions = await Permissions.initAdminPage('interest', {
        contentEl: document.getElementById('admin-content'),
        accessDeniedEl: document.getElementById('not-committee')
    });

    if (!currentPermissions) return;

    const shareLink = window.location.origin + '/register.html?intent=interest';
    document.getElementById('share-link').value = shareLink;

    document.getElementById('copy-share-link-btn').addEventListener('click', copyShareLink);
    document.getElementById('export-selected-btn').addEventListener('click', exportSelected);
    document.getElementById('select-all').addEventListener('change', toggleSelectAll);

    const tbody = document.getElementById('queue-table-body');
    tbody.addEventListener('change', (e) => {
        if (e.target.classList.contains('entry-checkbox')) updateSelection();
    });
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action="remove"]');
        if (btn) removeEntry(btn.dataset.id, btn);
    });

    await loadData();
});

async function loadData() {
    try {
        let events = await API.events.list();
        allEvents = Permissions.filterByEvent(currentPermissions, events, 'id');

        const allParticipations = await API.participations.list();
        let interestParticipations = allParticipations.filter(p =>
            p.roles?.includes('interest')
        );
        interestParticipations = Permissions.filterByEvent(currentPermissions, interestParticipations);

        allEntries = interestParticipations.map(p => {
            const firstName = p.interestFirstName || '';
            const lastName = p.interestLastName || '';
            const hasUpgraded = p.roles?.some(r => r !== 'interest');

            return {
                id: p.id,
                email: p.email,
                firstName,
                lastName,
                eventId: p.eventId,
                createdAt: p.interestDate || p.createdAt,
                verified: p.interestVerified !== false,
                converted: hasUpgraded || !!p.teamId
            };
        });

        allEntries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const total = allEntries.length;
        const verified = allEntries.filter(e => e.verified).length;
        const converted = allEntries.filter(e => e.converted).length;

        document.getElementById('stat-total').textContent = total;
        document.getElementById('stat-verified').textContent = verified;
        document.getElementById('stat-converted').textContent = converted;

        renderTable();
    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('queue-table-body').innerHTML =
            '<tr><td colspan="8" class="empty-state">Could not load the interest list. Reload the page to try again.</td></tr>';
    }
}

function renderTable() {
    const tbody = document.getElementById('queue-table-body');

    if (allEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No one has registered interest yet.</td></tr>';
        updateSelection();
        return;
    }

    tbody.innerHTML = allEntries.map((entry, index) => {
        const date = new Date(entry.createdAt).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });

        // Registered = done (success); verified = waiting for registration (info); unverified = needs attention.
        let statusBadge = entry.verified
            ? '<span class="badge badge-info">Verified</span>'
            : '<span class="badge badge-warning">Unverified</span>';
        if (entry.converted) {
            statusBadge = '<span class="badge badge-success">Registered</span>';
        }

        const name = [entry.firstName, entry.lastName].filter(Boolean).join(' ');

        const event = allEvents.find(e => sameId(e.id, entry.eventId));

        return `
            <tr>
                <td class="col-select"><input type="checkbox" class="entry-checkbox" data-id="${escapeHtml(entry.id)}" aria-label="Select ${escapeHtml(entry.email)}"></td>
                <td class="col-index text-muted">${index + 1}</td>
                <td class="lead-email"><strong>${escapeHtml(entry.email)}</strong></td>
                <td>${name ? escapeHtml(name) : '<span class="text-muted">—</span>'}</td>
                <td class="text-muted">${event ? escapeHtml(event.name) : '—'}</td>
                <td class="text-muted">${date}</td>
                <td>${statusBadge}</td>
                <td class="col-actions">
                    ${!entry.converted ? `<button type="button" class="btn-sm danger-ghost" data-action="remove" data-id="${escapeHtml(entry.id)}" aria-label="Remove ${escapeHtml(entry.email)} from the interest list">Remove</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');
    updateSelection();
}

function toggleSelectAll() {
    const selectAll = document.getElementById('select-all').checked;
    document.querySelectorAll('.entry-checkbox').forEach(cb => cb.checked = selectAll);
    updateSelection();
}

function updateSelection() {
    const checked = document.querySelectorAll('.entry-checkbox:checked').length;
    document.getElementById('selected-count').textContent = `${checked} selected`;
    document.getElementById('bulk-actions').classList.toggle('hidden', checked === 0);
}

function getSelectedIds() {
    return Array.from(document.querySelectorAll('.entry-checkbox:checked'))
        .map(cb => cb.dataset.id);
}

function exportSelected() {
    const ids = getSelectedIds();
    const entries = allEntries.filter(e => ids.some(id => sameId(id, e.id)));
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;

    const csv = [
        'Email,First Name,Last Name,Company,Phone,Signed Up',
        ...entries.map(e =>
            [q(e.email), q(e.firstName), q(e.lastName), q(e.company), q(e.phone), q(e.createdAt)].join(',')
        )
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interest-queue-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

async function removeEntry(id, button) {
    if (!confirm('Remove this interest lead?')) return;

    await withBusy(button, 'Removing...', async () => {
        try {
            await API.participations.removeRoles(id, ['interest']);
            await loadData();
        } catch (error) {
            console.error('Error removing entry:', error);
            alert('Error removing entry: ' + error.message);
        }
    });
}

function copyShareLink() {
    const input = document.getElementById('share-link');
    input.select();
    document.execCommand('copy');

    const btn = document.getElementById('copy-share-link-btn');
    btn.innerHTML = `${icon('check')}Copied`;
    setTimeout(() => { btn.innerHTML = `${icon('copy')}Copy link`; }, 2000);
}
