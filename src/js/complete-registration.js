// complete-registration.html: a signed-in user without a complete profile fills in the basics.
document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up…</div></div>');
        }
    }, 1200);
    const registrationCard = document.getElementById('registration-card');
    const form = document.getElementById('complete-registration-form');

    let currentUser = null;
    // Only same-origin paths are followed; anything else goes to the events list.
    const redirect = safeRedirectPath(new URLSearchParams(window.location.search).get('redirect'), '/events.html');

    Auth.init();

    try {
        await Auth.handleRedirect();

        if (!Auth.isLoggedIn()) {
            window.location.href = `/register.html?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
            return;
        }

        const authUser = Auth.getUser();

        // Only a 404 means "no account yet". Any other failure (5xx, network) must not create
        // a duplicate account with a client-generated id.
        currentUser = await API.users.getOrNull(authUser.email);

        if (currentUser && currentUser.profileComplete) {
            window.location.href = redirect;
            return;
        }

        if (!currentUser) {
            currentUser = {
                id: crypto.randomUUID(),
                email: authUser.email,
                firstName: '',
                lastName: '',
                phone: '',
                profileComplete: false,
                createdAt: new Date().toISOString()
            };
            await API.users.create(currentUser);
        }

        document.getElementById('email').value = authUser.email;

        if (currentUser.firstName || currentUser.lastName) {
            document.getElementById('firstName').value = currentUser.firstName || '';
            document.getElementById('lastName').value = currentUser.lastName || '';
        } else if (authUser.name && authUser.name !== authUser.email) {
            const nameParts = authUser.name.split(' ');
            document.getElementById('firstName').value = nameParts[0] || '';
            document.getElementById('lastName').value = nameParts.slice(1).join(' ') || '';
        }
        if (currentUser.phone) document.getElementById('phone').value = currentUser.phone;

        const inviteId = sessionStorage.getItem('pendingInvitation');
        if (inviteId) {
            try {
                const invitation = await API.invitations.get(inviteId);
                if (invitation && invitation.status === 'pending' && !invitation.isExpired) {
                    showInvitationBanner(invitation);
                }
            } catch (err) {
                console.warn('Could not load invitation:', err);
            }
        }

        loadingDiv.classList.add('hidden');
        clearTimeout(wakeTimer);
        registrationCard.classList.remove('hidden');

    } catch (error) {
        console.error('Error:', error);
        clearTimeout(wakeTimer);
        loadingDiv.replaceChildren();
        const message = document.createElement('p');
        message.className = 'error-message';
        message.textContent = `Could not load your profile: ${error.message || 'unknown error'}. Reload the page to try again.`;
        const back = document.createElement('a');
        back.href = '/events.html';
        back.className = 'btn btn-primary';
        back.textContent = 'Back to events';
        loadingDiv.append(message, back);
    }

    // Everything in the banner is data from the API (inviter, team, event names), rendered as text.
    // Saving this form does not accept the invitation, so the banner links back to it.
    function showInvitationBanner(invitation) {
        const banner = document.getElementById('invitation-banner');
        const iconEl = document.getElementById('invitation-icon');
        const titleEl = document.getElementById('invitation-title');
        const detailsEl = document.getElementById('invitation-details');
        const helperEl = document.getElementById('invitation-helper');

        const eventName = invitation.eventName || 'the event';
        const strong = (text) => {
            const el = document.createElement('strong');
            el.textContent = text;
            return el;
        };

        detailsEl.replaceChildren();
        if (invitation.role === 'judge') {
            iconEl.innerHTML = icon('scale');
            titleEl.textContent = 'Judge invitation';
            detailsEl.append(strong(invitation.inviterName || 'An event organizer'), ' invited you to be a judge at ',
                strong(eventName), '.');
        } else if (invitation.role === 'committee') {
            iconEl.innerHTML = icon('landmark');
            titleEl.textContent = 'Committee invitation';
            detailsEl.append(strong(invitation.inviterName || 'An event organizer'), ' invited you to join the committee for ',
                strong(eventName), '.');
        } else {
            iconEl.innerHTML = icon('users');
            titleEl.textContent = 'Team invitation';
            detailsEl.append(strong(invitation.inviterName || 'A team admin'), ' invited you to join team ',
                strong(invitation.teamName || 'the team'), '.');
        }

        const inviteLink = document.createElement('a');
        inviteLink.href = `/accept-invitation.html?invite=${encodeURIComponent(invitation.id || sessionStorage.getItem('pendingInvitation') || '')}`;
        inviteLink.textContent = 'open the invitation';
        helperEl.replaceChildren('Saving your profile doesn\'t accept the invitation. Afterwards, ', inviteLink, ' to accept it.');

        banner.classList.remove('hidden');
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const completeBtn = document.getElementById('complete-btn');
        const errorDiv = document.getElementById('form-error');

        const formData = {
            firstName: document.getElementById('firstName').value.trim(),
            lastName: document.getElementById('lastName').value.trim(),
            phone: document.getElementById('phone').value.trim()
        };

        if (!formData.firstName || !formData.lastName || !formData.phone) {
            errorDiv.textContent = 'Fill in your first name, last name and phone number.';
            errorDiv.classList.remove('hidden');
            return;
        }

        completeBtn.disabled = true;
        completeBtn.querySelector('.btn-text').classList.add('hidden');
        completeBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            await API.users.update(currentUser.id, {
                firstName: formData.firstName,
                lastName: formData.lastName,
                phone: formData.phone,
                profileComplete: true
            });

            window.location.href = redirect;

        } catch (error) {
            errorDiv.textContent = error.message || 'Could not save your profile. Try again in a moment.';
            errorDiv.classList.remove('hidden');

            completeBtn.disabled = false;
            completeBtn.querySelector('.btn-text').classList.remove('hidden');
            completeBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });
});
