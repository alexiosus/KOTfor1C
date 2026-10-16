import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as metadata from '../src/projectLibraryMetadata';
import * as ordering from '../src/projectGroupDisplayOrder';
import * as storeModule from '../src/projectLibraryStore';
import * as runtimeIdentity from '../src/scenarioRuntimeIdentity';
import * as catalogModule from '../src/scenarioCatalog';

async function fixture(t: test.TestContext) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kot-order-provider-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const store = new storeModule.ProjectLibraryStore(root);
    const group = await store.ensureGroup('Smoke', 'main', 'smoke');
    const other = await store.ensureGroup('Other', 'main', 'other');
    const infos: any[] = [];
    for (const [index, name] of ['a', 'b', 'process'].entries()) {
        const kind = name === 'process' ? 'process' : 'scenario';
        const file = path.join(root, `${name}.yaml`);
        const source = `${kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n  UID: ${name}\n  Шаги:\n    - Second\n    - First\n`;
        await fsp.writeFile(file, source);
        const uri = { scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href };
        await store.setMetadata({ kind, relativePath: `${name}.yaml`, uid: name }, { groupId: kind === 'process' ? '' : group.id, order: index });
        infos.push({ name, uid: name, kind, yamlFileUri: uri, tabName: kind === 'process' ? 'Ungrouped' : group.name, relativePath: file, order: index });
    }
    const values = new Map<string, unknown>();
    let dirty = false;
    const warnings: string[] = [];
    const groupChoices: any[] = [];
    const refreshOptions: unknown[] = [];
    let publications = 0;
    const guard = () => { if (dirty) { throw new Error('Save metadata first'); } };
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const module = { exports: {} as Record<string, any> };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/phaseSwitcher.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, {
        module, exports: module.exports, console, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return { EventEmitter: class {},
                workspace: { openTextDocument: async (uri: any) => ({ uri, version: 1 }) },
                window: { showWarningMessage: (message: string) => warnings.push(message),
                    showQuickPick: async (items: any[]) => { groupChoices.push(...items); return items.find(item => item.id === '' && !item.create); },
                    showInputBox: async () => { throw new Error('Ungrouped must not prompt for a new group.'); }
                } }; }
            if (specifier === 'path') { return path; }
            if (specifier === 'fs') { return fs; }
            if (specifier === 'os') { return os; }
            if (specifier === './projectLibraryMetadata') { return metadata; }
            if (specifier === './projectGroupDisplayOrder') { return ordering; }
            if (specifier === './projectLibraryStore') { return storeModule; }
            if (specifier === './scenarioRuntimeIdentity') { return runtimeIdentity; }
            if (specifier === './scenarioCatalog') { return catalogModule; }
            if (specifier === './projectLibraryIntegration') { return {
                projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }), assertProjectMetadataSaved: guard, assertProjectOrderingSourcesSaved: guard,
                projectedProjectScenario: (document: any) => current.byUri.get(document.uri.toString()),
                persistProjectMetadata: async (document: any, patch: any) => {
                    const info = current.byUri.get(document.uri.toString())!;
                    await store.setMetadata(metadata.resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid), patch);
                    metadata.cacheProjectLibrarySnapshot(root, await store.read());
                    return true;
                }
            }; }
            if (specifier === './deferredLoader') { return { createDeferredLoader: (factory: unknown) => factory }; }
            return {};
        }
    });
    const provider = Object.create(module.exports.PhaseSwitcherProvider.prototype) as Record<string, any>;
    provider._context = { workspaceState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } };
    provider._projectLibraryGroups = [];
    provider.t = (message: string) => message;
    let current = catalogModule.buildScenarioCatalog(infos);
    provider.ensureFreshScenarioCatalog = async () => current;
    provider.getScenarioCatalog = () => current;
    provider.publishScenarioCatalog = (catalog: typeof current) => { current = catalog; publications++; };
    provider.refreshFromExternalStateChange = async (options: unknown) => { refreshOptions.push(options); };
    return { root, store, group, other, infos, provider, values, warnings, refreshOptions, groupChoices, publications: () => publications, setDirty: () => { dirty = true; } };
}

