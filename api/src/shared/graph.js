// Graph API Helper - Create users in Entra External ID
const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

let graphClient = null;

function getConfig() {
    return {
        clientId: process.env.AZURE_CLIENT_ID || 'c14c3e9e-a80f-4c83-ab48-52673788cf8f',
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        tenantId: process.env.AZURE_TENANT_ID || '6faefb57-2c64-4298-a1c2-28d08a434986',
        issuerDomain: process.env.ENTRA_ISSUER_DOMAIN || 'acdcregistration.onmicrosoft.com'
    };
}

/**
 * Initialize the Graph client with client credentials
 */
function getGraphClient() {
    if (graphClient) return graphClient;

    const config = getConfig();
    if (!config.clientSecret) {
        throw new Error('AZURE_CLIENT_SECRET environment variable is not set');
    }

    const credential = new ClientSecretCredential(
        config.tenantId,
        config.clientId,
        config.clientSecret
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default']
    });

    graphClient = Client.initWithMiddleware({
        authProvider: authProvider
    });

    return graphClient;
}

/**
 * Create a user in Entra External ID with email identity
 * @param {string} email - User's email address
 * @param {string} displayName - Display name (optional, defaults to email prefix)
 * @returns {object} - Created user object or null if already exists
 */
async function createEntraUser(email, displayName = null) {
    const client = getGraphClient();
    const config = getConfig();
    
    // Use email prefix as display name if not provided
    const name = displayName || email.split('@')[0];
    
    // Check if user already exists
    try {
        const existingUsers = await client.api('/users')
            .filter(`identities/any(id:id/issuer eq '${config.issuerDomain}' and id/issuerAssignedId eq '${email}')`)
            .select('id,displayName,identities')
            .get();
        
        if (existingUsers.value && existingUsers.value.length > 0) {
            console.log(`User already exists in Entra: ${email}`);
            return { exists: true, user: existingUsers.value[0] };
        }
    } catch (filterError) {
        // Filter might fail on some tenant configs, continue with create
        console.log('Could not check for existing user, attempting create:', filterError.message);
    }

    // Generate a random password (user won't need it - they use Email OTP)
    // But Graph API requires a password for user creation
    const randomPassword = generateRandomPassword();

    // Create the user with email identity (for Email OTP sign-in)
    const newUser = {
        displayName: name,
        identities: [
            {
                signInType: 'emailAddress',
                issuer: config.issuerDomain,
                issuerAssignedId: email
            }
        ],
        passwordProfile: {
            password: randomPassword,
            forceChangePasswordNextSignIn: false
        },
        passwordPolicies: 'DisablePasswordExpiration'
    };

    try {
        const createdUser = await client.api('/users').post(newUser);
        console.log(`Created user in Entra: ${email} (ID: ${createdUser.id})`);
        return { exists: false, user: createdUser };
    } catch (error) {
        // Handle "user already exists" error gracefully
        if (error.code === 'Request_BadRequest' && error.message?.includes('already exists')) {
            console.log(`User already exists in Entra: ${email}`);
            return { exists: true, user: null };
        }
        throw error;
    }
}

/**
 * Generate a cryptographically strong random password
 * User won't actually use this - they use Email OTP only
 * This is purely to satisfy Graph API requirements
 */
function generateRandomPassword() {
    const length = 32;
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const all = uppercase + lowercase + numbers + symbols;
    
    // Use crypto for better randomness
    const crypto = require('crypto');
    const randomBytes = crypto.randomBytes(length);
    
    let password = '';
    // Ensure at least two of each required type for extra security
    password += uppercase[randomBytes[0] % uppercase.length];
    password += uppercase[randomBytes[1] % uppercase.length];
    password += lowercase[randomBytes[2] % lowercase.length];
    password += lowercase[randomBytes[3] % lowercase.length];
    password += numbers[randomBytes[4] % numbers.length];
    password += numbers[randomBytes[5] % numbers.length];
    password += symbols[randomBytes[6] % symbols.length];
    password += symbols[randomBytes[7] % symbols.length];
    
    // Fill the rest with cryptographically random characters
    for (let i = password.length; i < length; i++) {
        password += all[randomBytes[i] % all.length];
    }
    
    // Cryptographically shuffle the password
    const shuffled = password.split('');
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomBytes[i] % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    return shuffled.join('');
}

/**
 * Create multiple users in Entra External ID
 * @param {string[]} emails - Array of email addresses
 * @returns {object} - Results with created and existing users
 */
async function createEntraUsers(emails) {
    const results = {
        created: [],
        existing: [],
        failed: []
    };

    for (const email of emails) {
        try {
            const result = await createEntraUser(email);
            if (result.exists) {
                results.existing.push(email);
            } else {
                results.created.push(email);
            }
        } catch (error) {
            console.error(`Failed to create user ${email}:`, error.message);
            results.failed.push({ email, error: error.message });
        }
    }

    return results;
}

/**
 * Delete a user from Entra External ID
 * @param {string} email - User's email address
 * @returns {boolean} - True if deleted, false if not found
 */
async function deleteEntraUser(email) {
    const client = getGraphClient();
    const config = getConfig();

    try {
        // Find user by email identity
        const users = await client.api('/users')
            .filter(`identities/any(id:id/issuer eq '${config.issuerDomain}' and id/issuerAssignedId eq '${email}')`)
            .select('id')
            .get();

        if (!users.value || users.value.length === 0) {
            console.log(`User not found in Entra: ${email}`);
            return false;
        }

        // Delete the user
        await client.api(`/users/${users.value[0].id}`).delete();
        console.log(`Deleted user from Entra: ${email}`);
        return true;
    } catch (error) {
        console.error(`Failed to delete user ${email}:`, error.message);
        throw error;
    }
}

