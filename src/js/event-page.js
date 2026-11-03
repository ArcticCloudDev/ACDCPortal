

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up…</div></div>');
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
    // Users fetched for the team cards, reused by the badge section (same /users/{id} data).
    const usersById = new Map();

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
            // Sign in and come straight back to this event (register.js validates the redirect).
            Auth.login();
            return;
        }

        const authUser = Auth.getUser();

        try {
            currentUser = await API.users.getOrNull(authUser.email);

            if (!currentUser) {
                window.location.href = completeProfileUrl;
                return;
            }
        } catch (error) {
            console.error('Error loading user:', error);
            window.location.href = completeProfileUrl;
            return;
        }

        // The event and this user's participation do not depend on each other.
        const [eventResult, participationResult] = await Promise.allSettled([
            API.events.get(eventId),
            API.participations.getOrNull(currentUser.id, eventId)
        ]);

        currentParticipation = participationResult.status === 'fulfilled' ? (participationResult.value || null) : null;

        if (!currentUser.profileComplete && !currentParticipation) {
            window.location.href = completeProfileUrl;
            return;
        }

        if (eventResult.status === 'rejected') {
            console.error('Error loading event:', eventResult.reason);
            loadingDiv.innerHTML = `<p class="error-message">Event not found</p>
                                   <a href="events.html" class="btn btn-primary">Back to events</a>`;
            return;
        }
        currentEvent = eventResult.value;

        if (!currentParticipation) {
            // A first visit only records that the user looked at the event; hotel nights are
            // chosen later, never invented here.
            currentParticipation = await API.participations.upsert({
                userId: currentUser.id,
                eventId: eventId,
                hotelNights: {}
            });
        }

        await loadEventTeams();

        populateEventBanner();
        setupCostHint();
        await renderTeams();

        if (urlParams.get('action') === 'create-team') {
            window.history.replaceState({}, '', `event.html?id=${encodeURIComponent(eventId)}`);
            // Only open the dialog once we know the user is not already on a team here.
            if (!userHasTeam() && isRegistrationOpen()) {
                document.getElementById('create-team-btn').click();
            }
        }

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
        loadingDiv.innerHTML = `<p class="error-message">Error loading: ${escapeHtml(error.message)}</p>
                               <a href="events.html" class="btn btn-primary">Back to events</a>`;
    }

    // Teams, roster, badges and claims are independent: load them together.
    async function loadEventTeams() {
        const [teamsResult, rosterResult, badgesResult, claimsResult] = await Promise.allSettled([
            API.request('/teams'),
            API.participations.getByEvent(eventId),
            API.badges.getEventBadges(eventId),
            API.badgeClaims.list({ eventId: eventId })
        ]);

        if (teamsResult.status === 'fulfilled') {
            eventTeams = teamsResult.value.filter(t => sameId(t.eventId, eventId));
        } else {
            console.error('Error loading teams:', teamsResult.reason);
            eventTeams = [];
        }

        if (rosterResult.status === 'fulfilled') {
            allParticipations = rosterResult.value || [];
        } else {
            console.error('Error loading participations:', rosterResult.reason);
            allParticipations = [];
        }

        if (badgesResult.status === 'fulfilled' && claimsResult.status === 'fulfilled') {
            eventBadges = badgesResult.value || [];
            badgeClaims = claimsResult.value || [];
        } else {
            console.error('Error loading badges:', badgesResult.reason || claimsResult.reason);
            eventBadges = [];
            badgeClaims = [];
        }
    }

    // IDs come back upper-case from SQL and lower-case from some API echoes.
    function sameId(a, b) {
        return a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase();
    }

    function userHasTeam() {
        return !!currentParticipation?.teamId
            || (Array.isArray(currentParticipation?.teamMemberships) && currentParticipation.teamMemberships.length > 0);
    }

    function isRegistrationOpen() {
        if (!currentEvent) return false;
        return currentEvent.status === 'registration' || !!currentEvent.registrationOpen;
    }

    function setupCostHint() {
        if (!currentEvent || currentEvent.costPerParticipant == null) return;
        const participantSelect = document.getElementById('expectedParticipants');
        const costHint = document.getElementById('cost-hint');
        if (!participantSelect || !costHint) return;
        const currency = escapeHtml(currentEvent.currency || '');
        const locale = currencyLocale(currentEvent.currency);
        const costPer = Number(currentEvent.costPerParticipant) || 0;
        function updateCostHint() {
            const count = parseInt(participantSelect.value) || 0;
            if (count > 0) {
                const total = (count * costPer).toLocaleString(locale);
                costHint.innerHTML = `Total commitment: <strong>${total}\u00a0${currency}</strong> (${count}\u00a0\u00d7\u00a0${costPer.toLocaleString(locale)}\u00a0${currency})`;
            } else {
                costHint.textContent = `${costPer.toLocaleString(locale)}\u00a0${currentEvent.currency || ''} per participant \u2014 select a count to see total.`;
            }
        }
        participantSelect.addEventListener('change', updateCostHint);
        updateCostHint();
    }

    function populateEventBanner() {
        const currentTeam = eventTeams.find(team => sameId(team.id, currentParticipation?.teamId));
        const headerTitle = currentTeam
            ? `${currentEvent.name} - ${currentTeam.teamName}`
            : currentEvent.name;

        const status = currentEvent.status || 'draft';
        let statusText = 'Coming soon';
        if (status === 'live') statusText = 'Live';
        else if (status === 'registration') statusText = 'Registration open';
        else if (status === 'pre-registration') statusText = 'Pre-registration';
        else if (status === 'completed') statusText = 'Completed';
        // Status colours as on the events list: open = success, upcoming = info, live = violet.
        const statusTone = { 'registration': 'badge-success', 'pre-registration': 'badge-info', 'live': 'badge-violet' }[status] || '';

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
                `<span class="info-item meta-item">${icon('calendar')}${formatDateRange(currentEvent.startDate, currentEvent.endDate)}</span>`,
                currentEvent.location ? `<span class="info-item meta-item">${icon('map-pin')}${escapeHtml(currentEvent.location)}</span>` : '',
                currentEvent.costPerParticipant != null ? `<span class="info-item meta-item">${icon('wallet')}${currentEvent.costPerParticipant.toLocaleString(currencyLocale(currentEvent.currency))}\u00a0${currentEvent.currency || ''} / person</span>` : '',
                `<span class="status-chip badge badge-dot ${statusTone}">${escapeHtml(statusText)}</span>`,
            ].filter(Boolean).join('');
            infoStrip.innerHTML = stripItems;
            infoStrip.classList.remove('hidden');
        }

        const banner = SiteHeader.getElements().container;

        const isJudge = userRoles.includes('judge');
        const isCommittee = userRoles.includes('committee');
        const hasTeam = userHasTeam();
        const isInterest = userRoles.includes('interest') && !hasTeam;
        const hasSpecialRole = isJudge || isCommittee || isInterest;
        const eventMeta = `<div class="meta-list"><span class="meta-item">${icon('calendar')}${escapeHtml(formatDateRange(currentEvent.startDate, currentEvent.endDate))}</span>`
            + (currentEvent.location ? `<span class="meta-item">${icon('map-pin')}${escapeHtml(currentEvent.location)}</span>` : '')
            + '</div>';

        if (hasSpecialRole) {
            banner.classList.remove('inactive');

            const preRegSection = document.getElementById('pre-reg-section');
            if (preRegSection) preRegSection.classList.add('hidden');
            if (!hasTeam) {
                // A judge or committee member who is also on a team keeps their team section.
                document.getElementById('event-nav')?.classList.add('hidden');
                const teamsSection = document.querySelector('.teams-section');
                if (teamsSection) teamsSection.classList.add('hidden');
                const noTeams = document.getElementById('no-teams');
                if (noTeams) noTeams.classList.add('hidden');
                const createSection = document.getElementById('create-team-section');
                if (createSection) createSection.classList.add('hidden');
            }

            const roleSection = document.getElementById('role-confirmed-section');
            if (roleSection) {
                roleSection.classList.remove('hidden');

                if (isJudge) {
                    roleSection.classList.add('judge');
                    document.getElementById('role-confirmed-icon').innerHTML = icon('scale');
                    document.getElementById('role-confirmed-title').textContent = `You're a judge for ${currentEvent.name}`;
                    document.getElementById('role-confirmed-message').textContent =
                        `You've been registered as a judge for this event. We'll notify you when judging details are available.`;
                    document.getElementById('role-confirmed-badge').innerHTML = `${icon('circle-check', 'icon-sm')}Confirmed as judge`;
                    document.getElementById('role-confirmed-details').innerHTML = eventMeta +
                        `<p class="role-note">We'll be in touch with judging criteria, schedules, and logistics closer to the event.</p>`;
                    const adminLink = document.getElementById('role-admin-link');
                    if (adminLink) {
                        adminLink.innerHTML = `${icon('scale')}Open judge portal`;
                        adminLink.classList.remove('hidden');
                    }
                } else if (isCommittee) {
                    roleSection.classList.add('committee');
                    document.getElementById('role-confirmed-icon').innerHTML = icon('landmark');
                    document.getElementById('role-confirmed-title').textContent = `You're on the committee for ${currentEvent.name}`;
                    document.getElementById('role-confirmed-message').textContent =
                        `You've been registered as a committee member for this event. We'll notify you as things progress.`;
                    document.getElementById('role-confirmed-badge').innerHTML = `${icon('circle-check', 'icon-sm')}Confirmed committee member`;
                    document.getElementById('role-confirmed-details').innerHTML = eventMeta +
                        `<p class="role-note">You'll receive updates as the event planning progresses.</p>`;
                    const adminLink = document.getElementById('role-admin-link');
                    if (adminLink) {
                        adminLink.innerHTML = `${icon('landmark')}Open committee portal`;
                        adminLink.classList.remove('hidden');
                    }
                } else if (isInterest) {
                    roleSection.classList.add('interest');
                    // While registration is open an interest lead sees only the "ready to join?" card
                    // (.can-join). Otherwise the confirmation panel, worded for the event's status: the
                    // join buttons would only answer "registration is not open".
                    const canJoinNow = isRegistrationOpen();
                    const isOver = status === 'live' || status === 'completed';
                    roleSection.classList.toggle('can-join', canJoinNow);
                    document.getElementById('role-confirmed-icon').innerHTML = icon('bell');
                    document.getElementById('role-confirmed-title').textContent = `You've registered interest in ${currentEvent.name}`;
                    document.getElementById('role-confirmed-message').textContent = isOver
                        ? 'Registration for this event has closed.'
                        : 'We\'ll email you as soon as registration opens.';
                    document.getElementById('role-confirmed-badge').innerHTML = `${icon('circle-check', 'icon-sm')}Interest registered`;
                    document.getElementById('role-confirmed-details').innerHTML = eventMeta +
                        `<p class="role-note">${isOver
                            ? 'Thanks for your interest. Keep an eye on the events page for the next one.'
                            : 'Keep an eye on your inbox: we\'ll send updates as the event takes shape.'}</p>`;

                    if (canJoinNow) {
                        const upgradeDiv = document.getElementById('interest-upgrade-actions');
                        if (upgradeDiv) upgradeDiv.classList.remove('hidden');
                    }
                }

                const editBtn = document.getElementById('edit-details-btn');
                if (isInterest && !isJudge && !isCommittee) {
                    if (editBtn) editBtn.classList.add('hidden');
                } else {
                    // Only organizers can change hotel nights; for judges the hotel tab is read-only.
                    const canEditHotel = currentEvent.hotelEnabled && (isCommittee || !!currentUser?.isPortalAdmin);
                    if (editBtn) editBtn.innerHTML = `${icon('pencil')}${canEditHotel ? 'Update my details and hotel' : 'Update my details'}`;
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
                    interestLink.href = `register.html?intent=interest&eventId=${encodeURIComponent(currentEvent.id)}`;
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
            (currentParticipation?.teamMemberships || []).map(m => String(m.teamId).toUpperCase())
        );
        if (currentParticipation?.teamId) {
            userTeamIds.add(String(currentParticipation.teamId).toUpperCase());
        }
        const myTeams = isPrivileged ? eventTeams : eventTeams.filter(t => userTeamIds.has(String(t.id).toUpperCase()));

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

            document.querySelectorAll('.resend-invite-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    btn.disabled = true;
                    btn.textContent = 'Sending…';
                    try {
                        await API.invitations.resend(btn.dataset.inviteId);
                        btn.innerHTML = `${icon('check', 'icon-sm')}Sent`;
                        setTimeout(() => { btn.disabled = false; btn.textContent = 'Resend'; }, 2000);
                    } catch (err) {
                        alert('Failed to resend: ' + err.message);
                        btn.disabled = false;
                        btn.textContent = 'Resend';
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
        document.querySelectorAll('.btn-upload[data-team-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById(`file-${btn.dataset.teamId}`)?.click();
            });
        });

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
                progressEl.textContent = `Uploading "${file.name}"…`;
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
                progressEl.textContent = `"${file.name}" uploaded successfully!`;
                setTimeout(() => progressEl.classList.add('hidden'), 3000);
            }

            await loadEventTeams();
            await renderTeams();

        } catch (error) {
            console.error('File upload error:', error);
            if (progressEl) {
                progressEl.textContent = `Upload failed: ${error.message}`;
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

    async function buildTeamCard(team) {
        const teamParticipations = allParticipations.filter(p => {
            const memberships = p.teamMemberships || [];
            return memberships.some(m => sameId(m.teamId, team.id));
        });

        const userMembership = currentParticipation?.teamMemberships?.find(m => sameId(m.teamId, team.id));
        const isAdmin = userMembership?.isAdmin || false;
        // Only team admins, committee and portal admins may list a team's invitations.
        const canSeeInvitations = isAdmin || currentUser.isPortalAdmin
            || (currentParticipation?.roles || []).includes('committee');

        // Member profiles, pending invitations and uploaded files are independent requests.
        // The roster only carries membership data for ordinary participants, so each member's
        // profile still has to be fetched (one request per member, all in parallel).
        const [allParticipantCards, teamInvitations, uploadsHtml] = await Promise.all([
            Promise.all(teamParticipations.map(async (p) => {
                try {
                    const user = await API.request(`/users/${encodeURIComponent(p.userId)}`);
                    usersById.set(String(user.id).toUpperCase(), user);
                    const membership = (p.teamMemberships || []).find(m => sameId(m.teamId, team.id));
                    const canEdit = isAdmin || sameId(p.userId, currentUser.id);
                    return { user, membership, participation: p, canEdit, isTBD: user.isTBD || false };
                } catch (err) {
                    return null;
                }
            })),
            canSeeInvitations
                ? API.invitations.list(team.id).catch(err => {
                    console.error('Error loading invitations for team:', err);
                    return [];
                })
                : Promise.resolve([]),
            currentEvent.sharepointUrl ? buildUploadsSection(team) : Promise.resolve('')
        ]);

        const participantCards = allParticipantCards
            .filter(p => p !== null && !p.isTBD)
            .map(p => buildParticipantCard(p.user, p.membership, p.participation, p.canEdit, team.id));

        const maxParticipants = currentEvent.maxTeamSize || 5;
        // The team size lives in numberOfParticipants; committedParticipants is a legacy alias.
        const committedParticipants = team.numberOfParticipants || team.committedParticipants || maxParticipants;

        const realParticipantCount = allParticipantCards.filter(p => p !== null && !p.isTBD && p.membership?.isParticipant).length;

        const pendingInvitations = (teamInvitations || []).filter(i => i.status === 'pending');

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
                <div class="participant-card pending-card" data-invite-id="${escapeHtml(inv.id)}">
                    <div class="participant-head">
                        <span class="avatar avatar-muted pending-icon" aria-hidden="true">${icon('mail')}</span>
                        <div class="participant-ident">
                            <div class="name">Invitation sent</div>
                        </div>
                    </div>
                    <div class="roles">
                        <span class="role-tag pending badge badge-warning">Pending</span>
                    </div>
                    <div class="participant-details">
                        <div class="detail-row email">${icon('mail')}<span>${escapeHtml(inv.email)}</span></div>
                        <div class="detail-row pending-date">${icon('clock')}<span>Sent ${new Date(inv.createdAt).toLocaleDateString()}</span></div>
                    </div>
                    ${isAdmin ? `
                    <div class="pending-actions">
                        <button type="button" class="btn btn-small btn-ghost resend-invite-btn" data-invite-id="${escapeHtml(inv.id)}">Resend</button>
                        <button type="button" class="btn btn-small btn-danger-ghost cancel-invite-btn" data-invite-id="${escapeHtml(inv.id)}" data-invite-email="${escapeHtml(inv.email)}">Cancel</button>
                    </div>` : ''}
                </div>
            `).join('');
        }

        let emptySlotsHtml = '';
        if (isAdmin && emptyCommittedSlots > 0) {
            emptySlotsHtml = Array(emptyCommittedSlots).fill(`
                <button type="button" class="empty-slot add-member-slot" data-team-id="${escapeHtml(team.id)}">
                    <span class="add-icon">${icon('user-plus')}</span>
                    <span class="add-text">Add member</span>
                </button>
            `).join('');
        }

        let unlockSlotsHtml = '';
        if (isAdmin && unlockSlots > 0) {
            unlockSlotsHtml = `
                <button type="button" class="unlock-slot" data-team-id="${escapeHtml(team.id)}">
                    <span class="unlock-icon">${icon('lock-open')}</span>
                    <span class="unlock-text">Unlock 1 more slot</span>
                </button>
            `;
        }

        return `
            <div class="team-card" data-team-id="${escapeHtml(team.id)}">
                <div class="team-card-body">
                    <div class="team-card-header">
                        <h2>${escapeHtml(team.teamName)}</h2>
                        <div class="team-stats meta-list">
                            <span class="meta-item">${icon('users')}${realParticipantCount}/${committedParticipants} committed</span>
                            ${legacyPendingInvitations.length > 0 ? `<span class="meta-item">${icon('mail')}${legacyPendingInvitations.length} pending</span>` : ''}
                            <span class="meta-item">${emptyCommittedSlots > 0 ? `${icon('circle-dot')}${emptyCommittedSlots} open` : `${icon('circle-check')}Full`}</span>
                        </div>
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

        const teamIdAttr = escapeHtml(team.id);
        const filesHtml = spFiles.length > 0
            ? `<div class="uploaded-files-list">
                ${spFiles.map(f => {
                    const link = safeHttpUrl(f.webUrl);
                    const nameHtml = link
                        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" class="file-name file-link">${escapeHtml(f.name)}</a>`
                        : `<span class="file-name">${escapeHtml(f.name)}</span>`;
                    return `
                    <div class="uploaded-file-row">
                        <span class="file-category-badge badge">${escapeHtml(f.category || 'General')}</span>
                        ${nameHtml}
                        <span class="file-size">${formatFileSize(f.size)}</span>
                        <button type="button" class="btn-remove btn btn-icon btn-small btn-danger-ghost" data-team-id="${teamIdAttr}" data-file-path="${escapeHtml(`Events/${currentEvent.id}/${team.id}/${f.name}`)}" title="Remove" aria-label="Remove file">${icon('trash-2')}</button>
                    </div>
                `; }).join('')}
              </div>`
            : '<p class="uploads-empty">No files uploaded yet.</p>';

        return `
            <div class="team-uploads card">
                <h3>${icon('folder')}Team deliverables</h3>
                ${filesHtml}
                <div class="upload-box">
                    <div class="upload-row">
                        <label for="file-cat-${teamIdAttr}" class="visually-hidden">File category</label>
                        <select id="file-cat-${teamIdAttr}" class="upload-category-select input">
                            ${categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
                        </select>
                        <input type="file" id="file-${teamIdAttr}" class="hidden" accept="*/*" aria-label="Choose a file to upload">
                        <button type="button" class="btn btn-secondary btn-upload" id="upload-btn-${teamIdAttr}" data-team-id="${teamIdAttr}">${icon('upload')}Upload file</button>
                    </div>
                    <div id="upload-progress-${teamIdAttr}" class="upload-progress hidden"></div>
                </div>
                <small class="upload-hint">Max 10 MB per file.</small>
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
            container.innerHTML = `<div class="empty-state">${icon('award')}<p>No badges available for this event.</p></div>`;
            return;
        }

        const badgeTeamIds = new Set(
            (currentParticipation?.teamMemberships || []).map(m => String(m.teamId).toUpperCase())
        );
        if (currentParticipation?.teamId) badgeTeamIds.add(String(currentParticipation.teamId).toUpperCase());
        const myTeam = eventTeams.find(t => badgeTeamIds.has(String(t.id).toUpperCase()));
        const teamId = myTeam?.id || '';

        const teamParticipations = allParticipations.filter(p => {
            const memberships = p.teamMemberships || [];
            return memberships.some(m => sameId(m.teamId, teamId));
        });
        const memberOptions = teamParticipations
            .filter(p => {
                const m = (p.teamMemberships || []).find(m => sameId(m.teamId, teamId));
                return m?.isParticipant;
            })
            .map(p => {
                const user = usersById.get(String(p.userId).toUpperCase());
                const first = user?.firstName ?? p.firstName ?? '';
                const last = user?.lastName ?? p.lastName ?? '';
                return {
                    userId: p.userId,
                    name: `${first} ${last}`.trim() || user?.email || p.email || 'Team member'
                };
            });

        const categoryOrder = { 'soft': 0, 'low-code': 1, 'pro-code': 2, 'sponsor': 3, 'exclusive': 4 };
        const categoryLabels = { 'soft': 'Soft skills', 'low-code': 'Low-code', 'pro-code': 'Pro-code', 'sponsor': 'Sponsor', 'exclusive': 'Exclusive' };
        const categoryIcons = { 'soft': 'handshake', 'low-code': 'zap', 'pro-code': 'laptop', 'sponsor': 'building-2', 'exclusive': 'trophy' };
        const categoryIcon = cat => categoryIcons[cat] ? icon(categoryIcons[cat], 'icon-sm') : '';

        const teamClaims = teamId ? badgeClaims.filter(c => sameId(c.teamId, teamId)) : [];

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
                return `<button type="button" class="badge-tab ${i === 0 ? 'active' : ''}" data-cat="${escapeHtml(cat)}">
                    ${categoryIcon(cat)}${escapeHtml(label)} <span class="badge-tab-count">${awardedCount}/${catBadges.length}</span>
                </button>`;
            }
            const catClaimed = catBadges.filter(({ eventBadge }) => {
                return teamClaims.some(c => c.eventBadgeId === eventBadge.id && (c.status === 'pending' || c.status === 'approved'));
            }).length;
            return `<button type="button" class="badge-tab ${i === 0 ? 'active' : ''}" data-cat="${escapeHtml(cat)}">
                ${categoryIcon(cat)}${escapeHtml(label)} <span class="badge-tab-count">${catClaimed}/${catBadges.length}</span>
            </button>`;
        }).join('');

        let panelsHtml = '';
        for (let ci = 0; ci < sortedCategories.length; ci++) {
            const cat = sortedCategories[ci];
            const badges = grouped[cat];

            panelsHtml += `<div class="badge-panel ${ci === 0 ? 'active' : ''}" data-cat="${escapeHtml(cat)}">`;

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

                // Badge names, URLs and ids are rendered as text / data attributes; the click
                // handler is delegated from the section (no inline handlers under the CSP).
                const claimAttrs = `data-eb-id="${escapeHtml(eventBadge.id)}" data-team-id="${escapeHtml(teamId)}" data-badge-name="${escapeHtml(badge.name)}"`;
                const blogLink = claim ? safeHttpUrl(claim.blogUrl) : '';
                const blogHtml = blogLink
                    ? `<a href="${escapeHtml(blogLink)}" target="_blank" rel="noopener noreferrer" class="btn-badge-blog btn btn-small btn-ghost" title="View blog post">${icon('external-link', 'icon-sm')}Blog</a>`
                    : '';

                if (claim && claim.status === 'approved') {
                    statusHtml = `<span class="badge-claim-status approved badge badge-success" title="Approved">Approved</span>`;
                    actionHtml = blogHtml;
                } else if (claim && claim.status === 'pending') {
                    statusHtml = `<span class="badge-claim-status submitted badge badge-info" title="Submitted — awaiting review">Submitted</span>`;
                    actionHtml = blogHtml;
                } else if (claim && claim.status === 'declined') {
                    statusHtml = `<span class="badge-claim-status rejected badge badge-danger" title="Rejected">Rejected</span>`;
                    if (teamId && isEventLive) {
                        actionHtml = `<button type="button" class="btn-badge-claim btn btn-small btn-secondary" ${claimAttrs}>Claim again</button>`;
                    }
                } else if (isExclusive) {
                    statusHtml = `<span class="badge-claim-status exclusive badge badge-outline" title="Exclusive — awarded by judges">${icon('trophy', 'icon-sm')}Exclusive</span>`;
                    if (canAward) {
                        actionHtml = `<button type="button" class="btn-badge-award btn btn-small btn-secondary" ${claimAttrs}>${icon('trophy', 'icon-sm')}Award</button>`;
                    }
                } else {
                    if (teamId && isEventLive) {
                        actionHtml = `<button type="button" class="btn-badge-claim btn btn-small btn-secondary" ${claimAttrs}>Claim</button>`;
                    }
                }

                let assignedHtml = '';
                if (isExclusive && claim && claim.status === 'approved') {
                    const awardedTeam = eventTeams.find(t => sameId(t.id, claim.teamId));
                    assignedHtml = `<span class="badge-assigned-name">${icon('trophy', 'icon-sm')}${awardedTeam ? escapeHtml(awardedTeam.teamName) : 'Unknown team'}</span>`;
                } else if (isExclusive) {
                    assignedHtml = `<span class="badge-assigned-name is-awaiting">Awaiting award…</span>`;
                } else if (!isExclusive && teamId) {
                    const isApproved = claim && claim.status === 'approved';
                    assignedHtml = `
                        <select class="badge-assign-select" data-eb-id="${escapeHtml(eventBadge.id)}" data-team-id="${escapeHtml(teamId)}"
                                title="Assign team member" aria-label="Assign team member"${isApproved ? ' disabled' : ''}>
                            <option value="">Assign to…</option>
                            ${memberOptions.map(m =>
                                `<option value="${escapeHtml(m.userId)}" ${sameId(m.userId, assignedUserId) ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
                            ).join('')}
                        </select>
                    `;
                } else if (assignedUserId) {
                    const assigned = memberOptions.find(m => sameId(m.userId, assignedUserId));
                    assignedHtml = `<span class="badge-assigned-name">${assigned ? escapeHtml(assigned.name) : ''}</span>`;
                }

                const examplesUrl = safeHttpUrl(badge.imageUrl);
                const examplesLink = examplesUrl
                    ? `<a href="${escapeHtml(examplesUrl)}" target="_blank" rel="noopener noreferrer" class="btn-badge-examples btn btn-small btn-ghost" title="${escapeHtml(badge.description)}">${icon('external-link', 'icon-sm')}Examples</a>`
                    : '';

                const rejectionHtml = (claim && claim.status === 'declined' && claim.declineReason)
                    ? `<div class="badge-reject-reason">${icon('message-square', 'icon-sm')}<span>${escapeHtml(claim.declineReason)}</span></div>`
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
                <h2>Badges</h2>
                <span class="badge-stats">${claimedCount}/${totalBadges} claimed · ${earnedPoints}/${totalPoints} points</span>
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
                 data-user-id="${escapeHtml(user.id)}"
                 data-participation-id="${escapeHtml(participation.id)}"
                 data-team-id="${escapeHtml(teamId)}"
                 data-can-edit="${canEdit}">
                <div class="participant-head">
                    <span class="avatar" aria-hidden="true">${escapeHtml(getInitials(user.firstName, user.lastName))}</span>
                    <div class="participant-ident">
                        <div class="name">${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</div>
                    </div>
                    ${canEdit ? `<button type="button" class="btn btn-small btn-ghost edit-participant-btn">${icon('pencil', 'icon-sm')}Edit</button>` : ''}
                </div>
                <div class="roles">
                    ${membership.isAdmin ? '<span class="role-tag admin badge badge-accent">Admin</span>' : ''}
                    ${membership.isParticipant ? '<span class="role-tag participant badge">Participant</span>' : ''}
                    ${participation.profileVerification === false ? `<span class="role-tag verify-needed badge badge-warning" title="Confirm your information to continue">${icon('circle-alert', 'icon-sm')}Confirm information</span>` : ''}
                </div>
                <div class="participant-details">
                    <div class="detail-row email">${icon('mail')}<span>${escapeHtml(user.email)}</span></div>
                    <div class="detail-row">${icon('phone')}<span>${escapeHtml(user.phone || 'N/A')}</span></div>
                    ${user.allergies ? `<div class="detail-row allergies">${icon('utensils')}<span>${escapeHtml(user.allergies)}</span></div>` : ''}
                </div>
            </div>
        `;
    }

    async function openParticipantEdit(userId, participationId, teamId, requireConfirmation = false) {
        const modal = document.getElementById('edit-participant-modal');
        const form = document.getElementById('edit-participant-form');
        const rolesTab = document.getElementById('tab-roles-btn');
        profileConfirmationRequired = requireConfirmation;
        document.getElementById('edit-participant-heading').textContent = requireConfirmation ? 'Confirm your details' : 'Edit details';

        // Never show the previous session's error or "Saved!" message.
        document.getElementById('edit-participant-error').classList.add('hidden');
        document.getElementById('edit-participant-success').classList.add('hidden');

        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
        document.getElementById('tab-personal').classList.add('active');

        try {
            const user = await API.request(`/users/${encodeURIComponent(userId)}`);
            const participation = allParticipations.find(p => sameId(p.id, participationId));
            const membership = (participation?.teamMemberships || []).find(m => sameId(m.teamId, teamId));

            const currentMembership = currentParticipation?.teamMemberships?.find(m => sameId(m.teamId, teamId));
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
                        <div class="alert-icon">${icon('bed-double')}</div>
                        <div class="alert-body">
                            <div class="alert-title">Hotel booking needed</div>
                            <div class="alert-message">
                                Select your hotel nights soon so we can confirm the room reservations. Rooms fill up quickly.
                            </div>
                            <button type="button" id="role-hotel-select-btn" class="btn btn-secondary btn-small">${icon('moon', 'icon-sm')}Select hotel nights</button>
                        </div>
                    </div>
                `;
                hotelAlert.querySelector('#role-hotel-select-btn').addEventListener('click', openSelfEditHotel);
            } else {
                hotelAlert.innerHTML = `
                    <div class="hotel-urgency-alert is-info">
                        <div class="alert-icon">${icon('bed-double')}</div>
                        <div class="alert-body">
                            <div class="alert-title">Hotel not assigned yet</div>
                            <div class="alert-message">The organizers arrange your hotel nights. No action needed.</div>
                        </div>
                    </div>
                `;
            }
        } else {
            const nightCount = Object.values(hotelNights).filter(v => v === true).length;
            hotelAlert.innerHTML = `
                <div class="hotel-ok-badge badge badge-success">
                    ${icon('circle-check', 'icon-sm')}Hotel: ${nightCount} night${nightCount !== 1 ? 's' : ''} booked
                </div>
            `;
        }
    }

    async function openSelfEdit() {
        const modal = document.getElementById('edit-participant-modal');

        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-personal"]').classList.add('active');
        document.getElementById('tab-personal').classList.add('active');

        document.getElementById('tab-roles-btn').classList.add('hidden');
        document.getElementById('edit-participant-heading').textContent = 'Update your details';

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
    }

    async function openSelfEditHotel() {
        await openSelfEdit();
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="tab-hotel"]').classList.add('active');
        document.getElementById('tab-hotel').classList.add('active');
    }

    function switchEventTab(tabName, updateHash = true) {
        document.querySelectorAll('.event-nav-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        document.querySelectorAll('.event-tab-content').forEach(c => {
            c.classList.toggle('active', c.id === `tab-content-${tabName}`);
        });
        if (updateHash) {
            history.replaceState(null, '', `#${tabName}`);
        }
    }

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

    function switchBadgeTab(tabBtn) {
        const cat = tabBtn.dataset.cat;
        const section = document.getElementById('badges-section');
        if (!section) return;
        section.querySelectorAll('.badge-tab').forEach(t => t.classList.remove('active'));
        tabBtn.classList.add('active');
        section.querySelectorAll('.badge-panel').forEach(p => {
            p.classList.toggle('active', p.dataset.cat === cat);
        });
    }

    // One listener on the badge section serves every tab, claim/award button and assignment select.
    function setupBadgeSection() {
        const section = document.getElementById('badges-section');
        if (!section) return;
        section.addEventListener('click', (e) => {
            const tab = e.target.closest('.badge-tab');
            if (tab) { switchBadgeTab(tab); return; }
            const claimBtn = e.target.closest('.btn-badge-claim');
            if (claimBtn) { openClaimBadge(claimBtn.dataset.ebId, claimBtn.dataset.teamId, claimBtn.dataset.badgeName); return; }
            const awardBtn = e.target.closest('.btn-badge-award');
            if (awardBtn) { openAwardBadge(awardBtn.dataset.ebId, awardBtn.dataset.badgeName); }
        });
        section.addEventListener('change', (e) => {
            const select = e.target.closest('.badge-assign-select');
            if (select) assignBadgeMember(select);
        });
    }

    function openClaimBadge(eventBadgeId, teamId, badgeName) {
        const modal = document.getElementById('badge-claim-modal');
        if (!modal) return;

        document.getElementById('badge-claim-title').textContent = `Claim: ${badgeName}`;
        document.getElementById('badge-claim-eb-id').value = eventBadgeId;
        document.getElementById('badge-claim-team-id').value = teamId;
        document.getElementById('badge-claim-url').value = '';
        document.getElementById('badge-claim-error').classList.add('hidden');

        modal.classList.remove('hidden');
    }

    function openAwardBadge(eventBadgeId, badgeName) {
        const modal = document.getElementById('badge-award-modal');
        if (!modal) return;

        document.getElementById('badge-award-title').textContent = `Award: ${badgeName}`;
        document.getElementById('badge-award-eb-id').value = eventBadgeId;
        document.getElementById('badge-award-error').classList.add('hidden');

        const teamSelect = document.getElementById('badge-award-team');
        teamSelect.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a team...';
        teamSelect.appendChild(placeholder);
        for (const team of eventTeams) {
            const option = document.createElement('option');
            option.value = team.id;
            option.textContent = team.teamName;
            teamSelect.appendChild(option);
        }

        modal.classList.remove('hidden');
    }

    function closeBadgeClaimModal() {
        const modal = document.getElementById('badge-claim-modal');
        if (modal) modal.classList.add('hidden');
    }

    function closeAwardModal() {
        const modal = document.getElementById('badge-award-modal');
        if (modal) modal.classList.add('hidden');
    }

    async function submitBadgeAward() {
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
        submitBtn.textContent = 'Awarding…';
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
            submitBtn.textContent = 'Award badge';
        }
    }

    async function submitBadgeClaim() {
        const eventBadgeId = document.getElementById('badge-claim-eb-id').value;
        const teamId = document.getElementById('badge-claim-team-id').value;
        const blogUrl = document.getElementById('badge-claim-url').value.trim();
        const errorDiv = document.getElementById('badge-claim-error');
        const submitBtn = document.getElementById('badge-claim-submit-btn');

        if (!blogUrl) {
            errorDiv.textContent = 'Enter the link to your blog post.';
            errorDiv.classList.remove('hidden');
            return;
        }

        if (!safeHttpUrl(blogUrl)) {
            errorDiv.textContent = 'Enter a valid URL, for example https://acdc.blog/your-team/post.';
            errorDiv.classList.remove('hidden');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
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
            submitBtn.textContent = 'Submit claim';
        }
    }

    async function assignBadgeMember(selectEl) {
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
    }

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
                            <span class="night-icon">${icon('moon')}</span>
                            ${isLocked ? `<span class="lock-badge">${icon('lock')}</span>` : ''}
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
            if (!userData.firstName) missing.push('First name');
            if (!userData.lastName)  missing.push('Last name');
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
            const profileVerification = document.getElementById('edit-data-verified').checked;
            await API.participations.updateHotel(participationId, hotelNights, profileVerification);

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

            if (sameId(userId, currentUser.id)) {
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
        const team = eventTeams.find(t => sameId(t.id, teamId));
        if (!team) return;

        const userMembership = currentParticipation?.teamMemberships?.find(m => sameId(m.teamId, teamId));
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
                errorDiv.textContent = error.message || 'Could not add the team member.';
                errorDiv.classList.remove('is-warning');
                errorDiv.classList.remove('hidden');
            }
        } finally {
            sendBtn.disabled = false;
            sendBtn.querySelector('.btn-text').classList.remove('hidden');
            sendBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    }

    function showResendOption(email, invitationId, errorDiv, successDiv) {
        errorDiv.replaceChildren();
        const wrap = document.createElement('div');
        wrap.className = 'resend-option';
        const message = document.createElement('div');
        message.append('An invitation is already pending for ');
        const strong = document.createElement('strong');
        strong.textContent = email;
        message.appendChild(strong);
        const actions = document.createElement('div');
        actions.className = 'resend-option-actions';
        const resendBtn = document.createElement('button');
        resendBtn.type = 'button';
        resendBtn.className = 'btn btn-small btn-secondary';
        resendBtn.textContent = 'Resend invitation';
        resendBtn.addEventListener('click', () => resendExistingInvitation(invitationId));
        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'btn btn-small btn-ghost';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => errorDiv.classList.add('hidden'));
        actions.append(resendBtn, dismissBtn);
        wrap.append(message, actions);
        errorDiv.appendChild(wrap);
        errorDiv.classList.remove('hidden');
        // Not an error: a choice. Shown in warning colours (needs attention).
        errorDiv.classList.add('is-warning');
    }

    async function resendExistingInvitation(invitationId) {
        const errorDiv = document.getElementById('invite-error');
        const successDiv = document.getElementById('invite-success');

        try {
            await API.invitations.resend(invitationId);

            errorDiv.classList.add('hidden');
            errorDiv.classList.remove('is-warning');

            successDiv.textContent = 'Invitation sent again.';
            successDiv.classList.remove('hidden');

            document.getElementById('invite-email').value = '';

            setTimeout(() => {
                document.getElementById('invite-member-modal').classList.remove('active');
            }, 1500);
        } catch (error) {
            errorDiv.innerHTML = '';
            errorDiv.textContent = 'Could not resend the invitation: ' + (error.message || 'unknown error');
            errorDiv.classList.remove('is-warning');
        }
    }

    async function openTeamDetails(teamId) {
        const team = eventTeams.find(t => sameId(t.id, teamId));
        if (!team) return;

        const modal = document.getElementById('team-details-modal');
        const title = document.getElementById('team-modal-title');
        const membersList = document.getElementById('team-members-list');
        const adminActions = document.getElementById('team-admin-actions');

        title.textContent = team.teamName;
        membersList.innerHTML = '<p>Loading members…</p>';

        modal.classList.add('active');

        const userMembership = currentParticipation?.teamMemberships?.find(m => sameId(m.teamId, teamId));
        const isTeamAdmin = userMembership?.isAdmin;

        try {
            const teamParticipations = allParticipations.filter(p => {
                const membership = (p.teamMemberships || []).find(m => sameId(m.teamId, teamId));
                return membership;
            });

            const memberDetails = await Promise.all(
                teamParticipations.map(async (p) => {
                    try {
                        const user = await API.request(`/users/${p.userId}`);
                        const membership = (p.teamMemberships || []).find(m => sameId(m.teamId, teamId));
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
                        <div class="member-row member-item">
                            <div class="member-info">
                                <span class="avatar" aria-hidden="true">${escapeHtml(initials)}</span>
                                <div>
                                    <div class="name member-name">${escapeHtml(m.user.firstName)} ${escapeHtml(m.user.lastName)}</div>
                                    <div class="email member-email">${escapeHtml(m.user.email)}</div>
                                </div>
                            </div>
                            <div class="member-roles">
                                ${m.membership.isAdmin ? '<span class="role-badge admin badge badge-accent">Admin</span>' : ''}
                                ${m.membership.isParticipant ? '<span class="role-badge participant badge">Participant</span>' : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            }

            if (pendingInvitations.length > 0) {
                html += `<div class="pending-invitations-section member-section">
                    <p class="member-section-title">Pending invitations</p>
                `;
                html += pendingInvitations.map(inv => {
                    const sentDate = new Date(inv.createdAt).toLocaleDateString();
                    return `
                        <div class="member-row member-item invitation-pending">
                            <div class="member-info">
                                <span class="avatar avatar-muted" aria-hidden="true">${icon('mail')}</span>
                                <div>
                                    <div class="name member-name">${escapeHtml(inv.email)}</div>
                                    <div class="email member-email">Invited ${sentDate} • Awaiting response</div>
                                </div>
                            </div>
                            <div class="member-roles">
                                <span class="role-badge badge badge-warning">Pending</span>
                                <button type="button" class="btn btn-small btn-icon btn-danger-ghost cancel-pending-invite-btn" data-invite-id="${escapeHtml(inv.id)}" title="Cancel invitation" aria-label="Cancel invitation">${icon('x')}</button>
                            </div>
                        </div>
                    `;
                }).join('');
                html += '</div>';
            }

            const committedSpots = team.numberOfParticipants || team.committedParticipants || 3;
            const filledSpots = validMembers.length;
            const pendingSpots = pendingInvitations.length;
            const remainingSpots = Math.max(0, committedSpots - filledSpots - pendingSpots);

            if (isTeamAdmin && remainingSpots > 0) {
                html += `<div class="empty-spots-section member-section">
                    <p class="member-section-title">Available spots (${remainingSpots})</p>
                `;
                for (let i = 0; i < remainingSpots; i++) {
                    html += `
                        <div class="member-row member-item empty-spot">
                            <div class="member-info">
                                <span class="avatar avatar-muted" aria-hidden="true">${icon('user')}</span>
                                <div>
                                    <div class="name member-name">Empty spot</div>
                                    <div class="email member-email">Invite a team member</div>
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

    async function cancelInvitation(invitationId) {
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
    }

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

    // Safe for text nodes and quoted attribute values.
    function escapeHtml(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Admin-written terms are shown as text; line breaks survive through `white-space: pre-line`.
    function renderTerms(el, terms) {
        el.textContent = terms || '';
    }

    function setupModals() {
        document.getElementById('edit-details-btn')?.addEventListener('click', openSelfEdit);

        document.querySelectorAll('.event-nav-tab').forEach(tab => {
            tab.addEventListener('click', () => switchEventTab(tab.dataset.tab));
        });

        setupBadgeSection();

        ['badge-claim-backdrop', 'badge-claim-close', 'badge-claim-cancel'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', closeBadgeClaimModal);
        });
        document.getElementById('badge-claim-submit-btn')?.addEventListener('click', submitBadgeClaim);

        ['badge-award-backdrop', 'badge-award-close', 'badge-award-cancel'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', closeAwardModal);
        });
        document.getElementById('badge-award-submit-btn')?.addEventListener('click', submitBadgeAward);

        ['registration-terms-close', 'registration-terms-cancel'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', closeRegistrationTermsModal);
        });
        document.getElementById('registration-terms-confirm')?.addEventListener('click', confirmRegistrationTerms);

        document.getElementById('team-members-list')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.cancel-pending-invite-btn');
            if (btn) cancelInvitation(btn.dataset.inviteId);
        });

        const createTeamModal = document.getElementById('create-team-modal');
        document.getElementById('create-team-btn').addEventListener('click', () => {
            if (!isRegistrationOpen()) {
                alert('Registration is not open for this event.');
                return;
            }

            const select = document.getElementById('expectedParticipants');
            const min = currentEvent.minTeamSize || 3;
            const max = currentEvent.maxTeamSize || 5;
            select.innerHTML = '<option value="">Select…</option>';
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
                renderTerms(termsDisplay, terms);
                termsDisplay.classList.remove('hidden');
                ackLabel.textContent = 'I have read and agree to the terms above';
            } else {
                termsDisplay.classList.add('hidden');
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
                renderTerms(termsDisplay, terms);
                termsDisplay.classList.remove('hidden');
            } else {
                termsDisplay.textContent = '';
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

    // GET /solo-queue/position/{eventId}/{userId} answers {inQueue:false} or
    // {inQueue:true, position, totalCount, entry}. Older responses omit inQueue/entry and only
    // carry {position, totalCount}; both shapes are handled.
    async function checkSoloQueueStatus() {
        try {
            const result = await API.soloQueue.getPosition(eventId, currentUser.id);
            const inQueue = !!result && (result.inQueue === true
                || (result.inQueue === undefined && result.position != null));

            if (!inQueue) {
                currentSoloQueueEntry = null;
                hideSoloQueueStatus();
                return;
            }

            currentSoloQueueEntry = result.entry || await findOwnQueueEntry();
            showSoloQueueStatus(result.position, result.totalCount ?? result.totalInQueue);
        } catch (error) {
            currentSoloQueueEntry = null;
            hideSoloQueueStatus();
        }
    }

    // The queue list endpoint returns the caller's own entries; used when the position
    // response does not include the entry itself.
    async function findOwnQueueEntry() {
        try {
            const result = await API.soloQueue.get(eventId, currentUser.id);
            const entries = Array.isArray(result) ? result : (result?.entries || []);
            return entries.find(e => sameId(e.userId, currentUser.id) && sameId(e.eventId, eventId)) || null;
        } catch (error) {
            return null;
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

            let position = result.position;
            if (!(position > 0)) {
                // Fall back to the authoritative position when the join response has none.
                try {
                    const status = await API.soloQueue.getPosition(eventId, currentUser.id);
                    if (status?.position > 0) position = status.position;
                } catch (e) { }
            }

            successDiv.textContent = `You're in the queue! Position: ${position}`;
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
        if (!currentSoloQueueEntry) {
            currentSoloQueueEntry = await findOwnQueueEntry();
        }
        if (!currentSoloQueueEntry) {
            alert('Could not find your queue entry. Please reload the page and try again.');
            return;
        }

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
        const team = eventTeams.find(t => sameId(t.id, teamId));
        if (!team) return;

        const currentCommitted = team.numberOfParticipants || team.committedParticipants || 3;
        const newCommitted = currentCommitted + 1;

        if (!confirm(`Unlock 1 more slot? This will expand your team commitment to ${newCommitted} participants.`)) {
            return;
        }

        try {
            // The team size is stored in numberOfParticipants.
            await API.teams.update(teamId, { numberOfParticipants: newCommitted });

            await loadEventTeams();
            await renderTeams();
            renderBadgesSection();

        } catch (error) {
            console.error('Error unlocking slot:', error);
            alert('Could not unlock slot: ' + error.message);
        }
    }

    let _termsOnConfirm = null;

    function showRegistrationTermsModal(actionTitle, terms, onConfirm) {
        _termsOnConfirm = onConfirm;
        document.getElementById('registration-terms-title').textContent = `Before you continue: ${actionTitle}`;
        renderTerms(document.getElementById('registration-terms-body'), terms);
        document.getElementById('registration-terms-modal').classList.add('active');
    }

    function closeRegistrationTermsModal() {
        document.getElementById('registration-terms-modal').classList.remove('active');
        _termsOnConfirm = null;
    }

    function confirmRegistrationTerms() {
        const cb = _termsOnConfirm;
        closeRegistrationTermsModal();
        if (cb) cb();
    }
});

