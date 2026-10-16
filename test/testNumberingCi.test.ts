import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-numbering-ci-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const definitions = path.join(root, 'yaml'); await fs.mkdir(definitions);
    const write = (file: string, source: string) => fs.writeFile(path.join(definitions, file), source);
    const run = () => spawnSync(process.execPath, [path.join(process.cwd(), 'tools/checkTestNumbering.cjs'), '--project-root', root, definitions], { encoding: 'utf8' });
    return { root, definitions, write, run };
}

test('CI accepts distinct manual and author-series codes and ignores linked settings', async t => {
    const h = await fixture(t);
    await h.write('one.yaml', 'ДанныеСценария:\n    Код: "000012001"\n');
    await h.write('two.yaml', 'ДанныеПроцесса:\n    Код: "legacy-code"\n    ПолныйКод: "legacy-code"\n');
    await h.write('test.yaml', 'ДанныеТеста:\n    Код: "000012001"\n');
    const result = h.run(); assert.equal(result.status, 0, result.stderr);
});

test('CI catches cross-kind code collisions introduced by branch merging', async t => {
    const h = await fixture(t);
    await h.write('one.yaml', 'ДанныеСценария:\n    Код: "000012001"\n');
    await h.write('two.yaml', 'ДанныеПроцесса:\n    Код: "000012001"\n    ПолныйКод: "Sales.001"\n');
    const result = h.run(); assert.equal(result.status, 1);
    assert.match(result.stderr, /000012001/u); assert.match(result.stderr, /one.yaml/u); assert.match(result.stderr, /two.yaml/u);
});

test('CI rejects ambiguous catalogs and duplicate author prefixes without altering files', async t => {
    const h = await fixture(t); await fs.mkdir(path.join(h.root, '.kot'));
    const file = path.join(h.root, '.kot/test-numbering.yml');
    const source = 'version: 1\nseries:\n  - {prefix: "000012", author: A, lastNumber: 1}\n  - {prefix: "000012", author: B, lastNumber: 2}\n';
    await fs.writeFile(file, source);
    const result = h.run(); assert.equal(result.status, 1); assert.match(result.stderr, /prefix|duplicate/iu);
    assert.equal(await fs.readFile(file, 'utf8'), source);
});

test('CI reports malformed YAML and does not follow symbolic links', async t => {
    const h = await fixture(t);
    await h.write('broken.yaml', 'ДанныеСценария: [\n');
    assert.equal(h.run().status, 1);
    await fs.rm(path.join(h.definitions, 'broken.yaml'));
    await h.write('one.yaml', 'ДанныеСценария:\n    Код: "000012001"\n');
    await fs.symlink(path.join(h.definitions, 'one.yaml'), path.join(h.definitions, 'alias.yaml'));
    assert.equal(h.run().status, 0);
});

test('CI preserves unquoted leading zeroes when comparing compiler identities', async t => {
    const h = await fixture(t);
    await h.write('one.yaml', 'ДанныеСценария:\n    Код: 000012001\n');
    await h.write('two.yaml', 'ДанныеПроцесса:\n    Код: "000012001"\n');
    const result = h.run(); assert.equal(result.status, 1);
    assert.match(result.stderr, /000012001/u);
    await h.write('two.yaml', 'ДанныеПроцесса:\n    Код: "12001"\n');
    assert.equal(h.run().status, 0);
});
