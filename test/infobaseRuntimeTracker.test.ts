import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { InfobaseRuntimeTracker } from '../src/infobaseRuntimeTracker';
import { normalizeInfobaseConnectionIdentity } from '../src/oneCInfobaseConnection';

class FakeProcess extends EventEmitter {
    constructor(readonly pid: number) {
        super();
    }
}

test('keeps a base running until every KOT-launched process for it exits', () => {
    const tracker = new InfobaseRuntimeTracker();
    const changes: string[][] = [];
    tracker.onDidChange(identities => changes.push([...identities]));
    const first = new FakeProcess(101);
    const second = new FakeProcess(102);
    const identity = normalizeInfobaseConnectionIdentity('/workspace/demo');

    tracker.track('/workspace/demo', first);
    tracker.track('/workspace/demo', second);
    assert.deepEqual([...tracker.runningIdentities()], [identity]);

    first.emit('exit', 0);
    assert.deepEqual([...tracker.runningIdentities()], [identity]);

    second.emit('exit', 0);
    assert.deepEqual([...tracker.runningIdentities()], []);
    assert.deepEqual(changes, [[identity], [identity], [identity], []]);
});

test('ignores processes without a pid and removes failed launches', () => {
    const tracker = new InfobaseRuntimeTracker();
    const missingPid = new FakeProcess(Number.NaN);
    const failed = new FakeProcess(201);

    tracker.track('/workspace/missing', missingPid);
    tracker.track('/workspace/failed', failed);
    failed.emit('error', new Error('spawn failed'));

    assert.deepEqual([...tracker.runningIdentities()], []);
});
