// Email utility - For now, just logs to console
// In production, integrate with SendGrid, Azure Communication Services, etc.

const Email = {
    // Send verification code
    async sendVerificationCode(email, code) {
        // For local development, just log the code
        console.log('========================================');
        console.log(`📧 VERIFICATION EMAIL TO: ${email}`);
        console.log(`🔐 CODE: ${code}`);
        console.log('========================================');
        
        // In production, use SendGrid or similar:
        // const sgMail = require('@sendgrid/mail');
        // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        // await sgMail.send({
        //     to: email,
        //     from: 'noreply@acdcportal.com',
        //     subject: 'Your ACDC Portal Verification Code',
        //     text: `Your verification code is: ${code}`,
        //     html: `<h1>Your Verification Code</h1><p>Your code is: <strong>${code}</strong></p>`
        // });
        
        return true;
    },

    // Generate 6-digit code
    generateCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }
};

module.exports = Email;
