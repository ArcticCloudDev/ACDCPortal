const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checkEmail = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'auth-check-email.js'),
    'utf8'
);
const sendOtp = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'src', 'functions', 'auth-send-otp.js'),
    'utf8'
);

assert.match(checkEmail, /const checkRateLimits =/);
assert.match(checkEmail, /checkRateLimits\.byEmail/);
assert.match(checkEmail, /checkRateLimits\.byIp/);
assert.doesNotMatch(checkEmail, /rateLimits\.byEmail|rateLimits\.byIp/);
assert.match(sendOtp, /EMAIL_MAX:\s*3/);
assert.match(sendOtp, /COOLDOWN_MS:\s*60 \* 1000/);

console.log('PASS: Email routing checks do not consume OTP delivery quota');