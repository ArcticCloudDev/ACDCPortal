const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registerPage = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'register.js'),
    'utf8'
);
const eventPage = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'event-page.js'),
    'utf8'
);

assert.match(registerPage, /Auth\.isLoggedIn\(\) && isTeamIntent/);
assert.match(registerPage, /event\.html\?id=\$\{encodeURIComponent\(eventId\)\}&action=create-team/);
assert.match(registerPage, /isTeamIntent \? 'team-login' : 'login'/);
assert.match(registerPage, /flowMode === 'team-login'/);
assert.match(eventPage, /get\('action'\) === 'create-team'/);
assert.match(eventPage, /create-team-btn'\)\.click\(\)/);

console.log('PASS: Signed-in Register Team requests open the event team-creation flow');