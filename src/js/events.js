// ACDC Portal - Events List Page Logic

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const content = document.getElementById('content');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const profileBtn = document.getElementById('profile-btn');
    
    let currentUser = null;
    let allEvents = [];
    let userParticipations = [];
    let userInterestLeads = [];

    // Initialize Auth
    Auth.init();
    
    // Setup modals
    setupProfileModal();
    
    try {
        // Check auth state
        await Auth.handleRedirect();
        
        // Check if logged in (but don't require it)
        const isLoggedIn = Auth.isLoggedIn();
        
        if (isLoggedIn) {
            // Hide login button, show profile/logout
            loginBtn.classList.add('hidden');
            profileBtn.classList.remove('hidden');
            logoutBtn.classList.remove('hidden');
            
            const authUser = Auth.getUser();
            
            // Load user data
            try {
                currentUser = await API.users.getOrNull(authUser.email);
                
                if (!currentUser) {
                    console.log('New user, redirecting to complete registration...');
                    window.location.href = 'complete-registration.html';
                    return;
                }
                
                if (!currentUser.profileComplete) {
                    // Allow interest-only users through — check interest leads by email
                    let hasInterest = false;
                    try {
                        const resp = await fetch(`${API.baseUrl}/interest/leads?verified=true`);
                        if (resp.ok) {
                            const data = await resp.json();
                            const leads = Array.isArray(data) ? data : (data.leads || []);
                            hasInterest = leads.some(l => l.email.toLowerCase() === currentUser.email.toLowerCase());
                        }
                    } catch (e) { /* ignore */ }
                    if (!hasInterest) {
                        window.location.href = 'complete-registration.html';
                        return;
                    }
                }
                
                // Show admin link if user is portal admin (immediate)
                if (currentUser.isPortalAdmin) {
                    showAdminLink('⚙️ Admin');
                }
            } catch (error) {
                console.error('Error loading user:', error);
                window.location.href = 'complete-registration.html';
                return;
            }
            
            // Check for pending invitation and process it
            await processPendingInvitation();
            
            // Load user participations (to know which events they're involved in)
            try {
                const allParticipations = await API.participations.list();
                userParticipations = allParticipations.filter(p => p.userId === currentUser.id);
                
                // Show admin link for committee/judge roles (if not already shown for portalAdmin)
                if (!currentUser.isPortalAdmin) {
                    const hasCommitteeRole = userParticipations.some(p => (p.roles || []).includes('committee'));
                    const hasJudgeRole = userParticipations.some(p => (p.roles || []).includes('judge'));
                    if (hasCommitteeRole) {
                        showAdminLink('⚙️ Committee');
                    } else if (hasJudgeRole) {
                        showAdminLink('⚖️ Judge Portal');
                    }
                }
            } catch (error) {
                console.warn('Could not load participations:', error);
                userParticipations = [];
            }
            
            // Load interest leads for this user's email
            try {
                const response = await fetch(`${API.baseUrl}/interest/leads?verified=true`);
                if (response.ok) {
                    const data = await response.json();
                    const leads = Array.isArray(data) ? data : (data.leads || []);
                    userInterestLeads = leads.filter(l => l.email.toLowerCase() === currentUser.email.toLowerCase());
                }
            } catch (error) {
                console.warn('Could not load interest leads:', error);
                userInterestLeads = [];
            }
            
            // Populate profile form
            populateProfileForm();
        } else {
            // Not logged in - show login button
            loginBtn.classList.remove('hidden');
            profileBtn.classList.add('hidden');
            logoutBtn.classList.add('hidden');
        }
        
        // Load all events
        try {
            allEvents = await API.events.list();
            renderEvents(allEvents);
        } catch (error) {
            console.error('Error loading events:', error);
            loadingDiv.innerHTML = `<p class="error-message">Error loading events: ${error.message}</p>`;
            return;
        }
        
        // Populate profile form
        populateProfileForm();
        
        // Show content
        loadingDiv.classList.add('hidden');
        content.classList.remove('hidden');
        
    } catch (error) {
        console.error('Error loading page:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error loading: ${error.message}</p>
                               <a href="/events.html" class="btn btn-primary">Back to events</a>`;
    }
    
    // Show the admin navigation link with the given label
    function showAdminLink(label) {
        const committeeLink = document.getElementById('committee-link');
        if (committeeLink && committeeLink.classList.contains('hidden')) {
            committeeLink.textContent = label;
            committeeLink.classList.remove('hidden');
        }
    }
    
    // Process pending invitation from URL
    async function processPendingInvitation() {
        const inviteId = sessionStorage.getItem('pendingInvitation');
        if (!inviteId) return;
        
        console.log('Processing pending invitation:', inviteId);
        
        try {
            // Get the invitation details
            const invitation = await API.invitations.get(inviteId);
            
            if (!invitation) {
                console.log('Invitation not found');
                sessionStorage.removeItem('pendingInvitation');
                return;
            }
            
            if (invitation.isExpired) {
                showNotification('This invitation has expired.', 'error');
                sessionStorage.removeItem('pendingInvitation');
                return;
            }
            
            if (invitation.status !== 'pending') {
                console.log('Invitation already processed:', invitation.status);
                sessionStorage.removeItem('pendingInvitation');
                return;
            }
            
            // Check if invitation email matches current user
            if (invitation.email.toLowerCase() !== currentUser.email.toLowerCase()) {
                showNotification(`This invitation was sent to ${invitation.email}. You're logged in as ${currentUser.email}.`, 'error');
                sessionStorage.removeItem('pendingInvitation');
                return;
            }
            
            // Accept the invitation
            const result = await API.invitations.accept(inviteId, currentUser.id, currentUser.email);
            
            if (result.success) {
                // Clear the pending invitation
                sessionStorage.removeItem('pendingInvitation');
                
                // Role-specific success messages and redirects
                if (invitation.role === 'judge') {
                    showNotification(`⚖️ You've been registered as a Judge for "${invitation.eventName || 'the event'}"!`, 'success');
                    if (result.eventId) {
                        setTimeout(() => {
                            window.location.href = `event.html?id=${result.eventId}`;
                        }, 2000);
                    }
                } else if (invitation.role === 'committee') {
                    showNotification(`🏛️ You've joined the Committee for "${invitation.eventName || 'the event'}"!`, 'success');
                    if (result.eventId) {
                        setTimeout(() => {
                            window.location.href = `event.html?id=${result.eventId}`;
                        }, 2000);
                    }
                } else {
                    // Team participant invitation
                    currentUser.teamId = result.teamId;
                    showNotification(`🎉 You've joined team "${result.teamName}"!`, 'success');
                    
                    if (result.eventId) {
                        setTimeout(() => {
                            window.location.href = `event.html?id=${result.eventId}`;
                        }, 2000);
                    } else {
                        setTimeout(() => {
                            window.location.reload();
                        }, 2000);
                    }
                }
            }
        } catch (error) {
            console.error('Error processing invitation:', error);
            showNotification('Error processing invitation: ' + error.message, 'error');
            sessionStorage.removeItem('pendingInvitation');
        }
    }
    
    // Show notification toast
    function showNotification(message, type = 'info') {
        // Remove any existing notification
        const existing = document.querySelector('.notification-toast');
        if (existing) existing.remove();
        
        const colors = {
            success: { bg: '#dcfce7', border: '#16a34a', text: '#166534' },
            error: { bg: '#fee2e2', border: '#dc2626', text: '#991b1b' },
            info: { bg: '#dbeafe', border: '#2563eb', text: '#1e40af' }
        };
        const color = colors[type] || colors.info;
        
        const toast = document.createElement('div');
        toast.className = 'notification-toast';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${color.bg};
            border: 2px solid ${color.border};
            color: ${color.text};
            padding: 16px 24px;
            border-radius: 12px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 10px 40px rgba(0,0,0,0.15);
            animation: slideDown 0.3s ease-out;
        `;
        toast.textContent = message;
        
        // Add animation keyframes if not present
        if (!document.querySelector('#notification-styles')) {
            const style = document.createElement('style');
            style.id = 'notification-styles';
            style.textContent = `
                @keyframes slideDown {
                    from { transform: translateX(-50%) translateY(-100%); opacity: 0; }
                    to { transform: translateX(-50%) translateY(0); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }
        
        document.body.appendChild(toast);
        
        // Remove after 5 seconds
        setTimeout(() => {
            toast.style.animation = 'slideDown 0.3s ease-out reverse';
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    }

    // Render events to the page
    function renderEvents(events) {
        const activeGrid = document.getElementById('active-events-grid');
        const historicalGrid = document.getElementById('historical-events-grid');
        const activeCount = document.getElementById('active-count');
        const historicalCount = document.getElementById('historical-count');
        const noActive = document.getElementById('no-active-events');
        const noHistorical = document.getElementById('no-historical-events');
        
        // Separate active and historical events based on status
        const activeEvents = events.filter(e => e.status === 'pre-registration' || e.status === 'registration' || e.status === 'live');
        const historicalEvents = events.filter(e => e.status === 'completed' || e.status === 'draft');
        
        // Update counts
        activeCount.textContent = activeEvents.length;
        historicalCount.textContent = historicalEvents.length;
        
        // Render active events
        if (activeEvents.length === 0) {
            noActive.classList.remove('hidden');
            activeGrid.classList.add('hidden');
        } else {
            noActive.classList.add('hidden');
            activeGrid.classList.remove('hidden');
            activeGrid.innerHTML = activeEvents.map(event => createEventCard(event, true)).join('');
        }
        
        // Render historical events
        if (historicalEvents.length === 0) {
            noHistorical.classList.remove('hidden');
            historicalGrid.classList.add('hidden');
        } else {
            noHistorical.classList.add('hidden');
            historicalGrid.classList.remove('hidden');
            historicalGrid.innerHTML = historicalEvents.map(event => createEventCard(event, false)).join('');
        }
        
        // Add click handlers to event card action buttons
        document.querySelectorAll('.event-card .btn-card-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // If this is a login-required button, trigger login
                if (btn.classList.contains('login-required')) {
                    Auth.login();
                    return;
                }
                
                const href = btn.dataset.href;
                if (href) window.location.href = href;
            });
        });
        
        // Make the rest of the card clickable too (same destination)
        document.querySelectorAll('.event-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't double-navigate if they clicked the button
                if (e.target.closest('.btn-card-action')) return;
                const btn = card.querySelector('.btn-card-action');
                
                // If login required, trigger login
                if (btn && btn.classList.contains('login-required')) {
                    Auth.login();
                    return;
                }
                
                // Only navigate if there's a valid href
                if (btn && btn.dataset.href && btn.dataset.href !== '') {
                    window.location.href = btn.dataset.href;
                }
            });
        });
    }
    
    // Login button handler
    loginBtn.addEventListener('click', () => {
        Auth.login();
    });
    
    // Determine what the user's relationship is to an event
    function getUserEventContext(event) {
        const status = event.status || 'draft';
        
        // Check if user has a participation with team memberships for this event
        const participation = userParticipations.find(p => p.eventId === event.id);
        const hasTeam = participation && (participation.teamMemberships || []).length > 0;
        
        // Check if user registered interest for this event
        const hasInterest = userInterestLeads.some(l => l.eventId === event.id);
        
        return { status, participation, hasTeam, hasInterest };
    }
    
    // Create an event card HTML
    function createEventCard(event, isActive) {
        const startDate = new Date(event.startDate + 'T12:00:00');
        const endDate = event.endDate ? new Date(event.endDate + 'T12:00:00') : null;
        
        const dateStr = formatDateRange(startDate, endDate);
        
        // Get status
        const status = event.status || 'draft';
        const ctx = getUserEventContext(event);
        
        let statusBadge = '';
        if (status === 'completed') {
            statusBadge = '<span class="status-badge ended">Completed</span>';
        } else if (status === 'live') {
            statusBadge = '<span class="status-badge live">🚀 Live</span>';
        } else if (status === 'registration') {
            statusBadge = '<span class="status-badge open">✓ Registration Open</span>';
        } else if (status === 'pre-registration') {
            statusBadge = '<span class="status-badge preregistration">🔔 Pre-Registration</span>';
        } else {
            statusBadge = '<span class="status-badge closed">Coming Soon</span>';
        }
        
        // Determine button text and destination based on status + user context
        let buttonText = 'View Details';
        let buttonHref = `event.html?id=${event.id}`;
        let buttonClass = 'btn btn-primary btn-small btn-card-action';
        
        // Check if user has a special role for this event
        const userRoles = ctx.participation?.roles || [];
        const isJudge = userRoles.includes('judge');
        const isCommittee = userRoles.includes('committee');
        const isInterest = userRoles.includes('interest');
        let roleBadge = '';
        if (isJudge) {
            roleBadge = '<div style=\"margin-bottom: 10px;\"><span style=\"display: inline-block; background: #fef3c7; color: #92400e; font-size: 0.8rem; font-weight: 600; padding: 4px 12px; border-radius: 20px; border: 1px solid #fbbf24;\">⚖️ You\'re a Judge</span></div>';
        } else if (isCommittee) {
            roleBadge = '<div style=\"margin-bottom: 10px;\"><span style=\"display: inline-block; background: #dbeafe; color: #1e40af; font-size: 0.8rem; font-weight: 600; padding: 4px 12px; border-radius: 20px; border: 1px solid #60a5fa;\">🏛️ Committee Member</span></div>';
        } else if (isInterest) {
            roleBadge = '<div style=\"margin-bottom: 10px;\"><span style=\"display: inline-block; background: #dcfce7; color: #15803d; font-size: 0.8rem; font-weight: 600; padding: 4px 12px; border-radius: 20px; border: 1px solid #4ade80;\">🔔 Interest Registered</span></div>';
        }
        
        if (status === 'pre-registration') {
            if (ctx.hasInterest || isInterest) {
                buttonText = 'View Event';
                buttonHref = `event.html?id=${event.id}`;
            } else {
                buttonText = '🔔 Register Interest';
                buttonHref = `register.html?intent=interest&eventId=${event.id}`;
            }
        } else if (status === 'registration') {
            if (ctx.hasTeam || isJudge || isCommittee || isInterest) {
                buttonText = 'View Event';
                buttonHref = `event.html?id=${event.id}`;
            } else if (!currentUser) {
                // Not logged in - prompt to sign in
                buttonText = '🔑 Sign In to Register';
                buttonHref = ''; // Will trigger login via click handler
                buttonClass = 'btn btn-primary btn-small btn-card-action login-required';
            } else {
                buttonText = '📝 Register Team';
                buttonHref = `event.html?id=${event.id}`;
            }
        } else if (status === 'live' || status === 'completed') {
            buttonText = 'View Event';
            buttonHref = `event.html?id=${event.id}`;
        }
        
        return `
            <div class="event-card ${isActive ? 'active' : 'inactive'}" data-event-id="${event.id}">
                <div class="event-card-header">
                    <h3>${escapeHtml(event.name)}</h3>
                    <div class="event-dates">
                        📅 ${dateStr}
                    </div>
                </div>
                <div class="event-card-body">
                    ${roleBadge}
                    <div class="event-location">
                        📍 ${escapeHtml(event.location || 'Location TBD')}
                    </div>
                    <div class="event-stats">
                        <span>👥 Teams: ${event.teamCount || 0}</span>
                        <span>🎟️ Participants: ${event.participantCount || 0}</span>
                    </div>
                </div>
                <div class="event-card-footer">
                    ${statusBadge}
                    <button class="${buttonClass}" data-href="${buttonHref}">${buttonText}</button>
                </div>
            </div>
        `;
    }
    
    // Format date range
    function formatDateRange(start, end) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        if (end) {
            if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
                return `${months[start.getMonth()]} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`;
            }
            return `${months[start.getMonth()]} ${start.getDate()} - ${months[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
        }
        return `${months[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
    }
    
    // Escape HTML to prevent XSS
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Setup profile modal
    function setupProfileModal() {
        const profileModal = document.getElementById('profile-modal');
        
        profileBtn.addEventListener('click', () => profileModal.classList.add('active'));
        document.getElementById('close-profile').addEventListener('click', () => profileModal.classList.remove('active'));
        
        // Close on overlay click
        profileModal.addEventListener('click', (e) => {
            if (e.target === profileModal) {
                profileModal.classList.remove('active');
            }
        });
        
        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                profileModal.classList.remove('active');
            }
        });
        
        // Profile form submit
        document.getElementById('profile-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveProfile();
        });
    }
    
    // Populate profile form
    function populateProfileForm() {
        if (!currentUser) return;
        
        document.getElementById('firstName').value = currentUser.firstName || '';
        document.getElementById('lastName').value = currentUser.lastName || '';
        document.getElementById('email').value = currentUser.email || '';
        document.getElementById('phone').value = currentUser.phone || '';
        document.getElementById('gamertag').value = currentUser.gamertag || '';
        document.getElementById('allergies').value = currentUser.allergies || '';
    }
    
    // Save profile
    async function saveProfile() {
        const saveBtn = document.getElementById('save-btn');
        const errorDiv = document.getElementById('profile-error');
        const successDiv = document.getElementById('profile-success');
        
        const formData = {
            firstName: document.getElementById('firstName').value.trim(),
            lastName: document.getElementById('lastName').value.trim(),
            phone: document.getElementById('phone').value.trim(),
            gamertag: document.getElementById('gamertag').value.trim(),
            allergies: document.getElementById('allergies').value.trim(),
            profileComplete: true
        };

        saveBtn.disabled = true;
        saveBtn.querySelector('.btn-text').classList.add('hidden');
        saveBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');

        try {
            await API.users.update(currentUser.id, formData);
            currentUser = { ...currentUser, ...formData };
            
            successDiv.textContent = 'Profile saved!';
            successDiv.classList.remove('hidden');
            
            setTimeout(() => {
                document.getElementById('profile-modal').classList.remove('active');
            }, 1500);
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Could not save profile.';
            errorDiv.classList.remove('hidden');
        } finally {
            saveBtn.disabled = false;
            saveBtn.querySelector('.btn-text').classList.remove('hidden');
            saveBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }

    // Logout
    logoutBtn.addEventListener('click', async () => {
        await Auth.logout();
    });
});

console.log('Events page script loaded');
