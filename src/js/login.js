// ACDC Portal - Login Page Logic (Entra External ID with Email OTP)

document.addEventListener('DOMContentLoaded', async () => {
    const stepEmail = document.getElementById('step-email');
    const stepOtp = document.getElementById('step-otp');
    
    const emailForm = document.getElementById('email-form');
    const backToEmail = document.getElementById('back-to-email');

    // Initialize Auth
    Auth.init();
    
    // Handle redirect from Entra (after OTP verification)
    try {
        const account = await Auth.handleRedirect();
        if (account) {
            // User just logged in via Entra, redirect to events list
            window.location.href = '/events.html';
            return;
        }
        
        // Check if already logged in
        if (Auth.isLoggedIn()) {
            window.location.href = '/events.html';
            return;
        }
    } catch (error) {
        console.error('Auth redirect error:', error);
        const errorDiv = document.getElementById('email-error');
        errorDiv.textContent = 'Authentication error: ' + error.message;
        errorDiv.classList.remove('hidden');
    }

    // Step 1: Check email and redirect to Entra for OTP
    emailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const emailBtn = document.getElementById('email-btn');
        const errorDiv = document.getElementById('email-error');
        const email = document.getElementById('email').value.trim().toLowerCase();

        // Show loading state
        emailBtn.disabled = true;
        emailBtn.querySelector('.btn-text').classList.add('hidden');
        emailBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');

        try {
            // First, check if email is in our allowed list
            const checkResult = await API.auth.checkEmail(email);
            
            if (!checkResult.allowed) {
                throw new Error('Email not registered. Please register your team first.');
            }
            
            // Email is valid, redirect to Entra for OTP
            // User is pre-provisioned in Entra, so they'll go directly to OTP
            await Auth.login(email);
            
            // Note: The page will redirect to Microsoft, so code below won't execute
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Login failed. Please try again.';
            errorDiv.classList.remove('hidden');
            
            emailBtn.disabled = false;
            emailBtn.querySelector('.btn-text').classList.remove('hidden');
            emailBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Back to email form (hide OTP step if shown)
    if (backToEmail) {
        backToEmail.addEventListener('click', (e) => {
            e.preventDefault();
            if (stepOtp) stepOtp.classList.add('hidden');
            stepEmail.classList.remove('hidden');
        });
    }
});

console.log('Login page loaded (Entra Email OTP)');

console.log('Login page loaded (Pure OTP mode)');