test('existing tests can be moved to empty Ungrouped from the group picker and by drag', async t => {
    const f = await fixture(t);
    await f.provider.getProjectScenarioGroups();
    const data = f.provider._groupAndSortTestData(f.infos.filter(info => info.kind !== 'process'));
    const ungrouped = f.provider._projectLibraryGroups.find((group: any) => group.id === '');
    assert.ok(ungrouped.sections.includes('main'));
    assert.equal(data[ungrouped.key].length, 0);
    await f.provider.changeScenarioGroup(f.infos[0].yamlFileUri);
    assert.equal((await f.store.read()).metadata['uid:a'].groupId, '');
    assert.ok(f.groupChoices.some(choice => choice.label === 'Ungrouped' && !choice.create));
    assert.equal(f.refreshOptions[0].refreshCache, false);
    await f.provider.reorderProjectLibrary({ type: 'item', section: 'main', projectRoot: f.root, groupId: '', uri: f.infos[1].yamlFileUri.toString(),
        expectedSource: [{ key: 'uid:b', order: 1 }], expectedDestination: [{ key: 'uid:a', order: 0 }] });
    assert.equal((await f.store.read()).metadata['uid:b'].groupId, '');
    assert.deepEqual(f.warnings, []);
});

test('provider routes local group preference and shared item metadata through separate persistence scopes', async t => {
    const f = await fixture(t);
    const groupsFile = path.join(f.root, '.kot', 'groups.yml');
    const before = await fsp.readFile(groupsFile, 'utf8');
    await f.provider.reorderProjectLibrary({ type: 'group', section: 'main', projectRoot: f.root, groupId: 'smoke', beforeId: 'other', expectedIds: ['other', 'smoke'] });
    assert.equal(f.publications(), 1, 'both Library snapshots are notified about personal group order');
    const groups = await f.provider.getProjectScenarioGroups();
    assert.equal(groups.find((group: any) => group.id === 'smoke').displayOrders.main, 0);
    assert.equal(await fsp.readFile(groupsFile, 'utf8'), before);
    const data = f.provider._groupAndSortTestData(f.infos);
    assert.equal(Object.values<any[]>(data).flat().find(info => info.name === 'a').entityKey, 'uid:a');
    assert.ok(Object.keys(data).every(key => key.includes(f.root)), 'groups use their project owner and stable identity');
    const processSource = await fsp.readFile(path.join(f.root, 'process.yaml'), 'utf8');
    await f.provider.reorderProjectLibrary({ type: 'item', section: 'main', projectRoot: f.root, groupId: 'smoke', uri: f.infos[1].yamlFileUri.toString(), beforeId: 'uid:a',
        expectedSource: [{ key: 'uid:a', order: 0 }, { key: 'uid:b', order: 1 }], expectedDestination: [{ key: 'uid:a', order: 0 }, { key: 'uid:b', order: 1 }] });
    const shared = await f.store.read();
    assert.equal(shared.metadata['uid:b'].order, 0);
    assert.equal(shared.metadata['uid:a'].order, 1);
    assert.equal(await fsp.readFile(path.join(f.root, 'process.yaml'), 'utf8'), processSource);
    assert.equal(f.provider.getScenarioCatalog().byUri.get(f.infos[1].yamlFileUri.toString()).order, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(f.refreshOptions)), [{ refreshCache: false }, { refreshCache: false }]);
    assert.equal(f.warnings.length, 0);
});

test('provider refuses foreign project, stale, malformed and cross-section drag requests without shared writes', async t => {
    const f = await fixture(t);
    const before = await f.store.read();
    const base = { type: 'item', section: 'main', projectRoot: f.root, groupId: 'smoke', uri: f.infos[1].yamlFileUri.toString(), beforeId: 'uid:a',
        expectedSource: [{ key: 'uid:a', order: 0 }, { key: 'uid:b', order: 1 }], expectedDestination: [{ key: 'uid:a', order: 0 }, { key: 'uid:b', order: 1 }] };
    for (const patch of [{ projectRoot: '/foreign' }, { uri: 'file:///foreign/a.yaml' }, { uri: f.infos[2].yamlFileUri.toString() }, { beforeId: '../foreign' },
        { expectedSource: [] }, { expectedDestination: 'malicious' }, { groupId: 'foreign' }, { section: 'standalone' }]) {
        await f.provider.reorderProjectLibrary({ ...base, ...patch });
        assert.deepEqual(await f.store.read(), before);
    }
    assert.equal(f.values.size, 0);
    f.setDirty();
    await f.provider.reorderProjectLibrary(base);
    assert.deepEqual(await f.store.read(), before);
});
