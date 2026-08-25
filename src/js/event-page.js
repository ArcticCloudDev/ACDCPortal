

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
    let eventBadges = [];
    let badgeClaims = [];
    let profileConfirmationRequired = false;

    const urlParams = new URLSearchParams(window.location.search);
    const eventId = urlParams.get('id');
    const completeProfileUrl = `complete-registration.html?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;

    if (!eventId) {
        window.location.href = 'events.html';
        return;
    }

    Auth.init();

    setupModals();

    try {
        await Auth.handleRedirect();

        if (!Auth.isLoggedIn()) {
            window.location.href = '/events.html';
            return;
        }

        const authUser = Auth.getUser();

        try {
            currentUser = await API.users.getOrNull(authUser.email);

            if (!currentUser) {
                window.location.href = completeProfileUrl;
                return;
            }

            if (!currentUser.profileComplete) {
                let hasExistingRelationship = false;
                try {
                    const participation = await API.participations.getOrNull(currentUser.id, eventId);
                    if (participation) {
                        hasExistingRelationship = true;
                    }
                } catch (e) { }
                if (!hasExistingRelationship) {
                    window.location.href = completeProfileUrl;
                    return;
                }
            }
        } catch (error) {
            console.error('Error loading user:', error);
            window.location.href = completeProfileUrl;
            return;
        }

        try {
            currentEvent = await API.events.get(eventId);
        } catch (error) {
            console.error('Error loading event:', error);
            loadingDiv.innerHTML = `<p class="error-message">Event not found</p>
                                   <a href="events.html" class="btn btn-primary">Back to Events</a>`;
            return;
        }

        if (urlParams.get('action') === 'create-team') {
            document.getElementById('create-team-btn').click();
            window.history.replaceState({}, '', `event.html?id=${encodeURIComponent(eventId)}`);
        }

        currentParticipation = await API.participations.getOrNull(currentUser.id, eventId);

        if (!currentParticipation) {
            currentParticipation = await API.participations.upsert({
                userId: currentUser.id,
                eventId: eventId,
                hotelNights: { 'thu-sun': true }
            });
        }

        await loadEventTeams();

        populateEventBanner();
        setupCostHint();
        await renderTeams();

        const isTeamLeader = currentParticipation.isTeamAdmin
            || (currentParticipation.teamMemberships || []).some(membership => membership.isAdmin);
        if (currentParticipation.teamId && !isTeamLeader && !currentParticipation.profileVerification) {
            await openParticipantEdit(
                currentUser.id,
                currentParticipation.id,
                currentParticipation.teamId,
                true
            );
        }

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

        await checkSoloQueueStatus();

        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        content.classList.remove('hidden');

    } catch (error) {
        console.error('Error loading page:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error loading: ${error.message}</p>
                               <a href="events.html" class="btn btn-primary">Back to Events</a>`;
    }

    async function loadEventTeams() {
        try {
            const allTeams = await API.request('/teams');
            eventTeams = allTeams.filter(t => t.eventId === eventId);

            allParticipations = await API.participations.getByEvent(eventId);

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

    function setupCostHint() {
        if (!currentEvent || currentEvent.costPerParticipant == null) return;
        const participantSelect = document.getElementById('expectedParticipants');
        const costHint = document.getElementById('cost-hint');
        if (!participantSelect || !costHint) return;
        const currency = currentEvent.currency;
        const locale = currencyLocale(currency);
        const costPer = currentEvent.costPerParticipant;
        function updateCostHint() {
            const count = parseInt(participantSelect.value) || 0;
            if (count > 0) {
                const total = (count * costPer).toLocaleString(locale);
                costHint.innerHTML = `Total commitment: <strong>${total}\u00a0${currency}</strong> (${count}\u00a0\u00d7\u00a0${costPer.toLocaleString(locale)}\u00a0${currency})`;
            } else {
                costHint.textContent = `${costPer.toLocaleString(locale)}\u00a0${currency} per participant \u2014 select a count to see total.`;
            }
        }
        participantSelect.addEventListener('change', updateCostHint);
        updateCostHint();
    }

    function populateEventBanner() {
        const currentTeam = eventTeams.find(team => team.id === currentParticipation?.teamId);
        const headerTitle = currentTeam
            ? `${currentEvent.name} - ${currentTeam.teamName}`
            : currentEvent.name;

        const status = currentEvent.status || 'draft';
        let statusText = 'Coming Soon';
        if (status === 'live') statusText = '🚀 Live';
        else if (status === 'registration') statusText = '✓ Registration Open';
        else if (status === 'pre-registration') statusText = '🔔 Pre-Registration';
        else if (status === 'completed') statusText = '✓ Completed';

        SiteHeader.render({
            title: headerTitle,
            subtitle: null,
            infoBadges: [],
            showSignIn: false,
            inactive: false
        });

        const userRoles = currentParticipation?.roles || [];
        const isAdmin = userRoles.includes('committee') || userRoles.includes('judge');

        SiteHeader.update({ authUser: Auth.getUser(), user: currentUser, isAdmin });

        const infoStrip = document.getElementById('event-info-strip');
        if (infoStrip) {
            const stripItems = [
                `<span class="info-item">📅 ${formatDateRange(currentEvent.startDate, currentEvent.endDate)}</span>`,
                currentEvent.location ? `<span class="info-item">📍 ${escapeHtml(currentEvent.location)}</span>` : '',
                currentEvent.costPerParticipant != null ? `<span class="info-item">💰 ${currentEvent.costPerParticipant.toLocaleString(currencyLocale(currentEvent.currency))}\u00a0${currentEvent.currency || ''} / person</span>` : '',
                `<span class="status-chip">${escapeHtml(statusText)}</span>`,
            ].filter(Boolean).join('');
            infoStrip.innerHTML = stripItems;
            infoStrip.classList.remove('hidden');
        }

        const banner = SiteHeader.getElements().container;

        const isJudge = userRoles.includes('judge');
        const isCommittee = userRoles.includes('committee');
        const hasTeam = currentParticipation?.teamId || (currentParticipation?.teamMemberships?.length > 0);
        const isInterest = userRoles.includes('interest') && !hasTeam;
        const hasSpecialRole = isJudge || isCommittee || isInterest;

        if (hasSpecialRole) {
            banner.classList.remove('inactive');

            document.getElementById('event-nav')?.classList.add('hidden');

            const preRegSection = document.getElementById('pre-reg-section');
            if (preRegSection) preRegSection.classList.add('hidden');
            const teamsSection = document.querySelector('.teams-section');
            if (teamsSection) teamsSection.classList.add('hidden');
            const noTeams = document.getElementById('no-teams');
            if (noTeams) noTeams.classList.add('hidden');
            const createSection = document.getElementById('create-team-section');
            if (createSection) createSection.classList.add('hidden');

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

                    const eventStatus = currentEvent.status || 'draft';
                    if (eventStatus === 'registration-open' || eventStatus === 'pre-registration' || currentEvent.registrationOpen) {
                        const upgradeDiv = document.getElementById('interest-upgrade-actions');
                        if (upgradeDiv) upgradeDiv.classList.remove('hidden');
                    }
                }

                if (isInterest && !isJudge && !isCommittee) {
                    const editBtn = document.getElementById('edit-details-btn');
                    if (editBtn) editBtn.classList.add('hidden');
                } else {
                    updateRoleHotelAlert();
                }
            }
        }

        if (status === 'completed' || status === 'draft' || status === 'pre-registration') {
            banner.classList.add('inactive');
            const createSection = document.getElementById('create-team-section');
            if (createSection) createSection.classList.add('hidden');
        }

        if (status === 'pre-registration' && !hasSpecialRole) {
            const preRegSection = document.getElementById('pre-reg-section');
            if (preRegSection) {
                preRegSection.classList.remove('hidden');
                const interestLink = document.getElementById('interest-link');
                if (interestLink) {
                    interestLink.href = `register.html?intent=interest&eventId=${currentEvent.id}`;
                }
            }
            const teamsSection = document.querySelector('.teams-section');
            if (teamsSection) teamsSection.classList.add('hidden');
            const noTeams = document.getElementById('no-teams');
            if (noTeams) noTeams.classList.add('hidden');
        }
    }

    async function renderTeams() {
        const teamsContainer = document.getElementById('my-teams-container');
        const noTeams = document.getElementById('no-teams');
        const createSection = document.getElementById('create-team-section');

        const isPrivileged = currentUser.isPortalAdmin ||
            (currentParticipation?.roles || []).includes('committee');
        const userTeamIds = new Set(
            (currentParticipation?.teamMemberships || []).map(m => m.teamId)
        );
        if (currentParticipation?.teamId) {
            userTeamIds.add(currentParticipation.teamId);
        }
        const myTeams = isPrivileged ? eventTeams : eventTeams.filter(t => userTeamIds.has(t.id));

        if (myTeams.length === 0) {
            teamsContainer.classList.add('hidden');
            noTeams.classList.remove('hidden');
            const roles = currentParticipation?.roles || [];
            const isSpecialRole = roles.includes('judge') || roles.includes('committee') ||
                (roles.includes('interest') && !currentParticipation?.teamId);
            if (createSection && !isSpecialRole) createSection.classList.remove('hidden');
        } else {
            teamsContainer.classList.remove('hidden');
            noTeams.classList.add('hidden');
            if (createSection) createSection.classList.add('hidden');

            const teamCardsHtml = await Promise.all(myTeams.map(async team => {
                return await buildTeamCard(team);
            }));

            teamsContainer.innerHTML = teamCardsHtml.join('');

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

            document.querySelectorAll('.add-member-slot').forEach(slot => {
                slot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const teamId = slot.dataset.teamId;
                    openInviteMember(teamId);
                });
            });

            document.querySelectorAll('.unlock-slot').forEach(slot => {
                slot.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const teamId = slot.dataset.teamId;
                    await unlockTeamSlot(teamId);
                });
            });

            document.querySelectorAll('.btn-delete-team').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const teamId = btn.dataset.teamId;
                    const teamName = btn.dataset.teamName;
                    await deleteTeam(teamId, teamName);
                });
            });

            document.querySelectorAll('.resend-invite-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    btn.disabled = true;
                    btn.textContent = 'Sending...';
                    try {
                        await API.invitations.resend(btn.dataset.inviteId);
                        btn.textContent = '✓ Sent';
                        setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 Resend'; }, 2000);
                    } catch (err) {
                        alert('Failed to resend: ' + err.message);
                        btn.disabled = false;
                        btn.textContent = '🔄 Resend';
                    }
                });
            });

            document.querySelectorAll('.cancel-invite-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Cancel invitation for ${btn.dataset.inviteEmail}?`)) return;
                    try {
                        await API.invitations.cancel(btn.dataset.inviteId);
                        await renderTeams();
                    } catch (err) {
                        alert('Failed to cancel: ' + err.message);
                    }
                });
            });

            setupFileUploadHandlers();
        }

        const status = currentEvent.status || 'draft';
        if (status !== 'registration') {
            createSection.classList.add('hidden');
        }
    }

    function setupFileUploadHandlers() {
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

    async function handleFileUpload(teamId, category, file) {
        const progressEl = document.getElementById(`upload-progress-${teamId}`);
        const uploadBtn = document.getElementById(`upload-btn-${teamId}`);

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

    async function buildTeamCard(team) {
        const teamParticipations = allParticipations.filter(p => {
            const memberships = p.teamMemberships || [];
            return memberships.some(m => m.teamId === team.id);
        });

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

        if (adminParticipation) {
            try {
                adminUser = await API.request(`/users/${adminParticipation.userId}`);
            } catch (err) {
                console.error('Could not load admin user:', err);
            }
        }

        const userMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === team.id);
        const isAdmin = userMembership?.isAdmin || false;
        const isParticipant = userMembership?.isParticipant || false;

        const allParticipantCards = await Promise.all(
            teamParticipations.map(async (p) => {
                try {
                    const user = await API.request(`/users/${p.userId}`);
                    const membership = (p.teamMemberships || []).find(m => m.teamId === team.id);
                    const canEdit = isAdmin || (p.userId === currentUser.id);
                    return { user, membership, participation: p, canEdit, isTBD: user.isTBD || false };
                } catch (err) {
                    return null;
                }
            })
        );

        const participantCards = allParticipantCards
            .filter(p => p !== null && !p.isTBD)
            .map(p => buildParticipantCard(p.user, p.membership, p.participation, p.canEdit, team.id));

        const maxParticipants = currentEvent.maxTeamSize || 5;
        const committedParticipants = team.committedParticipants || team.numberOfParticipants || maxParticipants;

        const realParticipantCount = allParticipantCards.filter(p => p !== null && !p.isTBD && p.membership?.isParticipant).length;

        let pendingInvitations = [];
        try {
            const teamInvitations = await API.invitations.list(team.id);
            pendingInvitations = (teamInvitations || []).filter(i => i.status === 'pending');
        } catch (err) {
            console.error('Error loading invitations for team:', err);
        }

        const contactEmails = new Set(
            allParticipantCards
                .filter(participant => participant !== null)
                .map(participant => participant.user.email?.toLowerCase())
                .filter(Boolean)
        );
        const legacyPendingInvitations = pendingInvitations.filter(invitation =>
            !contactEmails.has(invitation.email?.toLowerCase())
        );

        const filledOrPendingCount = realParticipantCount + legacyPendingInvitations.length;
        const emptyCommittedSlots = Math.max(0, committedParticipants - filledOrPendingCount);

        const unlockSlots = Math.max(0, maxParticipants - committedParticipants);

        let pendingCardsHtml = '';
        if (legacyPendingInvitations.length > 0) {
            pendingCardsHtml = legacyPendingInvitations.map(inv => `
                <div class="participant-card pending-card" data-invite-id="${inv.id}">
                    <div class="pending-icon">✉️</div>
                    <div class="name">Invitation Sent</div>
                    <div class="detail-row email">${escapeHtml(inv.email)}</div>
                    <div class="roles">
                        <span class="role-tag pending">⏳ Pending</span>
                    </div>
                    <div class="pending-date">Sent ${new Date(inv.createdAt).toLocaleDateString()}</div>
                    ${isAdmin ? `
                    <div class="pending-actions" style="display:flex;gap:6px;margin-top:10px;justify-content:center;">
                        <button class="btn btn-small btn-secondary resend-invite-btn" data-invite-id="${inv.id}" style="padding:4px 10px;font-size:0.75rem;">🔄 Resend</button>
                        <button class="btn btn-small btn-danger cancel-invite-btn" data-invite-id="${inv.id}" data-invite-email="${escapeHtml(inv.email)}" style="padding:4px 10px;font-size:0.75rem;">✕ Cancel</button>
                    </div>` : ''}
                </div>
            `).join('');
        }

        let emptySlotsHtml = '';
        if (isAdmin && emptyCommittedSlots > 0) {
            emptySlotsHtml = Array(emptyCommittedSlots).fill(`
                <div class="empty-slot add-member-slot" data-team-id="${team.id}">
                    <span class="add-icon">+</span>
                    <span class="add-text">Add Member</span>
                </div>
            `).join('');
        }

        let unlockSlotsHtml = '';
        if (isAdmin && unlockSlots > 0) {
            unlockSlotsHtml = `
                <div class="unlock-slot" data-team-id="${team.id}">
                    <span class="unlock-icon">🔓</span>
                    <span class="unlock-text">Unlock 1 more</span>
                </div>
            `;
        }

        const uploadsHtml = currentEvent.sharepointUrl ? await buildUploadsSection(team) : '';

        const adminDisplay = adminUser
            ? `<span class="team-admin-info">Admin: ${escapeHtml(adminUser.firstName)} ${escapeHtml(adminUser.lastName)}</span>`
            : '';

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
                        ${legacyPendingInvitations.length > 0 ? `<span>✉️ ${legacyPendingInvitations.length} pending</span>` : ''}
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

    async function buildUploadsSection(team) {
        const categories = (currentEvent.fileCategories && currentEvent.fileCategories.length > 0)
            ? currentEvent.fileCategories
            : ['General'];

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

    function renderBadgesSection() {
        const container = document.getElementById('badges-section');
        if (!container) return;
        if (!eventBadges || eventBadges.length === 0) {
            container.innerHTML = '<p style="color: var(--text-muted); text-align:center; padding:32px;">No badges available for this event.</p>';
            return;
        }

        const badgeTeamIds = new Set(
            (currentParticipation?.teamMemberships || []).map(m => m.teamId)
        );
        if (currentParticipation?.teamId) badgeTeamIds.add(currentParticipation.teamId);
        const myTeam = eventTeams.find(t => badgeTeamIds.has(t.id));
        const teamId = myTeam?.id || '';

        const myMembership = (currentParticipation?.teamMemberships || []).find(m => m.teamId === teamId);
        const isAdmin = myMembership?.isAdmin || currentParticipation?.isTeamAdmin || false;

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

        const categoryOrder = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3, 'exclusive': 4 };
        const categoryLabels = { 'soft': '🤝 Soft Skills', 'low-code': '⚡ Low-Code', 'pro-code': '💻 Pro-Code', 'sponsor': '🏢 Sponsor', 'exclusive': '🏆 Exclusive' };

        const teamClaims = teamId ? badgeClaims.filter(c => c.teamId === teamId) : [];

        const userRoles = currentParticipation?.roles || [];
        const isJudge = userRoles.includes('judge');
        const isCommittee = userRoles.includes('committee');
        const canAward = isJudge || isCommittee;

        const isEventLive = currentEvent.status === 'live';

        const grouped = {};
        for (const eb of eventBadges) {
            const badge = eb.badge;
            if (!badge || !eb.isActive) continue;
            const claimType = badge.claimType || 'common';
            const cat = claimType === 'exclusive' ? 'exclusive' : (badge.category || 'other');
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push({ eventBadge: eb, badge });
        }

        const sortedCategories = Object.keys(grouped).sort((a, b) =>
            (categoryOrder[a] ?? 99) - (categoryOrder[b] ?? 99)
        );

        const commonEventBadges = eventBadges.filter(eb => eb.isActive && (eb.badge?.claimType || 'common') !== 'exclusive');
        const claimedCount = teamClaims.filter(c => {
            const eb = eventBadges.find(e => e.id === c.eventBadgeId);
            return (eb?.badge?.claimType || 'common') !== 'exclusive' && (c.status === 'pending' || c.status === 'approved');
        }).length;
        const totalBadges = commonEventBadges.length;

        const earnedPoints = teamClaims
            .filter(c => {
                const eb = eventBadges.find(e => e.id === c.eventBadgeId);
                return c.status === 'approved' && (eb?.badge?.claimType || 'common') !== 'exclusive';
            })
            .reduce((sum, c) => {
                const eb = eventBadges.find(e => e.id === c.eventBadgeId);
                return sum + (eb?.badge?.points || 0);
            }, 0);
        const totalPoints = commonEventBadges
            .filter(eb => eb.badge)
            .reduce((sum, eb) => sum + (eb.badge.points || 0), 0);

        const navCount = document.getElementById('badges-nav-count');
        if (navCount) navCount.textContent = `${claimedCount}/${totalBadges}`;

        const tabsHtml = sortedCategories.map((cat, i) => {
            const label = categoryLabels[cat] || cat;
            const catBadges = grouped[cat];
            if (cat === 'exclusive') {
                const awardedCount = catBadges.filter(({ eventBadge }) => {
                    return badgeClaims.some(c => c.eventBadgeId === eventBadge.id && c.status === 'approved');
                }).length;
                return `<button class="badge-tab ${i === 0 ? 'active' : ''}" data-cat="${cat}" onclick="switchBadgeTab(this)">
                    ${label} <span class="badge-tab-count">${awardedCount}/${catBadges.length}</span>
                </button>`;
            }
            const catClaimed = catBadges.filter(({ eventBadge }) => {
                return teamClaims.some(c => c.eventBadgeId === eventBadge.id && (c.status === 'pending' || c.status === 'approved'));
            }).length;
            return `<button class="badge-tab ${i === 0 ? 'active' : ''}" data-cat="${cat}" onclick="switchBadgeTab(this)">
                ${label} <span class="badge-tab-count">${catClaimed}/${catBadges.length}</span>
            </button>`;
        }).join('');

        let panelsHtml = '';
        for (let ci = 0; ci < sortedCategories.length; ci++) {
            const cat = sortedCategories[ci];
            const badges = grouped[cat];

            panelsHtml += `<div class="badge-panel ${ci === 0 ? 'active' : ''}" data-cat="${cat}">`;

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
                if (orderA !== orderB) return orderA - orderB;
                return a.badge.name.localeCompare(b.badge.name);
            });

            for (const { eventBadge, badge } of sortedBadges) {
                const claimType = badge.claimType || 'common';
                const isExclusive = claimType === 'exclusive';

                const claim = isExclusive
                    ? badgeClaims.find(c => c.eventBadgeId === eventBadge.id)
                    : teamClaims.find(c => c.eventBadgeId === eventBadge.id);

                const assignedUserId = claim?.assignedToUserId || '';
                const hasActiveClaim = claim && (claim.status === 'pending' || claim.status === 'approved');

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
                    if (teamId && isEventLive) {
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
                    if (teamId && isEventLive) {
                        const safeName = badge.name.replace(/'/g, "\\'");
                        actionHtml = `<button class="btn-badge-claim" onclick="openClaimBadge('${eventBadge.id}', '${teamId}', '${safeName}')">Claim</button>`;
                    }
                }

                let assignedHtml = '';
                if (isExclusive && claim && claim.status === 'approved') {
                    const awardedTeam = eventTeams.find(t => t.id === claim.teamId);
                    assignedHtml = `<span class="badge-assigned-name" style="color: #d97706; font-weight: 600;">🏆 ${awardedTeam ? escapeHtml(awardedTeam.teamName) : 'Unknown team'}</span>`;
                } else if (isExclusive) {
                    assignedHtml = `<span class="badge-assigned-name" style="color: #94a3b8; font-style: italic;">Awaiting award...</span>`;
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

                const examplesLink = badge.imageUrl
                    ? `<a href="${escapeHtml(badge.imageUrl)}" target="_blank" class="btn-badge-examples" title="${escapeHtml(badge.description)}">Examples</a>`
                    : '';

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
                ${user.allergies ? `<div class="detail-row">⚠️ ${escapeHtml(user.allergies)}</div>` : ''}
                <div class="roles">
                    ${membership.isAdmin ? '<span class="role-tag admin">Admin</span>' : ''}
                    ${membership.isParticipant ? '<span class="role-tag participant">Participant</span>' : ''}
                    ${!participation.profileVerification ? '<span class="role-tag verify-needed" title="Confirm your information to continue">Confirm information</span>' : ''}
                </div>
                ${canEdit ? '<button class="btn btn-small btn-secondary edit-participant-btn">✏️ Edit</button>' : ''}
            </div>
        `;
    }

    async function openParticipantEdit(userId, participationId, teamId, requireConfirmation = false) {
        const modal = document.getElementById('edit-participant-modal');
        const form = document.getElementById('edit-participant-form');
        const rolesTab = document.getElementById('tab-roles-btn');
        profileConfirmationRequired = requireConfirmation;

        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
        document.getElementById('tab-personal').classList.add('active');

        try {
            const user = await API.request(`/users/${userId}`);
            const participation = allParticipations.find(p => p.id === participationId);
            const membership = (participation?.teamMemberships || []).find(m => m.teamId === teamId);

            const currentMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === teamId);
            const isCurrentUserAdmin = currentMembership?.isAdmin || false;

            document.getElementById('edit-userId').value = userId;
            document.getElementById('edit-participationId').value = participationId;
            document.getElementById('edit-teamId').value = teamId;
            document.getElementById('edit-firstName').value = user.firstName || '';
            document.getElementById('edit-lastName').value = user.lastName || '';
            document.getElementById('edit-email').value = user.email || '';
            document.getElementById('edit-phone').value = user.phone || '';
            document.getElementById('edit-gamertag').value = user.gamertag || '';
            document.getElementById('edit-allergies').value = user.allergies || '';

            if (isCurrentUserAdmin) {
                document.getElementById('edit-isAdmin').checked = membership?.isAdmin || false;
                document.getElementById('edit-isParticipant').checked = membership?.isParticipant || false;
                rolesTab.classList.remove('hidden');
            } else {
                rolesTab.classList.add('hidden');
            }

            const hotelTabBtn = document.getElementById('tab-hotel-btn');
            if (currentEvent.hotelEnabled) {
                hotelTabBtn.classList.remove('hidden');
                buildHotelCalendar(participation?.hotelNights || {});
            } else {
                hotelTabBtn.classList.add('hidden');
            }

            document.getElementById('edit-data-verified').checked = false;

            modal.classList.add('active');

        } catch (error) {
            console.error('Error loading participant:', error);
            alert('Could not load participant data');
        }
    }

    function updateRoleHotelAlert() {
        const hotelAlert = document.getElementById('role-hotel-alert');
        if (!hotelAlert) return;
        if (!currentEvent?.hotelEnabled) {
            hotelAlert.innerHTML = '';
            return;
        }
        if (!currentEvent?.hotelDates || currentEvent.hotelDates.length === 0) return;

        const isAdmin = currentUser?.isPortalAdmin || (currentParticipation?.roles || []).includes('committee');
        const hotelNights = currentParticipation?.hotelNights || {};
        const hasAnyNight = Object.values(hotelNights).some(v => v === true);

        if (!hasAnyNight) {
            if (isAdmin) {
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
                hotelAlert.innerHTML = `
                    <div class="hotel-urgency-alert">
                        <div class="alert-icon">🏨</div>
                        <div class="alert-title">Hotel Not Yet Assigned</div>
                        <div class="alert-message">Your hotel nights will be arranged by the event organizers. No action needed.</div>
                    </div>
                `;
            }
        } else {
            const nightCount = Object.values(hotelNights).filter(v => v === true).length;
            hotelAlert.innerHTML = `
                <div class="hotel-ok-badge">
                    ✅ Hotel: ${nightCount} night${nightCount !== 1 ? 's' : ''} booked
                </div>
            `;
        }
    }

    window.openSelfEdit = async function() {
        const modal = document.getElementById('edit-participant-modal');

        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
        document.getElementById('tab-personal').classList.add('active');

        document.getElementById('tab-roles-btn').classList.add('hidden');

        const hotelTabBtn = document.getElementById('tab-hotel-btn');
        if (currentEvent.hotelEnabled) {
            hotelTabBtn.classList.remove('hidden');
        } else {
            hotelTabBtn.classList.add('hidden');
        }

        document.getElementById('edit-userId').value = currentUser.id;
        document.getElementById('edit-participationId').value = currentParticipation.id;
        document.getElementById('edit-teamId').value = '';
        document.getElementById('edit-firstName').value = currentUser.firstName || '';
        document.getElementById('edit-lastName').value = currentUser.lastName || '';
        document.getElementById('edit-email').value = currentUser.email || '';
        document.getElementById('edit-phone').value = currentUser.phone || '';
        document.getElementById('edit-gamertag').value = currentUser.gamertag || '';
        document.getElementById('edit-allergies').value = currentUser.allergies || '';

        if (currentEvent.hotelEnabled) {
            buildHotelCalendar(currentParticipation?.hotelNights || {});
        }

        document.getElementById('edit-data-verified').checked = false;

        document.getElementById('edit-participant-error').classList.add('hidden');
        document.getElementById('edit-participant-success').classList.add('hidden');

        modal.classList.add('active');
    };

    window.openSelfEditHotel = async function() {
        await openSelfEdit();
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-hotel"]').classList.add('active');
        document.getElementById('tab-hotel').classList.add('active');
    };

    window.openEditOnHotel = function(userId, participationId, teamId) {
        openParticipantEdit(userId, participationId, teamId).then(() => {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('.modal-tab[data-tab="tab-hotel"]').classList.add('active');
            document.getElementById('tab-hotel').classList.add('active');
        });
    };

    window.switchEventTab = function(tabName, updateHash = true) {
        document.querySelectorAll('.event-nav-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        document.querySelectorAll('.event-tab-content').forEach(c => {
            c.classList.toggle('active', c.id === `tab-content-${tabName}`);
        });
        if (updateHash) {
            history.replaceState(null, '', `#${tabName}`);
        }
    };

    const initHash = location.hash.replace('#', '');
    if (initHash === 'badges' || initHash === 'team') {
        switchEventTab(initHash, false);
    }

    window.addEventListener('hashchange', () => {
        const tab = location.hash.replace('#', '');
        if (tab === 'team' || tab === 'badges') {
            switchEventTab(tab, false);
        }
    });

    window.switchBadgeTab = function(tabBtn) {
        const cat = tabBtn.dataset.cat;
        const section = document.getElementById('badges-section');
        if (!section) return;
        section.querySelectorAll('.badge-tab').forEach(t => t.classList.remove('active'));
        tabBtn.classList.add('active');
        section.querySelectorAll('.badge-panel').forEach(p => {
            p.classList.toggle('active', p.dataset.cat === cat);
        });
    };

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

    window.openAwardBadge = function(eventBadgeId, badgeName) {
        const modal = document.getElementById('badge-award-modal');
        if (!modal) return;

        document.getElementById('badge-award-title').textContent = `Award: ${badgeName}`;
        document.getElementById('badge-award-eb-id').value = eventBadgeId;
        document.getElementById('badge-award-error').classList.add('hidden');

        const teamSelect = document.getElementById('badge-award-team');
        teamSelect.innerHTML = '<option value="">Select a team...</option>';
        for (const team of eventTeams) {
            teamSelect.innerHTML += `<option value="${team.id}">${escapeHtml(team.teamName)}</option>`;
        }

        modal.classList.remove('hidden');
    };

    window.closeBadgeClaimModal = function() {
        const modal = document.getElementById('badge-claim-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.closeAwardModal = function() {
        const modal = document.getElementById('badge-award-modal');
        if (modal) modal.classList.add('hidden');
    };

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
            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();
        }
    };

    function computeHotelDates(startDate, endDate) {
        const daysBefore = currentEvent.hotelDaysBefore ?? 0;
        const daysAfter = currentEvent.hotelDaysAfter ?? 0;
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dates = [];

        const start = new Date(startDate + 'T12:00:00');
        start.setDate(start.getDate() - Math.max(0, daysBefore));

        const end = new Date(endDate + 'T12:00:00');
        end.setDate(end.getDate() + Math.max(0, daysAfter));

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

    function buildHotelCalendar(savedNights = {}) {
        const container = document.getElementById('hotel-calendar-container');

        let hotelDays = (currentEvent.hotelDates && currentEvent.hotelDates.length > 0)
            ? currentEvent.hotelDates
            : computeHotelDates(currentEvent.startDate, currentEvent.endDate);

        if (!hotelDays || hotelDays.length === 0) {
            container.innerHTML = '<p class="text-muted">No event dates configured.</p>';
            return;
        }

        const defaultNights = currentEvent.hotelDefaultNights || [];
        const isMandatory = currentEvent.hotelMandatory || false;
        const isAdmin = currentUser?.isPortalAdmin || (currentParticipation?.roles || []).includes('committee');

        const readOnly = !isAdmin;

        const desc = document.getElementById('hotel-tab-description');
        if (desc) {
            desc.textContent = readOnly
                ? 'Your hotel accommodation is arranged by the event organizers. The nights below show your current booking.'
                : 'Configure the hotel nights for this participant. Check the nights they will be staying.';
        }

        const hasAnySaved = Object.values(savedNights).some(v => v === true);

        let html = '';
        hotelDays.forEach((dateInfo, index) => {
            const date = new Date(dateInfo.date + 'T12:00:00');
            const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

            html += `
                <div class="hotel-day">
                    <div class="day-label">${dateInfo.dayLabel}</div>
                    <div class="day-date">${monthDay}</div>
                </div>
            `;

            if (index < hotelDays.length - 1) {
                const nextDate = hotelDays[index + 1];
                const nightId = `${dateInfo.dayLabel.toLowerCase()}-${nextDate.dayLabel.toLowerCase()}`;
                const isDefaultNight = defaultNights.includes(nightId);
                const isLocked = isMandatory && isDefaultNight && !isAdmin;

                const isChecked = isLocked
                    || (savedNights[nightId] === true)
                    || (!hasAnySaved && isDefaultNight);

                const isDisabled = readOnly || isLocked;
                const disabledAttr = isDisabled ? ' disabled' : '';
                const titleAttr = isLocked ? ' title="Mandatory night — cannot be changed"' : (readOnly ? ' title="Hotel nights are managed by the organizers"' : '');

                html += `
                    <div class="hotel-night">
                        <input type="checkbox" id="edit-hotel-${nightId}" data-night-id="${nightId}"
                               ${isChecked ? 'checked' : ''}${disabledAttr}${titleAttr}>
                        <label for="edit-hotel-${nightId}" class="night-checkbox">
                            <span class="night-icon">🌙</span>
                            ${isLocked ? '<span class="lock-badge">🔒</span>' : ''}
                        </label>
                    </div>
                `;
            }
        });

        container.innerHTML = html;

        if (!readOnly) {
            container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.addEventListener('change', updateHotelNightsCount);
            });
        }

        updateHotelNightsCount();
    }

    function updateHotelNightsCount() {
        const checkboxes = document.querySelectorAll('.hotel-calendar input[type="checkbox"]');
        const count = Array.from(checkboxes).filter(cb => cb.checked).length;
        document.getElementById('hotel-nights-count').textContent = count;
    }

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

        if (!userData.firstName || !userData.lastName || !userData.phone) {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
            document.getElementById('tab-personal').classList.add('active');
            const missing = [];
            if (!userData.firstName) missing.push('First Name');
            if (!userData.lastName)  missing.push('Last Name');
            if (!userData.phone)     missing.push('Phone');
            errorDiv.textContent = `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required.`;
            errorDiv.classList.remove('hidden');
            if (!userData.firstName)     document.getElementById('edit-firstName').focus();
            else if (!userData.lastName) document.getElementById('edit-lastName').focus();
            else                         document.getElementById('edit-phone').focus();
            return;
        }

        if (!document.getElementById('edit-data-verified').checked) {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
            document.getElementById('tab-personal').classList.add('active');
            errorDiv.textContent = 'Please verify that your information is correct before saving.';
            errorDiv.classList.remove('hidden');
            document.getElementById('edit-data-verified').focus();
            return;
        }

        saveBtn.disabled = true;
        saveBtn.querySelector('.btn-text').classList.add('hidden');
        saveBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');

        try {
            await API.users.update(userId, userData);

            const isAdminSave = currentUser?.isPortalAdmin || (currentParticipation?.roles || []).includes('committee');
            let hotelNights;
            if (isAdminSave) {
                hotelNights = {};
                document.querySelectorAll('.hotel-calendar input[type="checkbox"]').forEach(cb => {
                    const nightId = cb.dataset.nightId;
                    if (nightId) hotelNights[nightId] = cb.checked;
                });
            } else {
                hotelNights = currentParticipation?.hotelNights || {};
            }
            await API.participations.updateHotel(participationId, hotelNights, true);

            const rolesTab = document.getElementById('tab-roles-btn');
            if (!rolesTab.classList.contains('hidden')) {
                const isAdmin = document.getElementById('edit-isAdmin').checked;
                const isParticipant = document.getElementById('edit-isParticipant').checked;
                try {
                    await API.participations.updateRoles(participationId, teamId, isAdmin, isParticipant);
                } catch (roleError) {
                    if (!roleError.requiresCommitmentIncrease) throw roleError;

                    const confirmed = confirm(
                        `${roleError.message}\n\nDo you want to commit to ${roleError.newCommittedParticipants} participant places?`
                    );
                    if (!confirmed) throw new Error('Participant role was not added.');

                    await API.participations.updateRoles(
                        participationId,
                        teamId,
                        isAdmin,
                        isParticipant,
                        true
                    );
                }
            }

            successDiv.textContent = 'Saved!';
            successDiv.classList.remove('hidden');
            profileConfirmationRequired = false;

            if (userId === currentUser.id) {
                Object.assign(currentUser, userData);
                if (currentParticipation) {
                    currentParticipation.hotelNights = hotelNights;
                }
                updateRoleHotelAlert();
            }

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

    function openInviteMember(teamId) {
        const team = eventTeams.find(t => t.id === teamId);
        if (!team) return;

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
        document.getElementById('invite-phone').value = '';
        document.getElementById('invite-gamertag').value = '';
        document.getElementById('invite-allergies').value = '';
        document.getElementById('invite-error').classList.add('hidden');
        document.getElementById('invite-success').classList.add('hidden');

        document.getElementById('invite-member-modal').classList.add('active');
    }

    async function sendInvitation() {
        const sendBtn = document.getElementById('send-invite-btn');
        const errorDiv = document.getElementById('invite-error');
        const successDiv = document.getElementById('invite-success');

        const teamId = document.getElementById('invite-teamId').value;
        const firstName = document.getElementById('invite-firstName').value.trim();
        const lastName = document.getElementById('invite-lastName').value.trim();
        const email = document.getElementById('invite-email').value.trim().toLowerCase();
        const phone = document.getElementById('invite-phone').value.trim();
        const gamertag = document.getElementById('invite-gamertag').value.trim();
        const allergies = document.getElementById('invite-allergies').value.trim();

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
                inviteePhone: phone,
                inviteeGamertag: gamertag,
                inviteeAllergies: allergies,
                inviterId: currentUser.id,
                inviterName: `${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim() || 'Team Admin',
                inviterEmail: currentUser.email
            });

            successDiv.textContent = `${firstName} ${lastName} is now a pending team member. A confirmation link was sent to ${email}.`;
            successDiv.classList.remove('hidden');

            document.getElementById('invite-firstName').value = '';
            document.getElementById('invite-lastName').value = '';
            document.getElementById('invite-email').value = '';
            document.getElementById('invite-phone').value = '';
            document.getElementById('invite-gamertag').value = '';
            document.getElementById('invite-allergies').value = '';

            await loadEventTeams();
            await renderTeams();

            setTimeout(() => {
                document.getElementById('invite-member-modal').classList.remove('active');
            }, 1500);

        } catch (error) {
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

        const userMembership = currentParticipation?.teamMemberships?.find(m => m.teamId === teamId);
        const isTeamAdmin = userMembership?.isAdmin;

        try {
            const teamParticipations = allParticipations.filter(p => {
                const membership = (p.teamMemberships || []).find(m => m.teamId === teamId);
                return membership;
            });

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

            let pendingInvitations = [];
            if (isTeamAdmin) {
                try {
                    const allInvitations = await API.invitations.list(teamId);
                    pendingInvitations = allInvitations.filter(inv => inv.status === 'pending' && !inv.isExpired);
                } catch (err) {
                    console.warn('Could not load invitations:', err);
                }
            }

            let html = '';

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

            const committedSpots = team.committedParticipants || 3;
            const filledSpots = validMembers.length;
            const pendingSpots = pendingInvitations.length;
            const remainingSpots = Math.max(0, committedSpots - filledSpots - pendingSpots);

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

    window.cancelInvitation = async function(invitationId) {
        if (!confirm('Are you sure you want to cancel this invitation?')) return;

        try {
            await API.invitations.cancel(invitationId);
            const teamIdInput = document.getElementById('invite-teamId');
            if (teamIdInput) {
                openTeamDetails(teamIdInput.value);
            }
        } catch (error) {
            alert('Error cancelling invitation: ' + error.message);
        }
    };

    function getInitials(firstName, lastName) {
        return ((firstName?.[0] || '') + (lastName?.[0] || '')).toUpperCase() || '?';
    }

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

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function setupModals() {
        const isRegistrationOpen = () => {
            const s = currentEvent.status;
            return s === 'registration' || s === 'registration-open' || !!currentEvent.registrationOpen;
        };

        const createTeamModal = document.getElementById('create-team-modal');
        document.getElementById('create-team-btn').addEventListener('click', () => {
            if (!isRegistrationOpen()) {
                alert('Registration is not open for this event.');
                return;
            }

            const select = document.getElementById('expectedParticipants');
            const min = currentEvent.minTeamSize || 3;
            const max = currentEvent.maxTeamSize || 5;
            select.innerHTML = '<option value="">Select...</option>';
            for (let i = min; i <= max; i++) {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = i;
                select.appendChild(opt);
            }

            document.getElementById('create-team-step-1').classList.remove('hidden');
            document.getElementById('create-team-step-2').classList.add('hidden');
            document.getElementById('create-team-step1-error').classList.add('hidden');
            document.getElementById('create-team-error').classList.add('hidden');
            document.getElementById('create-team-success').classList.add('hidden');
            document.getElementById('create-team-ack').checked = false;
            document.getElementById('step-indicator-1').classList.add('active');
            document.getElementById('step-indicator-2').classList.remove('active');

            createTeamModal.classList.add('active');
        });

        document.getElementById('create-team-next').addEventListener('click', () => {
            const teamName = document.getElementById('teamName').value.trim();
            const expectedParticipants = document.getElementById('expectedParticipants').value;
            const errorDiv = document.getElementById('create-team-step1-error');
            if (!teamName || !expectedParticipants) {
                errorDiv.textContent = 'Please fill in all fields.';
                errorDiv.classList.remove('hidden');
                return;
            }
            errorDiv.classList.add('hidden');

            const termsDisplay = document.getElementById('create-team-terms-display');
            const ackLabel = document.getElementById('create-team-ack-label');
            const terms = currentEvent.teamRegistrationTerms;
            if (terms) {
                const rendered = terms.includes('<') ? terms : terms.replace(/\n/g, '<br>');
                termsDisplay.innerHTML = rendered;
                termsDisplay.style.display = '';
                ackLabel.textContent = 'I have read and agree to the terms above';
            } else {
                termsDisplay.style.display = 'none';
                ackLabel.textContent = 'I confirm I want to create this team';
            }

            document.getElementById('create-team-step-1').classList.add('hidden');
            document.getElementById('create-team-step-2').classList.remove('hidden');
            document.getElementById('step-indicator-1').classList.remove('active');
            document.getElementById('step-indicator-2').classList.add('active');
        });

        document.getElementById('create-team-back').addEventListener('click', () => {
            document.getElementById('create-team-step-2').classList.add('hidden');
            document.getElementById('create-team-step-1').classList.remove('hidden');
            document.getElementById('step-indicator-2').classList.remove('active');
            document.getElementById('step-indicator-1').classList.add('active');
        });

        document.getElementById('close-create-team').addEventListener('click', () => createTeamModal.classList.remove('active'));

        const soloQueueModal = document.getElementById('solo-queue-modal');
        const openSoloQueueModal = () => {
            if (!isRegistrationOpen()) {
                alert('Registration is closed for this event.');
                return;
            }
            const termsDisplay = document.getElementById('solo-terms-display');
            const terms = currentEvent.soloQueueTerms;
            if (terms) {
                const rendered = terms.includes('<') ? terms : terms.replace(/\n/g, '<br>');
                termsDisplay.innerHTML = rendered;
                termsDisplay.classList.remove('hidden');
            } else {
                termsDisplay.innerHTML = '';
                termsDisplay.classList.add('hidden');
            }
            soloQueueModal.classList.add('active');
        };
        document.getElementById('join-solo-btn').addEventListener('click', openSoloQueueModal);
        const interestSoloBtn = document.getElementById('interest-solo-btn');
        if (interestSoloBtn) interestSoloBtn.addEventListener('click', openSoloQueueModal);

        document.getElementById('close-solo-queue').addEventListener('click', () => soloQueueModal.classList.remove('active'));

        document.getElementById('solo-queue-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await joinSoloQueue();
        });

        document.getElementById('leave-queue-btn').addEventListener('click', async () => {
            await leaveSoloQueue();
        });

        document.getElementById('leave-queue-interest-btn')?.addEventListener('click', async () => {
            await leaveSoloQueue();
        });

        ['upgrade-register-team-btn-a', 'upgrade-register-team-btn-b'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', () => {
                document.getElementById('create-team-btn')?.click();
            });
        });

        document.getElementById('close-team-details').addEventListener('click', () => {
            document.getElementById('team-details-modal').classList.remove('active');
        });

        document.getElementById('close-edit-participant').addEventListener('click', () => {
            if (!profileConfirmationRequired) {
                document.getElementById('edit-participant-modal').classList.remove('active');
            }
        });

        document.querySelectorAll('.modal-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetId = tab.dataset.tab;
                document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById(targetId).classList.add('active');
            });
        });

        document.getElementById('close-invite-member').addEventListener('click', () => {
            document.getElementById('invite-member-modal').classList.remove('active');
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay && !(profileConfirmationRequired && overlay.id === 'edit-participant-modal')) {
                    overlay.classList.remove('active');
                }
            });
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(modal => {
                    if (!(profileConfirmationRequired && modal.id === 'edit-participant-modal')) {
                        modal.classList.remove('active');
                    }
                });
            }
        });

        document.getElementById('create-team-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await createTeam();
        });

        document.getElementById('edit-participant-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveParticipantEdit();
        });

        document.getElementById('invite-member-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            await sendInvitation();
        });
    }

    async function checkSoloQueueStatus() {
        try {
            const result = await API.soloQueue.getPosition(eventId, currentUser.id);

            if (result && result.inQueue) {
                currentSoloQueueEntry = result.entry || null;
                showSoloQueueStatus(result.position, result.totalInQueue ?? result.totalCount);
                return;
            }

            if (result && typeof result.position !== 'undefined' && result.position !== null) {
                currentSoloQueueEntry = null;
                showSoloQueueStatus(result.position, result.totalInQueue ?? result.totalCount);
                return;
            }

            currentSoloQueueEntry = null;
            hideSoloQueueStatus();
        } catch (error) {
            currentSoloQueueEntry = null;
            hideSoloQueueStatus();
        }
    }

    function showSoloQueueStatus(position, total) {
        const roleSection = document.getElementById('role-confirmed-section');
        const isInterestUser = roleSection && roleSection.classList.contains('interest');

        const hasTeam = currentParticipation?.teamId ||
            (Array.isArray(currentParticipation?.teamMemberships) && currentParticipation.teamMemberships.length > 0);
        if (hasTeam) return;

        if (isInterestUser) {
            document.getElementById('upgrade-not-queued').classList.add('hidden');
            document.getElementById('upgrade-in-queue').classList.remove('hidden');
            document.getElementById('interest-queue-position').textContent = `${position} of ${total}`;
            document.getElementById('solo-queue-status').classList.add('hidden');
        } else {
            document.getElementById('solo-queue-status').classList.remove('hidden');
            document.getElementById('queue-position').textContent = `${position} of ${total}`;
            document.getElementById('join-solo-btn').classList.add('hidden');
        }
    }

    function hideSoloQueueStatus() {
        const roleSection = document.getElementById('role-confirmed-section');
        const isInterestUser = roleSection && roleSection.classList.contains('interest');

        if (isInterestUser) {
            document.getElementById('upgrade-not-queued').classList.remove('hidden');
            document.getElementById('upgrade-in-queue').classList.add('hidden');
        } else {
            document.getElementById('solo-queue-status').classList.add('hidden');
            document.getElementById('join-solo-btn').classList.remove('hidden');
        }
    }

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

    async function createTeam() {
        const submitBtn = document.getElementById('create-team-submit');
        const errorDiv = document.getElementById('create-team-error');
        const successDiv = document.getElementById('create-team-success');

        const ackCheckbox = document.getElementById('create-team-ack');
        if (!ackCheckbox.checked) {
            errorDiv.textContent = 'Please acknowledge to proceed.';
            errorDiv.classList.remove('hidden');
            return;
        }

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

            const newTeam = await API.teams.create({
                teamName: teamName,
                committedParticipants: committedCount,
                adminEmail: currentUser.email,
                creatorParticipates: creatorParticipates,
                eventId: eventId
            });

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

            setTimeout(() => {
                location.reload();
            }, 1200);

        } catch (error) {
            errorDiv.textContent = error.message || 'Could not create team.';
            errorDiv.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').classList.remove('hidden');
            submitBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }

    async function unlockTeamSlot(teamId) {
        const team = eventTeams.find(t => t.id === teamId);
        if (!team) return;

        const currentCommitted = team.committedParticipants || team.numberOfParticipants || 3;
        const newCommitted = currentCommitted + 1;

        if (!confirm(`Unlock 1 more slot? This will expand your team commitment to ${newCommitted} participants.`)) {
            return;
        }

        try {
            await API.teams.update(teamId, { committedParticipants: newCommitted });

            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();

        } catch (error) {
            console.error('Error unlocking slot:', error);
            alert('Could not unlock slot: ' + error.message);
        }
    }

    let _termsOnConfirm = null;

    function showRegistrationTermsModal(actionTitle, termsHtml, onConfirm) {
        _termsOnConfirm = onConfirm;
        document.getElementById('registration-terms-title').textContent = `Before you continue: ${actionTitle}`;
        const rendered = termsHtml.includes('<') ? termsHtml : termsHtml.replace(/\n/g, '<br>');
        document.getElementById('registration-terms-body').innerHTML = rendered;
        document.getElementById('registration-terms-modal').classList.add('active');
    }

    window.closeRegistrationTermsModal = function() {
        document.getElementById('registration-terms-modal').classList.remove('active');
        _termsOnConfirm = null;
    };

    window.confirmRegistrationTerms = function() {
        const cb = _termsOnConfirm;
        closeRegistrationTermsModal();
        if (cb) cb();
    };
});

