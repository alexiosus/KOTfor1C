import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { prepareMetadataResolution, applyMetadataResolution, listMetadataConflicts, metadataKind } from '../src/projectMetadataConflicts';
async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-conflict-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    const relative = '.kot/groups/smoke.yml'; const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    const write = async (name: string) => fs.writeFile(file, `version: 1\nid: smoke\nname: ${name}\nsections: [main]\n`);
    await write('Before'); git('add', '.'); git('commit', '-m', 'base'); git('checkout', '-b', 'other');
    await write('Theirs'); git('commit', '-am', 'theirs'); git('checkout', 'main'); await write('Ours'); git('commit', '-am', 'ours');
    assert.throws(() => git('merge', 'other'));
    return { root, relative, file, git };
}
test('resolves staged conflicts only after review and leaves Git index untouched', async t => {
    const f = await fixture(t); const before = f.git('ls-files', '-u');
    assert.deepEqual(await listMetadataConflicts(f.root), [f.relative]);
    const pending = await prepareMetadataResolution(f.root, f.relative); assert.equal(pending.merge.conflicts.length, 1);
    const reviewed = await prepareMetadataResolution(f.root, f.relative, { '/name': 'theirs' });
    assert.match(reviewed.merge.text!, /Theirs/u); assert.match(await fs.readFile(f.file, 'utf8'), /<<<<<<</u);
    await applyMetadataResolution(reviewed, () => false);
    assert.equal(await fs.readFile(f.file, 'utf8'), reviewed.merge.text); assert.equal(f.git('ls-files', '-u'), before);
});
test('guards dirty documents, stale disk and changed index snapshots', async t => {
    const f = await fixture(t); const review = await prepareMetadataResolution(f.root, f.relative, { '/name': 'ours' });
    await assert.rejects(applyMetadataResolution(review, () => true), /unsaved/iu);
    await fs.appendFile(f.file, '# Manual edit\n'); await assert.rejects(applyMetadataResolution(review, () => false), /changed/iu);
    await fs.writeFile(f.file, review.original!); f.git('add', f.relative);
    await assert.rejects(applyMetadataResolution(review, () => false), /index|changed/iu);
});
test('rejects traversals, unsupported files, symlinks and already manually resolved content', async t => {
    const f = await fixture(t);
    for (const name of ['../groups.yml', '/tmp/groups.yml', '.kot/parameter-profiles.json', '.git/config', '.kot/groups.yml']) { assert.equal(metadataKind(name), undefined); }
    await fs.writeFile(f.file, 'version: 1\nid: smoke\nname: Manual\nsections: [main]\n');
    await assert.rejects(prepareMetadataResolution(f.root, f.relative), /manual/iu);
    await fs.unlink(f.file); await fs.symlink(path.join(f.root, 'outside'), f.file);
    await assert.rejects(prepareMetadataResolution(f.root, f.relative), /symbolic|symlink/iu);
});

test('a cancelled proposal never writes and modified conflict stages invalidate it', async t => {
    const f = await fixture(t); const initial = await fs.readFile(f.file, 'utf8');
    await prepareMetadataResolution(f.root, f.relative, { '/name': 'theirs' });
    assert.equal(await fs.readFile(f.file, 'utf8'), initial);
    const review = await prepareMetadataResolution(f.root, f.relative, { '/name': 'theirs' });
    f.git('update-index', '--force-remove', '--', f.relative);
    await assert.rejects(applyMetadataResolution(review, () => false), /changed/iu);
});

test('saved partial/manual edits inside an unresolved conflict are preserved by refusal', async t => {
    const f = await fixture(t);
    const original = await fs.readFile(f.file, 'utf8');
    const manual = original.replace('sections: [main]', 'sections: [main, process]');
    await fs.writeFile(f.file, manual);
    await assert.rejects(prepareMetadataResolution(f.root, f.relative, { '/name': 'ours' }), /manual/iu);
    assert.equal(await fs.readFile(f.file, 'utf8'), manual);
});
