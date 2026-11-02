// Playwright's test.fail() passes when a test fails for ANY reason, so a BUG pin whose
// setup breaks would still look green. Every BUG test marks the line where the defect
// shows with `// <- bug`; this checks each expected failure died on or after that line.
// Run after `npx playwright test`:
//   node tests/e2e/support/audit-bug-pins.js
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'e2e', '.artifacts', 'results.json'), 'utf8'));

function* allTests(suite) {
    for (const spec of suite.specs || []) for (const t of spec.tests) yield { spec, test: t };
    for (const child of suite.suites || []) yield* allTests(child);
}

// Returns the `// <- bug` marker line and the closing line of the test body.
function bugRegion(file, startLine) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let marker = null;
    let depth = 0;
    for (let i = startLine - 1; i < lines.length; i++) {
        for (const ch of lines[i]) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
        if (marker === null && lines[i].includes('// <- bug')) marker = i + 1;
        if (i > startLine - 1 && depth <= 0) return { marker, end: i + 1 };
    }
    return { marker, end: lines.length };
}

let problems = 0;
let pins = 0;
for (const top of results.suites) {
    for (const { spec, test } of allTests(top)) {
        if (test.expectedStatus !== 'failed') continue;
        pins++;
        const result = test.results[test.results.length - 1];
        const file = path.join(ROOT, 'tests', 'e2e', 'specs', spec.file);
        const errorFile = result.error?.location?.file || '';
        const failedAt = errorFile.endsWith(spec.file.replace(/\//g, path.sep)) ? result.error.location.line : null;
        const { marker, end } = bugRegion(file, spec.line);
        const firstLine = (result.error?.message || '').split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '');
        if (result.status === 'passed') {
            console.log(`FIXED?  ${spec.file}:${spec.line} ${spec.title}\n        expected to fail but passed - remove test.fail()`);
            problems++;
        } else if (marker === null) {
            console.log(`MARKER  ${spec.file}:${spec.line} ${spec.title}\n        no "// <- bug" marker in the test body`);
            problems++;
        } else if (failedAt === null || failedAt < marker || failedAt > end) {
            console.log(`SETUP   ${spec.file}:${spec.line} ${spec.title}\n        failed at ${failedAt === null ? errorFile : `line ${failedAt}`}, bug marker is line ${marker}: ${firstLine}`);
            problems++;
        } else {
            console.log(`ok      ${spec.file}:${spec.line} ${spec.title}`);
        }
    }
}
console.log(`\n${pins} bug pins, ${problems} need attention`);
process.exitCode = problems ? 1 : 0;
