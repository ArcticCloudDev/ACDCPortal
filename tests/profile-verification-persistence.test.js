const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eventPage = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'event-page.js'),
    'utf8'
);
const participations = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'participations.js'),
    'utf8'
);

assert.match(
    eventPage,
    /const profileVerification = document\.getElementById\('edit-data-verified'\)\.checked;\s*await API\.participations\.updateHotel\(participationId, hotelNights, profileVerification\);/
);
assert.match(participations, /const \{ hotelNights, profileVerification \} = body;/);
assert.match(participations, /if \(profileVerification !== undefined\) changes\.profileVerification = profileVerification;/);

console.log('PASS: Profile confirmation is sent and persisted');
