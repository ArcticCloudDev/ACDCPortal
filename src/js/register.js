const RECAPTCHA_SITE_KEY = '6Lc7aKwsAAAAAA5DkTtC2lFIF5eAGVTHpQAkZFep';

document.addEventListener('DOMContentLoaded', async () => {
    const stepEmail = document.getElementById('step-email');
    const stepForm = document.getElementById('step-form');
    const stepOtp = document.getElementById('step-otp');
    const stepCompleting = document.getElementById('step-completing');
    const stepHotel = document.getElementById('step-hotel');
    const stepSuccess = document.getElementById('step-success');

    const emailCheckForm = document.getElementById('email-check-form');
    const registrationForm = document.getElementById('registration-form');
    const otpForm = document.getElementById('otp-form');

    let pendingFormData = null;
    let flowMode = null;
    let currentEmail = '';

    Auth.init();

    const urlParams = new URLSearchParams(window.location.search);
    const intent = urlParams.get('intent');
    const eventId = urlParams.get('eventId');
    // Both intents need an event; without one they are plain sign-in / account creation.
    const isTeamIntent = intent === 'team' && !!eventId;
    const isInterestIntent = intent === 'interest' && !!eventId;
    const redirectTarget = safeRedirectPath(urlParams.get('redirect'), '/events.html');

    const subtitle = document.getElementById('page-subtitle');
    const emailHeading = document.getElementById('email-heading');
    const emailSubheading = document.getElementById('email-subheading');
    if (isInterestIntent) {
        subtitle.textContent = 'Register interest';
        document.title = 'Register interest - ACDC Portal';
        emailHeading.textContent = 'Start with your email';
        emailSubheading.textContent = 'We\'ll let you know as soon as registration opens.';
    } else if (isTeamIntent) {
        subtitle.textContent = 'Register a team';
        document.title = 'Register a team - ACDC Portal';
        emailHeading.textContent = 'Start with your email';
        emailSubheading.textContent = 'We\'ll sign you in, or help you create an account if you\'re new.';
    }
    const flowTitle = subtitle.textContent;

    // Presentation only: the step bar lists the steps this visitor actually goes through.
    // Returning users skip "Details"; "Hotel" only appears when the event asks for it.
    const progressSteps = document.getElementById('progress-steps');
    function syncProgress(step) {
        const signingIn = flowMode === 'login' || flowMode === 'team-login' || flowMode === 'interest-login';
        const withDetails = flowMode ? !signingIn : (isTeamIntent || isInterestIntent);
        progressSteps.querySelector('[data-step="2"]').classList.toggle('hidden', !withDetails);
        progressSteps.querySelector('[data-step="4"]').classList.toggle('hidden', step !== 'hotel');
        // Already signed in and only waiting for the interest to be recorded: there are no steps.
        progressSteps.classList.toggle('hidden', step === 'completing' && !flowMode);
    }
    syncProgress('email');

    if (Auth.isLoggedIn() && isInterestIntent) {
        await recordInterestAndShow();
        return;
    }

    if (Auth.isLoggedIn() && isTeamIntent) {
        window.location.href = `/event.html?id=${encodeURIComponent(eventId)}&action=create-team`;
        return;
    }

    if (Auth.isLoggedIn()) {
        window.location.href = redirectTarget;
        return;
    }

    const emailParam = urlParams.get('email');
    if (emailParam) {
        document.getElementById('checkEmail').value = emailParam;
    }

    emailCheckForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const btn = document.getElementById('email-check-btn');
        const errorDiv = document.getElementById('email-check-error');
        currentEmail = document.getElementById('checkEmail').value.trim().toLowerCase();

        btn.disabled = true;
        btn.querySelector('.btn-text').classList.add('hidden');
        btn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            const result = await API.auth.checkEmail(currentEmail);

            if (result.allowed && !result.isNewUser) {
                flowMode = isInterestIntent
                    ? 'interest-login'
                    : (isTeamIntent ? 'team-login' : 'login');

                let sendError = null;
                try {
                    const otpResult = await API.auth.sendOtp(currentEmail);
                    if (!otpResult.success) {
                        sendError = otpResult.message || 'Failed to send code.';
                    }
                } catch (otpErr) {
                    sendError = otpErr.message || 'Failed to send code.';
                }

                showStep('otp', currentEmail);

                if (sendError) {
                    showError('otp-error', sendError + ' You can try resending below.');
                }
            } else {
                if (isInterestIntent) {
                    flowMode = 'interest-register';
                } else if (isTeamIntent) {
                    flowMode = 'register-team';
                } else {
                    flowMode = 'register-profile';
                }
                showStep('form', currentEmail);
            }
        } catch (error) {
            showError('email-check-error', error.message || 'Something went wrong. Please try again.');
        } finally {
            btn.disabled = false;
            btn.querySelector('.btn-text').classList.remove('hidden');
            btn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    document.getElementById('back-to-email').addEventListener('click', (e) => {
        e.preventDefault();
        flowMode = null;
        resetButton(document.getElementById('submit-btn'));
        showStep('email');
    });

    document.getElementById('back-to-email-otp').addEventListener('click', (e) => {
        e.preventDefault();
        flowMode = null;
        showStep('email');
    });

    registrationForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitBtn = document.getElementById('submit-btn');
        const errorDiv = document.getElementById('form-error');

        pendingFormData = {
            firstName: document.getElementById('firstName').value.trim(),
            lastName: document.getElementById('lastName').value.trim(),
            email: document.getElementById('regEmail').value.trim().toLowerCase(),
            registrationType: flowMode === 'register-team' ? 'team' : (flowMode === 'interest-register' ? 'interest' : 'profile')
        };

        if (flowMode !== 'interest-register') {
            pendingFormData.phone = document.getElementById('phone').value.trim();
        }

        if (flowMode === 'register-team') {
            pendingFormData.teamName = document.getElementById('teamName').value.trim();
            pendingFormData.numberOfParticipants = document.getElementById('numberOfParticipants').value;
            pendingFormData.willParticipate = document.getElementById('willParticipate').checked;
            pendingFormData.eventId = eventId || null;

            if (!pendingFormData.teamName || !pendingFormData.numberOfParticipants) {
                showError('form-error', 'Team name and number of participants are required.');
                return;
            }
        }

        if (flowMode === 'interest-register') {
            pendingFormData.interestEventId = eventId;
        }

        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').classList.add('hidden');
        submitBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            let captchaToken = '';
            if (typeof grecaptcha !== 'undefined' && RECAPTCHA_SITE_KEY !== 'RECAPTCHA_SITE_KEY') {
                captchaToken = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'register' });
            }

            const startResult = await API.register.start({
                ...pendingFormData,
                captchaToken: captchaToken
            });

            if (!startResult.success) {
                throw new Error(startResult.message || 'Registration failed');
            }

            const otpResult = await API.auth.sendOtp(pendingFormData.email);
            if (!otpResult.success) {
                throw new Error(otpResult.message || 'Failed to send verification code');
            }

            showStep('otp', pendingFormData.email);

        } catch (error) {
            console.error('Registration error:', error);
            showError('form-error', error.message || 'Registration failed. Please try again.');
        } finally {
            // The button must work again if the user comes back to this step.
            resetButton(submitBtn);
        }
    });

    otpForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const verifyBtn = document.getElementById('verify-otp-btn');
        const errorDiv = document.getElementById('otp-error');
        const codeInput = document.getElementById('otpCode');
        const code = codeInput.value.trim();

        if (code.length !== 6) {
            showError('otp-error', 'Enter the 6-digit code from the email.');
            return;
        }

        verifyBtn.disabled = true;
        verifyBtn.querySelector('.btn-text').classList.add('hidden');
        verifyBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            const isLoginFlow = flowMode === 'login' || flowMode === 'team-login' || flowMode === 'interest-login';
            const emailToVerify = isLoginFlow ? currentEmail : pendingFormData.email;

            const verifyResult = await API.auth.verifyOtp(emailToVerify, code);

            if (!verifyResult.success) {
                throw new Error(verifyResult.message || 'Verification failed');
            }

            Auth.setSession(verifyResult.token, verifyResult.user || {
                email: emailToVerify,
                name: !isLoginFlow
                    ? `${pendingFormData.firstName} ${pendingFormData.lastName}`
                    : emailToVerify
            });

            if (flowMode === 'interest-login') {
                await recordInterestAndShow();
            } else if (flowMode === 'team-login') {
                window.location.href = `/event.html?id=${encodeURIComponent(eventId)}&action=create-team`;
            } else if (flowMode === 'login') {
                window.location.href = redirectTarget;
            } else {
                showStep('completing');

                const completeResult = await API.register.complete({ email: pendingFormData.email });

                if (!completeResult.success) {
                    throw new Error(completeResult.message || 'Failed to complete registration');
                }

                // The OTP session was issued before the account existed (userId: null); the
                // completion response carries a session for the newly created user.
                if (completeResult.token && completeResult.user) {
                    Auth.setSession(completeResult.token, completeResult.user);
                }

                if (flowMode === 'interest-register') {
                    await recordInterestAndShow();
                } else if (flowMode === 'register-team') {
                    const targetEventId = completeResult.eventId || eventId;
                    const eventUrl = `/event.html?id=${encodeURIComponent(targetEventId)}`;
                    if (targetEventId && completeResult.isParticipant) {
                        let eventData = null;
                        try { eventData = await API.events.get(targetEventId); } catch (e) { }
                        if (eventData && eventData.hotelEnabled) {
                            let participation = null;
                            try { participation = await API.participations.get(completeResult.userId, targetEventId); } catch (e) { }
                            if (participation && participation.id) {
                                showHotelStep(eventData, participation.id, targetEventId);
                            } else {
                                window.location.href = eventUrl;
                            }
                        } else {
                            window.location.href = eventUrl;
                        }
                    } else if (targetEventId) {
                        window.location.href = eventUrl;
                    } else {
                        document.getElementById('success-heading-text').textContent = 'Registration complete';
                        document.getElementById('success-team-line').classList.remove('hidden');
                        document.getElementById('success-team-name').textContent = pendingFormData.teamName;
                        showStep('success');
                    }
                } else {
                    window.location.href = redirectTarget;
                }
            }

        } catch (error) {
            console.error('OTP verification error:', error);
            showVisibleError(error.message || 'Verification failed. Please try again.');
            resetButton(verifyBtn);
        }
    });

    document.getElementById('resend-otp-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const resendBtn = e.currentTarget;
        const isLoginFlow = flowMode === 'login' || flowMode === 'team-login' || flowMode === 'interest-login';
        const email = isLoginFlow ? currentEmail : (pendingFormData ? pendingFormData.email : null);

        if (!email) return;

        resendBtn.textContent = 'Sending…';
        resendBtn.disabled = true;

        try {
            await API.auth.sendOtp(email);
            resendBtn.textContent = 'New code sent';
            setTimeout(() => {
                resendBtn.textContent = 'Resend code';
                resendBtn.disabled = false;
            }, 30000);
        } catch (error) {
            resendBtn.textContent = 'Resend code';
            resendBtn.disabled = false;
            showError('otp-error', error.message || 'Could not send a new code. Wait a minute and try again.');
        }
    });

    document.getElementById('otpCode').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });

    function showStep(step, email) {
        stepEmail.classList.add('hidden');
        stepForm.classList.add('hidden');
        stepOtp.classList.add('hidden');
        stepCompleting.classList.add('hidden');
        stepHotel.classList.add('hidden');
        stepSuccess.classList.add('hidden');

        const welcomeBack = document.getElementById('otp-welcome-back');
        welcomeBack.classList.add('hidden');

        syncProgress(step);
        subtitle.textContent = flowMode === 'register-profile' ? 'Create an account' : flowTitle;

        switch (step) {
            case 'email':
                updateProgress(1);
                stepEmail.classList.remove('hidden');
                break;

            case 'form':
                updateProgress(2);
                document.getElementById('regEmail').value = email;
                resetButton(document.getElementById('submit-btn'));

                const teamFieldset = document.getElementById('team-fieldset');
                const roleFieldset = document.getElementById('role-fieldset');
                const formHeading = document.getElementById('form-heading');
                const formSubheading = document.getElementById('form-subheading');
                const submitBtnText = document.getElementById('submit-btn-text');

                const phoneGroup = document.getElementById('phone-group');
                const phoneInput = document.getElementById('phone');

                if (flowMode === 'register-team') {
                    teamFieldset.classList.remove('hidden');
                    roleFieldset.classList.remove('hidden');
                    phoneGroup.classList.remove('hidden');
                    phoneInput.required = true;
                    document.getElementById('teamName').required = true;
                    document.getElementById('numberOfParticipants').required = true;
                    formHeading.textContent = 'You and your team';
                    formSubheading.textContent = 'Next, we\'ll email you a code to confirm it\'s you. Your team is registered once you enter it.';
                    submitBtnText.textContent = 'Continue';
                } else if (flowMode === 'interest-register') {
                    teamFieldset.classList.add('hidden');
                    roleFieldset.classList.add('hidden');
                    phoneGroup.classList.add('hidden');
                    phoneInput.required = false;
                    document.getElementById('teamName').required = false;
                    document.getElementById('numberOfParticipants').required = false;
                    formHeading.textContent = 'Your name';
                    formSubheading.textContent = 'Next, we\'ll email you a code to confirm your email address.';
                    submitBtnText.textContent = 'Continue';
                } else {
                    teamFieldset.classList.add('hidden');
                    roleFieldset.classList.add('hidden');
                    phoneGroup.classList.remove('hidden');
                    phoneInput.required = true;
                    document.getElementById('teamName').required = false;
                    document.getElementById('numberOfParticipants').required = false;
                    formHeading.textContent = 'Your details';
                    formSubheading.textContent = 'Next, we\'ll email you a code to confirm it\'s you.';
                    submitBtnText.textContent = 'Continue';
                }

                stepForm.classList.remove('hidden');
                document.getElementById('firstName').focus();
                break;

            case 'otp':
                // Step 3 is the code step; returning users skip the hidden "Details" step.
                if (flowMode === 'login' || flowMode === 'team-login' || flowMode === 'interest-login') {
                    updateProgress(3);
                    welcomeBack.classList.remove('hidden');
                    document.getElementById('verify-btn-text').textContent = 'Verify and sign in';
                } else if (flowMode === 'register-team') {
                    updateProgress(3);
                    document.getElementById('verify-btn-text').textContent = 'Verify and register team';
                } else if (flowMode === 'interest-register') {
                    updateProgress(3);
                    document.getElementById('verify-btn-text').textContent = 'Verify and register interest';
                } else {
                    updateProgress(3);
                    document.getElementById('verify-btn-text').textContent = 'Verify and create account';
                }
                document.getElementById('otp-email-display').textContent = email;
                document.getElementById('otpCode').value = '';
                stepOtp.classList.remove('hidden');
                document.getElementById('otpCode').focus();
                break;

            case 'completing':
                updateProgress(3);
                const completingHeading = document.getElementById('completing-heading');
                const completingText = document.getElementById('completing-text');
                if (flowMode === 'interest-register' || flowMode === 'interest-login' || !flowMode) {
                    completingHeading.textContent = 'Registering your interest…';
                    completingText.textContent = 'This only takes a moment.';
                } else if (flowMode === 'register-team') {
                    completingHeading.textContent = 'Registering your team…';
                    completingText.textContent = 'Setting up your account and team. This only takes a moment.';
                } else {
                    completingHeading.textContent = 'Creating your account…';
                    completingText.textContent = 'This only takes a moment.';
                }
                stepCompleting.classList.remove('hidden');
                break;

            case 'hotel':
                if (flowMode === 'register-team') updateProgress(4);
                stepHotel.classList.remove('hidden');
                break;

            case 'success':
                updateProgress(4);
                stepSuccess.classList.remove('hidden');
                break;
        }
    }

    function showHotelStep(event, participationId, targetEventId) {
        stepEmail.classList.add('hidden');
        stepForm.classList.add('hidden');
        stepOtp.classList.add('hidden');
        stepCompleting.classList.add('hidden');
        stepSuccess.classList.add('hidden');

        const container = document.getElementById('hotel-nights-container');
        const defaultNights = event.hotelDefaultNights || [];
        const isMandatory = event.hotelMandatory || false;

        const daysBefore = event.hotelDaysBefore ?? 1;
        const daysAfter = event.hotelDaysAfter ?? 1;
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const hotelDates = [];
        const startD = new Date(event.startDate + 'T12:00:00');
        const endD = new Date(event.endDate + 'T12:00:00');
        startD.setDate(startD.getDate() - Math.max(0, daysBefore));
        endD.setDate(endD.getDate() + Math.max(0, daysAfter));
        const cur = new Date(startD);
        while (cur <= endD) {
            hotelDates.push({ date: cur.toISOString().split('T')[0], dayLabel: dayLabels[cur.getDay()] });
            cur.setDate(cur.getDate() + 1);
        }

        const optionalNights = [];
        hotelDates.forEach((d, i) => {
            if (i < hotelDates.length - 1) {
                const nightId = `${d.dayLabel.toLowerCase()}-${hotelDates[i + 1].dayLabel.toLowerCase()}`;
                if (!defaultNights.includes(nightId)) optionalNights.push(nightId);
            }
        });
        if (optionalNights.length > 0) {
            document.getElementById('hotel-optional-notice').classList.remove('hidden');
        }

        // One row per night (check-in day to check-out day): readable and easy to tap on a phone.
        // Non-breaking spaces: a row wraps between the two days, never inside one.
        const shortDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(/ /g, ' ');
        let html = '<div class="hotel-night-list">';
        hotelDates.forEach((dateInfo, index) => {
            if (index < hotelDates.length - 1) {
                const nextDate = hotelDates[index + 1];
                const nightId = `${dateInfo.dayLabel.toLowerCase()}-${nextDate.dayLabel.toLowerCase()}`;
                const isDefault = defaultNights.includes(nightId);
                const isLocked = isDefault && isMandatory;
                html += `<label class="checkbox-label hotel-night-option${isLocked ? ' is-locked' : ''}" for="reg-hotel-${nightId}">`;
                html += `<input type="checkbox" id="reg-hotel-${nightId}" data-night-id="${nightId}"${isDefault ? ' checked' : ''}${isLocked ? ' disabled' : ''}>`;
                html += `<span class="hotel-night-dates">${dateInfo.dayLabel} ${shortDate(dateInfo.date)} <span aria-hidden="true">–</span><span class="visually-hidden">to</span> ${nextDate.dayLabel} ${shortDate(nextDate.date)}</span>`;
                if (isLocked) html += `<span class="badge">${icon('lock', 'icon-sm')}Event night</span>`;
                html += `</label>`;
            }
        });
        html += '</div>';
        container.innerHTML = html;

        function updateSummary() {
            const checked = Array.from(container.querySelectorAll('input[type="checkbox"]')).filter(cb => cb.checked);
            const countEl = document.getElementById('hotel-nights-summary');
            countEl.textContent = `${checked.length} night${checked.length !== 1 ? 's' : ''} selected`;
        }
        container.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(cb => cb.addEventListener('change', updateSummary));
        updateSummary();

        showStep('hotel');

        const ackBtn = document.getElementById('acknowledge-hotel-btn');
        ackBtn.addEventListener('click', async () => {
            ackBtn.disabled = true;
            ackBtn.querySelector('.btn-text').classList.add('hidden');
            ackBtn.querySelector('.btn-loading').classList.remove('hidden');
            document.getElementById('hotel-step-error').classList.add('hidden');

            const hotelNights = {};
            container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                hotelNights[cb.dataset.nightId] = cb.checked;
            });

            try {
                await API.participations.updateHotel(participationId, hotelNights, true);
                window.location.href = `/event.html?id=${encodeURIComponent(targetEventId)}`;
            } catch (err) {
                console.error('Hotel save error:', err);
                const errorDiv = document.getElementById('hotel-step-error');
                errorDiv.textContent = err.message || 'Could not save your hotel nights. Try again, or contact the organizers.';
                errorDiv.classList.remove('hidden');
                ackBtn.disabled = false;
                ackBtn.querySelector('.btn-text').classList.remove('hidden');
                ackBtn.querySelector('.btn-loading').classList.add('hidden');
            }
        }, { once: true });
    }

    async function recordInterestAndShow() {
        showStep('completing');

        try {
            const user = Auth.getUser();
            const result = await API.interest.record({
                eventId: eventId,
                email: user.email || currentEmail || (pendingFormData ? pendingFormData.email : ''),
                firstName: user.firstName || (pendingFormData ? pendingFormData.firstName : ''),
                lastName: user.lastName || (pendingFormData ? pendingFormData.lastName : '')
            });

            window.location.href = `/event.html?id=${encodeURIComponent(eventId)}`;

        } catch (error) {
            console.error('Interest recording error:', error);
            showError('completing-error', error.message || 'Could not register your interest. Reload the page to try again.');
        }
    }

    // After the code is verified the OTP step is hidden; an error must land in the step the
    // user can actually see.
    function showVisibleError(message) {
        const steps = [
            ['step-completing', 'completing-error'],
            ['step-hotel', 'hotel-step-error'],
            ['step-otp', 'otp-error'],
            ['step-form', 'form-error'],
            ['step-email', 'email-check-error']
        ];
        const visible = steps.find(([stepId]) => !document.getElementById(stepId).classList.contains('hidden'));
        showError(visible ? visible[1] : 'otp-error', message);
    }

    function resetButton(btn) {
        if (!btn) return;
        btn.disabled = false;
        btn.querySelector('.btn-text')?.classList.remove('hidden');
        btn.querySelector('.btn-loading')?.classList.add('hidden');
    }
});

function updateProgress(activeStep) {
    const steps = document.querySelectorAll('.progress-step');
    steps.forEach((step, index) => {
        const stepNum = index + 1;
        step.classList.remove('active', 'completed');
        step.removeAttribute('aria-current');
        if (stepNum < activeStep) {
            step.classList.add('completed');
        } else if (stepNum === activeStep) {
            step.classList.add('active');
            step.setAttribute('aria-current', 'step');
        }
    });
}

function showError(elementId, message) {
    const errorDiv = document.getElementById(elementId);
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

