// ACDC Portal - Login Page Logic (Inline OTP)
// Flow: Enter email → Send OTP → Enter code → JWT session → Redirect

document.addEventListener('DOMContentLoaded', async () => {
    const stepEmail = document.getElementById('step-email');
    const stepOtp = document.getElementById('step-otp');
    
    const emailForm = document.getElementById('email-form');

    let loginEmail = '';

    // Initialize Auth
    Auth.init();
    
    // Already logged in? Redirect
    if (Auth.isLoggedIn()) {
        const redirect = new URLSearchParams(window.location.search).get('redirect') || '/events.html';
        window.location.href = redirect;
        return;
    }

    // Pre-fill email from query param
    const urlParams = new URLSearchParams(window.location.search);
    const emailParam = urlParams.get('email');
    if (emailParam) {
        document.getElementById('email').value = emailParam;
    }

    // Step 1: Enter email → send OTP
    emailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const emailBtn = document.getElementById('email-btn');
        const errorDiv = document.getElementById('email-error');
        loginEmail = document.getElementById('email').value.trim().toLowerCase();

        emailBtn.disabled = true;
        emailBtn.querySelector('.btn-text').classList.add('hidden');
        emailBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            // Check if email exists
            const checkResult = await API.auth.checkEmail(loginEmail);
            
            if (!checkResult.allowed || checkResult.isNewUser) {
                throw new Error('Email not registered. Please register first.');
            }
            
            // Try to send OTP
            let sendError = null;
            try {
                const otpResult = await API.auth.sendOtp(loginEmail);
                if (!otpResult.success) {
                    sendError = otpResult.message || 'Failed to send code.';
                }
            } catch (otpErr) {
                // Cooldown or rate limit — still show code entry (OTP may already be pending)
                sendError = otpErr.message || 'Failed to send code.';
            }
            
            // Always transition to OTP step (user may have a pending code)
            stepEmail.classList.add('hidden');
            stepOtp.classList.remove('hidden');
            document.getElementById('otp-email-display').textContent = loginEmail;
            document.getElementById('otpCode').value = '';
            document.getElementById('otpCode').focus();
            
            // Show send error as a warning on the OTP step (non-blocking)
            if (sendError) {
                showError('otp-error', sendError + ' You can try resending below.');
            }
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Login failed. Please try again.';
            errorDiv.classList.remove('hidden');
        } finally {
            emailBtn.disabled = false;
            emailBtn.querySelector('.btn-text').classList.remove('hidden');
            emailBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Step 2: Verify OTP code
    document.getElementById('otp-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const verifyBtn = document.getElementById('verify-otp-btn');
        const errorDiv = document.getElementById('otp-error');
        const code = document.getElementById('otpCode').value.trim();

        if (code.length !== 6) {
            showError('otp-error', 'Please enter the 6-digit code.');
            return;
        }

        verifyBtn.disabled = true;
        verifyBtn.querySelector('.btn-text').classList.add('hidden');
        verifyBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            const result = await API.auth.verifyOtp(loginEmail, code);

            if (!result.success) {
                throw new Error(result.message || 'Invalid code.');
            }

            // Store JWT session
            Auth.setSession(result.token, result.user);

            // Redirect to intended page (or events)
            const redirect = urlParams.get('redirect') || '/events.html';
            window.location.href = redirect;

        } catch (error) {
            showError('otp-error', error.message || 'Verification failed.');
            verifyBtn.disabled = false;
            verifyBtn.querySelector('.btn-text').classList.remove('hidden');
            verifyBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Back to email
    document.getElementById('back-to-email').addEventListener('click', (e) => {
        e.preventDefault();
        stepOtp.classList.add('hidden');
        stepEmail.classList.remove('hidden');
    });

    // Resend code
    document.getElementById('resend-otp-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const resendBtn = e.target;
        resendBtn.textContent = 'Sending...';
        resendBtn.style.pointerEvents = 'none';
        
        try {
            await API.auth.sendOtp(loginEmail);
            resendBtn.textContent = '✓ Code sent!';
            setTimeout(() => {
                resendBtn.textContent = 'Resend code';
                resendBtn.style.pointerEvents = '';
            }, 30000);
        } catch (error) {
            resendBtn.textContent = 'Resend code';
            resendBtn.style.pointerEvents = '';
            showError('otp-error', error.message || 'Failed to resend.');
        }
    });

    // Strip non-digits from OTP input
    document.getElementById('otpCode').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
});

function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = message;
        el.classList.remove('hidden');
    }
}

console.log('Login page loaded (inline OTP)');
