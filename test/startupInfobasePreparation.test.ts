import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeStartupInfobasePreparation } from '../src/startupInfobasePreparation';

test('template recreation waits for component installation in the same service base', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const install = serializeStartupInfobasePreparation('/service/ib', async () => { events.push('install'); await gate; events.push('installed'); });
    const recreate = serializeStartupInfobasePreparation('/service/ib', async () => { events.push('recreate'); });
    await serializeStartupInfobasePreparation('/other/ib', async () => { events.push('other'); });
    assert.deepEqual(events, ['install', 'other']);
    release(); await Promise.all([install, recreate]);
    assert.deepEqual(events, ['install', 'other', 'installed', 'recreate']);
});

test('a failed preparation releases the base for a retry', async () => {
    const first = serializeStartupInfobasePreparation('/retry/ib', async () => { throw new Error('locked'); });
    const second = serializeStartupInfobasePreparation('/retry/ib', async () => 42);
    await assert.rejects(first, /locked/);
    assert.equal(await second, 42);
});
