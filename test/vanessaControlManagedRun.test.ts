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

test('a second run with the same settings reuses its managed session while a new attachment requires an explicit policy choice', async () => {
    let generation: number | undefined; let starts = 0; let choices = 0; let runs = 0;
    const runner = new VanessaManagedRun({ currentGeneration: () => generation,
        chooseSession: async () => { choices++; return 'current'; },
        start: async launch => { starts++; if (!await launch(9877)) { return false; } generation = 4; return true; },
        run: async () => { runs++; return 'passed'; } });
    const request = { filePath: 'own.feature', sourceText: 'own source', configurationKey: 'settings-a', isCurrent: () => true, launch: async () => true };
    assert.equal(await runner.run(request), 'passed');
    assert.equal(await runner.run({ ...request, sourceText: 'new build, same settings' }), 'passed');
    assert.equal(starts, 1); assert.equal(choices, 0);
    generation = 8;
    await runner.run(request); assert.equal(choices, 1); assert.equal(starts, 1);
    await runner.run(request); assert.equal(choices, 1, 'explicit current-settings consent belongs to this generation and settings identity');
    await runner.run({ ...request, configurationKey: 'settings-b' }); assert.equal(choices, 2);
    assert.equal(runs, 5);
});

test('unrelated active settings require configured launch or cancellation and a cancelled picker never executes', async () => {
    for (const choice of ['configured', 'cancelled'] as const) {
        let starts = 0; let runs = 0;
        const runner = new VanessaManagedRun({ currentGeneration: () => 3, chooseSession: async () => choice,
            start: async launch => { starts++; return launch(9877); }, run: async () => { runs++; return 'passed'; } });
        const result = await runner.run({ filePath: 'own.feature', sourceText: 'own source', configurationKey: 'settings-a', isCurrent: () => true, launch: async () => true });
        assert.equal(result, choice === 'configured' ? 'passed' : 'cancelled');
        assert.equal(starts, choice === 'configured' ? 1 : 0); assert.equal(runs, choice === 'configured' ? 1 : 0);
    }
});

test('a reconnect or source edit while choosing current settings invalidates the pending run', async () => {
    for (const change of ['connection', 'source'] as const) {
        let generation = 3; let current = true; let runs = 0;
        const runner = new VanessaManagedRun({ currentGeneration: () => generation,
            chooseSession: async () => { if (change === 'connection') { generation++; } else { current = false; } return 'current'; },
            start: async () => { throw new Error('Must not launch'); }, run: async () => { runs++; return 'passed'; } });
        await assert.rejects(runner.run({ filePath: 'own.feature', sourceText: 'own source', configurationKey: 'settings-a', isCurrent: () => current, launch: async () => true }), /changed/u);
        assert.equal(runs, 0);
    }
});