/**
 * Find Entra user by email using multiple lookup strategies
 * Handles users created via Graph API, self-service sign-up, and CIAM tenants
 * @param {string} email - User's email address
 * @returns {string|null} - Entra user ID or null if not found
 */
async function findEntraUserByEmail(email) {
    const client = getGraphClient();
    const config = getConfig();

    // Strategy 1: Find by mail property
    try {
        const users = await client.api('/users')
            .filter(`mail eq '${email}'`)
            .select('id')
            .get();
        if (users.value && users.value.length > 0) {
            console.log(`Found Entra user by mail property: ${email} (ID: ${users.value[0].id})`);
            return users.value[0].id;
        }
    } catch (e) {
        console.log(`Mail filter failed for ${email}: ${e.message}`);
    }

    // Strategy 2: Find by identities with configured issuer domain
    try {
        const users = await client.api('/users')
            .filter(`identities/any(id:id/issuer eq '${config.issuerDomain}' and id/issuerAssignedId eq '${email}')`)
            .select('id')
            .get();
        if (users.value && users.value.length > 0) {
            console.log(`Found Entra user by identities (${config.issuerDomain}): ${email} (ID: ${users.value[0].id})`);
            return users.value[0].id;
        }
    } catch (e) {
        console.log(`Identities filter failed for ${email}: ${e.message}`);
    }

    // Strategy 3: Try CIAM login domain variant (for External ID tenants)
    const ciamDomain = config.issuerDomain.replace('.onmicrosoft.com', '.ciamlogin.com');
    if (ciamDomain !== config.issuerDomain) {
        try {
            const users = await client.api('/users')
                .filter(`identities/any(id:id/issuer eq '${ciamDomain}' and id/issuerAssignedId eq '${email}')`)
                .select('id')
                .get();
            if (users.value && users.value.length > 0) {
                console.log(`Found Entra user by CIAM identities (${ciamDomain}): ${email} (ID: ${users.value[0].id})`);
                return users.value[0].id;
            }
        } catch (e) {
            console.log(`CIAM identities filter failed for ${email}: ${e.message}`);
        }
    }

    // Strategy 4: Find by otherMails (self-service sign-up may store email here)
    try {
        const users = await client.api('/users')
            .filter(`otherMails/any(o:o eq '${email}')`)
            .select('id')
            .get();
        if (users.value && users.value.length > 0) {
            console.log(`Found Entra user by otherMails: ${email} (ID: ${users.value[0].id})`);
            return users.value[0].id;
        }
    } catch (e) {
        console.log(`otherMails filter failed for ${email}: ${e.message}`);
    }

    // Strategy 5: Last resort — list users with identities and manually search
    // This handles cases where special characters in email (like +) break OData filters
    try {
        const allUsers = await client.api('/users')
            .select('id,identities,mail,otherMails')
            .top(999)
            .get();
        if (allUsers.value) {
            const normalizedEmail = email.toLowerCase();
            for (const user of allUsers.value) {
                // Check mail property
                if (user.mail && user.mail.toLowerCase() === normalizedEmail) {
                    console.log(`Found Entra user by manual scan (mail): ${email} (ID: ${user.id})`);
                    return user.id;
                }
                // Check otherMails
                if (user.otherMails && user.otherMails.some(m => m.toLowerCase() === normalizedEmail)) {
                    console.log(`Found Entra user by manual scan (otherMails): ${email} (ID: ${user.id})`);
                    return user.id;
                }
                // Check identities
                if (user.identities) {
                    for (const identity of user.identities) {
                        if (identity.issuerAssignedId && identity.issuerAssignedId.toLowerCase() === normalizedEmail) {
                            console.log(`Found Entra user by manual scan (identity): ${email} (ID: ${user.id})`);
                            return user.id;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.log(`Manual user scan failed for ${email}: ${e.message}`);
    }

    console.log(`User not found in Entra by any method: ${email}`);
    return null;
}

/**
 * Update a user's profile in Entra External ID
 * @param {string} email - User's email address
 * @param {object} profile - Profile data to update (firstName, lastName, displayName, phone)
 * @returns {object|null} - Updated user object or null if not found
 */
async function updateEntraUser(email, profile) {
    const client = getGraphClient();

    try {
        const userId = await findEntraUserByEmail(email);

        if (!userId) {
            console.log(`User not found in Entra for update: ${email}`);
            return null;
        }
        
        // Build update payload - only include fields that are provided
        const updatePayload = {};
        
        if (profile.firstName) {
            updatePayload.givenName = profile.firstName;
        }
        if (profile.lastName) {
            updatePayload.surname = profile.lastName;
        }
        if (profile.firstName || profile.lastName) {
            updatePayload.displayName = `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
        }
        if (profile.displayName) {
            updatePayload.displayName = profile.displayName;
        }
        if (profile.phone) {
            updatePayload.mobilePhone = profile.phone;
        }

        // Only update if there's something to update
        if (Object.keys(updatePayload).length === 0) {
            console.log(`No fields to update for user: ${email}`);
            return { id: userId };
        }

        // Update the user
        await client.api(`/users/${userId}`).patch(updatePayload);
        console.log(`Updated Entra user: ${email} (ID: ${userId})`, updatePayload);
        
        return { id: userId, ...updatePayload };
    } catch (error) {
        console.error(`Failed to update user ${email}:`, error.message);
        throw error;
    }
}

module.exports = {
    createEntraUser,
    createEntraUsers,
    deleteEntraUser,
    updateEntraUser,
    findEntraUserByEmail
};
