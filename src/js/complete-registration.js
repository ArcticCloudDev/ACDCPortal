// complete-registration.html: a signed-in user without a complete profile fills in the basics.
document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const wakeTimer = setTimeout(() => {
        if (loadingDiv.classList.contains('hidden')) return;
        if (!loadingDiv.querySelector('.loader-wake')) {
            loadingDiv.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>');
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
        message.textContent = `Error: ${error.message || 'Could not load your registration.'}`;
        const back = document.createElement('a');
        back.href = '/events.html';
        back.className = 'btn btn-primary';
        back.textContent = 'Back to Events';
        loadingDiv.append(message, back);
    }

    // Everything in the banner is data from the API (inviter, team, event names), rendered as text.
    function showInvitationBanner(invitation) {
        const banner = document.getElementById('invitation-banner');
        const titleEl = document.getElementById('invitation-title');
        const detailsEl = document.getElementById('invitation-details');
        const helperEl = document.getElementById('invitation-helper');

        const eventName = invitation.eventName || 'the event';
        const strong = (text, color) => {
            const el = document.createElement('strong');
            el.textContent = text;
            if (color) el.style.color = color;
            return el;
        };

        detailsEl.replaceChildren();
        if (invitation.role === 'judge') {
            banner.style.background = 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)';
            banner.style.borderLeft = '4px solid #d97706';
            titleEl.style.color = '#92400e';
            titleEl.textContent = '⚖️ Judge Invitation';
            detailsEl.append(strong(invitation.inviterName || 'An event organizer'), ' invited you to serve as a ',
                strong('Judge', '#92400e'), ' for ', strong(eventName, '#92400e'));
            helperEl.textContent = 'Complete your profile below to accept the judge invitation.';
        } else if (invitation.role === 'committee') {
            banner.style.background = 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)';
            banner.style.borderLeft = '4px solid #2563eb';
            titleEl.style.color = '#1e40af';
            titleEl.textContent = '🏛️ Committee Invitation';
            detailsEl.append(strong(invitation.inviterName || 'An event organizer'), ' invited you to join the ',
                strong('Committee', '#1e40af'), ' for ', strong(eventName, '#1e40af'));
            helperEl.textContent = 'Complete your profile below to accept the committee invitation.';
        } else {
            banner.style.background = 'linear-gradient(135deg, #dbeafe 0%, #e0f2fe 100%)';
            banner.style.borderLeft = '4px solid #2563eb';
            titleEl.style.color = '#1e40af';
            titleEl.textContent = '🎉 You\'ve been invited to join a team!';
            detailsEl.append(strong(invitation.inviterName || 'A team admin'), ' invited you to join team ',
                strong(invitation.teamName || 'the team', '#1e40af'));
            helperEl.textContent = 'Complete your profile below to accept the invitation.';
        }

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
            errorDiv.textContent = 'Please fill in all fields.';
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
            errorDiv.textContent = error.message || 'Registration failed. Please try again.';
            errorDiv.classList.remove('hidden');

            completeBtn.disabled = false;
            completeBtn.querySelector('.btn-text').classList.remove('hidden');
            completeBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });
});
