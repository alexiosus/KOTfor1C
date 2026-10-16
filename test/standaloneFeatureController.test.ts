import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function loadController() {
    const sourcePath = path.join(process.cwd(), 'src', 'standaloneFeatureController.ts');
    const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const messages: unknown[] = [];
    const opened: string[] = [];
    const moves: unknown[] = [];
    const generated: string[] = [];
    const runIds: string[] = [];
    const renamedTitles: string[] = [];
    const renamedFiles: string[] = [];
    const runStepIds: string[] = [];
    const listeners = new Set<(value: unknown) => void>();
    let quickPick: unknown;
    let input: string | undefined;
    let jsonSelection: unknown;
    const snapshot = {
        features: [
            { id: 'file:///tests/a/same.feature', uri: 'file:///tests/a/same.feature', name: 'same', title: 'First', relativePath: 'a/same.feature', groupId: '', order: 0, language: 'en', jsonPath: '/tests/a/same.json' },
            { id: 'file:///tests/b/same.feature', uri: 'file:///tests/b/same.feature', name: 'same', title: 'Second', relativePath: 'b/same.feature', groupId: 'g1', order: 0, language: 'en' }
        ], groups: [{ id: 'g1', name: 'Smoke' }], revision: 1
    };
    const catalog = {
        getSnapshot: () => snapshot,
        ensureReady: async () => snapshot,
        refresh: async () => snapshot,
        find: (id: string) => snapshot.features.find(feature => feature.id === id),
        onDidChange: (listener: (value: unknown) => void) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        moveFeature: async (...args: unknown[]) => { moves.push(args); },
        createGroup: async (name: string) => { snapshot.groups.push({ id: 'g2', name }); return { id: 'g2', name }; },
        renameGroup: async (id: string, name: string) => { const group = snapshot.groups.find(value => value.id === id); if (group) { group.name = name; } },
        deleteGroup: async (id: string) => { snapshot.groups = snapshot.groups.filter(group => group.id !== id); },
        setLaunchJson: async (id: string, jsonPath: string) => { const feature = snapshot.features.find(value => value.id === id); if (feature) { Object.assign(feature, { jsonPath }); } }
    };
    const uri = (value: string) => ({ toString: () => value, fsPath: value.replace(/^file:\/\//u, '') });
    const vscode = {
        Uri: { parse: uri, file: (value: string) => uri(`file://${value}`) },
        l10n: { t: (message: string) => message },
        workspace: { openTextDocument: async (resource: { toString(): string }) => { opened.push(resource.toString()); return resource; } },
        window: {
            showTextDocument: async () => undefined,
            showInputBox: async () => input,
            showQuickPick: async () => quickPick,
            showOpenDialog: async () => jsonSelection,
            showWarningMessage: async () => 'Delete group',
            showErrorMessage: async () => undefined
        }
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject, exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return vscode; }
            if (specifier === './featureCreator') {
                return {
                    createFeature: async () => uri('file:///tests/new.feature'),
                    generateFeatureJson: async (_context: unknown, resource: { toString(): string }) => { generated.push(resource.toString()); return uri('file:///tests/generated.json'); }
                };
            }
            if (specifier === './featureRenameCommands') {
                return {
                    renameStandaloneFeatureTitle: async (resource: { toString(): string }) => { renamedTitles.push(resource.toString()); return true; },
                    renameStandaloneFeatureFile: async (resource: { toString(): string }) => { renamedFiles.push(resource.toString()); return uri('file:///tests/new.feature'); }
                };
            }
            return require(specifier);
        }
    });
    const api = moduleObject.exports as {
        parseStandaloneFeatureMessage?: (value: unknown) => unknown;
        StandaloneFeatureController?: new (...args: unknown[]) => {
            postSnapshot(): Promise<void>; handleMessage(value: unknown): Promise<boolean>;
            setVisible(value: boolean): void; dispose(): void;
        };
    };
    return {
        api, messages, moves, opened, generated, snapshot, listeners, runIds, runStepIds, renamedTitles, renamedFiles,
        create: () => new api.StandaloneFeatureController!({}, catalog, { postMessage: async (value: unknown) => { messages.push(value); return true; } }, {
            run: async (id: string) => { runIds.push(id); },
            openRunStep: async (id: string) => { runStepIds.push(id); }
        }),
        setQuickPick: (value: unknown) => { quickPick = value; },
        setInput: (value: string) => { input = value; },
        setJsonSelection: (value: unknown) => { jsonSelection = value; }, uri
    };
}

