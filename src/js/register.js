// ACDC Portal - Registration Page Logic
// Flow: Form + reCAPTCHA → Create Entra user → MS OTP → Save team data

// reCAPTCHA v3 site key
const RECAPTCHA_SITE_KEY = '6LcjN1YsAAAAALq6PKDAsDnRc4KnDzUJnScPTxiy';

document.addEventListener('DOMContentLoaded', async () => {
    const stepForm = document.getElementById('step-form');
    const stepCompleting = document.getElementById('step-completing');
    const stepSuccess = document.getElementById('step-success');
    
    const registrationForm = document.getElementById('registration-form');

    // Initialize Auth for handling MS redirect
    Auth.init();
    
    // Check if returning from MS login (after OTP verification)
    try {
        const account = await Auth.handleRedirect();
        
        if (account) {
            // User just completed MS OTP - now finalize registration
            console.log('Returned from MS login:', account.username);
            await finalizeRegistration(account);
            return;
        }
        
        // Check if we have pending registration data (user might refresh)
        const pendingData = sessionStorage.getItem('pendingRegistration');
        if (pendingData && Auth.isLoggedIn()) {
            // User is logged in and has pending data - finalize
            await finalizeRegistration(Auth.getUser());
            return;
        }
        
    } catch (error) {
        console.error('Auth redirect error:', error);
        showError('form-error', 'Authentication error. Please try again.');
    }

    // Form submission handler
    registrationForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = document.getElementById('submit-btn');
        const errorDiv = document.getElementById('form-error');
        
        // Collect form data
        const formData = {
            firstName: document.getElementById('firstName').value.trim(),
            lastName: document.getElementById('lastName').value.trim(),
            email: document.getElementById('email').value.trim().toLowerCase(),
            phone: document.getElementById('phone').value.trim(),
            teamName: document.getElementById('teamName').value.trim(),
            numberOfParticipants: document.getElementById('numberOfParticipants').value
        };
        
        // Show loading state
        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').classList.add('hidden');
        submitBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        
        try {
            // Get reCAPTCHA token
            let captchaToken = '';
            if (typeof grecaptcha !== 'undefined' && RECAPTCHA_SITE_KEY !== 'RECAPTCHA_SITE_KEY') {
                captchaToken = await grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'register' });
            } else {
                console.warn('reCAPTCHA not configured - proceeding without token');
            }
            
            // Phase 1: Create Entra user (validates captcha, prepares account)
            const startResult = await API.register.start({
                email: formData.email,
                firstName: formData.firstName,
                lastName: formData.lastName,
                captchaToken: captchaToken
            });
            
            if (!startResult.success) {
                throw new Error(startResult.message || 'Registration failed');
            }
            
            // Save form data for after MS OTP verification
            sessionStorage.setItem('pendingRegistration', JSON.stringify(formData));
            
            // Redirect to MS for sign-up (Email OTP)
            // Using signUp() with prompt=create to go directly to sign-up flow
            await Auth.signUp(formData.email);
            
            // Note: Page will redirect, code below won't execute
            
        } catch (error) {
            console.error('Registration error:', error);
            showError('form-error', error.message || 'Registration failed. Please try again.');
            
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').classList.remove('hidden');
            submitBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });
});

// Finalize registration after MS OTP verification
async function finalizeRegistration(account) {
    const stepForm = document.getElementById('step-form');
    const stepCompleting = document.getElementById('step-completing');
    const stepSuccess = document.getElementById('step-success');
    
    // Show completing step
    stepForm.classList.add('hidden');
    stepCompleting.classList.remove('hidden');
    
    try {
        // Get pending registration data
        const pendingData = sessionStorage.getItem('pendingRegistration');
        
        if (!pendingData) {
            throw new Error('Registration data not found. Please register again.');
        }
        
        const formData = JSON.parse(pendingData);
        
        // Verify email matches
        if (account.email.toLowerCase() !== formData.email.toLowerCase()) {
            throw new Error('Email mismatch. Please register again with the correct email.');
        }
        
        // Phase 3: Save team data (now that email is verified via MS OTP)
        const completeResult = await API.register.complete(formData);
        
        if (!completeResult.success) {
            throw new Error(completeResult.message || 'Failed to complete registration');
        }
        
        // Clear pending data
        sessionStorage.removeItem('pendingRegistration');
        
        // Show success
        stepCompleting.classList.add('hidden');
        stepSuccess.classList.remove('hidden');
        document.getElementById('success-team-name').textContent = formData.teamName;
        
    } catch (error) {
        console.error('Finalization error:', error);
        showError('completing-error', error.message);
        document.getElementById('completing-error').classList.remove('hidden');
    }
}

// Helper to show error messages
function showError(elementId, message) {
    const errorDiv = document.getElementById(elementId);
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

console.log('Register page loaded');
