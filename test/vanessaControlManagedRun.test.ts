import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaManagedRun } from '../src/vanessaControlManagedRun';

test('managed run prepares its own configured session before executing the complete feature', async () => {
    const calls: string[] = [];
    const runner = new VanessaManagedRun({ start: async launch => { calls.push('start'); return launch(9877); },
        run: async (file, text, current, points) => { assert.ok(current()); assert.equal(file, 'own.feature'); assert.equal(text, 'own source'); assert.deepEqual(points, [7]); calls.push('run whole feature'); return 'failed'; } });
    const request = { filePath: 'own.feature', sourceText: 'own source', isCurrent: () => true, breakpointLines: [7],
        launch: async (port: number) => { assert.equal(port, 9877); calls.push('prepare authored JSON'); return true; } };
    assert.equal(await runner.run(request), 'failed');
    assert.deepEqual(calls, ['start', 'prepare authored JSON', 'run whole feature']);
});

test('cancel, changed source and repeated requests cannot launch a queued or differently configured test', async () => {
    let current = true; let release!: (started: boolean) => void; let runs = 0; let launches = 0;
    const runner = new VanessaManagedRun({ start: async launch => { launches++; const ready = new Promise<boolean>(resolve => { release = resolve; }); await launch(9877); return ready; },
        run: async () => { runs++; return 'passed'; } });
    const request = { filePath: 'own.feature', sourceText: 'own source', isCurrent: () => current, launch: async () => true };
    const first = runner.run(request);
    await assert.rejects(runner.run(request), /busy/u);
    current = false; release(true); await assert.rejects(first, /changed/u);
    assert.equal(launches, 1); assert.equal(runs, 0);
    current = true; const second = runner.run(request); release(false);
    assert.equal(await second, 'cancelled'); assert.equal(runs, 0);
});
