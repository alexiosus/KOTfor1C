import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import nativeFs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyCallableFileConversion } from '../src/scenarioCallableFiles';

async function fixture(run: (directory: string) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-callable-'));
    try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
test('callable conversion creates export/archive, removes source and updates caller together', () => fixture(async directory => {
    const source = path.join(directory, 'scen.yaml'); const caller = path.join(directory, 'parent.yaml');
    const exported = path.join(directory, 'exports.feature'); const archive = exported + '.kot-nested.json';
    await fs.writeFile(source, 'source'); await fs.writeFile(caller, 'old call');
    await applyCallableFileConversion([{ path: source, before: 'source' }, { path: caller, before: 'old call', after: 'new call' },
        { path: exported, after: 'export' }, { path: archive, after: 'archive' }], async () => undefined);
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    assert.equal(await fs.readFile(caller, 'utf8'), 'new call');
    assert.equal(await fs.readFile(archive, 'utf8'), 'archive');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['exports.feature', 'exports.feature.kot-nested.json', 'parent.yaml']);
}));
test('collision and changed source leave every original intact', () => fixture(async directory => {
    const source = path.join(directory, 'scen.yaml'); const output = path.join(directory, 'export.feature');
    await fs.writeFile(source, 'original'); await fs.writeFile(output, 'existing');
    await assert.rejects(applyCallableFileConversion([{ path: source, before: 'original' }, { path: output, after: 'new' }], async () => undefined), /exists/u);
    await assert.rejects(applyCallableFileConversion([{ path: source, before: 'stale', after: 'new' }], async () => undefined), /changed/u);
    assert.equal(await fs.readFile(source, 'utf8'), 'original'); assert.equal(await fs.readFile(output, 'utf8'), 'existing');
}));
test('mid-transaction failure rolls back removed source, changed caller and newly created export', () => fixture(async directory => {
    const source = path.join(directory, 'scen.yaml'); const caller = path.join(directory, 'caller.yaml'); const output = path.join(directory, 'export.feature');
    await fs.writeFile(source, 'original'); await fs.writeFile(caller, 'old'); let checks = 0;
    await assert.rejects(applyCallableFileConversion([{ path: source, before: 'original' }, { path: output, after: 'export' }, { path: caller, before: 'old', after: 'new' }], async () => {
        if (++checks === 4) { throw new Error('buffer changed'); }
    }), /buffer changed/u);
    assert.equal(await fs.readFile(source, 'utf8'), 'original'); assert.equal(await fs.readFile(caller, 'utf8'), 'old');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['caller.yaml', 'scen.yaml']);
}));

test('creating a nested scenario directory is rolled back with a failed conversion', () => fixture(async directory => {
    const output = path.join(directory, 'nested', 'child', 'scen.yaml'); let checks = 0;
    await assert.rejects(applyCallableFileConversion([{ path: output, after: 'new' }], async () => {
        if (++checks === 3) { throw new Error('changed'); }
    }), /changed/u);
    assert.deepEqual(await fs.readdir(directory), []);
}));

test('conversion works on a filesystem without hard-link support', t => fixture(async directory => {
    t.mock.method(nativeFs, 'link', async () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); });
    const source = path.join(directory, 'scen.yaml'); const output = path.join(directory, 'export.feature');
    await fs.writeFile(source, 'original');
    await applyCallableFileConversion([{ path: source, before: 'original' }, { path: output, after: 'export' }], async () => undefined);
    assert.equal(await fs.readFile(output, 'utf8'), 'export');
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
}));

test('Parallels EINVAL hard links fall back to exclusive copies for conversion and rollback', t => fixture(async directory => {
    t.mock.method(nativeFs, 'link', async () => { throw Object.assign(new Error('invalid argument'), { code: 'EINVAL' }); });
    const source = path.join(directory, 'meta.yaml'); const output = path.join(directory, 'export.feature');
    await fs.writeFile(source, 'original'); let checks = 0;
    await assert.rejects(applyCallableFileConversion([{ path: source, before: 'original' }, { path: output, after: 'export' }], async () => {
        if (++checks === 4) { throw new Error('buffer changed'); }
    }), /buffer changed/u);
    assert.equal(await fs.readFile(source, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(directory), ['meta.yaml']);
    await applyCallableFileConversion([{ path: source, before: 'original' }, { path: output, after: 'export' }], async () => undefined);
    assert.equal(await fs.readFile(output, 'utf8'), 'export');
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
}));

test('a concurrent disk writer is preserved and triggers recovery instead of a false success', () => fixture(async directory => {
    const source = path.join(directory, 'scen.yaml'); const output = path.join(directory, 'export.feature');
    await fs.writeFile(source, 'original'); let checks = 0;
    await assert.rejects(applyCallableFileConversion([{ path: source, before: 'original' }, { path: output, after: 'export' }], async () => {
        if (++checks === 4) { await fs.writeFile(output, 'external edit'); }
    }), /Recovery copies|changed/u);
    assert.equal(await fs.readFile(source, 'utf8'), 'original');
    assert.equal(await fs.readFile(output, 'utf8'), 'external edit');
}));
