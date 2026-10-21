import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitVanessaControlReady } from '../src/vanessaControlReadiness';

test('readiness retries a starting manager, then accepts a successful handshake', async () => {
    let attempts = 0;
    await awaitVanessaControlReady(async () => { if (++attempts < 3) { throw new Error('starting'); } }, new AbortController().signal, { timeoutMs: 500, retryMs: 1 });
    assert.equal(attempts, 3);
});

test('readiness cancellation prevents attempts and rejects a late successful handshake', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    let attempts = 0;
    await assert.rejects(awaitVanessaControlReady(async () => { attempts++; }, cancelled.signal), { name: 'AbortError' });
    assert.equal(attempts, 0);
    const late = new AbortController();
    await assert.rejects(awaitVanessaControlReady(async () => { late.abort(); }, late.signal), { name: 'AbortError' });
});

test('readiness timeout exposes no raw endpoint or server error', async () => {
    await assert.rejects(awaitVanessaControlReady(async () => { throw new Error('Pwd=secret'); }, new AbortController().signal, { timeoutMs: 10, retryMs: 1 }), error => /did not become ready/.test(String(error)) && !String(error).includes('secret'));
});
