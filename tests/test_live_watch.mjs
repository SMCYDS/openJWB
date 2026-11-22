import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../public/js/jwlive.js', import.meta.url), 'utf8'))
    .replace("import { CookieBridge } from './cookie.js';", 'class CookieBridge {}')
    .replace("import jwbauth from './jwbauth.js';", 'const jwbauth = {};');
const { JWLive } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const originalFetch = globalThis.fetch;
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
try {
    const live = new JWLive();
    live.user = {};
    const actions = [];
    let frames = 0;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/bridge/live/watch');
        const request = JSON.parse(options.body);
        actions.push(request);
        if (request.action === 'start') return reply({ ok: true, watchId: 'lease' });
        if (request.action === 'stop') return reply({ ok: true });
        return ++frames === 1 ? reply({ ok: true, event: { eventId: 7, frame: 'jpeg', qrText: 'qr' } })
            : reply({ ok: true, ended: true });
    };
    const seen = [];
    await live.watchLiveFrames(123, { onFrame: (event) => seen.push(event), onEnd: (reason) => seen.push(reason) }).finished;
    assert.equal(seen[0].qrText, 'qr');
    assert.equal(seen[1], 'course-end');
    assert.deepEqual(actions.map((r) => r.action), ['start', 'next', 'next', 'stop']);
    assert.equal(actions[2].after, 7);

    // A stop during a pending long poll must cancel it and release its worker lease.
    let pending;
    const ready = new Promise((resolve) => { pending = resolve; });
    let released = false;
    globalThis.fetch = async (url, options) => {
        const { action } = JSON.parse(options.body);
        if (action === 'start') return reply({ ok: true, watchId: 'cancel-lease' });
        if (action === 'stop') { released = true; return reply({ ok: true }); }
        return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            pending();
        });
    };
    const watching = live.watchLiveFrames(123, { onFrame: () => assert.fail('stopped stream delivered a frame') });
    await ready;
    watching.stop();
    await watching.finished;
    assert.equal(released, true);

    // Expired source credentials must stop the old lease and reopen after login.
    let starts = 0;
    let retries = 0;
    const stoppedLeases = [];
    live.login = async () => { retries++; live.user = {}; live.jwtToken = 'fresh'; };
    globalThis.fetch = async (url, options) => {
        const request = JSON.parse(options.body);
        if (request.action === 'start') return reply({ ok: true, watchId: `lease-${++starts}` });
        if (request.action === 'stop') { stoppedLeases.push(request.watchId); return reply({ ok: true }); }
        return starts === 1 ? reply({ ok: false, authInvalid: true }, 401) : reply({ ok: true, ended: true });
    };
    await live.watchLiveFrames(123).finished;
    assert.equal(retries, 1);
    assert.equal(starts, 2);
    assert.deepEqual(stoppedLeases, ['lease-1', 'lease-2']);

    console.log('Live watch and cancellation checks passed');
} finally {
    globalThis.fetch = originalFetch;
}
