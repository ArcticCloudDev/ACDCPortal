// ACDC Portal - Dashboard Page Logic
// This page now redirects to the new events-based flow

document.addEventListener('DOMContentLoaded', async () => {
    // Redirect to the new events list page
    window.location.href = 'events.html';
});

console.log('My-page redirecting to events.html');

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
        
        // Load all events for selector
        try {
            allEvents = await API.events.list();
            populateEventSelector(allEvents);
        } catch (error) {
            console.error('Error loading events:', error);
        }
        
        // Load active event
        try {
            currentEvent = await API.events.getActive();
            if (currentEvent && eventSelector) {
                eventSelector.value = currentEvent.id;
            }
        } catch (error) {
            console.error('No active event found:', error);
        }
        
        // Load user data
        try {
            currentUser = await API.users.getOrNull(authUser.email);
            
            if (!currentUser) {
                console.log('New user, redirecting to complete registration...');
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
        
        // Load participation for current event
        if (currentEvent) {
            currentParticipation = await API.participations.getOrNull(currentUser.id, currentEvent.id);
            
            // Create participation if it doesn't exist
            if (!currentParticipation) {
                currentParticipation = await API.participations.upsert({
                    userId: currentUser.id,
                    eventId: currentEvent.id,
                    hotelNights: { 'thu-sun': true }
                });
            }
        }
        
        // Check for invitation in URL
        const urlParams = new URLSearchParams(window.location.search);
        const inviteId = urlParams.get('invite');
        if (inviteId) {
            await handleInvitation(inviteId, currentUser);
            currentParticipation = await API.participations.getOrNull(currentUser.id, currentEvent.id);
        }
        
        // Check for pending invitations
        await checkPendingInvitations(currentUser);
        
        // Load all teams the user is on for this event
        await loadUserTeams();
        
        // Populate the dashboard
        populateDashboard();
        
        // Show dashboard
        loadingDiv.classList.add('hidden');
        dashboard.classList.remove('hidden');
        
    } catch (error) {
        console.error('Error loading dashboard:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error loading: ${error.message}</p>
                               <a href="/" class="btn btn-primary">Back to home</a>`;
    }

    // Populate event selector dropdown
    function populateEventSelector(events) {
        eventSelector.innerHTML = '';
        events.forEach(event => {
            const option = document.createElement('option');
            option.value = event.id;
            option.textContent = event.name;
            if (event.isActive) option.selected = true;
            eventSelector.appendChild(option);
        });
    }

    // Event selector change handler
    eventSelector.addEventListener('change', async () => {
        const selectedEventId = eventSelector.value;
        if (selectedEventId && selectedEventId !== currentEvent?.id) {
            currentEvent = allEvents.find(e => e.id === selectedEventId);
            currentParticipation = await API.participations.getOrNull(currentUser.id, selectedEventId);
            
            if (!currentParticipation) {
                currentParticipation = await API.participations.upsert({
                    userId: currentUser.id,
                    eventId: selectedEventId,
                    hotelNights: { 'thu-sun': true }
                });
            }
            
            // Load teams for new event
            await loadUserTeams();
            
            populateDashboard();
        }
    });

    // Load all teams the user is on
    async function loadUserTeams() {
        userTeams = [];
        const memberships = currentParticipation?.teamMemberships || [];
        
        for (const membership of memberships) {
            try {
                const team = await API.teams.get(membership.teamId);
                const counts = await API.participations.getTeamCount(membership.teamId);
                userTeams.push({
                    ...team,
                    isAdmin: membership.isAdmin,
                    isParticipant: membership.isParticipant,
                    participantCount: counts.participantCount,
                    adminCount: counts.adminCount
                });
            } catch (error) {
                console.log('Team not found:', membership.teamId);
            }
        }
    }

    // Populate the dashboard with current data
    function populateDashboard() {
        // Event banner
        if (currentEvent) {
            document.getElementById('event-title').textContent = currentEvent.name;
            document.getElementById('event-dates').textContent = formatDateRange(currentEvent.startDate, currentEvent.endDate);
            document.getElementById('event-location').textContent = currentEvent.location || 'TBD';
            document.getElementById('event-status').textContent = currentEvent.registrationOpen ? 'Registration Open' : 'Registration Closed';
        }
        
        // Team section
        const noTeamDiv = document.getElementById('no-team');
        const hasTeamDiv = document.getElementById('has-team');
        const createAnotherDiv = document.getElementById('create-another-team');
        
        if (userTeams.length > 0) {
            noTeamDiv.classList.add('hidden');
            hasTeamDiv.classList.remove('hidden');
            createAnotherDiv.classList.remove('hidden');
            
            // Build team list HTML
            hasTeamDiv.innerHTML = userTeams.map(team => `
                <div class="team-item">
                    <div class="team-item-info">
                        <div class="team-item-name">${escapeHtml(team.teamName)}</div>
                        <div class="team-item-roles">
                            ${team.isAdmin ? '<span class="role-badge admin">⭐ Admin</span>' : ''}
                            ${team.isParticipant ? '<span class="role-badge participant">👤 Participant</span>' : ''}
                        </div>
                        <div class="team-item-count">👥 ${team.participantCount}/${team.numberOfParticipants} participants</div>
                    </div>
                    <div class="team-item-actions">
                        ${team.isAdmin ? `<a href="team-admin.html?team=${team.id}" class="btn btn-small btn-primary">Manage</a>` : ''}
                        ${team.isAdmin && !team.isParticipant ? `<button class="btn btn-small btn-secondary" onclick="toggleParticipant('${team.id}', true)">Join as Participant</button>` : ''}
                        ${team.isAdmin && team.isParticipant ? `<button class="btn btn-small btn-secondary" onclick="toggleParticipant('${team.id}', false)">Leave as Participant</button>` : ''}
                    </div>
                </div>
            `).join('');
        } else {
            noTeamDiv.classList.remove('hidden');
            hasTeamDiv.classList.add('hidden');
            createAnotherDiv.classList.add('hidden');
        }
        
        // Hotel section
        const hotelNights = currentParticipation?.hotelNights || {};
        document.getElementById('hotel-wed-thu').checked = hotelNights['wed-thu'] || false;
        document.getElementById('hotel-thu-sun').checked = hotelNights['thu-sun'] !== false;
        document.getElementById('hotel-sun-mon').checked = hotelNights['sun-mon'] || false;
        
        // Profile form
        document.getElementById('firstName').value = currentUser.firstName || '';
        document.getElementById('lastName').value = currentUser.lastName || '';
        document.getElementById('email').value = currentUser.email || '';
        document.getElementById('phone').value = currentUser.phone || '';
        document.getElementById('allergies').value = currentUser.allergies || '';
    }

    // Escape HTML to prevent XSS
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Toggle participant status (exposed globally)
    window.toggleParticipant = async function(teamId, isParticipant) {
        try {
            await API.participations.toggleParticipant(currentParticipation.id, teamId, isParticipant);
            
            // Update local state
            const membership = currentParticipation.teamMemberships.find(m => m.teamId === teamId);
            if (membership) {
                membership.isParticipant = isParticipant;
            }
            
            // Reload teams and refresh
            await loadUserTeams();
            populateDashboard();
        } catch (error) {
            alert(error.message || 'Could not update participant status');
        }
    };

    // Format date range
    function formatDateRange(start, end) {
        if (!start) return 'Date not set';
        const startDate = new Date(start);
        const endDate = end ? new Date(end) : null;
        
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        if (endDate) {
            return `${months[startDate.getMonth()]} ${startDate.getDate()}-${endDate.getDate()}, ${startDate.getFullYear()}`;
        }
        return `${months[startDate.getMonth()]} ${startDate.getDate()}, ${startDate.getFullYear()}`;
    }

    // Setup modal functionality
    function setupModals() {
        // Profile modal
        const profileModal = document.getElementById('profile-modal');
        profileBtn.addEventListener('click', () => profileModal.classList.add('active'));
        document.getElementById('close-profile').addEventListener('click', () => profileModal.classList.remove('active'));
        
        // Create team modal
        const createTeamModal = document.getElementById('create-team-modal');
        document.getElementById('create-team-btn').addEventListener('click', () => createTeamModal.classList.add('active'));
        
        // Second create team button (when user already has teams)
        const createTeamBtn2 = document.getElementById('create-team-btn-2');
        if (createTeamBtn2) {
            createTeamBtn2.addEventListener('click', () => createTeamModal.classList.add('active'));
        }
        
        document.getElementById('close-create-team').addEventListener('click', () => createTeamModal.classList.remove('active'));
        
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
    }

    // Save profile form
    document.getElementById('profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const saveBtn = document.getElementById('save-btn');
        const errorDiv = document.getElementById('profile-error');
        const successDiv = document.getElementById('profile-success');
        
        const formData = {
            firstName: document.getElementById('firstName').value.trim(),
            lastName: document.getElementById('lastName').value.trim(),
            phone: document.getElementById('phone').value.trim(),
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
    });

    // Save hotel
    document.getElementById('save-hotel-btn').addEventListener('click', async () => {
        const saveBtn = document.getElementById('save-hotel-btn');
        const errorDiv = document.getElementById('hotel-error');
        const successDiv = document.getElementById('hotel-success');
        
        const hotelNights = {
            'wed-thu': document.getElementById('hotel-wed-thu').checked,
            'thu-sun': document.getElementById('hotel-thu-sun').checked,
            'sun-mon': document.getElementById('hotel-sun-mon').checked
        };

        if (!hotelNights['wed-thu'] && !hotelNights['thu-sun'] && !hotelNights['sun-mon']) {
            errorDiv.textContent = 'Select at least one hotel night.';
            errorDiv.classList.remove('hidden');
            successDiv.classList.add('hidden');
            return;
        }

        saveBtn.disabled = true;
        saveBtn.querySelector('.btn-text').classList.add('hidden');
        saveBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');

        try {
            await API.participations.updateHotel(currentParticipation.id, hotelNights);
            currentParticipation.hotelNights = hotelNights;
            
            successDiv.textContent = 'Hotel selection saved!';
            successDiv.classList.remove('hidden');
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Could not save hotel selection.';
            errorDiv.classList.remove('hidden');
        } finally {
            saveBtn.disabled = false;
            saveBtn.querySelector('.btn-text').classList.remove('hidden');
            saveBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Register team form
    document.getElementById('register-team-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const registerBtn = document.getElementById('register-team-btn');
        const errorDiv = document.getElementById('team-register-error');
        const successDiv = document.getElementById('team-register-success');
        
        const teamName = document.getElementById('teamName').value.trim();
        const numberOfParticipants = document.getElementById('numberOfParticipants').value;
        
        if (!teamName || !numberOfParticipants) {
            errorDiv.textContent = 'Please fill in all fields.';
            errorDiv.classList.remove('hidden');
            return;
        }
        
        // Check if user is already participant on another team
        const existingParticipantTeam = userTeams.find(t => t.isParticipant);
        
        registerBtn.disabled = true;
        registerBtn.querySelector('.btn-text').classList.add('hidden');
        registerBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');
        
        try {
            // Create team with eventId
            const newTeam = await API.teams.create({
                teamName: teamName,
                numberOfParticipants: parseInt(numberOfParticipants),
                adminEmail: currentUser.email,
                adminUserId: currentUser.id,
                eventId: currentEvent.id
            });
            
            // Add team membership (admin + participant unless already participant elsewhere)
            const isParticipant = !existingParticipantTeam;
            await API.participations.addTeamMembership(
                currentParticipation.id,
                newTeam.id,
                true, // isAdmin
                isParticipant
            );
            
            // Update local participation
            if (!currentParticipation.teamMemberships) {
                currentParticipation.teamMemberships = [];
            }
            currentParticipation.teamMemberships.push({
                teamId: newTeam.id,
                isAdmin: true,
                isParticipant: isParticipant
            });
            
            // Reload teams
            await loadUserTeams();
            
            let message = 'Team created!';
            if (!isParticipant) {
                message += ' (You are admin only - already participating in another team)';
            }
            successDiv.textContent = message;
            successDiv.classList.remove('hidden');
            
            // Reset form
            document.getElementById('teamName').value = '';
            document.getElementById('numberOfParticipants').value = '';
            
            setTimeout(() => {
                document.getElementById('create-team-modal').classList.remove('active');
                populateDashboard();
            }, 2000);
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Could not create team.';
            errorDiv.classList.remove('hidden');
            
            registerBtn.disabled = false;
            registerBtn.querySelector('.btn-text').classList.remove('hidden');
            registerBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Logout
    logoutBtn.addEventListener('click', async () => {
        await Auth.logout();
    });

    // Handle invitation from URL
    async function handleInvitation(inviteId, user) {
        try {
            const invitation = await API.invitations.get(inviteId);
            
            if (invitation.status !== 'pending') {
                showNotification('Denne invitasjonen er ikke lenger gyldig.', 'error');
                return;
            }
            
            if (confirm(`Vil du bli med i laget "${invitation.teamName}"?`)) {
                const result = await API.invitations.accept(inviteId, user.id, user.email);
                showNotification(`Velkommen til ${result.teamName}!`, 'success');
            }
        } catch (error) {
            console.error('Error handling invitation:', error);
            showNotification('Kunne ikke behandle invitasjonen.', 'error');
        }
    }

    // Check for pending invitations
    async function checkPendingInvitations(user) {
        try {
            const invitations = await API.invitations.listByEmail(user.email);
            const pending = invitations.filter(i => i.status === 'pending');
            
            if (pending.length > 0) {
                showInvitationBanner(pending[0], user);
            }
        } catch (error) {
            console.log('Error checking invitations:', error);
        }
    }

    // Show invitation banner
    function showInvitationBanner(invitation, user) {
        const banner = document.createElement('div');
        banner.className = 'invitation-banner';
        banner.innerHTML = `
            <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                <div>
                    <strong>📩 Du har en laginvitasjon!</strong><br>
                    ${invitation.inviterName || 'Noen'} har invitert deg til <strong>${invitation.teamName}</strong>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-primary btn-small" onclick="acceptInvitation('${invitation.id}', '${user.id}', '${user.email}')">Godta</button>
                    <button class="btn btn-secondary btn-small" onclick="this.parentElement.parentElement.parentElement.remove()">Avslå</button>
                </div>
            </div>
        `;
        
        const eventBanner = document.getElementById('event-banner');
        eventBanner.parentNode.insertBefore(banner, eventBanner.nextSibling);
    }

    // Show notification
    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed; top: 20px; right: 20px; padding: 15px 25px;
            border-radius: 8px; z-index: 2000; animation: slideIn 0.3s ease;
            background: ${type === 'success' ? '#dcfce7' : type === 'error' ? '#fee2e2' : '#e0f2fe'};
            color: ${type === 'success' ? '#166534' : type === 'error' ? '#991b1b' : '#0369a1'};
            border: 1px solid ${type === 'success' ? '#86efac' : type === 'error' ? '#fca5a5' : '#7dd3fc'};
        `;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(() => notification.remove(), 5000);
    }
});

// Global function for accepting invitation from banner
async function acceptInvitation(inviteId, userId, userEmail) {
    try {
        const result = await API.invitations.accept(inviteId, userId, userEmail);
        alert(`Velkommen til ${result.teamName}!`);
        window.location.reload();
    } catch (error) {
        alert('Kunne ikke godta invitasjonen: ' + error.message);
    }
}

console.log('Dashboard page loaded');
