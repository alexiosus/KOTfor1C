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

test('tracks simultaneous launch modes until the last process in each mode exits', () => {
    const tracker = new InfobaseRuntimeTracker();
    const designer = new FakeProcess(301);
    const enterprise = new FakeProcess(302);
    const secondEnterprise = new FakeProcess(303);
    const unknownMode = new FakeProcess(304);
    const identity = normalizeInfobaseConnectionIdentity('/workspace/demo');
    const changes: string[][] = [];
    tracker.onDidChange(() => changes.push([...tracker.runningModes('/workspace/demo')]));

    tracker.track('/workspace/demo', designer, 'designer');
    tracker.track('/workspace/demo', enterprise, 'enterprise');
    tracker.track('/workspace/demo', secondEnterprise, 'enterprise');
    tracker.track('/workspace/demo', unknownMode);
    const bothModes = tracker.runningModes('File="/workspace/demo";');
    assert.deepEqual(bothModes, ['enterprise', 'designer']);
    assert.deepEqual(tracker.runningModes('/workspace/other'), []);

    enterprise.emit('exit', 0);
    assert.deepEqual(tracker.runningModes('/workspace/demo'), ['enterprise', 'designer']);
    designer.emit('close', 0);
    assert.deepEqual(tracker.runningModes('/workspace/demo'), ['enterprise']);
    secondEnterprise.emit('error', new Error('client stopped'));
    assert.deepEqual(tracker.runningModes('/workspace/demo'), []);
    assert.deepEqual([...tracker.runningIdentities()], [identity]);
    assert.deepEqual(bothModes, ['enterprise', 'designer']);
    unknownMode.emit('exit', 0);
    assert.deepEqual([...tracker.runningIdentities()], []);
    assert.deepEqual(changes, [['designer'], ['enterprise', 'designer'], ['enterprise', 'designer'],
        ['enterprise', 'designer'], ['enterprise', 'designer'], ['enterprise'], [], []]);
});
