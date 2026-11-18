import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(cancel = false) {
    class Uri {
        readonly fsPath: string;
        constructor(value: string) { this.fsPath = path.resolve(value); }
        static file(value: string) { return new Uri(value); }
        static isUri(value: unknown) { return value instanceof Uri; }
        static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.fsPath, ...parts)); }
    }
    const folders = [{ uri: Uri.file('first-project') }, { uri: Uri.file('second-project') }];
    const updates: Array<{ folder: Uri; key: string; value: unknown }> = [];
    const writes: string[] = []; const refreshes: Uri[] = []; const errors: string[] = [];
    let builds = 0;
    let command!: (resource?: unknown) => Promise<string | undefined>;
    const host = {
        Uri, ConfigurationTarget: { WorkspaceFolder: 3 }, ProgressLocation: { Notification: 15 },
        l10n: { t: (message: string) => message },
        commands: { registerCommand: (_name: string, callback: typeof command) => { command = callback; return { dispose() {} }; } },
        workspace: {
            isTrusted: true,
            workspaceFolders: folders,
            getWorkspaceFolder: (resource: Uri) => folders.find(folder => resource.fsPath.startsWith(folder.uri.fsPath)),
            getConfiguration: (_name: string, resource: Uri) => ({
                get: (key: string, fallback: unknown) => key === 'steps.vanessaVersion' ? '1.2.043.47' : key === 'steps.catalogMode' ? 'offline' : fallback,
                update: async (key: string, value: unknown) => { updates.push({ folder: resource, key, value }); }
            }),
            fs: { readFile: async () => new TextEncoder().encode('{"source":{"generatorVersion":2}}'), stat: async (uri: Uri) => { if (uri.fsPath.endsWith('.json') && !writes.includes(uri.fsPath)) { throw new Error('Missing'); } return {}; }, createDirectory: async () => {},
                writeFile: async (uri: Uri) => { writes.push(uri.fsPath); } }
        },
        window: {
            activeTextEditor: { document: { uri: Uri.joinPath(folders[0].uri, 'test.feature') } },
            showOpenDialog: async () => cancel ? undefined : [Uri.file('local-vanessa')],
            showInputBox: async () => '1.2.043.47',
            showSaveDialog: async (options: { defaultUri: Uri }) => options.defaultUri,
            withProgress: async (_options: unknown, work: (progress: unknown, token: unknown) => Promise<unknown>) =>
                work({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
            showInformationMessage() {}, showErrorMessage: (message: string) => errors.push(message)
        }
    };
    const dependencies: Record<string, unknown> = {
        vscode: host, 'node:path': path,
        './localStepCatalog': { findLocalStepCategoryEpfs: async () => [], localStepCatalogNeedsUpgrade: () => false,
            generateLocalStepCatalog: async () => { builds++; return { vanessaVersion: '1.2.043.47', steps: [] }; } },
        './localStepCatalogDump': {}, './directProcessLaunch': {},
        './vanessaVersion': { normalizeVanessaVersion: (value: string) => value }
    };
    const module = { exports: {} as { registerLocalStepCatalogCommands(context: unknown, catalogs: unknown): void; generateConfiguredLocalStepCatalog(resource: Uri): Promise<string> } };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/localStepCatalogCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name], TextDecoder, TextEncoder, AbortController });
    module.exports.registerLocalStepCatalogCommands({ subscriptions: [] }, { refresh: async (resource: Uri) => { refreshes.push(resource); } });
    return { run: (resource?: unknown) => command(resource), automatic: () => module.exports.generateConfiguredLocalStepCatalog(folders[1].uri), folders, updates, writes, refreshes, errors, builds: () => builds };
}

test('generation launched from setup targets its selected folder despite an editor in another project', async () => {
    const h = fixture(); const target = h.folders[1].uri;
    const destination = await h.run(target);
    assert.equal(destination, path.join(target.fsPath, '.kot', 'step-catalogs', '1.2.043.47.json'));
    assert.deepEqual(h.writes, [destination]);
    assert.equal(h.updates[0].folder, target); assert.equal(h.updates[0].key, 'steps.localCatalogPath');
    assert.equal(h.updates[0].value, destination); assert.deepEqual(h.refreshes, [target]); assert.deepEqual(h.errors, []);
});

test('automatic offline generation requires no pickers, writes the default project catalog and reuses it', async () => {
    const h = fixture(true);
    const first = await h.automatic(); const second = await h.automatic();
    assert.equal(first, path.join(h.folders[1].uri.fsPath, '.kot', 'step-catalogs', '1.2.043.47.json'));
    assert.equal(second, first); assert.equal(h.builds(), 1); assert.deepEqual(h.writes, [first]); assert.deepEqual(h.updates, []);
});

test('palette generation retains the active-editor fallback and cancellation enables nothing', async () => {
    const h = fixture(); await h.run(); assert.equal(h.updates[0].folder.fsPath, h.folders[0].uri.fsPath);
    const cancelled = fixture(true); assert.equal(await cancelled.run(cancelled.folders[1].uri), undefined);
    assert.deepEqual(cancelled.writes, []); assert.deepEqual(cancelled.updates, []); assert.deepEqual(cancelled.errors, []);
});
