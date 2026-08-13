const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const participantFiles = [
    'src/events.html',
    'src/js/events.js',
    'src/js/event-page.js'
];

for (const file of participantFiles) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.equal(
        source.includes('/interest/leads'),
        false,
        `${file} must not call the admin-only interest leads endpoint`
    );
}

console.log('PASS: Participant event pages do not call the admin-only interest leads endpoint');