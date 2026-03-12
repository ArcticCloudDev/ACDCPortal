// ACDC Portal - Event Detail Page Logic

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>');
        }
    }, 1200);
    const content = document.getElementById('content');
    
    let currentUser = null;
    let currentEvent = null;
    let currentParticipation = null;
    let eventTeams = [];
    let allParticipations = [];
    let allUsers = [];
    let currentSoloQueueEntry = null;
    let eventBadges = [];      // enriched event-badge assignments
    let badgeClaims = [];      // all claims for this event

    // Get event ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    const eventId = urlParams.get('id');
    
    if (!eventId) {
        window.location.href = 'events.html';
        return;
    }

    // Initialize Auth
    Auth.init();
    
    // Setup modals
    setupModals();
    
    try {
        // Check auth state
        await Auth.handleRedirect();
        
        // Check if logged in
        if (!Auth.isLoggedIn()) {
            window.location.href = '/events.html';
            return;
        }
        
        const authUser = Auth.getUser();
        
        // Load user data
        try {
            currentUser = await API.users.getOrNull(authUser.email);
            
            if (!currentUser) {
                window.location.href = 'complete-registration.html';
                return;
            }
            
            // If profile not complete, check if they have a participation or interest before redirecting
            if (!currentUser.profileComplete) {
                let hasExistingRelationship = false;
                try {
                    // Check for existing participation (team member, judge, committee, etc.)
                    const participation = await API.participations.getOrNull(currentUser.id, eventId);
                    if (participation) {
                        hasExistingRelationship = true;
                    }
                } catch (e) { /* ignore */ }
                if (!hasExistingRelationship) {
                    try {
                        const resp = await fetch(`${API.baseUrl}/interest/leads?verified=true`);
                        if (resp.ok) {
                            const data = await resp.json();
                            const leads = Array.isArray(data) ? data : (data.leads || []);
                            hasExistingRelationship = leads.some(l => 
                                l.email.toLowerCase() === currentUser.email.toLowerCase() && 
                                l.eventId === eventId
                            );
                        }
                    } catch (e) { /* ignore */ }
                }
                if (!hasExistingRelationship) {
                    window.location.href = 'complete-registration.html';
                    return;
                }
            }
        } catch (error) {
            console.error('Error loading user:', error);
            window.location.href = 'complete-registration.html';
            return;
        }
        
        // Load event
        try {
            currentEvent = await API.events.get(eventId);
        } catch (error) {
            console.error('Error loading event:', error);
            loadingDiv.innerHTML = `<p class="error-message">Event not found</p>
                                   <a href="events.html" class="btn btn-primary">Back to Events</a>`;
            return;
        }
        
        // Load or create participation
        currentParticipation = await API.participations.getOrNull(currentUser.id, eventId);
        
        if (!currentParticipation) {
            currentParticipation = await API.participations.upsert({
                userId: currentUser.id,
                eventId: eventId,
                hotelNights: { 'thu-sun': true }
            });
        }

        // Sync interest role: if user has a verified interest lead, ensure 'interest' is on participation
        if (!currentParticipation.roles || !currentParticipation.roles.includes('interest')) {
            try {
                const resp = await fetch(`${API.baseUrl}/interest/leads?verified=true`);
                if (resp.ok) {
                    const data = await resp.json();
                    const leads = Array.isArray(data) ? data : (data.leads || []);
                    const hasInterestLead = leads.some(l =>
                        l.email.toLowerCase() === currentUser.email.toLowerCase() &&
                        l.eventId === eventId
                    );
                    if (hasInterestLead) {
                        await API.participations.addRoles(currentParticipation.id, ['interest']);
                        if (!currentParticipation.roles) currentParticipation.roles = [];
                        currentParticipation.roles.push('interest');
                    }
                }
            } catch (e) {
                console.error('Failed to sync interest role:', e);
            }
        }
        
        // Load teams for this event
        await loadEventTeams();
        
        // Populate the page
        populateEventBanner();
        await renderTeams();
        
        // Render badges section and show nav tabs only for team participants
        renderBadgesSection();
        const teamMemberships = Array.isArray(currentParticipation?.teamMemberships)
            ? currentParticipation.teamMemberships
            : [];
        const isTeamParticipant = !!currentParticipation?.teamId || !!currentParticipation?.isTeamAdmin || teamMemberships.length > 0;

        if (isTeamParticipant && eventBadges && eventBadges.length > 0) {
            document.getElementById('event-nav')?.classList.remove('hidden');
        } else {
            document.getElementById('event-nav')?.classList.add('hidden');
        }
        
        // Check solo queue status
        await checkSoloQueueStatus();
        
        // Show content
        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        content.classList.remove('hidden');
        
    } catch (error) {
        console.error('Error loading page:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error loading: ${error.message}</p>
                               <a href="events.html" class="btn btn-primary">Back to Events</a>`;
    }

    // Load teams for this event
    async function loadEventTeams() {
        try {
            // Get all teams (we'll filter by eventId)
            const allTeams = await API.request('/teams');
            eventTeams = allTeams.filter(t => t.eventId === eventId);
            
            // Load all participations for this event to get member counts
            allParticipations = await API.participations.getByEvent(eventId);

            // Load event badges and claims
            try {
                eventBadges = await API.badges.getEventBadges(eventId);
                badgeClaims = await API.badgeClaims.list({ eventId: eventId });
            } catch (err) {
                console.error('Error loading badges:', err);
                eventBadges = [];
                badgeClaims = [];
            }
        } catch (error) {
            console.error('Error loading teams:', error);
            eventTeams = [];
        }
    }
    
    // Populate event banner using shared SiteHeader component
    function populateEventBanner() {
        // Determine status display
        const status = currentEvent.status || 'draft';
        let statusText = 'Coming Soon';
        if (status === 'live') statusText = '🚀 Live';
        else if (status === 'registration') statusText = '✓ Registration Open';
        else if (status === 'pre-registration') statusText = '🔔 Pre-Registration';
        else if (status === 'completed') statusText = '✓ Completed';

        SiteHeader.render({
            title: currentEvent.name,
            subtitle: null,
            infoBadges: [
                { icon: '📅', text: formatDateRange(currentEvent.startDate, currentEvent.endDate), id: 'event-dates' },
                { icon: '📍', text: currentEvent.location || 'TBD', id: 'event-location' },
                { text: statusText, id: 'event-status', className: 'status-badge' }
            ],
            showSignIn: false,
            inactive: false
        });
        
        // Check if user is admin (committee or judge)
        const userRoles = currentParticipation?.roles || [];
        const isAdmin = userRoles.includes('committee') || userRoles.includes('judge');
        
        SiteHeader.update({ authUser: Auth.getUser(), user: currentUser, isAdmin });

        // Apply status-specific background to the badge
        const statusEl = document.getElementById('event-status');
        if (statusEl) {
            if (status === 'live') statusEl.style.background = 'rgba(16, 185, 129, 0.3)';
            else if (status === 'registration') statusEl.style.background = 'rgba(40, 167, 69, 0.3)';
            else if (status === 'pre-registration') statusEl.style.background = 'rgba(245, 158, 11, 0.3)';
            else statusEl.style.background = 'rgba(100, 116, 139, 0.3)';
        }

        const banner = SiteHeader.getElements().container;
        
        // Check user's roles for this event
        const isJudge = userRoles.includes('judge');
        const isCommittee = userRoles.includes('committee');
        // Interest is only a "special role" if the user hasn't been upgraded to a team participant
        const hasTeam = currentParticipation?.teamId || (currentParticipation?.teamMemberships?.length > 0);
        const isInterest = userRoles.includes('interest') && !hasTeam;
        const hasSpecialRole = isJudge || isCommittee || isInterest;
        
        // If user is a judge or committee member, show the role confirmation view
        if (hasSpecialRole) {
            // Don't grey out the banner for role holders
            banner.classList.remove('inactive');

            // Special-role users should not see team/badges tabs
            document.getElementById('event-nav')?.classList.add('hidden');
            
            // Hide all participant-facing sections
            const preRegSection = document.getElementById('pre-reg-section');
            if (preRegSection) preRegSection.classList.add('hidden');
            const teamsSection = document.querySelector('.teams-section');
            if (teamsSection) teamsSection.classList.add('hidden');
            const noTeams = document.getElementById('no-teams');
            if (noTeams) noTeams.classList.add('hidden');
            const createSection = document.getElementById('create-team-section');
            if (createSection) createSection.classList.add('hidden');
            
            // Show the role confirmation section
            const roleSection = document.getElementById('role-confirmed-section');
            if (roleSection) {
                roleSection.classList.remove('hidden');
                
                if (isJudge) {
                    roleSection.classList.add('judge');
                    document.getElementById('role-confirmed-icon').textContent = '⚖️';
                    document.getElementById('role-confirmed-title').textContent = `You're a Judge for ${currentEvent.name}`;
                    document.getElementById('role-confirmed-message').textContent = 
                        `You've been registered as a judge for this event. We'll notify you when judging details are available.`;
                    document.getElementById('role-confirmed-badge').textContent = '✓ Judge — Confirmed';
                    document.getElementById('role-confirmed-details').innerHTML = 
                        `📅 ${formatDateRange(currentEvent.startDate, currentEvent.endDate)}` +
                        (currentEvent.location ? ` &nbsp;•&nbsp; 📍 ${currentEvent.location}` : '') +
                        `<br><span style="margin-top: 8px; display: inline-block;">We'll be in touch with judging criteria, schedules, and logistics closer to the event.</span>`;
                    // Show admin portal link for judges
                    const adminLink = document.getElementById('role-admin-link');
                    if (adminLink) {
                        adminLink.textContent = '⚖️ Open Judge Portal';
                        adminLink.classList.remove('hidden');
                    }
                } else if (isCommittee) {
                    roleSection.classList.add('committee');
                    document.getElementById('role-confirmed-icon').textContent = '🏛️';
                    document.getElementById('role-confirmed-title').textContent = `You're on the Committee for ${currentEvent.name}`;
                    document.getElementById('role-confirmed-message').textContent = 
                        `You've been registered as a committee member for this event. We'll notify you as things progress.`;
                    document.getElementById('role-confirmed-badge').textContent = '✓ Committee Member — Confirmed';
                    document.getElementById('role-confirmed-details').innerHTML = 
                        `📅 ${formatDateRange(currentEvent.startDate, currentEvent.endDate)}` +
                        (currentEvent.location ? ` &nbsp;•&nbsp; 📍 ${currentEvent.location}` : '') +
                        `<br><span style="margin-top: 8px; display: inline-block;">You'll receive updates as the event planning progresses.</span>`;
                    // Show admin portal link for committee
                    const adminLink = document.getElementById('role-admin-link');
                    if (adminLink) {
                        adminLink.textContent = '🏛️ Open Committee Portal';
                        adminLink.classList.remove('hidden');
                    }
                } else if (isInterest) {
                    roleSection.classList.add('interest');
                    document.getElementById('role-confirmed-icon').textContent = '🔔';
                    document.getElementById('role-confirmed-title').textContent = `You've registered interest for ${currentEvent.name}`;
                    document.getElementById('role-confirmed-message').textContent = 
                        `We'll notify you when registration opens. You'll be among the first to know!`;
                    document.getElementById('role-confirmed-badge').textContent = '✓ Interest Registered';
                    document.getElementById('role-confirmed-details').innerHTML = 
                        `📅 ${formatDateRange(currentEvent.startDate, currentEvent.endDate)}` +
                        (currentEvent.location ? ` &nbsp;•&nbsp; 📍 ${currentEvent.location}` : '') +
                        `<br><span style="margin-top: 8px; display: inline-block;">Keep an eye on your inbox — we'll send updates as the event takes shape.</span>`;

                    // Show upgrade options if event is open for registration
                    const eventStatus = currentEvent.status || 'draft';
                    if (eventStatus === 'registration-open' || eventStatus === 'pre-registration' || currentEvent.registrationOpen) {
                        const upgradeDiv = document.getElementById('interest-upgrade-actions');
                        if (upgradeDiv) upgradeDiv.classList.remove('hidden');
                        // Set eventId on the register team link
                        const upgradeLink = document.getElementById('upgrade-register-team-link');
                        if (upgradeLink) upgradeLink.href = `register.html?intent=team&eventId=${currentEvent.id}`;
                    }
                }

                // Interest-only users don't need hotel or edit buttons
                if (isInterest && !isJudge && !isCommittee) {
                    const editBtn = document.getElementById('edit-details-btn');
                    if (editBtn) editBtn.classList.add('hidden');
                } else {
                    // Show hotel urgency alert if hotel nights not filled in
                    updateRoleHotelAlert();
                }
            }
            // Don't return — let page continue so modal infrastructure is available
            // (but participant-facing sections are already hidden above)
        }
        
        // Check if event is completed/historical or not open for team registration
        if (status === 'completed' || status === 'draft' || status === 'pre-registration') {
            banner.classList.add('inactive');
            const createSection = document.getElementById('create-team-section');
            if (createSection) createSection.classList.add('hidden');
        }
        
        // Show pre-registration section with interest link (only if user hasn't already registered interest)
        if (status === 'pre-registration' && !hasSpecialRole) {
            const preRegSection = document.getElementById('pre-reg-section');
            if (preRegSection) {
                preRegSection.classList.remove('hidden');
                const interestLink = document.getElementById('interest-link');
                if (interestLink) {
                    interestLink.href = `register.html?intent=interest&eventId=${currentEvent.id}`;
                }
            }
            // Hide the teams area — nothing to show yet
            const teamsSection = document.querySelector('.teams-section');
            if (teamsSection) teamsSection.classList.add('hidden');
            const noTeams = document.getElementById('no-teams');
            if (noTeams) noTeams.classList.add('hidden');
        }
    }
    
    // Render teams grid
    async function renderTeams() {
        const teamsContainer = document.getElementById('my-teams-container');
        const noTeams = document.getElementById('no-teams');
        const createSection = document.getElementById('create-team-section');
        
        // Filter to only show teams where user is admin or participant
        // Portal admins and committee members see all teams
        const isPrivileged = currentUser.isPortalAdmin || 
            (currentParticipation?.roles || []).includes('committee');
        const userTeamIds = new Set(
            (currentParticipation?.teamMemberships || []).map(m => m.teamId)
        );
        // Also include the direct teamId from participation (set during registration)
        if (currentParticipation?.teamId) {
            userTeamIds.add(currentParticipation.teamId);
        }
        const myTeams = isPrivileged ? eventTeams : eventTeams.filter(t => userTeamIds.has(t.id));
        
        if (myTeams.length === 0) {
            teamsContainer.classList.add('hidden');
            noTeams.classList.remove('hidden');
            // Don't show create/solo buttons for judges, committee, or interest-only users
            const roles = currentParticipation?.roles || [];
            const isSpecialRole = roles.includes('judge') || roles.includes('committee') ||
                (roles.includes('interest') && !currentParticipation?.teamId);
            if (createSection && !isSpecialRole) createSection.classList.remove('hidden');
        } else {
            teamsContainer.classList.remove('hidden');
            noTeams.classList.add('hidden');
            // Hide "Create New Team / Join Solo Queue" — user already has a team
            if (createSection) createSection.classList.add('hidden');
            
            // Build team cards with participants
            const teamCardsHtml = await Promise.all(myTeams.map(async team => {
                return await buildTeamCard(team);
            }));
            
            teamsContainer.innerHTML = teamCardsHtml.join('');
            
            // Add click handlers for edit participant buttons
            document.querySelectorAll('.edit-participant-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const card = btn.closest('.participant-card');
                    const userId = card.dataset.userId;
                    const participationId = card.dataset.participationId;
                    const teamId = card.dataset.teamId;
                    openParticipantEdit(userId, participationId, teamId);
                });
            });
            
            // Add click handlers for add member slots (+ buttons)
            document.querySelectorAll('.add-member-slot').forEach(slot => {
                slot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const teamId = slot.dataset.teamId;
                    openInviteMember(teamId);
                });
            });
            
            // Add click handlers for unlock slots
            document.querySelectorAll('.unlock-slot').forEach(slot => {
                slot.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const teamId = slot.dataset.teamId;
                    await unlockTeamSlot(teamId);
                });
            });
            
            // Add click handlers for delete team buttons
            document.querySelectorAll('.btn-delete-team').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const teamId = btn.dataset.teamId;
                    const teamName = btn.dataset.teamName;
                    await deleteTeam(teamId, teamName);
                });
            });
            
            // Add file upload handlers
            setupFileUploadHandlers();
        }
        
        // Hide create button if registration not open
        const status = currentEvent.status || 'draft';
        if (status !== 'registration') {
            createSection.classList.add('hidden');
        }
    }
    
    // Setup file upload handlers for team deliverables
    function setupFileUploadHandlers() {
        // File upload inputs
        document.querySelectorAll('input[id^="file-"]').forEach(input => {
            input.addEventListener('change', async (e) => {
                const teamId = input.id.replace('file-', '');
                const file = e.target.files[0];
                const categorySelect = document.getElementById(`file-cat-${teamId}`);
                const category = categorySelect ? categorySelect.value : 'General';
                if (file) {
                    await handleFileUpload(teamId, category, file);
                }
            });
        });
        
        // Remove file buttons
        document.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const teamId = btn.dataset.teamId;
                const filePath = btn.dataset.filePath;
                if (filePath) {
                    await handleFileRemove(teamId, filePath);
                }
            });
        });
    }
    
    // Handle file upload — POST multipart to API which uploads to SharePoint
    async function handleFileUpload(teamId, category, file) {
        const progressEl = document.getElementById(`upload-progress-${teamId}`);
        const uploadBtn = document.getElementById(`upload-btn-${teamId}`);

        // Validate file size client-side
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
            alert('File too large. Maximum size is 10 MB.');
            return;
        }

        try {
            if (progressEl) {
                progressEl.classList.remove('hidden');
                progressEl.textContent = `⏳ Uploading "${file.name}"…`;
            }
            if (uploadBtn) uploadBtn.disabled = true;

            const url = `${CONFIG.api.baseUrl}/files/upload?eventId=${encodeURIComponent(currentEvent.id)}&teamId=${encodeURIComponent(teamId)}&category=${encodeURIComponent(category)}`;

            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(url, {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Upload failed' }));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            const result = await res.json();
            if (result.file?.metadataWarning) {
                console.warn('Metadata warning:', result.file.metadataWarning);
            }

            if (progressEl) {
                progressEl.textContent = `✅ "${file.name}" uploaded successfully!`;
                setTimeout(() => progressEl.classList.add('hidden'), 3000);
            }

            // Refresh the team cards to show the new file
            await loadEventTeams();
            await renderTeams();

        } catch (error) {
            console.error('File upload error:', error);
            if (progressEl) {
                progressEl.textContent = `❌ Upload failed: ${error.message}`;
                progressEl.classList.remove('hidden');
            }
            alert('Failed to upload file: ' + error.message);
        } finally {
            if (uploadBtn) uploadBtn.disabled = false;
        }
    }

    // Handle file removal — DELETE via API (removes from SharePoint)
    async function handleFileRemove(teamId, filePath) {
        if (!confirm('Are you sure you want to remove this file from SharePoint?')) return;

        try {
            const url = `${CONFIG.api.baseUrl}/files/delete?path=${encodeURIComponent(filePath)}`;
            const res = await fetch(url, { method: 'DELETE' });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Delete failed' }));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            await loadEventTeams();
            await renderTeams();

        } catch (error) {
            console.error('File remove error:', error);
            alert('Failed to remove file: ' + error.message);
        }
    }
    
    // Delete a team (portal admin / committee only)
    async function deleteTeam(teamId, teamName) {
        if (!confirm(`Are you sure you want to delete team "${teamName}"?\n\nThis will also remove:\n• Team memberships from all participants\n• Hotel bookings (for participants with no other role)\n• Badge claims for this team\n• Pending invitations\n\nThis action cannot be undone.`)) {
            return;
        }
        try {
            await API.teams.delete(teamId);
            eventTeams = eventTeams.filter(t => t.id !== teamId);
            await renderTeams();
        } catch (error) {
            console.error('Error deleting team:', error);
            alert('Failed to delete team: ' + error.message);
        }
    }
    
    // Build a single team card with participants grid
    async function buildTeamCard(team) {
        const teamParticipations = allParticipations.filter(p => {
            const memberships = p.teamMemberships || [];
            return memberships.some(m => m.teamId === team.id);
        });
        
        // Get participant count and find admin
        let participantCount = 0;
        let adminParticipation = null;
        let adminUser = null;
        
        for (const p of teamParticipations) {
            const membership = (p.teamMemberships || []).find(m => m.teamId === team.id);
            if (membership && membership.isParticipant) participantCount++;
            if (membership && membership.isAdmin && !adminParticipation) {
                adminParticipation = p;
            }
        }
        
        // Load admin user info
        if (adminParticipation) {
            try {
                adminUser = await API.request(`/users/${adminParticipation.userId}`);
            } catch (err) {
                console.error('Could not load admin user:', err);
            }
        }
        
        // Check if current user is admin
        const userMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === team.id);
        const isAdmin = userMembership?.isAdmin || false;
        const isParticipant = userMembership?.isParticipant || false;
        
        // Load user details for participants (separating real and TBD)
        const allParticipantCards = await Promise.all(
            teamParticipations.map(async (p) => {
                try {
                    const user = await API.request(`/users/${p.userId}`);
                    const membership = (p.teamMemberships || []).find(m => m.teamId === team.id);
                    // User can edit if they are admin OR if this is their own participation
                    const canEdit = isAdmin || (p.userId === currentUser.id);
                    return { user, membership, participation: p, canEdit, isTBD: user.isTBD || false };
                } catch (err) {
                    return null;
                }
            })
        );
        
        // Build participant cards (only real members, no TBD)
        const participantCards = allParticipantCards
            .filter(p => p !== null && !p.isTBD)
            .map(p => buildParticipantCard(p.user, p.membership, p.participation, p.canEdit, team.id));
        
        // Get max team size from event, committed from team
        const maxParticipants = currentEvent.maxTeamSize || 5;
        const committedParticipants = team.committedParticipants || team.numberOfParticipants || maxParticipants;
        
        // Count actual participants (not TBD)
        const realParticipantCount = allParticipantCards.filter(p => p !== null && !p.isTBD && p.membership?.isParticipant).length;
        
        // Load pending invitations for this team
        let pendingInvitations = [];
        try {
            const teamInvitations = await API.invitations.list(team.id);
            pendingInvitations = (teamInvitations || []).filter(i => i.status === 'pending');
        } catch (err) {
            console.error('Error loading invitations for team:', err);
        }
        
        // Calculate empty committed slots (show as + buttons), accounting for pending invites
        const filledOrPendingCount = realParticipantCount + pendingInvitations.length;
        const emptyCommittedSlots = Math.max(0, committedParticipants - filledOrPendingCount);
        
        // Calculate unlock slots (slots beyond committed count)
        const unlockSlots = Math.max(0, maxParticipants - committedParticipants);
        
        // Build pending invitation cards
        let pendingCardsHtml = '';
        if (pendingInvitations.length > 0) {
            pendingCardsHtml = pendingInvitations.map(inv => `
                <div class="participant-card pending-card">
                    <div class="pending-icon">✉️</div>
                    <div class="name">Invitation Sent</div>
                    <div class="detail-row email">${escapeHtml(inv.email)}</div>
                    <div class="roles">
                        <span class="role-tag pending">⏳ Pending</span>
                    </div>
                    <div class="pending-date">Sent ${new Date(inv.createdAt).toLocaleDateString()}</div>
                </div>
            `).join('');
        }
        
        // Build empty slot buttons for unfilled committed spots (only if admin)
        let emptySlotsHtml = '';
        if (isAdmin && emptyCommittedSlots > 0) {
            emptySlotsHtml = Array(emptyCommittedSlots).fill(`
                <div class="empty-slot add-member-slot" data-team-id="${team.id}">
                    <span class="add-icon">+</span>
                    <span class="add-text">Add Member</span>
                </div>
            `).join('');
        }
        
        // Build unlock slot HTML - just one button to unlock 1 more slot at a time
        let unlockSlotsHtml = '';
        if (isAdmin && unlockSlots > 0) {
            unlockSlotsHtml = `
                <div class="unlock-slot" data-team-id="${team.id}">
                    <span class="unlock-icon">🔓</span>
                    <span class="unlock-text">Unlock 1 more</span>
                </div>
            `;
        }
        
        // Build uploads section for all team members (if SharePoint is configured)
        const uploadsHtml = currentEvent.sharepointUrl ? await buildUploadsSection(team) : '';
        
        // Build admin display for header
        const adminDisplay = adminUser 
            ? `<span class="team-admin-info">Admin: ${escapeHtml(adminUser.firstName)} ${escapeHtml(adminUser.lastName)}</span>`
            : '';
        
        // Check if current user can delete teams (portal admin or committee for this event)
        const canDeleteTeam = currentUser.isPortalAdmin || 
            (currentParticipation?.roles || []).includes('committee');
        
        const deleteButtonHtml = canDeleteTeam ? `
            <button class="btn-delete-team" data-team-id="${team.id}" data-team-name="${escapeHtml(team.teamName)}" title="Delete team" style="background: none; border: 1px solid #fca5a5; color: #dc2626; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 0.85rem;">🗑️</button>
        ` : '';
        
        return `
            <div class="team-card" data-team-id="${team.id}">
                <div class="team-card-body">
                    <div class="team-stats">
                        <span>👥 ${realParticipantCount}/${committedParticipants} committed</span>
                        ${pendingInvitations.length > 0 ? `<span>✉️ ${pendingInvitations.length} pending</span>` : ''}
                        <span>${emptyCommittedSlots > 0 ? `📋 ${emptyCommittedSlots} open` : '✓ Full'}</span>
                    </div>
                    <div class="participants-grid">
                        ${participantCards.join('')}
                        ${pendingCardsHtml}
                        ${emptySlotsHtml}
                        ${unlockSlotsHtml}
                    </div>
                    ${uploadsHtml}
                </div>
            </div>
        `;
    }
    
    // Build uploads section — loads files from SharePoint API
    async function buildUploadsSection(team) {
        const categories = (currentEvent.fileCategories && currentEvent.fileCategories.length > 0)
            ? currentEvent.fileCategories
            : ['General'];

        // Load files from SharePoint
        let spFiles = [];
        try {
            const res = await fetch(`${CONFIG.api.baseUrl}/files/list?eventId=${encodeURIComponent(currentEvent.id)}&teamId=${encodeURIComponent(team.id)}`);
            if (res.ok) {
                spFiles = (await res.json()).filter(f => !f.isFolder);
            }
        } catch (err) {
            console.warn('Could not load SharePoint files:', err);
        }

        const filesHtml = spFiles.length > 0
            ? `<div class="uploaded-files-list">
                ${spFiles.map(f => `
                    <div class="uploaded-file-row">
                        <span class="file-category-badge">${escapeHtml(f.category || 'General')}</span>
                        <a href="${escapeHtml(f.webUrl)}" target="_blank" rel="noopener" class="file-name file-link">${escapeHtml(f.name)}</a>
                        <span class="file-size">${formatFileSize(f.size)}</span>
                        <button class="btn-remove" data-team-id="${team.id}" data-file-path="Events/${currentEvent.id}/${team.id}/${f.name}" title="Remove">✕</button>
                    </div>
                `).join('')}
              </div>`
            : '<p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 12px;">No files uploaded yet.</p>';

        return `
            <div class="team-uploads">
                <h4>📁 Team Deliverables</h4>
                ${filesHtml}
                <div class="upload-box">
                    <div class="upload-row">
                        <select id="file-cat-${team.id}" class="upload-category-select">
                            ${categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
                        </select>
                        <input type="file" id="file-${team.id}" style="display:none;" accept="*/*">
                        <button class="btn btn-secondary btn-upload" id="upload-btn-${team.id}" onclick="document.getElementById('file-${team.id}').click()">📎 Upload File</button>
                    </div>
                    <div id="upload-progress-${team.id}" class="upload-progress hidden"></div>
                </div>
                <small style="color: var(--text-muted); display: block; margin-top: 6px;">Max 10 MB per file.</small>
            </div>
        `;
    }

    function formatFileSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // Render badges into the standalone #badges-section container
    function renderBadgesSection() {
        const container = document.getElementById('badges-section');
        if (!container) return;
        if (!eventBadges || eventBadges.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted); text-align:center; padding:32px;">No badges available for this event.</p>';
            return;
        }

        // Find user's primary team
        const badgeTeamIds = new Set(
            (currentParticipation?.teamMemberships || []).map(m => m.teamId)
        );
        if (currentParticipation?.teamId) badgeTeamIds.add(currentParticipation.teamId);
        const myTeam = eventTeams.find(t => badgeTeamIds.has(t.id));
        const teamId = myTeam?.id || '';

        // Check if user is admin on this team
        const myMembership = (currentParticipation?.teamMemberships || []).find(m => m.teamId === teamId);
        const isAdmin = myMembership?.isAdmin || currentParticipation?.isTeamAdmin || false;

        // Get team participants for assign dropdown
        const teamParticipations = allParticipations.filter(p => {
            const memberships = p.teamMemberships || [];
            return memberships.some(m => m.teamId === teamId);
        });
        const memberOptions = teamParticipations
            .filter(p => {
                const m = (p.teamMemberships || []).find(m => m.teamId === teamId);
                return m?.isParticipant;
            })
            .map(p => ({
                userId: p.userId,
                name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.email
            }));

        // Group badges by category
        const categoryOrder = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3 };
        const categoryLabels = { 'soft': '🤝 Soft Skills', 'low-code': '⚡ Low-Code', 'pro-code': '💻 Pro-Code', 'sponsor': '🏢 Sponsor' };

        // Get claims for this team
        const teamClaims = teamId ? badgeClaims.filter(c => c.teamId === teamId) : [];

        // Check if user is judge or committee (can award exclusive badges)
        const userRoles = currentParticipation?.roles || [];
        const isJudge = userRoles.includes('judge');
        const isCommittee = userRoles.includes('committee');
        const canAward = isJudge || isCommittee;

        // Collect badges grouped
        const grouped = {};
        for (const eb of eventBadges) {
            const badge = eb.badge;
            if (!badge || !eb.isActive) continue;
            const cat = badge.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push({ eventBadge: eb, badge });
        }

        // Sort groups by category order
        const sortedCategories = Object.keys(grouped).sort((a, b) =>
            (categoryOrder[a] ?? 99) - (categoryOrder[b] ?? 99)
        );

        // Count stats
        const claimedCount = teamClaims.filter(c => c.status === 'pending' || c.status === 'approved').length;
        const approvedCount = teamClaims.filter(c => c.status === 'approved').length;
        const totalBadges = eventBadges.filter(eb => eb.isActive).length;

        // Calculate total points
        const earnedPoints = teamClaims
            .filter(c => c.status === 'approved')
            .reduce((sum, c) => {
                const eb = eventBadges.find(e => e.id === c.eventBadgeId);
                return sum + (eb?.badge?.points || 0);
            }, 0);
        const totalPoints = eventBadges
            .filter(eb => eb.isActive && eb.badge)
            .reduce((sum, eb) => sum + (eb.badge.points || 0), 0);

        // Update the nav count badge
        const navCount = document.getElementById('badges-nav-count');
        if (navCount) navCount.textContent = `${claimedCount}/${totalBadges}`;

        // Build category tabs
        const tabsHtml = sortedCategories.map((cat, i) => {
            const label = categoryLabels[cat] || cat;
            const catBadges = grouped[cat];
            const catClaimed = catBadges.filter(({ eventBadge }) => {
                return teamClaims.some(c => c.eventBadgeId === eventBadge.id && (c.status === 'pending' || c.status === 'approved'));
            }).length;
            return `<button class="badge-tab ${i === 0 ? 'active' : ''}" data-cat="${cat}" onclick="switchBadgeTab(this)">
                ${label} <span class="badge-tab-count">${catClaimed}/${catBadges.length}</span>
            </button>`;
        }).join('');

        // Build category panels
        let panelsHtml = '';
        for (let ci = 0; ci < sortedCategories.length; ci++) {
            const cat = sortedCategories[ci];
            const badges = grouped[cat];

            panelsHtml += `<div class="badge-panel ${ci === 0 ? 'active' : ''}" data-cat="${cat}">`;

            // Sort badges: rejected first, then unclaimed, then draft, then pending, then approved last
            const statusOrder = { 'declined': 0, undefined: 1, 'draft': 2, 'pending': 3, 'approved': 4 };
            const sortedBadges = [...badges].sort((a, b) => {
                const claimA = (a.badge.claimType === 'exclusive')
                    ? badgeClaims.find(c => c.eventBadgeId === a.eventBadge.id)
                    : teamClaims.find(c => c.eventBadgeId === a.eventBadge.id);
                const claimB = (b.badge.claimType === 'exclusive')
                    ? badgeClaims.find(c => c.eventBadgeId === b.eventBadge.id)
                    : teamClaims.find(c => c.eventBadgeId === b.eventBadge.id);
                const orderA = statusOrder[claimA?.status] ?? 1;
                const orderB = statusOrder[claimB?.status] ?? 1;
                return orderA - orderB;
            });

            for (const { eventBadge, badge } of sortedBadges) {
                const claimType = badge.claimType || 'common';
                const isExclusive = claimType === 'exclusive';

                // For exclusive badges, check ALL claims (any team); for common, check user's team only
                // Show declined claims too so users can see rejection and re-claim
                const claim = isExclusive
                    ? badgeClaims.find(c => c.eventBadgeId === eventBadge.id)
                    : teamClaims.find(c => c.eventBadgeId === eventBadge.id);

                const assignedUserId = claim?.assignedToUserId || '';
                const hasActiveClaim = claim && (claim.status === 'pending' || claim.status === 'approved');

                // Status icon
                let statusHtml = '';
                let actionHtml = '';

                if (claim && claim.status === 'approved') {
                    statusHtml = `<span class="badge-claim-status approved" title="Approved">Approved</span>`;
                    if (claim.blogUrl) {
                        actionHtml = `<a href="${escapeHtml(claim.blogUrl)}" target="_blank" class="btn-badge-blog" title="View blog post">📝 Blog</a>`;
                    }
                } else if (claim && claim.status === 'pending') {
                    statusHtml = `<span class="badge-claim-status submitted" title="Submitted — awaiting review">Submitted</span>`;
                    if (claim.blogUrl) {
                        actionHtml = `<a href="${escapeHtml(claim.blogUrl)}" target="_blank" class="btn-badge-blog" title="View blog post">📝 Blog</a>`;
                    }
                } else if (claim && claim.status === 'declined') {
                    statusHtml = `<span class="badge-claim-status rejected" title="Rejected">Rejected</span>`;
                    if (teamId) {
                        const safeName = badge.name.replace(/'/g, "\\'");
                        actionHtml = `<button class="btn-badge-claim" onclick="openClaimBadge('${eventBadge.id}', '${teamId}', '${safeName}')">Re-claim</button>`;
                    }
                } else if (isExclusive) {
                    statusHtml = `<span class="badge-claim-status exclusive" title="Exclusive — awarded by judges">🏆</span>`;
                    if (canAward) {
                        const safeName = badge.name.replace(/'/g, "\\'");
                        actionHtml = `<button class="btn-badge-award" onclick="openAwardBadge('${eventBadge.id}', '${safeName}')">Award</button>`;
                    }
                } else {
                    if (teamId) {
                        const safeName = badge.name.replace(/'/g, "\\'");
                        actionHtml = `<button class="btn-badge-claim" onclick="openClaimBadge('${eventBadge.id}', '${teamId}', '${safeName}')">Claim</button>`;
                    }
                }

                // Middle column: for exclusive badges show awarded team name; for common show assign dropdown
                let assignedHtml = '';
                if (isExclusive && claim && claim.status === 'approved') {
                    // Show which team was awarded
                    const awardedTeam = eventTeams.find(t => t.id === claim.teamId);
                    assignedHtml = `<span class="badge-assigned-name" style="color: #d97706; font-weight: 600;">🏆 ${awardedTeam ? escapeHtml(awardedTeam.teamName) : 'Unknown team'}</span>`;
                } else if (!isExclusive && teamId) {
                    const isApproved = claim && claim.status === 'approved';
                    assignedHtml = `
                        <select class="badge-assign-select" data-eb-id="${eventBadge.id}" data-team-id="${teamId}"
                                onchange="assignBadgeMember(this)" title="Assign team member"${isApproved ? ' disabled' : ''}>
                            <option value="">— assign —</option>
                            ${memberOptions.map(m =>
                                `<option value="${m.userId}" ${m.userId === assignedUserId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
                            ).join('')}
                        </select>
                    `;
                } else if (assignedUserId) {
                    const assigned = memberOptions.find(m => m.userId === assignedUserId);
                    assignedHtml = `<span class="badge-assigned-name">${assigned ? escapeHtml(assigned.name) : ''}</span>`;
                }

                // Examples link
                const examplesLink = badge.imageUrl
                    ? `<a href="${escapeHtml(badge.imageUrl)}" target="_blank" class="btn-badge-examples" title="${escapeHtml(badge.description)}">Examples</a>`
                    : '';

                // Build rejection reason line (visible to team members)
                const rejectionHtml = (claim && claim.status === 'declined' && claim.declineReason)
                    ? `<div class="badge-reject-reason">💬 ${escapeHtml(claim.declineReason)}</div>`
                    : '';

                panelsHtml += `
                    <div class="badge-row ${claim ? (claim.status === 'approved' ? 'claimed' : claim.status === 'pending' ? 'pending' : claim.status === 'declined' ? 'rejected' : '') : ''} ${isExclusive ? 'exclusive' : ''}">
                        <div class="badge-row-main">
                            <div class="badge-row-left">
                                ${statusHtml}
                                <span class="badge-name" title="${escapeHtml(badge.description)}">${escapeHtml(badge.name)}</span>
                            </div>
                            <div class="badge-row-mid">
                                ${assignedHtml}
                            </div>
                            <div class="badge-row-right">
                                <span class="badge-points">${badge.points > 0 ? '+' : ''}${badge.points}p</span>
                                ${examplesLink}
                                ${actionHtml}
                            </div>
                        </div>
                        ${rejectionHtml}
                    </div>
                `;
            }

            panelsHtml += `</div>`;
        }

        container.innerHTML = `
            <div class="badges-section-header">
                <h3>🏅 Badges <span class="badge-stats">${claimedCount}/${totalBadges} claimed · ${earnedPoints}/${totalPoints} points</span></h3>
            </div>
            <div class="badge-tabs">
                ${tabsHtml}
            </div>
            <div class="badge-panels">
                ${panelsHtml}
            </div>
        `;
    }

    // Build a participant card with full details
    function buildParticipantCard(user, membership, participation, canEdit, teamId) {
        // Determine hotel status
        const hotelNights = participation.hotelNights || {};
        const hasAnyHotel = Object.values(hotelNights).some(v => v === true);
        const hotelStatusHtml = hasAnyHotel
            ? `<div class="hotel-status ok">🏨 Hotel ✓</div>`
            : `<div class="hotel-status missing" title="Click to set hotel nights"
                    onclick="openEditOnHotel('${user.id}', '${participation.id}', '${teamId}')">
                    ⚠️ Hotel missing
               </div>`;

        return `
            <div class="participant-card ${canEdit ? 'editable' : ''}" 
                 data-user-id="${user.id}" 
                 data-participation-id="${participation.id}"
                 data-team-id="${teamId}"
                 data-can-edit="${canEdit}">
                <div class="name">${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</div>
                <div class="detail-row email">${escapeHtml(user.email)}</div>
                <div class="detail-row">📱 ${escapeHtml(user.phone || 'N/A')}</div>
                ${user.allergies ? `<div class="detail-row">⚠️ ${escapeHtml(user.allergies)}</div>` : ''}
                <div class="roles">
                    ${membership.isAdmin ? '<span class="role-tag admin">Admin</span>' : ''}
                    ${membership.isParticipant ? '<span class="role-tag participant">Participant</span>' : ''}
                    ${hotelStatusHtml}
                </div>
                ${canEdit ? '<button class="btn btn-small btn-secondary edit-participant-btn">✏️ Edit</button>' : ''}
            </div>
        `;
    }
    
    // Open participant edit modal
    async function openParticipantEdit(userId, participationId, teamId) {
        const modal = document.getElementById('edit-participant-modal');
        const form = document.getElementById('edit-participant-form');
        const rolesTab = document.getElementById('tab-roles-btn');
        
        // Reset to first tab
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
        document.getElementById('tab-personal').classList.add('active');
        
        // Load user and participation data
        try {
            const user = await API.request(`/users/${userId}`);
            const participation = allParticipations.find(p => p.id === participationId);
            const membership = (participation?.teamMemberships || []).find(m => m.teamId === teamId);
            
            // Check if current user is admin of this team
            const currentMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === teamId);
            const isCurrentUserAdmin = currentMembership?.isAdmin || false;
            
            // Populate form
            document.getElementById('edit-userId').value = userId;
            document.getElementById('edit-participationId').value = participationId;
            document.getElementById('edit-teamId').value = teamId;
            document.getElementById('edit-firstName').value = user.firstName || '';
            document.getElementById('edit-lastName').value = user.lastName || '';
            document.getElementById('edit-email').value = user.email || '';
            document.getElementById('edit-phone').value = user.phone || '';
            document.getElementById('edit-gamertag').value = user.gamertag || '';
            document.getElementById('edit-allergies').value = user.allergies || '';
            
            // Show/hide roles tab and populate if admin
            if (isCurrentUserAdmin) {
                document.getElementById('edit-isAdmin').checked = membership?.isAdmin || false;
                document.getElementById('edit-isParticipant').checked = membership?.isParticipant || false;
                rolesTab.classList.remove('hidden');
            } else {
                rolesTab.classList.add('hidden');
            }
            
            // Build hotel calendar from event data
            buildHotelCalendar();
            
            // Populate hotel nights from participation data
            const hotelNights = participation?.hotelNights || {};
            const defaultNights = currentEvent.hotelDefaultNights || [];
            
            document.querySelectorAll('.hotel-calendar input[type="checkbox"]').forEach(cb => {
                const nightId = cb.dataset.nightId;
                // Check if this night is in saved data, otherwise use default
                if (hotelNights[nightId] !== undefined) {
                    cb.checked = hotelNights[nightId];
                } else {
                    cb.checked = defaultNights.includes(nightId);
                }
            });
            updateHotelNightsCount();
            
            // Show modal
            modal.classList.add('active');
            
        } catch (error) {
            console.error('Error loading participant:', error);
            alert('Could not load participant data');
        }
    }
    
    // Update hotel alert on role confirmation section
    function updateRoleHotelAlert() {
        const hotelAlert = document.getElementById('role-hotel-alert');
        if (!hotelAlert || !currentEvent?.hotelDates || currentEvent.hotelDates.length === 0) return;
        
        const hotelNights = currentParticipation?.hotelNights || {};
        const hasAnyNight = Object.values(hotelNights).some(v => v === true);
        if (!hasAnyNight) {
            hotelAlert.innerHTML = `
                <div class="hotel-urgency-alert">
                    <div class="alert-icon">🏨</div>
                    <div class="alert-title">Hotel Booking Needed!</div>
                    <div class="alert-message">
                        Please select your hotel nights as soon as possible so we can finalize room reservations.
                        <br>Rooms fill up quickly — don't miss out!
                    </div>
                    <button onclick="openSelfEditHotel()">🛏️ Select Hotel Nights Now</button>
                </div>
            `;
        } else {
            const nightCount = Object.values(hotelNights).filter(v => v === true).length;
            hotelAlert.innerHTML = `
                <div class="hotel-ok-badge">
                    ✅ Hotel: ${nightCount} night${nightCount !== 1 ? 's' : ''} selected
                </div>
            `;
        }
    }

    // Open self-edit modal for judges/committee (no team context)
    window.openSelfEdit = async function() {
        const modal = document.getElementById('edit-participant-modal');
        
        // Reset to first tab
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
        document.getElementById('tab-personal').classList.add('active');
        
        // Hide roles tab (no team context)
        document.getElementById('tab-roles-btn').classList.add('hidden');
        
        // Populate with current user data
        document.getElementById('edit-userId').value = currentUser.id;
        document.getElementById('edit-participationId').value = currentParticipation.id;
        document.getElementById('edit-teamId').value = '';  // No team
        document.getElementById('edit-firstName').value = currentUser.firstName || '';
        document.getElementById('edit-lastName').value = currentUser.lastName || '';
        document.getElementById('edit-email').value = currentUser.email || '';
        document.getElementById('edit-phone').value = currentUser.phone || '';
        document.getElementById('edit-gamertag').value = currentUser.gamertag || '';
        document.getElementById('edit-allergies').value = currentUser.allergies || '';
        
        // Build hotel calendar and populate
        buildHotelCalendar();
        const hotelNights = currentParticipation?.hotelNights || {};
        const defaultNights = currentEvent.hotelDefaultNights || [];
        document.querySelectorAll('.hotel-calendar input[type="checkbox"]').forEach(cb => {
            const nightId = cb.dataset.nightId;
            if (hotelNights[nightId] !== undefined) {
                cb.checked = hotelNights[nightId];
            } else {
                cb.checked = defaultNights.includes(nightId);
            }
        });
        updateHotelNightsCount();
        
        // Clear any old messages
        document.getElementById('edit-participant-error').classList.add('hidden');
        document.getElementById('edit-participant-success').classList.add('hidden');
        
        modal.classList.add('active');
    };

    // Open self-edit modal directly on the Hotel tab
    window.openSelfEditHotel = async function() {
        await openSelfEdit();
        // Switch to Hotel tab
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-hotel"]').classList.add('active');
        document.getElementById('tab-hotel').classList.add('active');
    };

    // Open edit modal directly on Hotel tab (called from "Hotel missing" badge)
    window.openEditOnHotel = function(userId, participationId, teamId) {
        // Open the normal edit modal first
        openParticipantEdit(userId, participationId, teamId).then(() => {
            // Switch to Hotel tab
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('.modal-tab[data-tab="tab-hotel"]').classList.add('active');
            document.getElementById('tab-hotel').classList.add('active');
        });
    };

    // ============================================================
    // EVENT PAGE TAB SWITCHING & BADGE CATEGORY TABS
    // ============================================================

    // Switch between My Team / Badges top-level tabs
    window.switchEventTab = function(tabName) {
        // Toggle nav tab active states
        document.querySelectorAll('.event-nav-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        // Toggle tab content visibility
        document.querySelectorAll('.event-tab-content').forEach(c => {
            c.classList.toggle('active', c.id === `tab-content-${tabName}`);
        });
    };

    // Switch category tab within the badges section
    window.switchBadgeTab = function(tabBtn) {
        const cat = tabBtn.dataset.cat;
        const section = document.getElementById('badges-section');
        if (!section) return;
        // Toggle tab active states
        section.querySelectorAll('.badge-tab').forEach(t => t.classList.remove('active'));
        tabBtn.classList.add('active');
        // Toggle panel visibility
        section.querySelectorAll('.badge-panel').forEach(p => {
            p.classList.toggle('active', p.dataset.cat === cat);
        });
    };

    // ============================================================
    // BADGE CLAIMING
    // ============================================================

    // Open claim badge dialog (common badges — self-claim by team)
    window.openClaimBadge = function(eventBadgeId, teamId, badgeName) {
        const modal = document.getElementById('badge-claim-modal');
        if (!modal) return;

        document.getElementById('badge-claim-title').textContent = `Claim: ${badgeName}`;
        document.getElementById('badge-claim-eb-id').value = eventBadgeId;
        document.getElementById('badge-claim-team-id').value = teamId;
        document.getElementById('badge-claim-url').value = '';
        document.getElementById('badge-claim-error').classList.add('hidden');

        modal.classList.remove('hidden');
    };

    // Open award badge dialog (exclusive badges — judges pick a team to award)
    window.openAwardBadge = function(eventBadgeId, badgeName) {
        const modal = document.getElementById('badge-award-modal');
        if (!modal) return;

        document.getElementById('badge-award-title').textContent = `Award: ${badgeName}`;
        document.getElementById('badge-award-eb-id').value = eventBadgeId;
        document.getElementById('badge-award-error').classList.add('hidden');

        // Populate team dropdown with all event teams
        const teamSelect = document.getElementById('badge-award-team');
        teamSelect.innerHTML = '<option value="">Select a team...</option>';
        for (const team of eventTeams) {
            teamSelect.innerHTML += `<option value="${team.id}">${escapeHtml(team.teamName)}</option>`;
        }

        modal.classList.remove('hidden');
    };

    // Close badge claim modal
    window.closeBadgeClaimModal = function() {
        const modal = document.getElementById('badge-claim-modal');
        if (modal) modal.classList.add('hidden');
    };

    // Close badge award modal
    window.closeAwardModal = function() {
        const modal = document.getElementById('badge-award-modal');
        if (modal) modal.classList.add('hidden');
    };

    // Submit badge award (exclusive badges — judge awards to a team)
    window.submitBadgeAward = async function() {
        const eventBadgeId = document.getElementById('badge-award-eb-id').value;
        const teamId = document.getElementById('badge-award-team').value;
        const errorDiv = document.getElementById('badge-award-error');
        const submitBtn = document.getElementById('badge-award-submit-btn');

        if (!teamId) {
            errorDiv.textContent = 'Please select a team to award the badge to.';
            errorDiv.classList.remove('hidden');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Awarding...';
        errorDiv.classList.add('hidden');

        try {
            await API.badgeClaims.award({
                eventBadgeId: eventBadgeId,
                teamId: teamId,
                awardedBy: currentUser.id
            });

            closeAwardModal();

            // Reload data and re-render
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();

        } catch (err) {
            console.error('Award error:', err);
            errorDiv.textContent = err.message || 'Failed to award badge.';
            errorDiv.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Award Badge';
        }
    };

    // Submit badge claim
    window.submitBadgeClaim = async function() {
        const eventBadgeId = document.getElementById('badge-claim-eb-id').value;
        const teamId = document.getElementById('badge-claim-team-id').value;
        const blogUrl = document.getElementById('badge-claim-url').value.trim();
        const errorDiv = document.getElementById('badge-claim-error');
        const submitBtn = document.getElementById('badge-claim-submit-btn');

        if (!blogUrl) {
            errorDiv.textContent = 'Please enter a blog post URL.';
            errorDiv.classList.remove('hidden');
            return;
        }

        // Basic URL validation
        try {
            new URL(blogUrl);
        } catch {
            errorDiv.textContent = 'Please enter a valid URL (e.g. https://acdc.blog/...).';
            errorDiv.classList.remove('hidden');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
        errorDiv.classList.add('hidden');

        try {
            await API.badgeClaims.create({
                eventBadgeId: eventBadgeId,
                teamId: teamId,
                blogUrl: blogUrl,
                claimedBy: currentUser.id
            });

            closeBadgeClaimModal();

            // Reload data and re-render
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();

        } catch (err) {
            console.error('Claim error:', err);
            errorDiv.textContent = err.message || 'Failed to claim badge.';
            errorDiv.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Claim';
        }
    };

    // Assign a team member to a badge (dropdown change)
    window.assignBadgeMember = async function(selectEl) {
        const eventBadgeId = selectEl.dataset.ebId;
        const teamId = selectEl.dataset.teamId;
        const assignedToUserId = selectEl.value || null;

        try {
            await API.badgeClaims.assign({
                eventBadgeId: eventBadgeId,
                teamId: teamId,
                assignedToUserId: assignedToUserId
            });
        } catch (err) {
            console.error('Assign error:', err);
            alert('Failed to assign member: ' + (err.message || 'Unknown error'));
            // Reload to reset UI
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();
        }
    };

    // Compute hotel dates from event start/end (1 day before to 1 day after)
    function computeHotelDates(startDate, endDate) {
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dates = [];

        // Use noon to avoid timezone date-shifting
        const start = new Date(startDate + 'T12:00:00');
        start.setDate(start.getDate() - 1);

        const end = new Date(endDate + 'T12:00:00');
        end.setDate(end.getDate() + 1);

        const current = new Date(start);
        while (current <= end) {
            dates.push({
                date: current.toISOString().split('T')[0],
                dayLabel: dayLabels[current.getDay()]
            });
            current.setDate(current.getDate() + 1);
        }
        return dates;
    }

    // Build hotel calendar from event start/end dates
    function buildHotelCalendar() {
        const container = document.getElementById('hotel-calendar-container');

        if (!currentEvent.startDate || !currentEvent.endDate) {
            container.innerHTML = '<p class="text-muted">No event dates configured.</p>';
            return;
        }

        // Always compute fresh from event dates — never trust stored hotelDates
        const hotelDates = computeHotelDates(currentEvent.startDate, currentEvent.endDate);

        let html = '';

        hotelDates.forEach((dateInfo, index) => {
            const date = new Date(dateInfo.date + 'T12:00:00');
            const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

            html += `
                <div class="hotel-day">
                    <div class="day-label">${dateInfo.dayLabel}</div>
                    <div class="day-date">${monthDay}</div>
                </div>
            `;

            if (index < hotelDates.length - 1) {
                const nextDate = hotelDates[index + 1];
                const nightId = `${dateInfo.dayLabel.toLowerCase()}-${nextDate.dayLabel.toLowerCase()}`;

                html += `
                    <div class="hotel-night">
                        <input type="checkbox" id="edit-hotel-${nightId}" data-night-id="${nightId}">
                        <label for="edit-hotel-${nightId}" class="night-checkbox">
                            <span class="night-icon">🌙</span>
                        </label>
                    </div>
                `;
            }
        });

        container.innerHTML = html;

        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', updateHotelNightsCount);
        });
    }
    
    // Update hotel nights count display
    function updateHotelNightsCount() {
        const checkboxes = document.querySelectorAll('.hotel-calendar input[type="checkbox"]');
        const count = Array.from(checkboxes).filter(cb => cb.checked).length;
        document.getElementById('hotel-nights-count').textContent = count;
    }
    
    // Save participant edits
    async function saveParticipantEdit() {
        const saveBtn = document.getElementById('save-participant-btn');
        const errorDiv = document.getElementById('edit-participant-error');
        const successDiv = document.getElementById('edit-participant-success');
        
        const userId = document.getElementById('edit-userId').value;
        const participationId = document.getElementById('edit-participationId').value;
        const teamId = document.getElementById('edit-teamId').value;
        
        const userData = {
            firstName: document.getElementById('edit-firstName').value.trim(),
            lastName: document.getElementById('edit-lastName').value.trim(),
            phone: document.getElementById('edit-phone').value.trim(),
            gamertag: document.getElementById('edit-gamertag').value.trim(),
            allergies: document.getElementById('edit-allergies').value.trim()
        };
        
        // Validate required fields
        if (!userData.firstName || !userData.lastName) {
            errorDiv.textContent = 'First Name and Last Name are required.';
            errorDiv.classList.remove('hidden');
            return;
        }
        
        saveBtn.disabled = true;
        saveBtn.querySelector('.btn-text').classList.add('hidden');
        saveBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');
        
        try {
            // Update user data
            await API.users.update(userId, userData);
            
            // Update hotel nights (dynamic from checkboxes)
            const hotelNights = {};
            document.querySelectorAll('.hotel-calendar input[type="checkbox"]').forEach(cb => {
                const nightId = cb.dataset.nightId;
                if (nightId) {
                    hotelNights[nightId] = cb.checked;
                }
            });
            await API.participations.updateHotel(participationId, hotelNights);
            
            // Update roles if roles tab is visible (user is admin)
            const rolesTab = document.getElementById('tab-roles-btn');
            if (!rolesTab.classList.contains('hidden')) {
                const isAdmin = document.getElementById('edit-isAdmin').checked;
                const isParticipant = document.getElementById('edit-isParticipant').checked;
                await API.participations.updateRoles(participationId, teamId, isAdmin, isParticipant);
            }
            
            successDiv.textContent = 'Saved!';
            successDiv.classList.remove('hidden');
            
            // Update currentUser in memory if editing self
            if (userId === currentUser.id) {
                Object.assign(currentUser, userData);
                // Update currentParticipation hotel nights so the page reflects changes
                if (currentParticipation) {
                    currentParticipation.hotelNights = hotelNights;
                }
                // Refresh hotel alert on role confirmation section
                updateRoleHotelAlert();
            }
            
            // Reload teams to show updated data
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();
            
            setTimeout(() => {
                document.getElementById('edit-participant-modal').classList.remove('active');
            }, 1000);
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Could not save changes.';
            errorDiv.classList.remove('hidden');
        } finally {
            saveBtn.disabled = false;
            saveBtn.querySelector('.btn-text').classList.remove('hidden');
            saveBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }

    // Open invite member modal
    function openInviteMember(teamId) {
        const team = eventTeams.find(t => t.id === teamId);
        if (!team) return;
        
        // Check if user is admin of this team
        const userMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === teamId);
        if (!userMembership?.isAdmin) {
            alert('Only team admins can invite members.');
            return;
        }
        
        document.getElementById('invite-teamId').value = teamId;
        document.getElementById('invite-teamName').textContent = team.teamName;
        document.getElementById('invite-firstName').value = '';
        document.getElementById('invite-lastName').value = '';
        document.getElementById('invite-email').value = '';
        document.getElementById('invite-error').classList.add('hidden');
        document.getElementById('invite-success').classList.add('hidden');
        
        document.getElementById('invite-member-modal').classList.add('active');
    }
    
    // Send invitation
    async function sendInvitation() {
        const sendBtn = document.getElementById('send-invite-btn');
        const errorDiv = document.getElementById('invite-error');
        const successDiv = document.getElementById('invite-success');
        
        const teamId = document.getElementById('invite-teamId').value;
        const firstName = document.getElementById('invite-firstName').value.trim();
        const lastName = document.getElementById('invite-lastName').value.trim();
        const email = document.getElementById('invite-email').value.trim().toLowerCase();
        
        if (!firstName || !lastName || !email) {
            errorDiv.textContent = 'Please fill in first name, last name, and email.';
            errorDiv.classList.remove('hidden');
            return;
        }
        
        sendBtn.disabled = true;
        sendBtn.querySelector('.btn-text').classList.add('hidden');
        sendBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');
        
        try {
            await API.invitations.create({
                teamId: teamId,
                eventId: eventId,
                email: email,
                inviteeFirstName: firstName,
                inviteeLastName: lastName,
                inviterId: currentUser.id,
                inviterName: `${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim() || 'Team Admin',
                inviterEmail: currentUser.email
            });
            
            successDiv.textContent = `Invitation sent to ${firstName} ${lastName} (${email})`;
            successDiv.classList.remove('hidden');
            
            document.getElementById('invite-firstName').value = '';
            document.getElementById('invite-lastName').value = '';
            document.getElementById('invite-email').value = '';
            
            // Reload team cards to show pending invitation
            await loadEventTeams();
            await renderTeams();
            
            setTimeout(() => {
                document.getElementById('invite-member-modal').classList.remove('active');
            }, 1500);
            
        } catch (error) {
            // Check if this is a "already invited" error with resend option
            if (error.existingInvitationId && error.canResend) {
                showResendOption(email, error.existingInvitationId, errorDiv, successDiv);
            } else {
                errorDiv.textContent = error.message || 'Could not send invitation.';
                errorDiv.classList.remove('hidden');
            }
        } finally {
            sendBtn.disabled = false;
            sendBtn.querySelector('.btn-text').classList.remove('hidden');
            sendBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }
    
    // Show resend option for existing invitation
    function showResendOption(email, invitationId, errorDiv, successDiv) {
        errorDiv.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div>📧 An invitation is already pending for <strong>${escapeHtml(email)}</strong></div>
                <div style="display: flex; gap: 8px;">
                    <button type="button" class="btn btn-small btn-secondary" onclick="resendExistingInvitation('${invitationId}')">
                        🔄 Resend Invitation
                    </button>
                    <button type="button" class="btn btn-small btn-ghost" onclick="document.getElementById('invite-error').classList.add('hidden')">
                        Dismiss
                    </button>
                </div>
            </div>
        `;
        errorDiv.classList.remove('hidden');
        errorDiv.style.background = '#fef3c7';
        errorDiv.style.color = '#92400e';
        errorDiv.style.borderColor = '#f59e0b';
    }
    
    // Resend an existing invitation
    window.resendExistingInvitation = async function(invitationId) {
        const errorDiv = document.getElementById('invite-error');
        const successDiv = document.getElementById('invite-success');
        
        try {
            await API.invitations.resend(invitationId);
            
            errorDiv.classList.add('hidden');
            errorDiv.style.background = '';
            errorDiv.style.color = '';
            errorDiv.style.borderColor = '';
            
            successDiv.textContent = '✅ Invitation resent successfully!';
            successDiv.classList.remove('hidden');
            
            document.getElementById('invite-email').value = '';
            
            setTimeout(() => {
                document.getElementById('invite-member-modal').classList.remove('active');
            }, 1500);
        } catch (error) {
            errorDiv.innerHTML = '';
            errorDiv.textContent = 'Failed to resend: ' + (error.message || 'Unknown error');
            errorDiv.style.background = '';
            errorDiv.style.color = '';
            errorDiv.style.borderColor = '';
        }
    };

    // Open team details modal
    async function openTeamDetails(teamId) {
        const team = eventTeams.find(t => t.id === teamId);
        if (!team) return;
        
        const modal = document.getElementById('team-details-modal');
        const title = document.getElementById('team-modal-title');
        const membersList = document.getElementById('team-members-list');
        const adminActions = document.getElementById('team-admin-actions');
        
        title.textContent = `👥 ${team.teamName}`;
        membersList.innerHTML = '<p>Loading members...</p>';
        
        modal.classList.add('active');
        
        // Check if current user is admin of this team
        const userMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === teamId);
        const isTeamAdmin = userMembership?.isAdmin;
        
        // Load team members with user details
        try {
            const teamParticipations = allParticipations.filter(p => {
                const membership = (p.teamMemberships || []).find(m => m.teamId === teamId);
                return membership;
            });
            
            // We need to load user details for each participation
            const memberDetails = await Promise.all(
                teamParticipations.map(async (p) => {
                    try {
                        const user = await API.request(`/users/${p.userId}`);
                        const membership = (p.teamMemberships || []).find(m => m.teamId === teamId);
                        return {
                            participation: p,
                            user,
                            membership
                        };
                    } catch (err) {
                        return null;
                    }
                })
            );
            
            const validMembers = memberDetails.filter(m => m !== null);
            
            // Load pending invitations for this team (only if admin)
            let pendingInvitations = [];
            if (isTeamAdmin) {
                try {
                    const allInvitations = await API.invitations.list(teamId);
                    pendingInvitations = allInvitations.filter(inv => inv.status === 'pending' && !inv.isExpired);
                } catch (err) {
                    console.log('Could not load invitations:', err);
                }
            }
            
            let html = '';
            
            // Render confirmed members
            if (validMembers.length > 0) {
                html += validMembers.map(m => {
                    const initials = getInitials(m.user.firstName, m.user.lastName);
                    return `
                        <div class="member-row">
                            <div class="member-info">
                                <div class="avatar">${initials}</div>
                                <div>
                                    <div class="name">${escapeHtml(m.user.firstName)} ${escapeHtml(m.user.lastName)}</div>
                                    <div class="email">${escapeHtml(m.user.email)}</div>
                                </div>
                            </div>
                            <div class="member-roles">
                                ${m.membership.isAdmin ? '<span class="role-badge admin">⭐ Admin</span>' : ''}
                                ${m.membership.isParticipant ? '<span class="role-badge participant">👤 Participant</span>' : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            }
            
            // Render pending invitations (only for admins)
            if (pendingInvitations.length > 0) {
                html += `<div class="pending-invitations-section" style="margin-top: 20px; padding-top: 20px; border-top: 1px dashed #e2e8f0;">
                    <p style="color: #64748b; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">📧 Pending Invitations</p>
                `;
                html += pendingInvitations.map(inv => {
                    const sentDate = new Date(inv.createdAt).toLocaleDateString();
                    return `
                        <div class="member-row invitation-pending" style="background: linear-gradient(135deg, #fef3c7 0%, #fef9c3 100%); border-radius: 8px; margin-bottom: 8px;">
                            <div class="member-info">
                                <div class="avatar" style="background: #f59e0b; color: white;">📧</div>
                                <div>
                                    <div class="name" style="color: #92400e;">${escapeHtml(inv.email)}</div>
                                    <div class="email" style="color: #a16207;">Invited ${sentDate} • Awaiting response</div>
                                </div>
                            </div>
                            <div class="member-roles">
                                <span class="role-badge" style="background: #fef3c7; color: #92400e; border: 1px solid #f59e0b;">⏳ Pending</span>
                                <button class="btn btn-small btn-ghost" onclick="cancelInvitation('${inv.id}')" title="Cancel invitation" style="padding: 4px 8px; margin-left: 8px;">✕</button>
                            </div>
                        </div>
                    `;
                }).join('');
                html += '</div>';
            }
            
            // Calculate remaining spots
            const committedSpots = team.committedParticipants || 3;
            const filledSpots = validMembers.length;
            const pendingSpots = pendingInvitations.length;
            const remainingSpots = Math.max(0, committedSpots - filledSpots - pendingSpots);
            
            // Show remaining empty spots (for admins)
            if (isTeamAdmin && remainingSpots > 0) {
                html += `<div class="empty-spots-section" style="margin-top: 20px; padding-top: 20px; border-top: 1px dashed #e2e8f0;">
                    <p style="color: #64748b; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">🪑 Available Spots (${remainingSpots})</p>
                `;
                for (let i = 0; i < remainingSpots; i++) {
                    html += `
                        <div class="member-row empty-spot" style="background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 8px; margin-bottom: 8px;">
                            <div class="member-info">
                                <div class="avatar" style="background: #e2e8f0; color: #94a3b8;">?</div>
                                <div>
                                    <div class="name" style="color: #94a3b8;">Empty Spot</div>
                                    <div class="email" style="color: #cbd5e1;">Invite a team member</div>
                                </div>
                            </div>
                        </div>
                    `;
                }
                html += '</div>';
            }
            
            if (html === '') {
                html = '<p class="text-muted">No members yet</p>';
            }
            
            membersList.innerHTML = html;
            
            // Show admin actions if user is admin
            if (isTeamAdmin) {
                adminActions.classList.remove('hidden');
            } else {
                adminActions.classList.add('hidden');
            }
            
        } catch (error) {
            console.error('Error loading team members:', error);
            membersList.innerHTML = '<p class="error-message">Error loading members</p>';
        }
    }
    
    // Cancel an invitation
    window.cancelInvitation = async function(invitationId) {
        if (!confirm('Are you sure you want to cancel this invitation?')) return;
        
        try {
            await API.invitations.cancel(invitationId);
            // Refresh the team details modal
            const teamIdInput = document.getElementById('invite-teamId');
            if (teamIdInput) {
                openTeamDetails(teamIdInput.value);
            }
        } catch (error) {
            alert('Error cancelling invitation: ' + error.message);
        }
    };
    
    // Get initials from name
    function getInitials(firstName, lastName) {
        return ((firstName?.[0] || '') + (lastName?.[0] || '')).toUpperCase() || '?';
    }
    
    // Format date range
    function formatDateRange(start, end) {
        if (!start) return 'Date TBD';
        const startDate = new Date(start + 'T12:00:00');
        const endDate = end ? new Date(end + 'T12:00:00') : null;
        
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        if (endDate) {
            return `${months[startDate.getMonth()]} ${startDate.getDate()}-${endDate.getDate()}, ${startDate.getFullYear()}`;
        }
        return `${months[startDate.getMonth()]} ${startDate.getDate()}, ${startDate.getFullYear()}`;
    }
    
    // Escape HTML
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Setup modals
    function setupModals() {
        // Helper to check if registration is open
        const isRegistrationOpen = () => {
            return currentEvent.status === 'registration';
        };
        
        // Create team modal
        const createTeamModal = document.getElementById('create-team-modal');
        document.getElementById('create-team-btn').addEventListener('click', () => {
            if (isRegistrationOpen()) {
                createTeamModal.classList.add('active');
            } else {
                alert('Registration is not open for this event.');
            }
        });
        
        document.getElementById('close-create-team').addEventListener('click', () => createTeamModal.classList.remove('active'));
        
        // Solo queue modal
        const soloQueueModal = document.getElementById('solo-queue-modal');
        document.getElementById('join-solo-btn').addEventListener('click', () => {
            if (isRegistrationOpen()) {
                soloQueueModal.classList.add('active');
            } else {
                alert('Registration is closed for this event.');
            }
        });
        
        document.getElementById('close-solo-queue').addEventListener('click', () => soloQueueModal.classList.remove('active'));
        
        // Solo queue form submit
        document.getElementById('solo-queue-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await joinSoloQueue();
        });
        
        // Leave queue button
        document.getElementById('leave-queue-btn').addEventListener('click', async () => {
            await leaveSoloQueue();
        });
        
        // Team details modal
        document.getElementById('close-team-details').addEventListener('click', () => {
            document.getElementById('team-details-modal').classList.remove('active');
        });
        
        // Edit participant modal
        document.getElementById('close-edit-participant').addEventListener('click', () => {
            document.getElementById('edit-participant-modal').classList.remove('active');
        });
        
        // Tab navigation in edit participant modal
        document.querySelectorAll('.modal-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetId = tab.dataset.tab;
                // Switch active tab
                document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                // Switch active content
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById(targetId).classList.add('active');
            });
        });
        
        // Invite member modal
        document.getElementById('close-invite-member').addEventListener('click', () => {
            document.getElementById('invite-member-modal').classList.remove('active');
        });
        
        // Close modals on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('active');
                }
            });
        });
        
        // Close modals on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
            }
        });
        
        // Create team form submit
        document.getElementById('create-team-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await createTeam();
        });
        
        
        // Edit participant form submit
        document.getElementById('edit-participant-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveParticipantEdit();
        });
        
        // Invite member form submit
        document.getElementById('invite-member-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await sendInvitation();
        });
    }
    
    // Check and display solo queue status
    async function checkSoloQueueStatus() {
        try {
            const result = await API.soloQueue.getPosition(eventId, currentUser.id);
            
            if (result.inQueue) {
                currentSoloQueueEntry = result.entry;
                showSoloQueueStatus(result.position, result.totalInQueue);
            } else {
                currentSoloQueueEntry = null;
                hideSoloQueueStatus();
            }
        } catch (error) {
            // Not in queue
            currentSoloQueueEntry = null;
            hideSoloQueueStatus();
        }
    }
    
    function showSoloQueueStatus(position, total) {
        document.getElementById('solo-queue-status').classList.remove('hidden');
        document.getElementById('queue-position').textContent = `${position} of ${total}`;
        // Hide the join solo button when in queue
        document.getElementById('join-solo-btn').classList.add('hidden');
    }
    
    function hideSoloQueueStatus() {
        document.getElementById('solo-queue-status').classList.add('hidden');
        document.getElementById('join-solo-btn').classList.remove('hidden');
    }
    
    // Join solo queue
    async function joinSoloQueue() {
        const submitBtn = document.getElementById('join-queue-btn');
        const errorDiv = document.getElementById('solo-queue-error');
        const successDiv = document.getElementById('solo-queue-success');
        
        const note = document.getElementById('solo-note').value.trim();
        
        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').classList.add('hidden');
        submitBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');
        
        try {
            const result = await API.soloQueue.join(eventId, currentUser.id, note);
            currentSoloQueueEntry = result;
            
            successDiv.textContent = `You're in the queue! Position: ${result.position}`;
            successDiv.classList.remove('hidden');
            
            // Update UI after short delay
            setTimeout(async () => {
                document.getElementById('solo-queue-modal').classList.remove('active');
                await checkSoloQueueStatus();
            }, 1500);
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Failed to join solo queue.';
            errorDiv.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').classList.remove('hidden');
            submitBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }
    
    // Leave solo queue
    async function leaveSoloQueue() {
        if (!currentSoloQueueEntry) return;
        
        if (!confirm('Are you sure you want to leave the solo queue?')) return;
        
        try {
            await API.soloQueue.leave(currentSoloQueueEntry.id);
            currentSoloQueueEntry = null;
            hideSoloQueueStatus();
        } catch (error) {
            alert('Failed to leave queue: ' + (error.message || 'Unknown error'));
        }
    }
    
    // Create team
    async function createTeam() {
        const submitBtn = document.getElementById('create-team-submit');
        const errorDiv = document.getElementById('create-team-error');
        const successDiv = document.getElementById('create-team-success');
        
        const teamName = document.getElementById('teamName').value.trim();
        const expectedParticipants = document.getElementById('expectedParticipants').value;
        const creatorParticipates = document.querySelector('input[name="creatorParticipates"]:checked').value === 'yes';
        
        if (!teamName || !expectedParticipants) {
            errorDiv.textContent = 'Please fill in all fields.';
            errorDiv.classList.remove('hidden');
            return;
        }
        
        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').classList.add('hidden');
        submitBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');
        
        try {
            const committedCount = parseInt(expectedParticipants);
            
            // Create the team with committed participant count (max comes from event)
            const newTeam = await API.teams.create({
                teamName: teamName,
                committedParticipants: committedCount, // number they committed to
                adminEmail: currentUser.email,
                adminUserId: currentUser.id,
                eventId: eventId
            });
            
            // Add team membership for current user (always admin, optionally participant)
            await API.participations.addTeamMembership(
                currentParticipation.id,
                newTeam.id,
                true, // isAdmin
                creatorParticipates  // isParticipant - based on user choice
            );
            
            // Update local data
            if (!currentParticipation.teamMemberships) {
                currentParticipation.teamMemberships = [];
            }
            currentParticipation.teamMemberships.push({
                teamId: newTeam.id,
                isAdmin: true,
                isParticipant: creatorParticipates
            });
            
            successDiv.textContent = 'Team created successfully!';
            successDiv.classList.remove('hidden');
            
            // Reset form
            document.getElementById('teamName').value = '';
            document.getElementById('expectedParticipants').value = '';
            document.querySelector('input[name="creatorParticipates"][value="yes"]').checked = true;
            
            // Reload teams and close modal
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();
            
            setTimeout(() => {
                document.getElementById('create-team-modal').classList.remove('active');
            }, 1500);
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Could not create team.';
            errorDiv.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').classList.remove('hidden');
            submitBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }
    
    // Unlock 1 additional team slot
    async function unlockTeamSlot(teamId) {
        const team = eventTeams.find(t => t.id === teamId);
        if (!team) return;
        
        const currentCommitted = team.committedParticipants || team.numberOfParticipants || 3;
        const newCommitted = currentCommitted + 1;
        
        if (!confirm(`Unlock 1 more slot? This will expand your team commitment to ${newCommitted} participants.`)) {
            return;
        }
        
        try {
            // Update team's committed participants (+1)
            await API.teams.update(teamId, { committedParticipants: newCommitted });
            
            // Reload and re-render
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();
            
        } catch (error) {
            console.error('Error unlocking slot:', error);
            alert('Could not unlock slot: ' + error.message);
        }
    }
    
    // Populate profile form
    // Logout handled by SiteHeader component
});

console.log('Event page script loaded');
