const API = {
    baseUrl: CONFIG.api.baseUrl,

    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const method = options.method || 'GET';

        const response = await fetch(url, {
            ...defaultOptions,
            ...options,
            headers: {
                ...defaultOptions.headers,
                ...(options.headers || {})
            }
        });

        if (!response.ok) {
            if (response.status === 401 && typeof Auth !== 'undefined') {
                Auth.handleUnauthorized();
            }
            const errorData = await response.json().catch(() => ({ message: 'Request failed' }));
            const error = new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
            Object.assign(error, errorData);
            error.status = response.status;
            throw error;
        }

        return response.json();
    },

    register: {
        async start(data) {
            return API.request('/register/start', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async complete(data) {
            return API.request('/register/complete', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        }
    },

    auth: {
        async checkEmail(email) {
            return API.request('/auth/check-email', {
                method: 'POST',
                body: JSON.stringify({ email })
            });
        },

        async sendOtp(email) {
            return API.request('/auth/send-otp', {
                method: 'POST',
                body: JSON.stringify({ email })
            });
        },

        async verifyOtp(email, code) {
            return API.request('/auth/verify-otp', {
                method: 'POST',
                body: JSON.stringify({ email, code })
            });
        }
    },

    interest: {
        async record(data) {
            return API.request('/interest/record', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        }
    },

    users: {
        async list() {
            return API.request('/users/all');
        },

        async get(email) {
            return API.request(`/users?email=${encodeURIComponent(email)}`);
        },

        async getOrNull(email) {
            const url = `${API.baseUrl}/users?email=${encodeURIComponent(email)}`;
            const response = await fetch(url, {
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.status === 404) {
                return null;
            }
            if (response.status === 401 && typeof Auth !== 'undefined') {
                Auth.handleUnauthorized();
                return null;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const text = await response.text();
            if (!text) return null;
            try { return JSON.parse(text) || null; } catch { return null; }
        },

        async create(data) {
            return API.request('/users', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(userId, data) {
            return API.request(`/users/${userId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        }
    },

    teams: {
        async list() {
            return API.request('/teams');
        },

        async get(teamId) {
            return API.request(`/teams/${teamId}`);
        },

        async create(data) {
            return API.request('/teams', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(teamId, data) {
            return API.request(`/teams/${teamId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async getMembers(teamId) {
            return API.request(`/teams/${teamId}/members`);
        },

        async delete(teamId) {
            return API.request(`/teams/${teamId}`, {
                method: 'DELETE'
            });
        }
    },

    members: {
        async remove(teamId, userId) {
            return API.request(`/members/${userId}`, {
                method: 'DELETE',
                body: JSON.stringify({ teamId })
            });
        }
    },

    invitations: {
        async create(data) {
            return API.request('/invitations', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async list(teamId) {
            const url = teamId ? `/invitations?teamId=${teamId}` : '/invitations';
            return API.request(url);
        },

        async listByEmail(email) {
            return API.request(`/invitations?email=${encodeURIComponent(email)}`);
        },

        async get(id) {
            return API.request(`/invitations/${id}`);
        },

        async accept(id, userId, userEmail, profile) {
            return API.request(`/invitations/${id}/accept`, {
                method: 'POST',
                body: JSON.stringify({ userId, userEmail, profile })
            });
        },

        async cancel(id) {
            return API.request(`/invitations/${id}`, {
                method: 'DELETE'
            });
        },

        async delete(id) {
            return API.request(`/invitations/${id}`, {
                method: 'DELETE'
            });
        },

        async resend(id) {
            return API.request(`/invitations/${id}/resend`, {
                method: 'POST'
            });
        }
    },

    email: {
        async getTemplates() {
            return API.request('/email/templates');
        },

        async getTemplate(id) {
            return API.request(`/email/templates/${id}`);
        },

        async preview(templateId, data) {
            return API.request('/email/preview', {
                method: 'POST',
                body: JSON.stringify({ templateId, data })
            });
        },

        async getRecipients(filter, options = {}) {
            let url = `/email/recipients?filter=${filter}`;
            if (options.teamId) url += `&teamId=${options.teamId}`;
            if (options.year) url += `&year=${options.year}`;
            return API.request(url);
        },

        async send(data) {
            return API.request('/email/send', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async getHistory() {
            return API.request('/email/history');
        }
    },

    events: {
        async list() {
            return API.request('/events');
        },

        async getActive() {
            return API.request('/events/active');
        },

        async get(eventId) {
            return API.request(`/events/${eventId}`);
        },

        async create(data) {
            return API.request('/events', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(eventId, data) {
            return API.request(`/events/${eventId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async delete(eventId) {
            return API.request(`/events/${eventId}`, {
                method: 'DELETE'
            });
        },

        sponsors: {
            async list(eventId) {
                return API.request(`/events/${eventId}/sponsors`);
            },

            async create(eventId, data) {
                return API.request(`/events/${eventId}/sponsors`, {
                    method: 'POST',
                    body: JSON.stringify(data)
                });
            },

            async update(eventId, sponsorId, data) {
                return API.request(`/events/${eventId}/sponsors/${sponsorId}`, {
                    method: 'PUT',
                    body: JSON.stringify(data)
                });
            },

            async delete(eventId, sponsorId) {
                return API.request(`/events/${eventId}/sponsors/${sponsorId}`, {
                    method: 'DELETE'
                });
            }
        },

        financials: {
            async list(eventId) {
                return API.request(`/events/${eventId}/financials`);
            },

            async summary(eventId) {
                return API.request(`/events/${eventId}/financials/summary`);
            },

            async create(eventId, data) {
                return API.request(`/events/${eventId}/financials`, {
                    method: 'POST',
                    body: JSON.stringify(data)
                });
            },

            async update(eventId, rowId, data) {
                return API.request(`/events/${eventId}/financials/${rowId}`, {
                    method: 'PUT',
                    body: JSON.stringify(data)
                });
            },

            async delete(eventId, rowId) {
                return API.request(`/events/${eventId}/financials/${rowId}`, {
                    method: 'DELETE'
                });
            },

            async recalculate(eventId) {
                return API.request(`/events/${eventId}/financials/recalculate`, {
                    method: 'POST'
                });
            },

            async patchPaidBy(eventId, rowId, paidBy) {
                return API.request(`/events/${eventId}/financials/${rowId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ paidBy })
                });
            }
        }
    },

    participations: {
        async list() {
            return API.request('/participations/all');
        },

        async get(userId, eventId = null) {
            let url = `/participations?userId=${userId}`;
            if (eventId) url += `&eventId=${eventId}`;
            return API.request(url);
        },

        async getOrNull(userId, eventId = null) {
            let url = `${API.baseUrl}/participations?userId=${userId}`;
            if (eventId) url += `&eventId=${eventId}`;
            const response = await fetch(url, {
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const text = await response.text();
            if (!text) return null;
            try { return JSON.parse(text) || null; } catch { return null; }
        },

        async upsert(data) {
            return API.request('/participations', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(participationId, data) {
            return API.request(`/participations/${participationId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async delete(participationId) {
            return API.request(`/participations/${participationId}`, {
                method: 'DELETE'
            });
        },

        async updateHotel(participationId, hotelNights, profileVerification) {
            const body = { hotelNights };
            if (profileVerification !== undefined) body.profileVerification = profileVerification;
            return API.request(`/participations/${participationId}/hotel`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
        },

        async addRoles(participationId, roles) {
            return API.request(`/participations/${participationId}/roles`, {
                method: 'PUT',
                body: JSON.stringify({ add: roles })
            });
        },

        async removeRoles(participationId, roles) {
            return API.request(`/participations/${participationId}/roles`, {
                method: 'PUT',
                body: JSON.stringify({ remove: roles })
            });
        },

        async setRoles(participationId, roles) {
            return API.request(`/participations/${participationId}/roles`, {
                method: 'PUT',
                body: JSON.stringify({ set: roles })
            });
        },

        async assignTeam(participationId, teamId, isTeamAdmin = false, isParticipant = true) {
            return API.request(`/participations/${participationId}/team`, {
                method: 'PUT',
                body: JSON.stringify({ teamId, isTeamAdmin, isParticipant })
            });
        },

        async updateRoles(participationId, teamId, isAdmin, isParticipant, confirmCommitmentIncrease = false) {
            return API.request(`/participations/${participationId}/team-membership/${teamId}/roles`, {
                method: 'PUT',
                body: JSON.stringify({ isAdmin, isParticipant, confirmCommitmentIncrease })
            });
        },

        async getTeamCount(teamId) {
            return API.request(`/participations/team/${teamId}/count`);
        },

        async getByEvent(eventId, role = null) {
            let url = `/participations/event/${eventId}`;
            if (role) url += `?role=${role}`;
            return API.request(url);
        },

        async getByPerson(email) {
            return API.request(`/participations/person/${encodeURIComponent(email)}`);
        },

        async getAll() {
            return API.request('/participations/all');
        }
    },

    soloQueue: {
        async get(eventId, userId) {
            let url = '/solo-queue';
            const params = [];
            if (eventId) params.push(`eventId=${eventId}`);
            if (userId) params.push(`userId=${userId}`);
            if (params.length) url += '?' + params.join('&');
            return API.request(url);
        },

        async join(eventId, userId, note) {
            return API.request('/solo-queue', {
                method: 'POST',
                body: JSON.stringify({ eventId, userId, note })
            });
        },

        async leave(entryId) {
            return API.request(`/solo-queue/${entryId}`, {
                method: 'DELETE'
            });
        },

        async getPosition(eventId, userId) {
            return API.request(`/solo-queue/position/${eventId}/${userId}`);
        }
    },

    campaigns: {
        async list(eventId = null) {
            const url = eventId ? `/email/campaigns?eventId=${eventId}` : '/email/campaigns';
            return API.request(url);
        },

        async get(campaignId) {
            return API.request(`/email/campaigns/${campaignId}`);
        },

        async create(data) {
            return API.request('/email/campaigns', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(campaignId, data) {
            return API.request(`/email/campaigns/${campaignId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async delete(campaignId) {
            return API.request(`/email/campaigns/${campaignId}`, {
                method: 'DELETE'
            });
        },

        async send(campaignId, recipients) {
            return API.request(`/email/campaigns/${campaignId}/send`, {
                method: 'POST',
                body: JSON.stringify({ recipients })
            });
        },

        async getDeliveries(campaignId) {
            return API.request(`/email/campaigns/${campaignId}/deliveries`);
        },

        async triggerSequence(userId, eventId) {
            return API.request('/email/trigger-sequence', {
                method: 'POST',
                body: JSON.stringify({ userId, eventId })
            });
        }
    },

    sequences: {
        async list(eventId = null) {
            const url = eventId ? `/sequences?eventId=${eventId}` : '/sequences';
            return API.request(url);
        },

        async get(sequenceId) {
            return API.request(`/sequences/${sequenceId}`);
        },

        async create(data) {
            return API.request('/sequences', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(sequenceId, data) {
            return API.request(`/sequences/${sequenceId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async delete(sequenceId) {
            return API.request(`/sequences/${sequenceId}`, {
                method: 'DELETE'
            });
        },

        async copy(sequenceId, targetEventId) {
            return API.request(`/sequences/${sequenceId}/copy`, {
                method: 'POST',
                body: JSON.stringify({ targetEventId })
            });
        }
    },

    deliveries: {
        async getEventDeliveries(eventId) {
            return API.request(`/deliveries/event/${eventId}`);
        },

        async retry(deliveryId) {
            return API.request('/deliveries/retry', {
                method: 'POST',
                body: JSON.stringify({ deliveryId })
            });
        }
    },

    badges: {
        async list(category = null) {
            const url = category ? `/badges?category=${category}` : '/badges';
            return API.request(url);
        },

        async getEventBadges(eventId) {
            return API.request(`/events/${eventId}/badges`);
        }
    },

    badgeClaims: {
        async list(filters = {}) {
            const params = [];
            if (filters.eventId) params.push(`eventId=${filters.eventId}`);
            if (filters.teamId) params.push(`teamId=${filters.teamId}`);
            if (filters.status) params.push(`status=${filters.status}`);
            if (filters.badgeId) params.push(`badgeId=${filters.badgeId}`);
            const url = '/badge-claims' + (params.length ? '?' + params.join('&') : '');
            return API.request(url);
        },

        async create(data) {
            return API.request('/badge-claims', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        async update(claimId, data) {
            return API.request(`/badge-claims/${claimId}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async review(claimId, data) {
            return API.request(`/badge-claims/${claimId}/review`, {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async delete(claimId) {
            return API.request(`/badge-claims/${claimId}`, {
                method: 'DELETE'
            });
        },

        async assign(data) {
            return API.request('/badge-claims/assign', {
                method: 'PUT',
                body: JSON.stringify(data)
            });
        },

        async award(data) {
            return API.request('/badge-claims/award', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        }
    }
};

