/**
 * Migration script: Replace all non-GUID IDs with proper UUIDs (v4)
 * 
 * Migrates:
 * - users.json: user IDs (19-char alphanumeric → GUID)
 * - email-campaigns.json: campaign IDs (camp_* → GUID)
 * - email-deliveries.json: delivery IDs (del_* → GUID), campaignId refs, userId refs
 * - email-log.json: log IDs (log_camp_* → GUID), campaignId refs
 * - scheduled-runs.json: campaign refs in runs
 * - invitations.json: teamId, inviterId, acceptedBy refs
 * - participations.json: userId refs
 * - event-badges.json: judgeUserId refs
 * 
 * Badge slugs (badge-*) are intentionally kept as-is.
 * 
 * Usage: node scripts/migrate-ids-to-guid.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRY_RUN = process.argv.includes('--dry-run');

// GUID regex to detect already-valid GUIDs
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(filename) {
    const filePath = path.join(DATA_DIR, filename);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filename, data) {
    const filePath = path.join(DATA_DIR, filename);
    if (DRY_RUN) {
        console.log(`  [DRY RUN] Would write ${filename}`);
    } else {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        console.log(`  ✓ Wrote ${filename}`);
    }
}

function isNonGuid(id) {
    return id && typeof id === 'string' && !GUID_RE.test(id);
}

function isBadgeSlug(id) {
    return id && typeof id === 'string' && id.startsWith('badge-');
}

// Build ID mapping: oldId → newGuid
function buildMapping() {
    const mapping = {};

    function mapId(id) {
        if (!id || !isNonGuid(id) || isBadgeSlug(id)) return;
        if (!mapping[id]) {
            mapping[id] = uuidv4();
        }
    }

    // 1. Users
    const users = readJson('users.json');
    for (const user of users) {
        mapId(user.id);
    }

    // 2. Campaigns
    const campaigns = readJson('email-campaigns.json');
    for (const camp of campaigns.campaigns) {
        mapId(camp.id);
    }

    // 3. Deliveries
    const deliveries = readJson('email-deliveries.json');
    for (const del of deliveries.deliveries) {
        mapId(del.id);
        // campaignId can be comma-separated
        if (del.campaignId) {
            for (const cid of del.campaignId.split(',')) {
                mapId(cid.trim());
            }
        }
        mapId(del.userId);
    }

    // 4. Email log
    const emailLog = readJson('email-log.json');
    for (const log of emailLog.emails) {
        mapId(log.id);
        mapId(log.campaignId);
    }

    // 5. Scheduled runs
    const scheduledRuns = readJson('scheduled-runs.json');
    for (const run of scheduledRuns.runs) {
        if (run.campaigns) {
            for (const camp of run.campaigns) {
                mapId(camp.id);
            }
        }
    }

    // 6. Invitations
    const invitations = readJson('invitations.json');
    for (const inv of invitations.invitations) {
        mapId(inv.teamId);
        mapId(inv.inviterId);
        mapId(inv.acceptedBy);
    }

    // 7. Participations
    const participations = readJson('participations.json');
    for (const p of participations.participations) {
        mapId(p.userId);
    }

    // 8. Event badges
    const eventBadges = readJson('event-badges.json');
    for (const eb of eventBadges) {
        mapId(eb.judgeUserId);
        // badgeId: skip if badge slug
    }

    return mapping;
}

// Apply mapping to a single value
function applyMapping(mapping, value) {
    if (!value || typeof value !== 'string') return value;
    return mapping[value] || value;
}

// Apply mapping to comma-separated values (like campaignId)
function applyMappingCsv(mapping, value) {
    if (!value || typeof value !== 'string') return value;
    if (!value.includes(',')) return applyMapping(mapping, value);
    return value.split(',').map(v => applyMapping(mapping, v.trim())).join(',');
}

function migrate() {
    console.log(DRY_RUN ? '=== DRY RUN MODE ===' : '=== MIGRATING IDs TO GUIDs ===');
    console.log('');

    // Build the mapping
    console.log('Building ID mapping...');
    const mapping = buildMapping();
    const entries = Object.entries(mapping);
    console.log(`  Found ${entries.length} non-GUID IDs to migrate`);
    console.log('');

    // Print the mapping
    console.log('ID Mapping:');
    for (const [oldId, newId] of entries) {
        console.log(`  ${oldId} → ${newId}`);
    }
    console.log('');

    // 1. Migrate users.json
    console.log('Migrating users.json...');
    const users = readJson('users.json');
    let userChanges = 0;
    for (const user of users) {
        if (mapping[user.id]) {
            user.id = mapping[user.id];
            userChanges++;
        }
        // Also update teamId if it's a non-GUID
        if (mapping[user.teamId]) {
            user.teamId = mapping[user.teamId];
        }
    }
    console.log(`  ${userChanges} user IDs updated`);
    writeJson('users.json', users);

    // 2. Migrate email-campaigns.json
    console.log('Migrating email-campaigns.json...');
    const campaigns = readJson('email-campaigns.json');
    let campChanges = 0;
    for (const camp of campaigns.campaigns) {
        if (mapping[camp.id]) {
            camp.id = mapping[camp.id];
            campChanges++;
        }
    }
    console.log(`  ${campChanges} campaign IDs updated`);
    writeJson('email-campaigns.json', campaigns);

    // 3. Migrate email-deliveries.json
    console.log('Migrating email-deliveries.json...');
    const deliveries = readJson('email-deliveries.json');
    let delChanges = 0;
    for (const del of deliveries.deliveries) {
        const oldId = del.id;
        del.id = applyMapping(mapping, del.id);
        del.campaignId = applyMappingCsv(mapping, del.campaignId);
        del.userId = applyMapping(mapping, del.userId);
        if (del.id !== oldId) delChanges++;
    }
    console.log(`  ${delChanges} delivery IDs updated, all campaignId/userId refs updated`);
    writeJson('email-deliveries.json', deliveries);

    // 4. Migrate email-log.json
    console.log('Migrating email-log.json...');
    const emailLog = readJson('email-log.json');
    let logChanges = 0;
    for (const log of emailLog.emails) {
        const oldId = log.id;
        log.id = applyMapping(mapping, log.id);
        log.campaignId = applyMapping(mapping, log.campaignId);
        if (log.id !== oldId) logChanges++;
    }
    console.log(`  ${logChanges} log IDs updated, campaignId refs updated`);
    writeJson('email-log.json', emailLog);

    // 5. Migrate scheduled-runs.json
    console.log('Migrating scheduled-runs.json...');
    const scheduledRuns = readJson('scheduled-runs.json');
    let runChanges = 0;
    for (const run of scheduledRuns.runs) {
        if (run.campaigns) {
            for (const camp of run.campaigns) {
                if (mapping[camp.id]) {
                    camp.id = mapping[camp.id];
                    runChanges++;
                }
            }
        }
    }
    console.log(`  ${runChanges} campaign refs in runs updated`);
    writeJson('scheduled-runs.json', scheduledRuns);

    // 6. Migrate invitations.json
    console.log('Migrating invitations.json...');
    const invitations = readJson('invitations.json');
    let invChanges = 0;
    for (const inv of invitations.invitations) {
        const before = JSON.stringify(inv);
        inv.teamId = applyMapping(mapping, inv.teamId);
        inv.inviterId = applyMapping(mapping, inv.inviterId);
        inv.acceptedBy = applyMapping(mapping, inv.acceptedBy);
        if (JSON.stringify(inv) !== before) invChanges++;
    }
    console.log(`  ${invChanges} invitations updated (teamId/inviterId/acceptedBy)`);
    writeJson('invitations.json', invitations);

    // 7. Migrate participations.json
    console.log('Migrating participations.json...');
    const participations = readJson('participations.json');
    let partChanges = 0;
    for (const p of participations.participations) {
        if (mapping[p.userId]) {
            p.userId = mapping[p.userId];
            partChanges++;
        }
    }
    console.log(`  ${partChanges} participation userId refs updated`);
    writeJson('participations.json', participations);

    // 8. Migrate event-badges.json
    console.log('Migrating event-badges.json...');
    const eventBadges = readJson('event-badges.json');
    let badgeChanges = 0;
    for (const eb of eventBadges) {
        if (mapping[eb.judgeUserId]) {
            eb.judgeUserId = mapping[eb.judgeUserId];
            badgeChanges++;
        }
        // Keep badgeId as-is (badge slugs stay)
    }
    console.log(`  ${badgeChanges} event-badge judgeUserId refs updated`);
    writeJson('event-badges.json', eventBadges);

    console.log('');
    console.log(DRY_RUN ? '=== DRY RUN COMPLETE (no files changed) ===' : '=== MIGRATION COMPLETE ===');
}

migrate();
