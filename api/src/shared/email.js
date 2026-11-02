const crypto = require('crypto');

// Verification codes only ever appear in logs on a developer machine. In Azure the
// Functions host sets AZURE_FUNCTIONS_ENVIRONMENT to 'Production' (or leaves it unset).
function isDevelopment() {
    return process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Development';
}

const Email = {
    generateCode() {
        return crypto.randomInt(100000, 999999).toString();
    },

    hashCode(code) {
        return crypto.createHash('sha256').update(code).digest('hex');
    },

    verifyCode(inputCode, storedHash) {
        const inputHash = this.hashCode(String(inputCode));
        try {
            return crypto.timingSafeEqual(
                Buffer.from(inputHash, 'hex'),
                Buffer.from(storedHash, 'hex')
            );
        } catch {
            return false;
        }
    },

    // Resolves true when the code was handed to the mail system; throws otherwise. A failed
    // send is never reported as success - the caller must not tell the user a code is on its way.
    async sendVerificationCode(email, code) {
        if (isDevelopment()) {
            console.log(`[otp] development only - code for ${email}: ${code}`);
        }

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

            return true;
        } catch (mailError) {
            console.error('Failed to send verification email:', mailError.message);
            const error = new Error('Failed to send verification email. Please try again.');
            error.code = 'MAIL_SEND_FAILED';
            throw error;
        }
    }
};

module.exports = Email;
