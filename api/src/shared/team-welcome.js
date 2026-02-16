// Team Welcome Email - Send welcome email when team member joins
const Storage = require('./storage');
const Email = require('./email');

/**
 * Send welcome email to new team member and optionally digest of sequence emails
 * @param {string} memberEmail - Email of the member who joined
 * @param {string} eventId - Event the team is registered for
 * @param {object} context - Azure Function context for logging
 */
async function sendTeamWelcomeEmail(memberEmail, eventId, context) {
    try {
        // Get event
        const event = Storage.events.getById(eventId);
        if (!event) {
            context.warn(`Event ${eventId} not found for team welcome email`);
            return { success: false, reason: 'Event not found' };
        }

        // Check if event has a team welcome email configured
        if (!event.teamWelcomeEmailId) {
            context.log(`Event ${eventId} has no team welcome email configured`);
            return { success: false, reason: 'No team welcome email configured' };
        }

        // Get the welcome email campaign
        const campaigns = Storage.emailCampaigns.getAll();
        const welcomeCampaign = campaigns.find(c => c.id === event.teamWelcomeEmailId);
        
        if (!welcomeCampaign) {
            context.warn(`Team welcome email campaign ${event.teamWelcomeEmailId} not found`);
            return { success: false, reason: 'Welcome email campaign not found' };
        }

        // Check if member was an interest lead (verified)
        const interestLeads = Storage.interestLeads.getAll();
        const wasInterestLead = interestLeads.some(lead => 
            lead.email.toLowerCase() === memberEmail.toLowerCase() && 
            lead.eventId === eventId &&
            lead.isVerified === true
        );

        context.log(`Member ${memberEmail} ${wasInterestLead ? 'was' : 'was not'} an interest lead for event ${eventId}`);

        // Prepare emails to send
        const emailsToSend = [];

        // 1. Always send the welcome email
        emailsToSend.push({
            subject: welcomeCampaign.subject,
            body: welcomeCampaign.body,
            type: 'team-welcome'
        });

        // 2. If member was NOT an interest lead, send digest of sequence emails they missed
        if (!wasInterestLead && event.sequenceId) {
            const sequences = Storage.sequences.getAll();
            const sequence = sequences.find(s => s.id === event.sequenceId);
            
            if (sequence && sequence.emails && sequence.emails.length > 0) {
                // Get all live/scheduled emails from the sequence
                const unsentEmails = sequence.emails.filter(email => 
                    email.status === 'live' || email.status === 'scheduled'
                ).sort((a, b) => a.order - b.order);

                if (unsentEmails.length > 0) {
                    // Create digest email
                    let digestBody = `<h2>Important Information You Should Know</h2>`;
                    digestBody += `<p>Since you joined the team, we've sent some important updates about ${event.name}. Here's what you need to know:</p>`;
                    digestBody += `<hr style="margin: 20px 0; border: none; border-top: 2px solid #ddd;">`;
                    
                    unsentEmails.forEach((email, index) => {
                        digestBody += `<div style="margin: 30px 0;">`;
                        digestBody += `<h3>${email.subject}</h3>`;
                        digestBody += email.body;
                        if (index < unsentEmails.length - 1) {
                            digestBody += `<hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">`;
                        }
                        digestBody += `</div>`;
                    });

                    emailsToSend.push({
                        subject: `${event.name} - Important Updates`,
                        body: digestBody,
                        type: 'sequence-digest'
                    });

                    context.log(`Including digest of ${unsentEmails.length} sequence emails for ${memberEmail}`);
                }
            }
        }

        // Send all emails
        const results = [];
        for (const emailData of emailsToSend) {
            try {
                await Email.sendEmail({
                    to: memberEmail,
                    subject: emailData.subject,
                    htmlContent: emailData.body
                });
                
                results.push({ type: emailData.type, success: true });
                context.log(`Sent ${emailData.type} email to ${memberEmail}`);
            } catch (error) {
                context.error(`Failed to send ${emailData.type} email to ${memberEmail}:`, error);
                results.push({ type: emailData.type, success: false, error: error.message });
            }
        }

        return {
            success: true,
            wasInterestLead,
            emailsSent: results.filter(r => r.success).length,
            emailsFailed: results.filter(r => !r.success).length,
            results
        };

    } catch (error) {
        context.error('Error in sendTeamWelcomeEmail:', error);
        return {
            success: false,
            reason: 'Error sending team welcome email',
            error: error.message
        };
    }
}

module.exports = {
    sendTeamWelcomeEmail
};
