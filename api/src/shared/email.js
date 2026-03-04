// Email utility - OTP code generation and sending
// Uses the existing mail.js (Graph API / Exchange) infrastructure for sending
const crypto = require('crypto');

const Email = {
    /**
     * Generate a cryptographically secure 6-digit OTP code
     */
    generateCode() {
        return crypto.randomInt(100000, 999999).toString();
    },

    /**
     * Hash an OTP code for secure storage (SHA-256)
     */
    hashCode(code) {
        return crypto.createHash('sha256').update(code).digest('hex');
    },

    /**
     * Timing-safe comparison of OTP codes
     */
    verifyCode(inputCode, storedHash) {
        const inputHash = this.hashCode(inputCode);
        try {
            return crypto.timingSafeEqual(
                Buffer.from(inputHash, 'hex'),
                Buffer.from(storedHash, 'hex')
            );
        } catch {
            return false;
        }
    },

    /**
     * Send a verification code email using the existing mail infrastructure
     */
    async sendVerificationCode(email, code) {
        // Always log in dev for debugging
        console.log('========================================');
        console.log(`📧 VERIFICATION EMAIL TO: ${email}`);
        console.log(`🔐 CODE: ${code}`);
        console.log('========================================');

        // Send via the real mail system (Graph API / Exchange shared mailbox)
        try {
            const { sendEmail } = require('./mail');
            
            const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
    <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #1e293b; font-size: 1.5rem; margin: 0;">🏔️ ACDC Portal</h1>
    </div>
    <div style="background: #f8fafc; border-radius: 12px; padding: 32px; text-align: center; border: 1px solid #e2e8f0;">
        <p style="color: #475569; margin: 0 0 8px; font-size: 0.95rem;">Your verification code is:</p>
        <div style="font-size: 2.5rem; font-weight: 700; letter-spacing: 8px; color: #1e293b; margin: 16px 0; font-family: 'Courier New', monospace;">
            ${code}
        </div>
        <p style="color: #94a3b8; margin: 16px 0 0; font-size: 0.85rem;">
            This code expires in <strong>10 minutes</strong>.
        </p>
    </div>
    <p style="color: #94a3b8; font-size: 0.8rem; text-align: center; margin-top: 24px;">
        If you didn't request this code, you can safely ignore this email.
    </p>
</body>
</html>`;

            await sendEmail({
                to: email,
                subject: 'Your ACDC Portal Verification Code',
                htmlContent: htmlContent
            });

            console.log(`✅ Verification email sent to ${email}`);
            return true;
        } catch (mailError) {
            console.error('❌ Failed to send verification email via mail system:', mailError.message);
            // In local dev, allow continuing (code is logged to console above)
            const isLocal = !process.env.WEBSITE_HOSTNAME;
            if (isLocal) {
                console.log('⚠️  Code was logged above for development use');
                return true;
            }
            // In production, propagate the error so the API can report failure
            throw new Error('Failed to send verification email. Please try again.');
        }
    }
};

module.exports = Email;
