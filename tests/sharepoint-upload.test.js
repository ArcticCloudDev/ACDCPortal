// shared/sharepoint.js uploadFile: files up to 4 MiB go through the simple PUT, larger
// files through a Graph upload session (createUploadSession + sequential Content-Range
// PUTs in multiples of 320 KiB, without an Authorization header), capped at 10 MB.
const assert = require('node:assert/strict');
const path = require('node:path');

const sharedDir = path.join(__dirname, '..', 'api', 'src', 'shared');

function mock(request, exportsObject) {
    const resolved = require.resolve(request, { paths: [sharedDir] });
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObject };
}

Object.assign(process.env, {
    MAIL_TENANT_ID: 'test-tenant',
    MAIL_CLIENT_ID: 'test-client',
    MAIL_CLIENT_SECRET: 'test-secret',
    SHAREPOINT_SITE_URL: 'contoso.sharepoint.com:/sites/acdc',
    SHAREPOINT_DOC_LIBRARY: 'Team Files'
});

mock('@azure/msal-node', {
    ConfidentialClientApplication: class {
        async acquireTokenByClientCredential() { return { accessToken: 'test-token' }; }
    }
});

const calls = [];
const sessionChunks = [];

function jsonResponse(status, body) {
    return {
        ok: status < 400,
        status,
        headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => body,
        text: async () => JSON.stringify(body)
    };
}

async function fakeFetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    calls.push({ url, method, headers, bodyLength: init.body ? init.body.length : 0 });

    if (url.endsWith('/sites/contoso.sharepoint.com:/sites/acdc')) return jsonResponse(200, { id: 'site-1' });
    if (url.endsWith('/sites/site-1/drives')) return jsonResponse(200, { value: [{ id: 'drive-1', name: 'Team Files' }] });
    if (/\/createUploadSession$/.test(url)) {
        return jsonResponse(200, { uploadUrl: 'https://up.example.test/session-1', expirationDateTime: '2030-01-01T00:00:00Z' });
    }
    if (url === 'https://up.example.test/session-1') {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['Content-Range'] || '');
        assert.ok(match, 'every session PUT carries a Content-Range header');
        const [start, end, total] = match.slice(1).map(Number);
        assert.equal(init.body.length, end - start + 1, 'chunk length matches its Content-Range');
        assert.equal(Number(headers['Content-Length']), init.body.length);
        sessionChunks.push({ start, end, total, body: Buffer.from(init.body) });
        if (end + 1 === total) return jsonResponse(201, { id: 'item-big', name: 'big.zip', size: total, webUrl: 'https://contoso.sharepoint.com/big.zip' });
        return jsonResponse(202, { nextExpectedRanges: [`${end + 1}-`] });
    }
    if (method === 'PUT' && /:\/content$/.test(url)) {
        return jsonResponse(201, { id: 'item-small', name: 'small.txt', size: init.body.length, webUrl: 'https://contoso.sharepoint.com/small.txt' });
    }
    if (method === 'GET' && /\/root:\//.test(url)) return jsonResponse(200, { id: 'folder', folder: {} });
    throw new Error(`Unexpected request in test: ${method} ${url}`);
}
mock('node-fetch', Object.assign(fakeFetch, { default: fakeFetch }));

const SharePoint = require(path.join(sharedDir, 'sharepoint.js'));
const KIB_320 = 320 * 1024;

(async () => {
    // Large file: upload session, sequential chunks, bytes intact.
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    const result = await SharePoint.uploadFile(big, 'big.zip', 'Events/EVENT/TEAM');
    assert.equal(result.id, 'item-big');
    assert.equal(result.size, big.length);

    const session = calls.find(c => /createUploadSession$/.test(c.url));
    assert.ok(session, 'a Graph upload session is created for files over 4 MiB');
    assert.equal(session.method, 'POST');
    assert.match(session.headers.Authorization, /^Bearer /, 'createUploadSession is authenticated');
    assert.ok(session.url.includes('/root:/Events/EVENT/TEAM/big.zip:/createUploadSession'));

    assert.ok(sessionChunks.length >= 2, 'the file is split into more than one byte range');
    const sessionPuts = calls.filter(c => c.url === 'https://up.example.test/session-1');
    for (const put of sessionPuts) assert.equal(put.headers.Authorization, undefined, 'session PUTs carry no Authorization header');
    for (const chunk of sessionChunks.slice(0, -1)) {
        assert.equal(chunk.body.length % KIB_320, 0, 'non-final byte ranges are multiples of 320 KiB');
    }
    let expectedStart = 0;
    for (const chunk of sessionChunks) {
        assert.equal(chunk.start, expectedStart, 'byte ranges are uploaded sequentially');
        assert.equal(chunk.total, big.length);
        expectedStart = chunk.end + 1;
    }
    assert.equal(expectedStart, big.length, 'the last range ends at the final byte');
    assert.ok(Buffer.concat(sessionChunks.map(c => c.body)).equals(big), 'reassembled bytes equal the original');
    assert.equal(calls.filter(c => c.method === 'PUT' && /:\/content$/.test(c.url)).length, 0, 'no simple PUT for a large file');

    // Small file: single authenticated PUT, no session.
    calls.length = 0;
    const small = await SharePoint.uploadFile(Buffer.from('hello'), 'small.txt', 'Events/EVENT/TEAM');
    assert.equal(small.id, 'item-small');
    const simplePut = calls.find(c => c.method === 'PUT' && /:\/content$/.test(c.url));
    assert.ok(simplePut, 'files up to 4 MiB use the simple content PUT');
    assert.match(simplePut.headers.Authorization, /^Bearer /);
    assert.equal(calls.filter(c => /createUploadSession$/.test(c.url)).length, 0);

    // File name sanitising and the hard ceiling.
    calls.length = 0;
    await SharePoint.uploadFile(Buffer.from('x'), 'bad<name>:x.txt', 'Events/EVENT/TEAM');
    assert.ok(calls.some(c => c.url.includes('/root:/Events/EVENT/TEAM/bad_name__x.txt:/content')), 'reserved characters are replaced');

    await assert.rejects(
        SharePoint.uploadFile(Buffer.alloc(10 * 1024 * 1024 + 1), 'huge.bin', 'Events/EVENT/TEAM'),
        /too large/i,
        'files above 10 MB are refused before any Graph call'
    );

    assert.equal(SharePoint.UPLOAD_CHUNK_SIZE % KIB_320, 0);
    console.log('PASS: SharePoint uploads use Graph upload sessions above 4 MiB and stay within the 10 MB limit');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
