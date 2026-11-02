// accept-invitation.html: one page accepts participant, judge and committee invitations.
// Steps: invitation card -> profile details -> (OTP sign-in when needed) -> accept -> event page.
document.addEventListener('DOMContentLoaded', async () => {
    Auth.init();

    const ROLE_COPY = {
        participant: {
            subtitle: 'Team Invitation',
            icon: '🎉',
            heading: 'You\'ve Been Invited!',
            detail: 'You have been invited to join team',
            acceptLabel: 'Accept Invitation →',
            verifyLabel: 'Verify & Join Team 🎉',
            verifyingLabel: 'Verifying & joining...',
            successTitle: 'You\'re In!',
            successPrefix: 'You\'ve successfully joined team '
        },
        judge: {
            subtitle: 'Judge Invitation',
            icon: '⚖️',
            heading: 'Judge Invitation',
            detail: 'You have been invited to serve as a Judge for',
            acceptLabel: '⚖️ Accept Judge Invitation →',
            verifyLabel: 'Verify & Accept ⚖️',
            verifyingLabel: 'Verifying & accepting...',
            successTitle: 'Welcome to the Jury!',
            successPrefix: 'You are now registered as a Judge for '
        },
        committee: {
            subtitle: 'Committee Invitation',
            icon: '🏛️',
            heading: 'Committee Invitation',
            detail: 'You have been invited to join the Committee for',
            acceptLabel: '🏛️ Accept Committee Invitation →',
            verifyLabel: 'Verify & Accept 🏛️',
            verifyingLabel: 'Verifying & accepting...',
            successTitle: 'Welcome to the Committee!',
            successPrefix: 'You are now a Committee member for '
        }
    };

    const stepLoading = document.getElementById('step-loading');
    const wakeTimer = setTimeout(() => {
        if (stepLoading.classList.contains('hidden')) return;
        if (!stepLoading.querySelector('.loader-wake')) {
            stepLoading.insertAdjacentHTML('beforeend', '<div class="loader-wake"><span class="wake-scene"><span class="wake-bear">🐻‍❄️</span> <span class="wake-zzz">💤</span></span><div class="wake-title">Waking up the Arctic Database<span class="wake-dots"></span></div>Our polar bear database keeper is hibernating! Give it a moment to wake up and stretch. This can take up to a minute.<div class="wake-subtitle">☕ Brewing some Arctic coffee to speed things up...</div></div>');
        }
    }, 1200);

    const urlParams = new URLSearchParams(window.location.search);
    const inviteId = urlParams.get('invite');

    if (!inviteId) {
        showError('No Invitation Found', 'This link is missing an invitation ID. Please use the link from your invitation email.');
        return;
    }

    let invitation = null;
    let currentUser = null;
    let alreadyLoggedIn = false;
    let pendingProfile = {};
    let submitting = false;
    let copy = ROLE_COPY.participant;

    try {
        invitation = await API.invitations.get(inviteId);

        if (!invitation) {
            showError('Invitation Not Found', 'This invitation could not be found. It may have been deleted.');
            return;
        }

        if (invitation.isExpired) {
            showError('Invitation Expired', 'This invitation has expired. Please ask the event organizer to send a new one.');
            return;
        }

        if (invitation.status !== 'pending') {
            showError('Already Processed', `This invitation has already been ${invitation.status}.`);
            return;
        }

        copy = ROLE_COPY[invitation.role] || ROLE_COPY.participant;
        sessionStorage.setItem('pendingInvitation', inviteId);
        displayInvitation(invitation);

    } catch (err) {
        console.error('Failed to load invitation:', err);
        showError('Error Loading Invitation', 'Could not load the invitation. Please try again later.');
        return;
    }

    if (Auth.isLoggedIn()) {
        const authUser = Auth.getUser();
        if (authUser?.email) {
            alreadyLoggedIn = true;
            try {
                currentUser = await API.users.getOrNull(authUser.email);
            } catch (e) {
                console.warn('Could not load user:', e);
            }
        }
    }

    initProfileForm();

    function initProfileForm() {
        const firstNameField = document.getElementById('profile-firstName');
        const lastNameField = document.getElementById('profile-lastName');
        const phoneField = document.getElementById('profile-phone');
        const gamertagField = document.getElementById('profile-gamertag');
        const allergiesField = document.getElementById('profile-allergies');
        const emailField = document.getElementById('profile-email');

        const sessionEmail = Auth.getUser()?.email || '';
        emailField.value = sessionEmail;
        emailField.readOnly = false;
        emailField.required = true;

        // The public invitation projection carries no personal data; signed-in users see their own.
        firstNameField.value = currentUser?.firstName || invitation.inviteeFirstName || '';
        lastNameField.value = currentUser?.lastName || invitation.inviteeLastName || '';
        phoneField.value = currentUser?.phone || invitation.inviteePhone || '';
        gamertagField.value = currentUser?.gamertag || invitation.inviteeGamertag || '';
        allergiesField.value = currentUser?.allergies || invitation.inviteeAllergies || '';

        firstNameField.focus();
    }

    document.getElementById('next-to-profile-btn').addEventListener('click', () => {
        document.getElementById('step-invite').classList.add('hidden');
        document.getElementById('step-profile').classList.remove('hidden');
        initProfileForm();
    });

    document.getElementById('profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (submitting) return;
        const errorDiv = document.getElementById('profile-error');

        const firstName = document.getElementById('profile-firstName').value.trim();
        const lastName = document.getElementById('profile-lastName').value.trim();
        const phone = document.getElementById('profile-phone').value.trim();
        const gamertag = document.getElementById('profile-gamertag').value.trim();
        const allergies = document.getElementById('profile-allergies').value.trim();

        if (!firstName || !lastName || !phone) {
            errorDiv.textContent = 'Please fill in all required fields.';
            errorDiv.classList.remove('hidden');
            return;
        }

        errorDiv.classList.add('hidden');

        const email = document.getElementById('profile-email').value.trim().toLowerCase();
        if (!email) {
            errorDiv.textContent = 'Please enter your email address.';
            errorDiv.classList.remove('hidden');
            return;
        }

        pendingProfile = { firstName, lastName, phone, gamertag, allergies, email };

        if (alreadyLoggedIn && Auth.getUser()?.email?.toLowerCase() === email) {
            await submitAcceptance();
            return;
        }

        document.getElementById('step-profile').classList.add('hidden');
        document.getElementById('step-verify').classList.remove('hidden');
        document.getElementById('substep-email').classList.remove('hidden');
        document.getElementById('substep-otp').classList.add('hidden');
        document.getElementById('email-error').classList.add('hidden');
        document.getElementById('email-display').textContent = email;
    });

    document.getElementById('send-otp-btn').addEventListener('click', async () => {
        const btn = document.getElementById('send-otp-btn');
        const errorDiv = document.getElementById('email-error');

        setBusy(btn, true);
        errorDiv.classList.add('hidden');

        const email = document.getElementById('profile-email').value.trim().toLowerCase();

        try {
            await API.auth.sendOtp(email);
            showOtpSubstep(email);
        } catch (err) {
            showOtpSubstep(email);
            const otpError = document.getElementById('otp-error');
            otpError.textContent = (err.message || 'Failed to send code.') + ' You may already have a pending code.';
            otpError.classList.remove('hidden');
        } finally {
            setBusy(btn, false);
        }
    });

    function showOtpSubstep(email) {
        document.getElementById('substep-email').classList.add('hidden');
        document.getElementById('substep-otp').classList.remove('hidden');
        document.getElementById('otp-email-display').textContent = email;
        document.getElementById('otp-error').classList.add('hidden');
        document.getElementById('otp-code').value = '';
        document.getElementById('otp-code').focus();
    }

    document.getElementById('otp-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('verify-otp-btn');
        const errorDiv = document.getElementById('otp-error');
        const code = document.getElementById('otp-code').value.trim();

        if (code.length !== 6) {
            errorDiv.textContent = 'Please enter the 6-digit code.';
            errorDiv.classList.remove('hidden');
            return;
        }

        setBusy(btn, true);
        errorDiv.classList.add('hidden');

        const email = document.getElementById('profile-email').value.trim().toLowerCase();

        try {
            const result = await API.auth.verifyOtp(email, code);

            if (!result.success) {
                throw new Error(result.message || 'Invalid code.');
            }

            // A brand-new invitee has no account yet, so the server sends user: null.
            Auth.setSession(result.token, result.user || { email, name: email, profileComplete: false });

            try {
                currentUser = await API.users.getOrNull(email);
            } catch (e) {
                console.warn('Could not load user:', e);
            }

            alreadyLoggedIn = true;
            initProfileForm();
            document.getElementById('step-verify').classList.add('hidden');
            document.getElementById('step-profile').classList.remove('hidden');

        } catch (err) {
            errorDiv.textContent = err.message || 'Verification failed. Please try again.';
            errorDiv.classList.remove('hidden');
        } finally {
            setBusy(btn, false);
        }
    });

    document.getElementById('resend-otp-link').addEventListener('click', async (e) => {
        e.preventDefault();
        const link = e.target;
        link.textContent = 'Sending...';
        link.style.pointerEvents = 'none';
        try {
            await API.auth.sendOtp(document.getElementById('profile-email').value.trim().toLowerCase());
            link.textContent = '✓ Code sent!';
            setTimeout(() => {
                link.textContent = 'Resend code';
                link.style.pointerEvents = '';
            }, 30000);
        } catch (err) {
            link.textContent = 'Resend code';
            link.style.pointerEvents = '';
            const otpError = document.getElementById('otp-error');
            otpError.textContent = err.message || 'Failed to resend.';
            otpError.classList.remove('hidden');
        }
    });

    document.getElementById('otp-code').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });

    async function submitAcceptance() {
        if (submitting) return;
        submitting = true;
        const continueBtn = document.getElementById('continue-to-verify-btn');
        setBusy(continueBtn, true);

        try {
            const userId = currentUser ? currentUser.id : null;

            const result = await API.invitations.accept(inviteId, userId, pendingProfile.email, {
                firstName: pendingProfile.firstName,
                lastName: pendingProfile.lastName,
                phone: pendingProfile.phone,
                gamertag: pendingProfile.gamertag,
                allergies: pendingProfile.allergies
            });

            if (!result.success) {
                throw new Error(result.message || result.error || 'Failed to accept invitation.');
            }

            // The session issued before the account existed has userId: null; a fresh one
            // for the (possibly new) user comes back with the acceptance.
            if (result.token && result.user) {
                Auth.setSession(result.token, result.user);
            }
            sessionStorage.removeItem('pendingInvitation');

            document.getElementById('step-invite').classList.add('hidden');
            document.getElementById('step-profile').classList.add('hidden');
            document.getElementById('step-verify').classList.add('hidden');
            document.getElementById('step-success').classList.remove('hidden');
            document.getElementById('success-title').textContent = copy.successTitle;
            document.getElementById('success-prefix').textContent = copy.successPrefix;
            document.getElementById('success-team-name').textContent = invitation.role === 'participant' || !invitation.role
                ? (result.teamName || invitation.teamName || 'the team')
                : (invitation.eventName || 'the event');

            const eventId = result.eventId || invitation.eventId;
            setTimeout(() => {
                window.location.href = eventId
                    ? `/event.html?id=${encodeURIComponent(eventId)}`
                    : '/events.html';
            }, 2000);

        } catch (err) {
            const message = err.message || 'Something went wrong. Please try again.';
            // Show the error in whichever step is on screen; the OTP box may already be hidden.
            const profileVisible = !document.getElementById('step-profile').classList.contains('hidden');
            const verifyVisible = !document.getElementById('step-verify').classList.contains('hidden');
            const otpVisible = verifyVisible && !document.getElementById('substep-otp').classList.contains('hidden');
            const target = profileVisible
                ? document.getElementById('profile-error')
                : (otpVisible ? document.getElementById('otp-error') : document.getElementById('email-error'));
            if (!profileVisible && !verifyVisible) {
                document.getElementById('step-profile').classList.remove('hidden');
            }
            const visibleError = profileVisible || verifyVisible ? target : document.getElementById('profile-error');
            visibleError.textContent = message;
            visibleError.classList.remove('hidden');
        } finally {
            submitting = false;
            setBusy(continueBtn, false);
        }
    }

    function setBusy(btn, busy) {
        if (!btn) return;
        btn.disabled = busy;
        const txt = btn.querySelector('.btn-text');
        const load = btn.querySelector('.btn-loading');
        if (txt) txt.classList.toggle('hidden', busy);
        if (load) load.classList.toggle('hidden', !busy);
    }

    function displayInvitation(inv) {
        document.getElementById('step-loading').classList.add('hidden');
        clearTimeout(wakeTimer);
        document.getElementById('step-invite').classList.remove('hidden');

        document.getElementById('page-subtitle').textContent = copy.subtitle;
        document.title = `${copy.subtitle} - ACDC Portal`;
        document.getElementById('invite-icon').textContent = copy.icon;
        document.getElementById('invite-heading').textContent = copy.heading;
        document.getElementById('invite-detail-line').textContent = copy.detail;
        document.getElementById('next-to-profile-btn').textContent = copy.acceptLabel;
        document.querySelector('#verify-otp-btn .btn-text').textContent = copy.verifyLabel;
        document.querySelector('#verify-otp-btn .btn-loading').textContent = copy.verifyingLabel;

        const isTeamInvite = !inv.role || inv.role === 'participant';
        // Headline: the team for participants, the event for judges and committee members.
        document.getElementById('invite-team-name').textContent = isTeamInvite
            ? (inv.teamName || 'the team')
            : (inv.eventName || 'this event');

        const eventLine = document.getElementById('invite-event-line');
        if (isTeamInvite && inv.eventName) {
            eventLine.textContent = `for ${inv.eventName}`;
        } else {
            eventLine.classList.add('hidden');
        }

        const metaParts = [];
        if (inv.eventStartDate) {
            metaParts.push(`📅 ${formatDate(inv.eventStartDate)}${inv.eventEndDate ? ' – ' + formatDate(inv.eventEndDate) : ''}`);
        }
        if (inv.eventLocation) {
            metaParts.push(`📍 ${inv.eventLocation}`);
        }
        const metaLine = document.getElementById('invite-meta-line');
        if (metaParts.length > 0) {
            metaLine.textContent = metaParts.join(' · ');
        } else {
            metaLine.classList.add('hidden');
        }

        const hintLine = document.getElementById('invite-email-hint');
        if (inv.emailHint) {
            hintLine.textContent = `Sent to ${inv.emailHint}`;
        } else {
            hintLine.classList.add('hidden');
        }

        const expiresLine = document.getElementById('invite-expires-line');
        if (inv.expiresAt) {
            const days = Math.ceil((new Date(inv.expiresAt) - new Date()) / (1000 * 60 * 60 * 24));
            if (days <= 1) {
                expiresLine.textContent = 'This invitation expires soon';
            } else {
                expiresLine.textContent = `This invitation expires in ${days} days`;
            }
        } else {
            expiresLine.classList.add('hidden');
        }
    }

    function showError(title, message) {
        clearTimeout(wakeTimer);
        document.getElementById('step-loading').classList.add('hidden');
        document.getElementById('step-invite').classList.add('hidden');
        document.getElementById('step-profile').classList.add('hidden');
        document.getElementById('step-verify').classList.add('hidden');
        document.getElementById('step-error').classList.remove('hidden');
        document.getElementById('error-title').textContent = title;
        document.getElementById('error-message').textContent = message;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
});
