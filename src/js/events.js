// events.html: the public event list, with each signed-in visitor's status per event.
document.addEventListener('DOMContentLoaded', async () => {
    Auth.init();

    const urlParams = new URLSearchParams(window.location.search);
    const inviteId = urlParams.get('invite');
    if (inviteId) {
        // Every invitation (participant, judge, committee) is accepted on one page.
        window.location.replace(`/accept-invitation.html?invite=${encodeURIComponent(inviteId)}`);
        return;
    }

    SiteHeader.render({ containerId: 'site-header', logoUrl: '/images/ACDCLogo.png' });

    let authUser = null;
    let currentUser = null;
    const participationByEventId = new Map();
    let isAdmin = false;

    const eventsSection = document.getElementById('events-section');
    let pageLoadDone = false;
    const wakeupTimer = setTimeout(() => {
        if (pageLoadDone) return;
        eventsSection.innerHTML = `
            <div class="acdc-loader">
                <div class="loader-spinner"></div>
                <div class="loader-text">Loading events…</div>
                <div class="loader-wake">
                    <span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span>
                    <div class="wake-title">Waking up the Arctic database<span class="wake-dots"></span></div>
                    Our polar bear database keeper is hibernating!
                    Give it a moment to wake up, stretch, and fetch your events. This can take up to a minute.
                    <div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up…</div>
                </div>
            </div>
        `;
    }, 1200);

    try {
        authUser = Auth.isLoggedIn() ? Auth.getUser() : null;
        SiteHeader.update({ authUser });

        if (authUser?.email) {
            currentUser = await API.users.getOrNull(authUser.email);

            if (currentUser?.id) {
                try {
                    // Every participation (one per event). The ?userId= endpoint only returns the one for a
                    // default event, which hid the visitor's status on all other open events.
                    const participationData = await API.participations.getByPerson(authUser.email);
                    if (participationData) {
                        const participationList = Array.isArray(participationData) ? participationData : [participationData];
                        participationList.filter(Boolean).forEach(participation => {
                            if (participation.eventId) {
                                participationByEventId.set(String(participation.eventId).toUpperCase(), participation);
                            }
                            const roles = participation?.roles || [];
                            if (roles.includes('committee') || roles.includes('judge')) {
                                isAdmin = true;
                            }
                        });
                    }
                } catch (e) {
                    console.warn('Could not load participations for event status badges:', e);
                }
            }

            SiteHeader.update({ authUser, user: currentUser, isAdmin });
        }
    } catch (error) {
        console.error('Auth/user context error:', error);
    }

    await loadEvents();
    SiteHeader.update({ authUser, user: currentUser, isAdmin });

    async function loadEvents(attempt = 1) {
        const maxRetries = 3;
        const section = document.getElementById('events-section');

        try {
            const response = await fetch(`${CONFIG.api.baseUrl}/events`);
            if (!response.ok) {
                if (response.status >= 500 && attempt < maxRetries) {
                    console.warn(`Events API returned ${response.status}, retrying (${attempt}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, attempt * 2000));
                    return loadEvents(attempt + 1);
                }
                throw new Error('Failed to load events');
            }

            const events = await response.json();
            pageLoadDone = true;
            clearTimeout(wakeupTimer);

            // Live events stay listed so teams, judges and committee can reach their event page
            // while badges are being claimed.
            const activeEvents = events.filter(e =>
                e.status === 'pre-registration' || e.status === 'registration' || e.status === 'live'
            );

            if (activeEvents.length === 0) {
                section.innerHTML = `
                    <div class="no-events-message empty-state">
                        ${icon('calendar-days')}
                        <h3>Nothing open right now</h3>
                        <p>No events are currently open for registration.</p>
                        <p>Check back later or sign in to see your profile.</p>
                    </div>
                `;
                return null;
            }

            section.innerHTML = '<div class="events-grid">' + activeEvents.map(event => {
                const eventId = String(event.id);
                const eventIdAttr = encodeURIComponent(eventId);
                const participation = participationByEventId.get(eventId.toUpperCase()) || null;
                const roles = participation?.roles || [];
                const isInterestRegistered = roles.includes('interest');
                const isJudge = roles.includes('judge');
                const isCommittee = roles.includes('committee');
                const hasTeam = !!participation?.teamId
                    || (Array.isArray(participation?.teamMemberships) && participation.teamMemberships.length > 0);

                const isPreReg = event.status === 'pre-registration';
                const isLive = event.status === 'live';
                const statusText = isPreReg ? 'Coming soon' : (isLive ? 'Live' : 'Registration open');
                const statusTone = isPreReg ? 'badge-info' : (isLive ? 'badge-violet' : 'badge-success');
                const statusPill = hasTeam
                    ? `<span class="my-status-pill team badge badge-accent">${icon('circle-check', 'icon-sm')}<span>Team registered</span></span>`
                    : isInterestRegistered
                        ? `<span class="my-status-pill interest badge badge-accent">${icon('bell', 'icon-sm')}<span>Interest registered</span></span>`
                        : '';

                const meta = `<span class="meta-item">${icon('calendar')}${escapeHtml(formatDateRange(event.startDate, event.endDate))}</span>`
                    + (event.location ? `<span class="meta-item">${icon('map-pin')}${escapeHtml(event.location)}</span>` : '');
                const desc = event.description ? `<p class="description">${escapeHtml(event.description)}</p>` : '';

                const hasRelationship = hasTeam || isJudge || isCommittee || isInterestRegistered;

                let actions = '';
                let helperText = '';

                if (hasRelationship) {
                    actions = `<a href="event.html?id=${eventIdAttr}" class="btn-event primary btn btn-primary">Open${icon('arrow-right')}</a>`;
                } else if (isLive) {
                    helperText = '<p class="helper-text">Registration is closed — the event is in progress.</p>';
                } else if (isPreReg) {
                    actions = `<a href="register.html?intent=interest&eventId=${eventIdAttr}" class="btn-event interest-only btn btn-secondary">${icon('bell')}Register interest</a>`;
                    helperText = '<p class="helper-text">Be the first to know when registration opens.</p>';
                } else {
                    actions = `
                        <a href="register.html?intent=team&eventId=${eventIdAttr}" class="btn-event primary btn btn-primary">${icon('users')}Register a team</a>
                        <a href="register.html?intent=interest&eventId=${eventIdAttr}" class="btn-event secondary btn btn-secondary">${icon('bell')}Register interest</a>
                    `;
                    helperText = '<p class="helper-text">Register your team, or register interest to stay informed.</p>';
                }

                const cardClass = isPreReg ? 'pre-registration' : (isLive ? 'live' : 'registration');
                return `
                    <article class="event-card ${cardClass}" data-event-id="${escapeHtml(eventId)}">
                        <div class="event-status-row">
                            <span class="status-badge badge badge-dot ${statusTone}">${statusText}</span>
                            ${statusPill}
                        </div>
                        <h3>${escapeHtml(event.name)}</h3>
                        ${desc}
                        <p class="event-meta meta-list">${meta}</p>
                        <div class="btn-row">${actions.trim()}</div>
                        ${helperText}
                    </article>
                `;
            }).join('') + '</div>';

            return activeEvents[0]?.id || null;

        } catch (error) {
            pageLoadDone = true;
            clearTimeout(wakeupTimer);
            console.error('Error loading events:', error);
            section.innerHTML = `
                <div class="no-events-message empty-state">
                    ${icon('triangle-alert')}
                    <h3>Something went wrong</h3>
                    <p>Unable to load events. Please try again later.</p>
                </div>
            `;
            return null;
        }
    }

    function formatDateRange(start, end) {
        const startDate = new Date(start);
        const endDate = new Date(end);
        if (Number.isNaN(startDate.getTime())) return 'Date TBD';
        if (Number.isNaN(endDate.getTime())) {
            return startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        if (startDate.getMonth() === endDate.getMonth() && startDate.getFullYear() === endDate.getFullYear()) {
            return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endDate.getDate()}, ${endDate.getFullYear()}`;
        }
        return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
});
