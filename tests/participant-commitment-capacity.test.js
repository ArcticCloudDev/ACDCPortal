const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const participations = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'participations.js'),
    'utf8'
);
const eventPage = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'event-page.js'),
    'utf8'
);
const apiClient = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'api.js'),
    'utf8'
);

assert.match(participations, /requiresCommitmentIncrease:\s*true/);
assert.match(participations, /status:\s*409/);
assert.match(participations, /numberOfParticipants:\s*newCommittedParticipants/);
assert.ok(
    (participations.match(/enforceParticipantCapacity\(/g) || []).length >= 6,
    'every participant-promotion endpoint must use the shared capacity guard'
);
assert.match(eventPage, /Do you want to commit to \$\{roleError\.newCommittedParticipants\} participant places/);
assert.match(apiClient, /confirmCommitmentIncrease = false/);

console.log('PASS: Participant promotion requires explicit commitment increase when committed places are full');