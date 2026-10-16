import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planCompilerBuildJobs, runCompilerBuildJobs, mergeCompilerBuildOutputs, compilerBuildPathsOverlap } from '../src/compilerBuildRuntime';

test('build parts have isolated output and managed protocol paths, and one-based indices', () => {
    const jobs = planCompilerBuildJobs([
        { key: 'ThreadsCount', value: '2' }, { key: 'Result_File', value: '/wrong/result' },
        { key: 'LogFile', value: '/wrong/log' }, { key: 'FeatureFolder', value: '/out' }
    ], '/runtime', '/out');
    assert.equal(jobs.length, 2);
    assert.notEqual(jobs[0].outputPath, jobs[1].outputPath);
    for (let index = 0; index < jobs.length; index++) {
        const values = Object.fromEntries(jobs[index].parameters.map(item => [item.key, item.value]));
        assert.equal(values.ThreadIndex, String(index + 1));
        assert.equal(values.ResultFile, jobs[index].resultPath);
        assert.equal(values.LogFile, jobs[index].logPath);
        assert.equal(values.FeatureFolder, jobs[index].outputPath);
        assert.equal(values.Result_File, undefined);
    }
});
test('an explicit zero-based thread number compiles only the requested part', () => {
    const jobs = planCompilerBuildJobs([{ key: 'ThreadsCount', value: '4' }, { key: 'ThreadNumber', value: '2' }], '/runtime', '/out');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].index, 3);
});
test('worker failure cancels peers and cannot produce an aggregate success', async () => {
    let cancelled = false;
    await assert.rejects(runCompilerBuildJobs([1, 2, 3], async value => {
        if (value === 2) { throw new Error('part failed'); }
    }, () => { cancelled = true; }, 2), /part failed/u);
    assert.equal(cancelled, true);
});
test('a failed worker aborts peers that are still preparing before they launch', async () => {
    let ready!: () => void; let release!: () => void;
    const preparing = new Promise<void>(resolve => { ready = resolve; });
    const prepared = new Promise<void>(resolve => { release = resolve; });
    const launched: number[] = [];
    await assert.rejects(runCompilerBuildJobs([1, 2, 3], async (job, signal) => {
        if (job === 1) { await preparing; throw new Error('first worker failed'); }
        ready(); await prepared;
        if (!signal?.aborted) { launched.push(job); }
    }, () => { release(); }, 2), /first worker failed/u);
    assert.deepEqual(launched, []);
});
test('merge keeps colliding worker names separate and rewrites only staged launch paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-build-parts-'));
    try {
        const jobs = planCompilerBuildJobs([{ key: 'ThreadTotal', value: '2' }], path.join(root, 'runtime'), path.join(root, 'out'));
        for (const job of jobs) {
            await fs.mkdir(job.outputPath, { recursive: true });
            await fs.writeFile(path.join(job.outputPath, 'same.feature'), `part ${job.index}`);
            await fs.writeFile(path.join(job.outputPath, 'same.json'), JSON.stringify({ feature: path.join(job.outputPath, 'same.feature'), unchanged: 'https://example.invalid/a' }));
            await fs.writeFile(path.join(job.outputPath, 'compile.txt'), JSON.stringify({ scenario_tests: [`test-${job.index}`], process_tests: [] }));
            await fs.mkdir(path.join(job.outputPath, 'QA'));
            await fs.writeFile(path.join(job.outputPath, 'QA', 'db.feature'), 'selected model database');
        }
        await mergeCompilerBuildOutputs(jobs, path.join(root, 'out'));
        assert.equal(await fs.readFile(path.join(root, 'out', 'part-2', 'same.feature'), 'utf8'), 'part 2');
        assert.equal(await fs.readFile(path.join(root, 'out', 'part-2', 'QA', 'db.feature'), 'utf8'), 'selected model database');
        await assert.rejects(fs.stat(path.join(root, 'out', 'QA', 'QA')), { code: 'ENOENT' });
        const json = JSON.parse(await fs.readFile(path.join(root, 'out', 'part-1', 'same.json'), 'utf8'));
        assert.equal(json.feature, path.join(root, 'out', 'part-1', 'same.feature'));
        assert.equal(json.unchanged, 'https://example.invalid/a');
        const inventory = JSON.parse(await fs.readFile(path.join(root, 'out', 'compile.txt'), 'utf8'));
        assert.deepEqual(inventory.scenario_tests, ['test-1', 'test-2']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker output overlap is rejected before any launch or recursive copy', () => {
    for (const output of ['/runtime', '/runtime/compiler-parts/1', '/runtime/compiler-parts/1/artifacts/merged']) {
        assert.throws(() => planCompilerBuildJobs([], '/runtime', output), /overlap|separate/u);
    }
});

test('Windows path case cannot bypass output/runtime overlap checks', () => {
    assert.equal(compilerBuildPathsOverlap('C:\\KOT\\runtime\\compiler-parts\\1', 'c:\\kot\\runtime\\compiler-parts', path.win32, true), true);
    assert.equal(compilerBuildPathsOverlap('C:\\KOT\\runtime', 'D:\\out', path.win32, true), false);
});
