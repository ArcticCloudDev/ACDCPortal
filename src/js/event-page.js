// ACDC Portal - Event Detail Page Logic

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const content = document.getElementById('content');
    const logoutBtn = document.getElementById('logout-btn');
    const profileBtn = document.getElementById('profile-btn');
    
    let currentUser = null;
    let currentEvent = null;
    let currentParticipation = null;
    let eventTeams = [];
    let allParticipations = [];
    let allUsers = [];
    let currentSoloQueueEntry = null;

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
        // Handle any redirect from Entra
        await Auth.handleRedirect();
        
        // Check if logged in
        if (!Auth.isLoggedIn()) {
            window.location.href = '/';
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
            
            if (!currentUser.profileComplete) {
                window.location.href = 'complete-registration.html';
                return;
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
        
        // Load teams for this event
        await loadEventTeams();
        
        // Populate the page
        populateEventBanner();
        populateProfileForm();
        await renderTeams();
        
        // Check solo queue status
        await checkSoloQueueStatus();
        
        // Show content
        loadingDiv.classList.add('hidden');
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
        } catch (error) {
            console.error('Error loading teams:', error);
            eventTeams = [];
        }
    }
    
    // Populate event banner
    function populateEventBanner() {
        const banner = document.getElementById('event-banner');
        
        document.getElementById('event-name').textContent = currentEvent.name;
        document.getElementById('event-dates').textContent = formatDateRange(currentEvent.startDate, currentEvent.endDate);
        document.getElementById('event-location').textContent = currentEvent.location || 'TBD';
        
        // Get status from new field or derive from old registrationOpen
        const status = currentEvent.status || (currentEvent.registrationOpen ? 'registration' : 'draft');
        
        const statusEl = document.getElementById('event-status');
        if (status === 'live') {
            statusEl.textContent = '🚀 Live';
            statusEl.style.background = 'rgba(16, 185, 129, 0.3)';
        } else if (status === 'registration') {
            statusEl.textContent = '✓ Registration Open';
            statusEl.style.background = 'rgba(40, 167, 69, 0.3)';
        } else if (status === 'waitlist') {
            statusEl.textContent = '📋 Waiting List';
            statusEl.style.background = 'rgba(245, 158, 11, 0.3)';
        } else {
            statusEl.textContent = 'Coming Soon';
            statusEl.style.background = 'rgba(100, 116, 139, 0.3)';
        }
        
        // Check if event is historical
        if (!currentEvent.isActive && new Date(currentEvent.endDate) < new Date()) {
            banner.classList.add('inactive');
            const createSection = document.getElementById('create-team-section');
            if (createSection) createSection.classList.add('hidden');
        }
    }
    
    // Render teams grid
    async function renderTeams() {
        const teamsContainer = document.getElementById('my-teams-container');
        const noTeams = document.getElementById('no-teams');
        const createSection = document.getElementById('create-team-section');
        
        // Filter to only show teams where user is admin or participant
        const userTeamIds = (currentParticipation?.teamMemberships || []).map(m => m.teamId);
        const myTeams = eventTeams.filter(t => userTeamIds.includes(t.id));
        
        if (myTeams.length === 0) {
            teamsContainer.classList.add('hidden');
            noTeams.classList.remove('hidden');
        } else {
            teamsContainer.classList.remove('hidden');
            noTeams.classList.add('hidden');
            
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
            
            // Add file upload handlers
            setupFileUploadHandlers();
        }
        
        // Hide create button if registration not open or event inactive
        const status = currentEvent.status || (currentEvent.registrationOpen ? 'registration' : 'draft');
        if (status !== 'registration' || !currentEvent.isActive) {
            createSection.classList.add('hidden');
        }
    }
    
    // Setup file upload handlers for team deliverables
    function setupFileUploadHandlers() {
        // Presentation file uploads
        document.querySelectorAll('input[id^="ppt-"]').forEach(input => {
            input.addEventListener('change', async (e) => {
                const teamId = input.id.replace('ppt-', '');
                const file = e.target.files[0];
                if (file) {
                    await handleFileUpload(teamId, 'presentation', file);
                }
            });
        });
        
        // Video file uploads
        document.querySelectorAll('input[id^="video-"]').forEach(input => {
            input.addEventListener('change', async (e) => {
                const teamId = input.id.replace('video-', '');
                const file = e.target.files[0];
                if (file) {
                    await handleFileUpload(teamId, 'video', file);
                }
            });
        });
        
        // Remove file buttons
        document.querySelectorAll('.btn-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const teamId = btn.dataset.teamId;
                const fileType = btn.dataset.type;
                await handleFileRemove(teamId, fileType);
            });
        });
    }
    
    // Handle file upload
    async function handleFileUpload(teamId, fileType, file) {
        try {
            // For now, we'll just store the filename in the team record
            // In production, you'd upload to Azure Blob Storage
            const updateData = {};
            if (fileType === 'presentation') {
                updateData.presentationFile = file.name;
            } else if (fileType === 'video') {
                updateData.deliveryVideo = file.name;
            }
            
            await API.teams.update(teamId, updateData);
            
            // Reload to show updated state
            await loadEventTeams();
            await renderTeams();
            
        } catch (error) {
            console.error('File upload error:', error);
            alert('Failed to upload file: ' + error.message);
        }
    }
    
    // Handle file removal
    async function handleFileRemove(teamId, fileType) {
        if (!confirm('Are you sure you want to remove this file?')) return;
        
        try {
            const updateData = {};
            if (fileType === 'presentation') {
                updateData.presentationFile = null;
            } else if (fileType === 'video') {
                updateData.deliveryVideo = null;
            }
            
            await API.teams.update(teamId, updateData);
            
            // Reload to show updated state
            await loadEventTeams();
            await renderTeams();
            
        } catch (error) {
            console.error('File remove error:', error);
            alert('Failed to remove file: ' + error.message);
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
        
        // Calculate empty committed slots (show as + buttons)
        const emptyCommittedSlots = Math.max(0, committedParticipants - realParticipantCount);
        
        // Calculate unlock slots (slots beyond committed count)
        const unlockSlots = Math.max(0, maxParticipants - committedParticipants);
        
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
        
        // Build uploads section (only for admins)
        const uploadsHtml = isAdmin ? buildUploadsSection(team) : '';
        
        // Build admin display for header
        const adminDisplay = adminUser 
            ? `<span class="team-admin-info">Admin: ${escapeHtml(adminUser.firstName)} ${escapeHtml(adminUser.lastName)}</span>`
            : '';
        
        return `
            <div class="team-card" data-team-id="${team.id}">
                <div class="team-card-header">
                    <h3>Team - ${escapeHtml(team.teamName)}</h3>
                    ${adminDisplay}
                </div>
                <div class="team-card-body">
                    <div class="team-stats">
                        <span>👥 ${realParticipantCount}/${committedParticipants} committed</span>
                        <span>${emptyCommittedSlots > 0 ? `📋 ${emptyCommittedSlots} open` : '✓ Full'}</span>
                    </div>
                    <div class="participants-grid">
                        ${participantCards.join('')}
                        ${emptySlotsHtml}
                        ${unlockSlotsHtml}
                    </div>
                    ${uploadsHtml}
                </div>
            </div>
        `;
    }
    
    // Build uploads section for team files
    function buildUploadsSection(team) {
        const hasPpt = team.presentationFile;
        const hasVideo = team.deliveryVideo;
        
        return `
            <div class="team-uploads">
                <h4>📁 Team Deliverables</h4>
                <div class="uploads-grid">
                    <div class="upload-box ${hasPpt ? 'has-file' : ''}" data-team-id="${team.id}" data-type="presentation">
                        <div class="upload-icon">📊</div>
                        <div class="upload-label">Team Presentation</div>
                        <div class="upload-hint">.pptx file</div>
                        ${hasPpt ? `
                            <div class="file-info">
                                <span class="file-name">${escapeHtml(team.presentationFile)}</span>
                                <button class="btn-remove" data-team-id="${team.id}" data-type="presentation" title="Remove">✕</button>
                            </div>
                            <div class="upload-status">✓ Uploaded</div>
                        ` : `
                            <input type="file" id="ppt-${team.id}" accept=".pptx,.ppt">
                            <button class="btn btn-secondary btn-upload" onclick="document.getElementById('ppt-${team.id}').click()">Choose File</button>
                        `}
                    </div>
                    <div class="upload-box ${hasVideo ? 'has-file' : ''}" data-team-id="${team.id}" data-type="video">
                        <div class="upload-icon">🎬</div>
                        <div class="upload-label">Delivery Video</div>
                        <div class="upload-hint">Video file</div>
                        ${hasVideo ? `
                            <div class="file-info">
                                <span class="file-name">${escapeHtml(team.deliveryVideo)}</span>
                                <button class="btn-remove" data-team-id="${team.id}" data-type="video" title="Remove">✕</button>
                            </div>
                            <div class="upload-status">✓ Uploaded</div>
                        ` : `
                            <input type="file" id="video-${team.id}" accept="video/*">
                            <button class="btn btn-secondary btn-upload" onclick="document.getElementById('video-${team.id}').click()">Choose File</button>
                        `}
                    </div>
                </div>
            </div>
        `;
    }
    
    // Build a participant card with full details
    function buildParticipantCard(user, membership, participation, canEdit, teamId) {
        return `
            <div class="participant-card ${canEdit ? 'editable' : ''}" 
                 data-user-id="${user.id}" 
                 data-participation-id="${participation.id}"
                 data-team-id="${teamId}"
                 data-can-edit="${canEdit}">
                <div class="name">${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</div>
                <div class="detail-row email">${escapeHtml(user.email)}</div>
                <div class="detail-row">📱 ${escapeHtml(user.phone || 'N/A')}</div>
                ${user.gamertag ? `<div class="detail-row">🎮 ${escapeHtml(user.gamertag)}</div>` : ''}
                ${user.allergies ? `<div class="detail-row">⚠️ ${escapeHtml(user.allergies)}</div>` : ''}
                <div class="roles">
                    ${membership.isAdmin ? '<span class="role-tag admin">Admin</span>' : ''}
                    ${membership.isParticipant ? '<span class="role-tag participant">Participant</span>' : ''}
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
    
    // Build hotel calendar from event data
    function buildHotelCalendar() {
        const container = document.getElementById('hotel-calendar-container');
        const hotelDates = currentEvent.hotelDates || [];
        
        if (hotelDates.length === 0) {
            container.innerHTML = '<p class="text-muted">No hotel dates configured for this event.</p>';
            return;
        }
        
        let html = '';
        
        hotelDates.forEach((dateInfo, index) => {
            const date = new Date(dateInfo.date);
            const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            
            // Add day column
            html += `
                <div class="hotel-day">
                    <div class="day-label">${dateInfo.dayLabel}</div>
                    <div class="day-date">${monthDay}</div>
                </div>
            `;
            
            // Add night checkbox between days (not after last day)
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
        
        // Add event listeners for count update
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
            
            successDiv.textContent = 'Participant updated!';
            successDiv.classList.remove('hidden');
            
            // Reload teams to show updated data
            await loadEventTeams();
            await renderTeams();
            
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
        const email = document.getElementById('invite-email').value.trim().toLowerCase();
        
        if (!email) {
            errorDiv.textContent = 'Please enter an email address.';
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
                inviterId: currentUser.id,
                inviterName: `${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim() || 'Team Admin',
                inviterEmail: currentUser.email
            });
            
            successDiv.textContent = `Invitation sent to ${email}`;
            successDiv.classList.remove('hidden');
            
            document.getElementById('invite-email').value = '';
            
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
        const startDate = new Date(start);
        const endDate = end ? new Date(end) : null;
        
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
        // Profile modal
        const profileModal = document.getElementById('profile-modal');
        profileBtn.addEventListener('click', () => profileModal.classList.add('active'));
        document.getElementById('close-profile').addEventListener('click', () => profileModal.classList.remove('active'));
        
        // Helper to check if registration is open
        const isRegistrationOpen = () => {
            const status = currentEvent.status || (currentEvent.registrationOpen ? 'registration' : 'draft');
            return status === 'registration';
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
        
        // Profile form submit
        document.getElementById('profile-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveProfile();
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
            
        } catch (error) {
            console.error('Error unlocking slot:', error);
            alert('Could not unlock slot: ' + error.message);
        }
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
        const saveBtn = document.getElementById('save-profile-btn');
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

console.log('Event page script loaded');
