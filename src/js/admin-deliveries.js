// Admin Deliveries Logic
let deliveriesData = null;

async function loadDeliveries() {
    if (!currentEventId) return;
    
    const loadingDiv = document.getElementById('deliveries-loading');
    const contentDiv = document.getElementById('deliveries-content');
    
    loadingDiv.style.display = 'block';
    contentDiv.style.display = 'none';
    
    try {
        deliveriesData = await API.deliveries.getEventDeliveries(currentEventId);
        renderDeliveries();
        
        loadingDiv.style.display = 'none';
        contentDiv.style.display = 'block';
    } catch (err) {
        console.error('Error loading deliveries:', err);
        loadingDiv.innerHTML = '<span style="color: var(--admin-danger);">Failed to load deliveries</span>';
    }
}

function renderDeliveries() {
    const container = document.getElementById('deliveries-list');
    
    if (!deliveriesData || deliveriesData.leads.length === 0) {
        container.innerHTML = '<div class="empty-state">No verified interest leads yet</div>';
        return;
    }
    
    // Group deliveries by lead/email
    const recipientMap = new Map();
    
    // Start with all verified leads
    deliveriesData.leads.forEach(lead => {
        recipientMap.set(lead.email.toLowerCase(), {
            lead: lead,
            deliveries: []
        });
    });
    
    // Add delivery records
    deliveriesData.deliveries.forEach(delivery => {
        const key = delivery.email.toLowerCase();
        if (recipientMap.has(key)) {
            recipientMap.get(key).deliveries.push(delivery);
        }
    });
    
    // Sort recipients alphabetically by name
    const recipients = Array.from(recipientMap.values()).sort((a, b) => {
        const nameA = `${a.lead.firstName} ${a.lead.lastName}`.toLowerCase();
        const nameB = `${b.lead.firstName} ${b.lead.lastName}`.toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    const totalEmails = deliveriesData.totalSequenceEmails || 0;
    
    container.innerHTML = recipients.map(recipient => {
        const { lead, deliveries } = recipient;
        const sentCount = deliveries.filter(d => d.status === 'sent').length;
        const failedCount = deliveries.filter(d => d.status === 'failed').length;
        
        let statusIcon = '';
        let statusClass = '';
        if (sentCount === totalEmails) {
            statusIcon = '✅';
            statusClass = 'complete';
        } else if (failedCount > 0 || (deliveries.length > 0 && sentCount < totalEmails)) {
            statusIcon = '⚠️';
            statusClass = 'partial';
        } else {
            statusIcon = '❌';
            statusClass = 'none';
        }
        
        return `
            <div class="recipient-card ${statusClass}" data-email="${escapeHtml(lead.email)}">
                <div class="recipient-header" onclick="toggleRecipient('${escapeHtml(lead.email)}')">
                    <div class="recipient-info">
                        <span class="status-icon">${statusIcon}</span>
                        <div>
                            <strong>${escapeHtml(lead.firstName)} ${escapeHtml(lead.lastName)}</strong>
                            <div style="color: var(--admin-text-muted); font-size: 0.85rem;">${escapeHtml(lead.email)}</div>
                        </div>
                    </div>
                    <div class="recipient-stats">
                        <span class="email-count">${sentCount}/${totalEmails} emails</span>
                        <span class="expand-icon">▶</span>
                    </div>
                </div>
                <div class="recipient-details" style="display: none;">
                    ${renderRecipientDetails(lead, deliveries, deliveriesData.campaigns)}
                </div>
            </div>
        `;
    }).join('');
}

function renderRecipientDetails(lead, deliveries, campaigns) {
    if (campaigns.length === 0) {
        return '<div style="padding: 16px; color: var(--admin-text-muted);">No sequence emails configured</div>';
    }
    
    // Create a map of deliveries by campaignId
    const deliveryMap = new Map();
    deliveries.forEach(d => deliveryMap.set(d.campaignId, d));
    
    return `
        <div class="deliveries-table">
            ${campaigns.map(campaign => {
                const delivery = deliveryMap.get(campaign.id);
                
                if (!delivery) {
                    return `
                        <div class="delivery-row pending">
                            <div class="delivery-info">
                                <span class="sequence-badge">#${campaign.sequenceOrder}</span>
                                <strong>${escapeHtml(campaign.subject)}</strong>
                            </div>
                            <div class="delivery-status">
                                <span style="color: var(--admin-text-muted);">Not sent yet</span>
                            </div>
                        </div>
                    `;
                }
                
                const isSent = delivery.status === 'sent';
                const statusColor = isSent ? 'var(--admin-success)' : 'var(--admin-danger)';
                const statusText = isSent ? 'Sent' : 'Failed';
                const date = delivery.sentAt || delivery.createdAt;
                const formattedDate = new Date(date).toLocaleString();
                
                return `
                    <div class="delivery-row ${delivery.status}">
                        <div class="delivery-info">
                            <span class="sequence-badge">#${campaign.sequenceOrder}</span>
                            <div>
                                <strong>${escapeHtml(campaign.subject)}</strong>
                                ${delivery.error ? `<div class="error-message">${escapeHtml(delivery.error)}</div>` : ''}
                            </div>
                        </div>
                        <div class="delivery-status">
                            <span style="color: ${statusColor};">${statusText}</span>
                            <span style="color: var(--admin-text-muted); font-size: 0.85rem;">${formattedDate}</span>
                            ${!isSent ? `<button class="btn-sm danger" onclick="retryDelivery('${delivery.id}', event)">Retry</button>` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function toggleRecipient(email) {
    const card = document.querySelector(`.recipient-card[data-email="${email}"]`);
    if (!card) return;
    
    const details = card.querySelector('.recipient-details');
    const expandIcon = card.querySelector('.expand-icon');
    
    if (details.style.display === 'none') {
        details.style.display = 'block';
        expandIcon.textContent = '▼';
    } else {
        details.style.display = 'none';
        expandIcon.textContent = '▶';
    }
}

async function retryDelivery(deliveryId, event) {
    event.stopPropagation();
    
    if (!confirm('Retry sending this email?')) return;
    
    try {
        const result = await API.deliveries.retry(deliveryId);
        alert('Email sent successfully!');
        loadDeliveries(); // Refresh the list
    } catch (err) {
        console.error('Error retrying delivery:', err);
        alert(`Failed to send email: ${err.message || 'Unknown error'}`);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
