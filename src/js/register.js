// ACDC Portal - Unified Register / Sign In Page Logic
// Flow A (known user):     Email → auto-send OTP → Verify → JWT session → redirect
// Flow B (new user, sign-in):  Email → Profile Form (name/phone) → reCAPTCHA → Send OTP → Verify → Complete → redirect
// Flow C (new user, team):     Email → Full Form (profile + team) → reCAPTCHA → Send OTP → Verify → Complete → Success
// Flow D (interest):           Same as A or B, but after auth → record interest for eventId → interest success
// No external auth provider — everything happens on this page

const RECAPTCHA_SITE_KEY = '6LcjN1YsAAAAALq6PKDAsDnRc4KnDzUJnScPTxiy';

document.addEventListener('DOMContentLoaded', async () => {
    const stepEmail = document.getElementById('step-email');
    const stepForm = document.getElementById('step-form');
    const stepOtp = document.getElementById('step-otp');
    const stepCompleting = document.getElementById('step-completing');
    const stepSuccess = document.getElementById('step-success');

    const emailCheckForm = document.getElementById('email-check-form');
    const registrationForm = document.getElementById('registration-form');
    const otpForm = document.getElementById('otp-form');

    // Store form data between steps
    let pendingFormData = null;
    // Track flow: 'login', 'register-profile', 'register-team', 'interest-login', 'interest-register'
    let flowMode = null;
    // Store the email being used
    let currentEmail = '';

    // Initialize Auth (checks for existing session)
    Auth.init();

    // Parse URL params
    const urlParams = new URLSearchParams(window.location.search);
    const intent = urlParams.get('intent'); // 'team', 'interest', or null (profile/sign-in)
    const eventId = urlParams.get('eventId');
    const isTeamIntent = intent === 'team';
    const isInterestIntent = intent === 'interest' && eventId;

    // Update page wording based on intent
    const subtitle = document.getElementById('page-subtitle');
    const emailHeading = document.getElementById('email-heading');
    const emailSubheading = document.getElementById('email-subheading');
    if (isInterestIntent) {
        subtitle.textContent = 'Register Interest';
        document.title = 'Register Interest - ACDC Portal';
        emailHeading.textContent = 'Register Interest';
        emailSubheading.textContent = 'Enter your email address to register your interest.';
    } else if (isTeamIntent) {
        subtitle.textContent = 'Register Team';
        document.title = 'Register Team - ACDC Portal';
        emailHeading.textContent = 'Register Team';
        emailSubheading.textContent = 'Enter your email address to get started.';
    }

    // If already logged in and this is an interest request, record interest immediately
    if (Auth.isLoggedIn() && isInterestIntent) {
        await recordInterestAndShow();
        return;
    }

    // If already logged in (no interest intent), go to events
    if (Auth.isLoggedIn()) {
        window.location.href = '/events.html';
        return;
    }

    // Pre-fill email from query param (e.g. from login.html redirect)
    const emailParam = urlParams.get('email');
    if (emailParam) {
        document.getElementById('checkEmail').value = emailParam;
    }

    // --- Step 1: Email Check ---
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
                // Known user → LOGIN flow: auto-send OTP
                flowMode = isInterestIntent ? 'interest-login' : 'login';

                // Try to auto-send OTP immediately
                let sendError = null;
                try {
                    const otpResult = await API.auth.sendOtp(currentEmail);
                    if (!otpResult.success) {
                        sendError = otpResult.message || 'Failed to send code.';
                    }
                } catch (otpErr) {
                    sendError = otpErr.message || 'Failed to send code.';
                }

                // Show OTP step with welcome-back messaging
                showStep('otp', currentEmail);

                if (sendError) {
                    showError('otp-error', sendError + ' You can try resending below.');
                }
            } else {
                // New user → show form (profile-only, team, or interest based on intent)
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

    // Back links
    document.getElementById('back-to-email').addEventListener('click', (e) => {
        e.preventDefault();
        flowMode = null;
        showStep('email');
    });

    document.getElementById('back-to-email-otp').addEventListener('click', (e) => {
        e.preventDefault();
        flowMode = null;
        showStep('email');
    });

    // --- Step 2: Registration Form submission (register flow — profile or team) ---
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

        // Include phone for non-interest flows
        if (flowMode !== 'interest-register') {
            pendingFormData.phone = document.getElementById('phone').value.trim();
        }

        // Include team fields only for team registration
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

        // For interest flow, store eventId
        if (flowMode === 'interest-register') {
            pendingFormData.interestEventId = eventId;
        }

        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').classList.add('hidden');
        submitBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            // Get reCAPTCHA token
            let captchaToken = '';
            if (typeof grecaptcha !== 'undefined' && RECAPTCHA_SITE_KEY !== 'RECAPTCHA_SITE_KEY') {
                captchaToken = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'register' });
            }

            // Phase 1: Send all form data to server + validate captcha
            const startResult = await API.register.start({
                ...pendingFormData,
                captchaToken: captchaToken
            });

            if (!startResult.success) {
                throw new Error(startResult.message || 'Registration failed');
            }

            // Send OTP code to the email
            const otpResult = await API.auth.sendOtp(pendingFormData.email);
            if (!otpResult.success) {
                throw new Error(otpResult.message || 'Failed to send verification code');
            }

            // Show OTP input step
            showStep('otp', pendingFormData.email);

        } catch (error) {
            console.error('Registration error:', error);
            showError('form-error', error.message || 'Registration failed. Please try again.');

            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').classList.remove('hidden');
            submitBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // --- Step 3: OTP Verification (handles both login + register) ---
    otpForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const verifyBtn = document.getElementById('verify-otp-btn');
        const errorDiv = document.getElementById('otp-error');
        const codeInput = document.getElementById('otpCode');
        const code = codeInput.value.trim();

        if (code.length !== 6) {
            showError('otp-error', 'Please enter the 6-digit code.');
            return;
        }

        verifyBtn.disabled = true;
        verifyBtn.querySelector('.btn-text').classList.add('hidden');
        verifyBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            const isLoginFlow = flowMode === 'login' || flowMode === 'interest-login';
            const emailToVerify = isLoginFlow ? currentEmail : pendingFormData.email;

            // Verify the OTP code — returns JWT + user data
            const verifyResult = await API.auth.verifyOtp(emailToVerify, code);

            if (!verifyResult.success) {
                throw new Error(verifyResult.message || 'Verification failed');
            }

            // Store the JWT session
            Auth.setSession(verifyResult.token, verifyResult.user || {
                email: emailToVerify,
                name: !isLoginFlow
                    ? `${pendingFormData.firstName} ${pendingFormData.lastName}`
                    : emailToVerify
            });

            if (flowMode === 'interest-login') {
                // Known user + interest: record interest, show success
                await recordInterestAndShow();
            } else if (flowMode === 'login') {
                // LOGIN flow: JWT set → redirect immediately
                const redirect = urlParams.get('redirect') || '/events.html';
                window.location.href = redirect;
            } else {
                // REGISTER flow (profile, team, or interest-register): complete registration first
                showStep('completing');

                const completeResult = await API.register.complete({ email: pendingFormData.email });

                if (!completeResult.success) {
                    throw new Error(completeResult.message || 'Failed to complete registration');
                }

                if (flowMode === 'interest-register') {
                    // New user + interest: registration done, now record interest
                    await recordInterestAndShow();
                } else if (flowMode === 'register-team') {
                    // Team registration: redirect to event page
                    const targetEventId = completeResult.eventId || eventId;
                    if (targetEventId) {
                        window.location.href = `/event.html?id=${targetEventId}`;
                    } else {
                        // Fallback: show success page if no eventId
                        document.getElementById('success-heading-text').textContent = 'Registration Complete!';
                        document.getElementById('success-team-line').classList.remove('hidden');
                        document.getElementById('success-team-name').textContent = pendingFormData.teamName;
                        showStep('success');
                    }
                } else {
                    // Profile-only: redirect to events
                    const redirect = urlParams.get('redirect') || '/events.html';
                    window.location.href = redirect;
                }
            }

        } catch (error) {
            console.error('OTP verification error:', error);
            showError('otp-error', error.message || 'Verification failed. Please try again.');

            verifyBtn.disabled = false;
            verifyBtn.querySelector('.btn-text').classList.remove('hidden');
            verifyBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Resend code button
    document.getElementById('resend-otp-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const resendBtn = e.target;
        const isLoginFlow = flowMode === 'login' || flowMode === 'interest-login';
        const email = isLoginFlow ? currentEmail : (pendingFormData ? pendingFormData.email : null);

        if (!email) return;

        resendBtn.textContent = 'Sending...';
        resendBtn.style.pointerEvents = 'none';

        try {
            await API.auth.sendOtp(email);
            resendBtn.textContent = '✓ Code sent!';
            setTimeout(() => {
                resendBtn.textContent = 'Resend code';
                resendBtn.style.pointerEvents = '';
            }, 30000); // 30s cooldown on UI
        } catch (error) {
            resendBtn.textContent = 'Resend code';
            resendBtn.style.pointerEvents = '';
            showError('otp-error', error.message || 'Failed to resend code.');
        }
    });

    // Auto-strip non-digits from OTP input
    document.getElementById('otpCode').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });

    // --- Step Navigation ---
    function showStep(step, email) {
        stepEmail.classList.add('hidden');
        stepForm.classList.add('hidden');
        stepOtp.classList.add('hidden');
        stepCompleting.classList.add('hidden');
        stepSuccess.classList.add('hidden');

        // Welcome-back banner (login flow only)
        const welcomeBack = document.getElementById('otp-welcome-back');
        welcomeBack.classList.add('hidden');

        switch (step) {
            case 'email':
                updateProgress(1);
                stepEmail.classList.remove('hidden');
                break;

            case 'form':
                updateProgress(2);
                document.getElementById('regEmail').value = email;

                // Configure form based on flow mode
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
                    formHeading.textContent = 'Register Your Team';
                    formSubheading.textContent = 'Complete the form below to register your team.';
                    submitBtnText.textContent = 'Register Team →';
                } else if (flowMode === 'interest-register') {
                    teamFieldset.classList.add('hidden');
                    roleFieldset.classList.add('hidden');
                    phoneGroup.classList.add('hidden');
                    phoneInput.required = false;
                    document.getElementById('teamName').required = false;
                    document.getElementById('numberOfParticipants').required = false;
                    formHeading.textContent = 'Create Your Account';
                    formSubheading.textContent = 'Enter your details to register your interest.';
                    submitBtnText.textContent = 'Continue →';
                } else {
                    teamFieldset.classList.add('hidden');
                    roleFieldset.classList.add('hidden');
                    phoneGroup.classList.remove('hidden');
                    phoneInput.required = true;
                    document.getElementById('teamName').required = false;
                    document.getElementById('numberOfParticipants').required = false;
                    formHeading.textContent = 'Create Your Account';
                    formSubheading.textContent = 'Enter your details to create your profile.';
                    submitBtnText.textContent = 'Create Account →';
                }

                stepForm.classList.remove('hidden');
                document.getElementById('firstName').focus();
                break;

            case 'otp':
                if (flowMode === 'login' || flowMode === 'interest-login') {
                    updateProgress(2); // Login: Email(1) → Verify(2)
                    welcomeBack.classList.remove('hidden');
                    document.getElementById('verify-btn-text').textContent = 'Verify & Sign In →';
                } else if (flowMode === 'register-team') {
                    updateProgress(3); // Team Register: Email(1) → Details(2) → Verify(3)
                    document.getElementById('verify-btn-text').textContent = 'Verify & Complete Registration →';
                } else if (flowMode === 'interest-register') {
                    updateProgress(3);
                    document.getElementById('verify-btn-text').textContent = 'Verify & Register Interest →';
                } else {
                    updateProgress(3); // Profile Register: Email(1) → Details(2) → Verify(3)
                    document.getElementById('verify-btn-text').textContent = 'Verify & Create Account →';
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
                if (flowMode === 'interest-register' || flowMode === 'interest-login') {
                    completingHeading.textContent = 'Recording Your Interest...';
                    completingText.textContent = 'Please wait...';
                } else if (flowMode === 'register-team') {
                    completingHeading.textContent = 'Completing Registration...';
                    completingText.textContent = 'Finalizing your team registration. Please wait...';
                } else {
                    completingHeading.textContent = 'Creating Account...';
                    completingText.textContent = 'Please wait...';
                }
                stepCompleting.classList.remove('hidden');
                break;

            case 'success':
                updateProgress(4);
                stepSuccess.classList.remove('hidden');
                break;
        }
    }
    // --- Record Interest Helper (used by both interest-login and interest-register flows) ---
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

            // Redirect to the event page — they'll see their interest card there
            window.location.href = `event.html?id=${eventId}`;

        } catch (error) {
            console.error('Interest recording error:', error);
            showError('completing-error', error.message || 'Failed to record interest. Please try again.');
        }
    }
});

// --- Progress Indicator ---
function updateProgress(activeStep) {
    const steps = document.querySelectorAll('.progress-step');
    steps.forEach((step, index) => {
        const stepNum = index + 1;
        step.classList.remove('active', 'completed');
        if (stepNum < activeStep) {
            step.classList.add('completed');
        } else if (stepNum === activeStep) {
            step.classList.add('active');
        }
    });
}

// --- Helper ---
function showError(elementId, message) {
    const errorDiv = document.getElementById(elementId);
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

console.log('Register/Sign-In page loaded (unified flow)');
