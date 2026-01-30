// Storage Module - JSON File Storage for Local Development
const fs = require('fs');
const path = require('path');

// Data folder path - relative to project root (api/../data)
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');

// Helper to read JSON file
function readJsonFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    try {
        if (!fs.existsSync(filePath)) {
            // Ensure directory exists
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(filePath, '[]', 'utf8');
            return [];
        }
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading ${filename}:`, error);
        return [];
    }
}

// Helper to write JSON file
function writeJsonFile(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    try {
        // Ensure directory exists
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Error writing ${filename}:`, error);
        return false;
    }
}

const Storage = {
    // Teams
    teams: {
        getAll() {
            return readJsonFile('teams.json');
        },
        
        getById(id) {
            const teams = this.getAll();
            return teams.find(t => t.id === id) || null;
        },
        
        getByName(name) {
            const teams = this.getAll();
            return teams.find(t => t.teamName.toLowerCase() === name.toLowerCase()) || null;
        },
        
        create(team) {
            const teams = this.getAll();
            teams.push(team);
            writeJsonFile('teams.json', teams);
            return team;
        },
        
        update(id, updates) {
            const teams = this.getAll();
            const index = teams.findIndex(t => t.id === id);
            if (index === -1) return null;
            
            teams[index] = { ...teams[index], ...updates, updatedAt: new Date().toISOString() };
            writeJsonFile('teams.json', teams);
            return teams[index];
        },
        
        delete(id) {
            const teams = this.getAll();
            const filtered = teams.filter(t => t.id !== id);
            writeJsonFile('teams.json', filtered);
            return filtered.length < teams.length;
        }
    },

    // Users
    users: {
        getAll() {
            return readJsonFile('users.json');
        },
        
        getById(id) {
            const users = this.getAll();
            return users.find(u => u.id === id) || null;
        },
        
        getByEmail(email) {
            const users = this.getAll();
            return users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
        },
        
        getByTeamId(teamId) {
            const users = this.getAll();
            return users.filter(u => u.teamId === teamId);
        },
        
        create(user) {
            const users = this.getAll();
            users.push(user);
            writeJsonFile('users.json', users);
            return user;
        },
        
        update(id, updates) {
            const users = this.getAll();
            const index = users.findIndex(u => u.id === id);
            if (index === -1) return null;
            
            users[index] = { ...users[index], ...updates, updatedAt: new Date().toISOString() };
            writeJsonFile('users.json', users);
            return users[index];
        },
        
        delete(id) {
            const users = this.getAll();
            const filtered = users.filter(u => u.id !== id);
            writeJsonFile('users.json', filtered);
            return filtered.length < users.length;
        }
    },

    // Allowed Emails
    allowedEmails: {
        getAll() {
            return readJsonFile('allowed-emails.json');
        },
        
        getByEmail(email) {
            const emails = this.getAll();
            return emails.find(e => e.email.toLowerCase() === email.toLowerCase()) || null;
        },
        
        isAllowed(email) {
            const entry = this.getByEmail(email);
            return entry && entry.isActive;
        },
        
        add(email, addedByUserId = null) {
            const emails = this.getAll();
            
            // Check if already exists
            const existing = emails.find(e => e.email.toLowerCase() === email.toLowerCase());
            if (existing) {
                return existing;
            }
            
            const newEntry = {
                email: email.toLowerCase().trim(),
                isActive: true,
                addedAt: new Date().toISOString(),
                addedByUserId: addedByUserId
            };
            
            emails.push(newEntry);
            writeJsonFile('allowed-emails.json', emails);
            return newEntry;
        },
        
        remove(email) {
            const emails = this.getAll();
            const filtered = emails.filter(e => e.email.toLowerCase() !== email.toLowerCase());
            writeJsonFile('allowed-emails.json', filtered);
            return filtered.length < emails.length;
        },
        
        deactivate(email) {
            const emails = this.getAll();
            const index = emails.findIndex(e => e.email.toLowerCase() === email.toLowerCase());
            if (index === -1) return false;
            
            emails[index].isActive = false;
            writeJsonFile('allowed-emails.json', emails);
            return true;
        }
    },

    // Pending Registrations
    pendingRegistrations: {
        getAll() {
            return readJsonFile('pending-registrations.json');
        },
        
        getById(id) {
            const registrations = this.getAll();
            return registrations.find(r => r.id === id) || null;
        },
        
        getByEmail(email) {
            const registrations = this.getAll();
            return registrations.find(r => r.email.toLowerCase() === email.toLowerCase()) || null;
        },
        
        create(registration) {
            const registrations = this.getAll();
            
            // Remove any existing registration for this email
            const filtered = registrations.filter(r => r.email.toLowerCase() !== registration.email.toLowerCase());
            filtered.push(registration);
            
            writeJsonFile('pending-registrations.json', filtered);
            return registration;
        },
        
        delete(id) {
            const registrations = this.getAll();
            const filtered = registrations.filter(r => r.id !== id);
            writeJsonFile('pending-registrations.json', filtered);
            return filtered.length < registrations.length;
        },
        
        // Clean up expired registrations
        cleanupExpired() {
            const registrations = this.getAll();
            const now = new Date();
            const active = registrations.filter(r => new Date(r.expiresAt) > now);
            
            if (active.length < registrations.length) {
                writeJsonFile('pending-registrations.json', active);
            }
            return registrations.length - active.length; // Return count of removed
        }
    }
};

