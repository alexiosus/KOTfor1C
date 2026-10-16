import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadProjectScenarioMetadata, setProjectSourceCleanupGuard } from '../src/projectLibraryMetadata';
import { ProjectLibraryStore } from '../src/projectLibraryStore';

test('group-only reads do not inspect source files or adjacent metadata', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-groups-only-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.kot'));
    await fs.writeFile(path.join(root, '.kot/groups.yml'), 'version: 1\ngroups:\n  - {id: second, name: Second, sections: [main], order: 2}\n  - {id: first, name: First, sections: [process, main], order: 1}\n');
    const original = fs.readdir;
    fs.readdir = (async () => { throw new Error('Group choices must not enumerate the project'); }) as typeof fs.readdir;
    try {
        const started = performance.now();
        const groups = await new ProjectLibraryStore(root).readGroups();
        assert.deepEqual(groups.map(value => value.id), ['first', 'second']);
        t.diagnostic(`group-only read: ${Math.round(performance.now() - started)} ms, no directory enumeration`);
    } finally { fs.readdir = original; }
});

test('scanning reuses source snapshots and reordering only reads changed sources', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-library-io-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const count = Number(process.env.KOT_LIBRARY_PERFORMANCE_COUNT || 80); const snapshots = new Map<string, string>(); const infos: any[] = [];
    for (let index = 0; index < count; index++) {
        const file = path.join(root, 'tests/Yaml/Drive/Parent', `test-${index}`, 'scen.yaml'); await fs.mkdir(path.dirname(file), { recursive: true });
        const source = `ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "uid-${index}"\nKOTМетаданные:\n    Описание: "Description"\n    PhaseSwitcher:\n        Tab: "Smoke"\n        OrderOnTab: ${index}\nТекстСценария: |\n    And Step\n`;
        await fs.writeFile(file, source); snapshots.set(file, source);
        infos.push({ name: `Test ${index}`, uid: `uid-${index}`, tabName: 'Smoke', order: index, scenarioDescription: 'Description',
            yamlFileUri: { scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href } });
    }
    setProjectSourceCleanupGuard(() => true); t.after(() => setProjectSourceCleanupGuard(() => false));
    const originalRead = fs.readFile; const originalReaddir = fs.readdir; const originalLstat = fs.lstat;
    let sourceReads = 0; let sourceEnumerations = 0; let statCalls = 0;
    fs.readFile = (async (...args: any[]) => {
        if (String(args[0]).endsWith('scen.yaml')) { sourceReads++; }
        return (originalRead as any)(...args);
    }) as typeof fs.readFile;
    fs.readdir = (async (...args: any[]) => {
        if (!String(args[0]).includes(`${path.sep}.kot`)) { sourceEnumerations++; }
        return (originalReaddir as any)(...args);
    }) as typeof fs.readdir;
    fs.lstat = (async (...args: any[]) => { statCalls++; return (originalLstat as any)(...args); }) as typeof fs.lstat;
    t.after(() => { fs.readFile = originalRead; fs.readdir = originalReaddir; fs.lstat = originalLstat; });
    const started = performance.now();
    await loadProjectScenarioMetadata(infos, [root], [root], true, undefined, snapshots);
    const migrationMs = Math.round(performance.now() - started);
    assert.equal(sourceEnumerations, 0, 'the scanner already enumerated the source corpus');
    assert.ok(sourceReads <= count, `migration must only reread sources for the conflict guard, got ${sourceReads}`);
    sourceReads = 0;
    const cleanStarted = performance.now();
    await loadProjectScenarioMetadata(infos, [root], [root], true, undefined, new Map());
    const metadataMs = Math.round(performance.now() - cleanStarted);
    assert.equal(sourceReads, 0, 'a clean scan must not reopen source files for metadata cleanup');
    const identities = infos.map((info, index) => ({ kind: 'scenario' as const, uid: info.uid, relativePath: `tests/Yaml/Drive/Parent/test-${index}/scen.yaml` }));
    const store = new ProjectLibraryStore(root, { sourceIdentities: identities });
    const snapshot = await store.readMetadata(); const group = snapshot.groups[0].id;
    const expected = identities.map((identity, order) => ({ key: `uid:${identity.uid}`, order }));
    sourceReads = 0; statCalls = 0;
    const moveStarted = performance.now();
    const moved = await store.moveEntity('main', identities[count - 1], group, expected[count - 2].key, expected, expected);
    assert.equal(moved.metadata[expected[count - 1].key].order, count - 2);
    assert.ok(sourceReads <= 6, `a two-item reorder must not read all ${count} sources, got ${sourceReads}`);
    assert.ok(statCalls <= 3 * count + 150, `shared parent directories must not be checked again for every metadata file, got ${statCalls}`);
    t.diagnostic(`${count} definitions: migration ${migrationMs} ms, clean metadata reload ${metadataMs} ms, reorder ${Math.round(performance.now() - moveStarted)} ms / ${sourceReads} source reads`);
});
