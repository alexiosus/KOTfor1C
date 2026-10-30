import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { TestNumberingStore as StoreClass } from '../src/testNumberingStore';

async function fixture(t: test.TestContext, options?: { beforeWrite?: () => Promise<void> | void }) {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-numbering-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, store: new StoreClass(root, options) };
}

test('reading an unconfigured project does not create a catalog', async t => {
    const { root, store } = await fixture(t);
    assert.deepEqual(await store.read(), { version: 1, series: [] });
    assert.deepEqual(await fs.readdir(path.join(root, '.kot')), ['project.yml']);
});

test('a series continues the highest existing number and preserves nine characters', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', ['000012001', '000012087', '000013999', 'old-name']);
    assert.equal(await store.suggest('000012', ['000012090']), '000012091');
    assert.equal((await store.read()).series[0].lastNumber, 87);
    assert.equal(await store.claim('000012091', async () => ['000012090']), 'Tester A');
    assert.equal(await store.suggest('000012', []), '000012092');
    assert.equal((await store.read()).series[0].lastNumber, 91);
});

test('a fresh series begins at 001 and different authors have independent sequences', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', []);
    await store.addSeries('000013', 'Tester B', []);
    assert.equal(await store.suggest('000012', []), '000012001');
    await store.claim('000012001', async () => []);
    assert.equal(await store.suggest('000013', []), '000013001');
});

test('deleting a test or filling an old gap cannot reuse an issued number', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', ['000012010']);
    await store.claim('000012011', async () => ['000012010']);
    for (const code of ['000012011', '000012005']) {
        await assert.rejects(store.claim(code, async () => []), /issued|used|number/iu);
    }
    assert.equal(await store.suggest('000012', []), '000012012');
});

test('competing claims from separate store instances issue a code only once', async t => {
    const { root, store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', []);
    const outcomes = await Promise.allSettled([
        store.claim('000012001', async () => []),
        new StoreClass!(root).claim('000012001', async () => [])
    ]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal((await store.read()).series[0].lastNumber, 1);
});

test('manual creation is serialized through the file write, including different destination folders', async t => {
    const { root, store } = await fixture(t);
    const file = path.join(root, 'created-code.txt');
    const discover = async () => { try { return [await fs.readFile(file, 'utf8')]; } catch { return []; } };
    const create = () => fs.writeFile(file, 'manual-code');
    const results = await Promise.allSettled([
        store.claim('manual-code', discover, undefined, create),
        new StoreClass!(root).claim('manual-code', discover, undefined, create)
    ]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(await fs.readFile(file, 'utf8'), 'manual-code');
});

test('fresh code discovery rejects an occupied code without advancing the counter', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', []);
    assert.equal(await store.suggest('000012', []), '000012001');
    await assert.rejects(store.claim('000012001', async () => ['000012001']), /already|exists|used/iu);
    assert.equal((await store.read()).series[0].lastNumber, 0);
});

test('series exhaustion does not issue a number belonging to the next tester', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', ['000012999']);
    await assert.rejects(store.suggest('000012', []), /exhaust/iu);
    assert.equal((await store.read()).series[0].lastNumber, 999);
});

test('manual codes remain supported and advance a matching configured series', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', []);
    assert.equal(await store.claim('named-main', async () => []), undefined);
    assert.equal(await store.claim('000012050', async () => []), 'Tester A');
    assert.equal(await store.suggest('000012', []), '000012051');
    await assert.rejects(store.claim('named-main', async () => ['named-main']), /already|exists|used/iu);
});

test('catalog comments survive reservations and duplicate or invalid series cannot be added', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', []);
    await fs.writeFile(store.filePath, '# Shared authors\n' + await fs.readFile(store.filePath, 'utf8'));
    await store.claim('000012001', async () => []);
    assert.match(await fs.readFile(store.filePath, 'utf8'), /# Shared authors/u);
    await assert.rejects(store.addSeries('000012', 'Another tester', []), /already|duplicate/iu);
    for (const prefix of ['12', '0000123', 'abc123']) { await assert.rejects(store.addSeries(prefix, 'Tester B', []), /prefix|six|digits/iu); }
    await assert.rejects(store.addSeries('000013', ' ', []), /author|name/iu);
});