// Generic read/write functions for any JSON file
async function readData(filename) {
    const filePath = path.join(DATA_DIR, filename);
    try {
        if (!fs.existsSync(filePath)) {
            // Return default structure based on filename
            const defaults = {
                'invitations.json': { invitations: [] },
                'email-log.json': { emails: [] },
                'users.json': { users: [] },
                'teams.json': { teams: [] }
            };
            return defaults[filename] || {};
        }
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading ${filename}:`, error);
        throw error;
    }
}

async function writeData(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Error writing ${filename}:`, error);
        throw error;
    }
}

// Generic Storage class for any JSON file
class GenericStorage {
    constructor(filename) {
        this.filename = filename.endsWith('.json') ? filename : `${filename}.json`;
        // Derive the wrapper key from filename (e.g., 'participations.json' -> 'participations')
        this.wrapperKey = this.filename.replace('.json', '');
    }

    // Get raw data without unwrapping (useful for wrapped objects like interest-queue)
    async getRaw() {
        return readJsonFile(this.filename);
    }

    // Save raw data without wrapping
    async saveRaw(data) {
        return writeJsonFile(this.filename, data);
    }

    async getAll() {
        const data = readJsonFile(this.filename);
        // Handle both wrapped objects {key: [...]} and plain arrays [...]
        if (Array.isArray(data)) {
            return data;
        }
        // Try the wrapper key first, then common alternatives
        if (data[this.wrapperKey]) {
            return data[this.wrapperKey];
        }
        // If it's an object but not wrapped, return empty array
        return [];
    }

    async saveAll(items) {
        // Read current structure to preserve wrapper format
        const currentData = readJsonFile(this.filename);
        
        if (Array.isArray(currentData)) {
            // Plain array format
            return writeJsonFile(this.filename, items);
        } else if (currentData[this.wrapperKey]) {
            // Wrapped format - maintain it
            currentData[this.wrapperKey] = items;
            return writeJsonFile(this.filename, currentData);
        } else {
            // Default to plain array
            return writeJsonFile(this.filename, items);
        }
    }

    async getById(id) {
        const items = await this.getAll();
        return items.find(item => item.id === id);
    }

    async create(item) {
        const items = await this.getAll();
        items.push(item);
        await this.saveAll(items);
        return item;
    }

    async update(id, updates) {
        const items = await this.getAll();
        const index = items.findIndex(item => item.id === id);
        if (index === -1) return null;
        items[index] = { ...items[index], ...updates };
        await this.saveAll(items);
        return items[index];
    }

    async delete(id) {
        const items = await this.getAll();
        const index = items.findIndex(item => item.id === id);
        if (index === -1) return false;
        items.splice(index, 1);
        await this.saveAll(items);
        return true;
    }
}

module.exports = Storage;
module.exports.Storage = GenericStorage;
module.exports.readData = readData;
module.exports.writeData = writeData;
