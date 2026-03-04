// ACDC Portal - Team Admin Page Logic

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const notAdminDiv = document.getElementById('not-admin');
    const adminContent = document.getElementById('admin-content');
    const inviteMemberForm = document.getElementById('invite-member-form');
    const logoutBtn = document.getElementById('logout-btn');
    
    let currentUser = null;
    let currentTeam = null;

    // Initialize Auth
    Auth.init();
    
    try {
        // Check auth state
        await Auth.handleRedirect();
        
        // Check if logged in
        if (!Auth.isLoggedIn()) {
            window.location.href = '/register.html';
            return;
        }
        
        const authUser = Auth.getUser();
        
        // Load user data from API
        currentUser = await API.users.get(authUser.email);
        
        // Check if user is team admin
        if (!currentUser.isTeamAdmin) {
            loadingDiv.classList.add('hidden');
            notAdminDiv.classList.remove('hidden');
            return;
        }
        
        // Load team data
        currentTeam = await API.teams.get(currentUser.teamId);
        
        // Populate team info
        document.getElementById('team-name').textContent = currentTeam.teamName;
        document.getElementById('max-participants').textContent = currentTeam.numberOfParticipants;
        
        // Load and display members and invitations
        await loadMembers();
        await loadInvitations();
        
        // Show admin content
        loadingDiv.classList.add('hidden');
        adminContent.classList.remove('hidden');
        
    } catch (error) {
        console.error('Error loading team data:', error);
        loadingDiv.innerHTML = `<p class="error-message">Error: ${error.message}</p>
                               <a href="/events.html" class="btn btn-primary">Back to Events</a>`;
    }

    async function loadMembers() {
        const memberList = document.getElementById('member-list');
        
        try {
            const members = await API.teams.getMembers(currentTeam.id);
            
            document.getElementById('current-members').textContent = members.length;
            
            if (members.length === 0) {
                memberList.innerHTML = '<p class="text-muted">No team members yet. Send some invitations!</p>';
                return;
            }
            
            memberList.innerHTML = members.map(member => `
                <div class="member-item" data-user-id="${member.id}">
                    <div class="member-info">
                        <span class="member-name">
                            ${member.firstName || 'Unknown'} ${member.lastName || ''}
                            ${member.isTeamAdmin ? '<span class="member-badge">Admin</span>' : ''}
                        </span>
                        <span class="member-email">${member.email}</span>
                    </div>
                    ${!member.isTeamAdmin ? `
                        <button class="btn btn-small btn-danger remove-member-btn" data-user-id="${member.id}">
                            Remove
                        </button>
                    ` : ''}
                </div>
            `).join('');
            
            // Add remove handlers
            memberList.querySelectorAll('.remove-member-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const userId = e.target.dataset.userId;
                    if (confirm('Are you sure you want to remove this member?')) {
                        await removeMember(userId);
                    }
                });
            });
            
        } catch (error) {
            memberList.innerHTML = `<p class="error-message">Failed to load members: ${error.message}</p>`;
        }
    }

    async function loadInvitations() {
        const invitationList = document.getElementById('invitation-list');
        
        try {
            const invitations = await API.invitations.list(currentTeam.id);
            const pendingInvitations = invitations.filter(i => i.status === 'pending');
            
            if (pendingInvitations.length === 0) {
                invitationList.innerHTML = '<p class="text-muted">No pending invitations.</p>';
                return;
            }
            
            invitationList.innerHTML = pendingInvitations.map(invite => {
                const createdDate = new Date(invite.createdAt).toLocaleDateString();
                const isExpired = new Date(invite.expiresAt) < new Date();
                
                return `
                    <div class="invitation-item ${isExpired ? 'expired' : ''}" data-invite-id="${invite.id}">
                        <div class="invitation-info">
                            <span class="invitation-email">${invite.email}</span>
                            <span class="invitation-date">Sent: ${createdDate}</span>
                            ${isExpired ? '<span class="invitation-status expired">Expired</span>' : ''}
                        </div>
                        <div class="invitation-actions">
                            <button class="btn btn-small btn-secondary resend-btn" data-invite-id="${invite.id}" ${isExpired ? '' : 'title="Resend invitation email"'}>
                                🔄 Resend
                            </button>
                            <button class="btn btn-small btn-danger cancel-btn" data-invite-id="${invite.id}">
                                ✕ Cancel
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
            
            // Add resend handlers
            invitationList.querySelectorAll('.resend-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const inviteId = e.target.dataset.inviteId;
                    await resendInvitation(inviteId);
                });
            });
            
            // Add cancel handlers
            invitationList.querySelectorAll('.cancel-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const inviteId = e.target.dataset.inviteId;
                    if (confirm('Cancel this invitation?')) {
                        await cancelInvitation(inviteId);
                    }
                });
            });
            
        } catch (error) {
            invitationList.innerHTML = `<p class="error-message">Failed to load invitations: ${error.message}</p>`;
        }
    }

    async function resendInvitation(inviteId) {
        try {
            await API.invitations.resend(inviteId);
            alert('Invitation resent!');
            await loadInvitations();
        } catch (error) {
            alert('Failed to resend invitation: ' + error.message);
        }
    }

    async function cancelInvitation(inviteId) {
        try {
            await API.invitations.cancel(inviteId);
            await loadInvitations();
        } catch (error) {
            alert('Failed to cancel invitation: ' + error.message);
        }
    }

    async function removeMember(userId) {
        try {
            await API.members.remove(currentTeam.id, userId);
            await loadMembers();
        } catch (error) {
            alert('Failed to remove member: ' + error.message);
        }
    }

    // Invite member form
    inviteMemberForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const inviteBtn = document.getElementById('invite-member-btn');
        const errorDiv = document.getElementById('invite-member-error');
        const successDiv = document.getElementById('invite-member-success');
        const email = document.getElementById('inviteEmail').value.trim().toLowerCase();
        const message = document.getElementById('inviteMessage').value.trim();

        // Check member limit (include pending invitations)
        const currentCount = parseInt(document.getElementById('current-members').textContent);
        const pendingInvites = document.querySelectorAll('.invitation-item:not(.expired)').length;
        
        if (currentCount + pendingInvites >= currentTeam.numberOfParticipants) {
            errorDiv.textContent = `Team is at maximum capacity (${currentTeam.numberOfParticipants} members including pending invites)`;
            errorDiv.classList.remove('hidden');
            successDiv.classList.add('hidden');
            return;
        }

        // Show loading state
        inviteBtn.disabled = true;
        inviteBtn.querySelector('.btn-text').classList.add('hidden');
        inviteBtn.querySelector('.btn-loading').classList.remove('hidden');
        errorDiv.classList.add('hidden');
        successDiv.classList.add('hidden');

        try {
            await API.invitations.create({
                email: email,
                teamId: currentTeam.id,
                inviterId: currentUser.id,
                inviterName: `${currentUser.firstName} ${currentUser.lastName}`.trim() || 'Team Admin',
                inviterEmail: currentUser.email,
                message: message || 'Join our team for the Arctic Cloud Developer Challenge!'
            });
            
            successDiv.textContent = `Invitation sent to ${email}! They'll receive an email with a link to join.`;
            successDiv.classList.remove('hidden');
            
            document.getElementById('inviteEmail').value = '';
            document.getElementById('inviteMessage').value = '';
            
            // Refresh invitation list
            await loadInvitations();
            
        } catch (error) {
            errorDiv.textContent = error.message || 'Failed to send invitation.';
            errorDiv.classList.remove('hidden');
        } finally {
            inviteBtn.disabled = false;
            inviteBtn.querySelector('.btn-text').classList.remove('hidden');
            inviteBtn.querySelector('.btn-loading').classList.add('hidden');
        }
    });

    // Logout
    logoutBtn.addEventListener('click', async () => {
        await Auth.logout();
    });
});

// Add some styles for invitations
const style = document.createElement('style');
style.textContent = `
    .invitation-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem;
        background: #f8fafc;
        border-radius: 8px;
        margin-bottom: 0.5rem;
        border: 1px solid #e2e8f0;
    }
    .invitation-item.expired {
        opacity: 0.6;
        background: #fef2f2;
        border-color: #fecaca;
    }
    .invitation-info {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    .invitation-email {
        font-weight: 500;
        color: #334155;
    }
    .invitation-date {
        font-size: 0.75rem;
        color: #64748b;
    }
    .invitation-status.expired {
        font-size: 0.75rem;
        color: #dc2626;
        font-weight: 600;
    }
    .invitation-actions {
        display: flex;
        gap: 0.5rem;
    }
    .text-muted {
        color: #94a3b8;
        font-style: italic;
    }
    .form-hint {
        color: #64748b;
        font-size: 0.875rem;
        margin-bottom: 1rem;
    }
    textarea {
        width: 100%;
        padding: 0.75rem;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        font-family: inherit;
        font-size: 1rem;
        resize: vertical;
    }
`;
document.head.appendChild(style);

console.log('Team Admin page loaded');