test('standalone action protocol rejects unknown actions and malformed move destinations', () => {
    const h = loadController();
    assert.equal(typeof h.api.parseStandaloneFeatureMessage, 'function');
    const parse = h.api.parseStandaloneFeatureMessage!;
    assert.equal(parse({ command: 'standaloneFeatureAction', action: 'removeEverything' }), null);
    assert.equal(parse({ command: 'standaloneFeatureAction', action: 'openFeature', featureId: '' }), null);
    assert.equal(parse({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a.feature', groupId: 4 }), null);
    assert.equal(JSON.stringify(parse({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a.feature', groupId: '', beforeId: 'file:///b.feature' })), JSON.stringify({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///a.feature', groupId: '', beforeId: 'file:///b.feature' }));
});

test('standalone rename actions use the selected catalog feature and ignore stale or missing identities', async () => {
    const h = loadController();
    const controller = h.create();
    for (const action of ['renameFeature', 'renameFeatureFile']) {
        assert.equal(h.api.parseStandaloneFeatureMessage!({ command: 'standaloneFeatureAction', action }), null);
        await controller.handleMessage({ command: 'standaloneFeatureAction', action, featureId: 'file:///tests/b/same.feature' });
        await controller.handleMessage({ command: 'standaloneFeatureAction', action, featureId: 'file:///tests/missing.feature' });
    }
    assert.deepEqual(h.renamedTitles, ['file:///tests/b/same.feature']);
    assert.deepEqual(h.renamedFiles, ['file:///tests/b/same.feature']);
    controller.dispose();
});

test('controller routes run-step navigation only for a discovered feature URI', async () => {
    const h = loadController();
    const controller = h.create();
    assert.equal(await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'openRunStep', featureId: 'file:///tests/b/same.feature' }), true);
    assert.deepEqual(h.runStepIds, ['file:///tests/b/same.feature']);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'openRunStep', featureId: 'file:///tests/missing.feature' });
    assert.deepEqual(h.runStepIds, ['file:///tests/b/same.feature']);
    assert.equal(h.api.parseStandaloneFeatureMessage!({ command: 'standaloneFeatureAction', action: 'openRunStep' }), null);
    controller.dispose();
});

test('controller routes duplicate filenames by URI and validates the requested destination', async () => {
    const h = loadController();
    assert.equal(typeof h.api.StandaloneFeatureController, 'function');
    const controller = h.create();
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'openFeature', featureId: 'file:///tests/b/same.feature' });
    assert.deepEqual(h.opened, ['file:///tests/b/same.feature']);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///tests/a/same.feature', groupId: 'missing' });
    assert.equal(h.moves.length, 0);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///tests/a/same.feature', groupId: 'g1', beforeId: 'file:///tests/b/same.feature' });
    assert.deepEqual(h.moves, [['file:///tests/a/same.feature', 'g1', 'file:///tests/b/same.feature']]);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'run', featureId: 'file:///tests/b/same.feature' });
    assert.deepEqual(h.runIds, ['file:///tests/b/same.feature']);
    controller.dispose();
});

test('controller supports the move picker and feature JSON actions', async () => {
    const h = loadController();
    assert.equal(typeof h.api.StandaloneFeatureController, 'function');
    const controller = h.create();
    h.setQuickPick({ label: 'Smoke', groupId: 'g1' });
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'moveFeature', featureId: 'file:///tests/a/same.feature' });
    assert.deepEqual(h.moves, [['file:///tests/a/same.feature', 'g1', undefined]]);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'generateJson', featureId: 'file:///tests/b/same.feature' });
    assert.deepEqual(h.generated, ['file:///tests/b/same.feature']);
    assert.equal(h.snapshot.features[1].jsonPath, '/tests/generated.json');
    h.setJsonSelection([h.uri('file:///tests/custom.json')]);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'selectJson', featureId: 'file:///tests/a/same.feature' });
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'openJson', featureId: 'file:///tests/a/same.feature' });
    assert.deepEqual(h.opened, ['file:///tests/custom.json']);
    controller.dispose();
});

test('controller preserves hidden catalog changes and removes its listener on disposal', async () => {
    const h = loadController();
    assert.equal(typeof h.api.StandaloneFeatureController, 'function');
    const controller = h.create();
    await controller.postSnapshot();
    assert.equal((h.messages[0] as { command: string }).command, 'standaloneFeatures');
    controller.setVisible(false);
    const count = h.messages.length;
    h.snapshot.revision = 2;
    for (const listener of h.listeners) { listener(h.snapshot); }
    assert.equal(h.messages.length, count);
    controller.setVisible(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((h.messages.at(-1) as { snapshot: { revision: number } }).snapshot.revision, 2);
    controller.dispose();
    assert.equal(h.listeners.size, 0);
});

test('controller creates renames and deletes only known groups', async () => {
    const h = loadController();
    assert.equal(typeof h.api.StandaloneFeatureController, 'function');
    const controller = h.create();
    h.setInput('Acceptance');
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'createGroup' });
    assert.deepEqual(h.snapshot.groups, [{ id: 'g1', name: 'Smoke' }, { id: 'g2', name: 'Acceptance' }]);
    h.setInput('Release');
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'renameGroup', groupId: 'g2' });
    assert.equal(h.snapshot.groups[1].name, 'Release');
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'deleteGroup', groupId: 'missing' });
    assert.equal(h.snapshot.groups.length, 2);
    await controller.handleMessage({ command: 'standaloneFeatureAction', action: 'deleteGroup', groupId: 'g2' });
    assert.deepEqual(h.snapshot.groups, [{ id: 'g1', name: 'Smoke' }]);
    controller.dispose();
});