test('invalid, duplicate, aliased and future catalog schemas are rejected without replacement', async t => {
    const { store } = await fixture(t); await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    for (const source of [
        'version: 2\nseries: []\n', 'version: 1\nseries: []\nseries: []\n',
        'version: 1\nseries: [{prefix: 000012, author: A, lastNumber: 1}]\n',
        'version: 1\nseries: [{prefix: "000012", author: A, lastNumber: 1000}]\n',
        'version: 1\nseries: [{prefix: "000012", author: A, lastNumber: 0}, {prefix: "000012", author: B, lastNumber: 0}]\n',
        'version: 1\nseries: [&entry {prefix: "000012", author: A, lastNumber: 0}, *entry]\n'
    ]) {
        await fs.writeFile(store.filePath, source);
        await assert.rejects(store.claim('000012001', async () => []), /catalog|schema|version|prefix|duplicate|ambiguous|number/iu);
        assert.equal(await fs.readFile(store.filePath, 'utf8'), source);
    }
});

test('dirty or externally edited catalogs block reservation and preserve edits', async t => {
    const { root, store } = await fixture(t);
    await store.addSeries('000012', 'Tester A', []);
    const original = await fs.readFile(store.filePath, 'utf8');
    await assert.rejects(new StoreClass!(root, { beforeWrite: () => { throw new Error('Save catalog'); } }).claim('000012001', async () => []), /Save catalog/u);
    assert.equal(await fs.readFile(store.filePath, 'utf8'), original);
    let changed = false;
    await assert.rejects(new StoreClass!(root, { beforeWrite: async () => {
        if (!changed) { changed = true; await fs.writeFile(store.filePath, original + '# external edit\n'); }
    } }).claim('000012001', async () => []), /conflict|changed/iu);
    assert.match(await fs.readFile(store.filePath, 'utf8'), /# external edit/u);
    assert.equal(parseDocument(await fs.readFile(store.filePath, 'utf8')).toJS().series[0].lastNumber, 0);
});

test('symlinked catalogs and busy locks do not write outside the project', async t => {
    const { root, store } = await fixture(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-numbering-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.rm(path.join(root, '.kot'), {recursive: true});
    await fs.symlink(outside, path.join(root, '.kot'));
    await assert.rejects(store.addSeries('000012', 'Tester A', []), /symbolic|symlink|KOT 3/iu);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.unlink(path.join(root, '.kot')); await v3Fixture(root);
    const lock = path.join(root, '.kot', 'test-numbering.lock');
    await fs.writeFile(lock, 'another writer');
    await assert.rejects(store.addSeries('000012', 'Tester A', []), /busy|locked|progress/iu);
    assert.equal(await fs.readFile(lock, 'utf8'), 'another writer');
    assert.equal(existsSync(store.filePath), false);
});

test('settings edit series definitions while preserving counters advanced by another creator', async t => {
    const { store } = await fixture(t);
    await store.addSeries('000012', 'Author A', ['000012010']);
    const expected = [{ prefix: '000012', author: 'Author A' }];
    await store.claim('000012011', async () => []);
    await store.replaceSeries([{ prefix: '000012', author: 'Renamed A' }, { prefix: '000013', author: 'Author B' }], expected, async () => ['000013023']);
    assert.deepEqual((await store.read()).series, [
        { prefix: '000012', author: 'Renamed A', lastNumber: 11 }, { prefix: '000013', author: 'Author B', lastNumber: 23 }
    ]);
    await assert.rejects(store.replaceSeries([], [{ prefix: '000012', author: 'Renamed A' }, { prefix: '000013', author: 'Author B' }], async () => []), /issued|remove|delete/iu);
    await assert.rejects(store.replaceSeries(expected, expected, async () => []), /changed|conflict/iu);
});
