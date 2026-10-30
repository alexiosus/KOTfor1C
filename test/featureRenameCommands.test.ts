import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as parser from '../src/exportScenarioParser';
import * as model from '../src/standaloneFeatureModel';
import * as rename from '../src/featureRename';
import * as matcher from '../src/projectDefinitionMatcher';
import * as definitionsApi from '../src/projectDefinition';
import * as writes from '../src/preparedFileWrites';
import type { ProjectDefinitionView } from '../src/projectDefinition';

function uri(value: string) {
    return { toString: () => value, fsPath: decodeURIComponent(new URL(value).pathname) };
}
type Uri = ReturnType<typeof uri>;
const exportUri = 'file:///tests/export.feature';
const featureUri = 'file:///tests/test.feature';
const yamlUri = 'file:///tests/scen.yaml';
const declaration = '#language: en\n@ExportScenarios\nFeature: Exports\n@exampleofuse: Then open "Main" window\nScenario: open "WindowName" window\n    Given ready\n';
const context = {
    sourceUri: exportUri, workspaceFolderUri: 'file:///tests', profileId: 'default',
    libraryRootUri: 'file:///tests', sourceLabel: 'Exports', defaultLanguage: 'en' as const
};

function harness() {
    const files = new Map([
        [exportUri, declaration],
        [featureUri, '\uFEFF#language: en\r\nFeature: Original\r\nScenario: Check\r\n    Then open "Main" window\r\n'],
        [yamlUri, 'ДанныеСценария:\n  Имя: Check\n  ТекстСценария: |\n    And open [CurrentWindow] window\n']
    ]);
    const definitions = parser.parseExportScenarios(declaration, context).definitions;
    const view = {
        all: definitions, byId: new Map(definitions.map(value => [value.id, value])),
        byNormalizedTemplate: new Map(), identity: 'rename-test'
    } as unknown as ProjectDefinitionView;
    const documents: { uri: Uri; isDirty: boolean; version: number }[] = [];
    const writeCalls: string[] = [];
    const renames: { from: Uri; to: Uri; options: unknown }[] = [];
    const inputs: { title: string; value: string }[] = [];
    const h = {
        files, documents, writeCalls, renames, inputs, view,
        answer: undefined as string | undefined,
        onInput: undefined as (() => void) | undefined,
        onReferences: undefined as (() => void) | undefined,
        failWrite: undefined as string | undefined,
        applyEditResult: true,
        locations: [featureUri, yamlUri].map(value => ({ uri: uri(value), range: { start: { line: 3 } } })),
        definitionId: definitions[0].id
    };
    const vscode = {
        l10n: { t: (text: string) => text },
        Uri: {
            parse: uri,
            joinPath: (base: Uri, ...parts: string[]) => uri(`file://${path.posix.join(base.fsPath, ...parts)}`)
        },
        WorkspaceEdit: class {
            renameFile(from: Uri, to: Uri, options: unknown) { renames.push({ from, to, options }); }
        },
        window: {
            showInputBox: async (options: { title: string; value: string }) => {
                inputs.push(options);
                h.onInput?.();
                return h.answer;
            }
        },
        workspace: {
            textDocuments: documents,
            fs: {
                readFile: async (resource: Uri) => {
                    const text = files.get(resource.toString());
                    if (text === undefined) { throw Object.assign(new Error('Missing'), { code: 'FileNotFound' }); }
                    return Buffer.from(text);
                },
                stat: async (resource: Uri) => {
                    if (!files.has(resource.toString())) { throw Object.assign(new Error('Missing'), { code: 'FileNotFound' }); }
                    return { type: 1 };
                },
                writeFile: async (resource: Uri, bytes: Uint8Array) => {
                    const key = resource.toString();
                    writeCalls.push(key);
                    if (h.failWrite === key) { h.failWrite = undefined; throw new Error('Write failed'); }
                    files.set(key, Buffer.from(bytes).toString('utf8'));
                }
            },
            applyEdit: async () => {
                if (!h.applyEditResult) { return false; }
                for (const change of renames) {
                    files.set(change.to.toString(), files.get(change.from.toString())!);
                    files.delete(change.from.toString());
                }
                return true;
            }
        }
    };
    const ts = require('typescript') as typeof import('typescript');
    const dependencies: Record<string, unknown> = {
        vscode, 'node:path': path, './exportScenarioParser': parser, './standaloneFeatureModel': model,
        './featureRename': rename, './projectDefinitionMatcher': matcher, './projectDefinition': definitionsApi, './preparedFileWrites': writes
    };
    const moduleObject = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/featureRenameCommands.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module: moduleObject, exports: moduleObject.exports, Buffer, require: (name: string) => dependencies[name] });
    const api = moduleObject.exports as {
        renameStandaloneFeatureTitle(resource: Uri): Promise<boolean>;
        renameStandaloneFeatureFile(resource: Uri, beforeRename?: () => Promise<void>): Promise<Uri | undefined>;
        renameExportScenario(id: string, resource: Uri | undefined, resolver: unknown, references: unknown): Promise<boolean>;
    };
    const resolver = {
        getView: async () => h.view,
        resolve: async (_resource: Uri, invocation: string, current: ProjectDefinitionView) => matcher.resolveProjectInvocation(current, invocation)
    };
    const references = {
        findReferences: async (_id: string, _resource: Uri, options: { failOnScanError?: boolean }) => {
            assert.equal(options.failOnScanError, true, 'rename requires a complete scan');
            h.onReferences?.(); return h.locations;
        }
    };
    return { ...h, state: h, api, renameExport: () => api.renameExportScenario(h.definitionId, undefined, resolver, references) };
}

test('feature title and filename are independent; filename rename uses a non-overwriting workspace edit', async () => {
    const h = harness();
    const original = h.files.get(featureUri)!;
    h.state.answer = 'New title';
    assert.equal(await h.api.renameStandaloneFeatureTitle(uri(featureUri)), true);
    assert.equal(h.files.get(featureUri), original.replace('Feature: Original', 'Feature: New title'));
    h.state.answer = 'New file';
    let associated = false;
    const destination = await h.api.renameStandaloneFeatureFile(uri(featureUri), async () => {
        assert.equal(h.renames.length, 0);
        associated = true;
    });
    assert.equal(associated, true);
    assert.equal(destination?.toString(), 'file:///tests/New file.feature');
    assert.equal(h.files.has(featureUri), false);
    assert.equal(h.files.get(destination!.toString()), original.replace('Feature: Original', 'Feature: New title'));
    assert.deepEqual(JSON.parse(JSON.stringify(h.renames[0].options)), { overwrite: false, ignoreIfExists: false });
});

test('cancel and unchanged input do not write or rename files', async () => {
    const h = harness();
    assert.equal(await h.api.renameStandaloneFeatureTitle(uri(featureUri)), false);
    assert.equal(await h.api.renameStandaloneFeatureFile(uri(featureUri)), undefined);
    assert.equal(await h.renameExport(), false);
    h.state.answer = 'Original';
    assert.equal(await h.api.renameStandaloneFeatureTitle(uri(featureUri)), false);
    h.state.answer = 'test.feature';
    assert.equal(await h.api.renameStandaloneFeatureFile(uri(featureUri)), undefined);
    assert.deepEqual(h.writeCalls, []);
    assert.deepEqual(h.renames, []);
});

test('feature rename rejects dirty documents, changed sources and filename collisions', async () => {
    for (const action of ['title', 'file'] as const) {
        const h = harness();
        const run = () => action === 'title' ? h.api.renameStandaloneFeatureTitle(uri(featureUri)) : h.api.renameStandaloneFeatureFile(uri(featureUri));
        h.documents.push({ uri: uri(featureUri), isDirty: true, version: 1 });
        await assert.rejects(run, /Save modified/);
        assert.equal(h.inputs.length, 0);
        h.documents[0].isDirty = false;
        h.state.answer = 'Changed';
        h.state.onInput = () => { h.files.set(featureUri, h.files.get(featureUri)! + '# changed\n'); };
        await assert.rejects(run, /source changed/);
        assert.deepEqual(h.writeCalls, []);
        assert.deepEqual(h.renames, []);
    }
    const h = harness();
    h.state.answer = 'export.feature';
    await assert.rejects(() => h.api.renameStandaloneFeatureFile(uri(featureUri)), /already exists/);
    assert.equal(h.files.get(exportUri), declaration);
    assert.deepEqual(h.renames, []);
});

test('export rename updates declaration, usage example and feature/YAML calls, retaining argument values and EOL', async () => {
    const h = harness();
    const originals = new Map(h.files);
    h.state.answer = 'activate "WindowName" window';
    assert.equal(await h.renameExport(), true);
    assert.equal(h.files.get(exportUri), declaration.replaceAll('open ', 'activate '));
    for (const key of [featureUri, yamlUri]) {
        assert.equal(h.files.get(key), originals.get(key)!.replace('open ', 'activate '));
    }
});

test('export rename cancels all writes for dirty calls, ambiguous calls and source changes during reference lookup', async () => {
    for (const issue of ['dirty', 'ambiguous', 'changed'] as const) {
        const h = harness();
        h.state.answer = 'activate "WindowName" window';
        if (issue === 'dirty') { h.documents.push({ uri: uri(yamlUri), isDirty: true, version: 1 }); }
        if (issue === 'ambiguous') {
            const duplicate = { ...h.view.all[0], id: 'duplicate' };
            h.state.view = { ...h.view, all: [...h.view.all, duplicate] };
        }
        if (issue === 'changed') { h.state.onReferences = () => { h.files.set(exportUri, declaration + '# changed\n'); }; }
        await assert.rejects(h.renameExport, /modified|ambiguous|changed/);
        assert.deepEqual(h.writeCalls, []);
    }
});

test('export rename rolls back earlier writes when a later call file cannot be written', async () => {
    const h = harness();
    const originals = new Map(h.files);
    h.state.answer = 'activate "WindowName" window';
    h.state.failWrite = yamlUri;
    await assert.rejects(h.renameExport, /Write failed/);
    assert.deepEqual(h.files, originals);
});

test('export rename rechecks name collisions after the input dialog', async () => {
    const h = harness();
    h.state.answer = 'activate "WindowName" window';
    h.state.onInput = () => {
        const duplicate = { ...h.view.all[0], id: 'new-export', template: 'activate "OtherName" window' };
        h.state.view = { ...h.view, all: [...h.view.all, duplicate] };
    };
    await assert.rejects(h.renameExport, /already exists/);
    assert.deepEqual(h.writeCalls, []);
});

test('export rename leaves every file unchanged when reference scanning fails', async () => {
    const h = harness();
    const originals = new Map(h.files);
    h.state.answer = 'activate "WindowName" window';
    h.state.onReferences = () => { throw new Error('Reference scan failed'); };
    await assert.rejects(h.renameExport, /Reference scan failed/);
    assert.deepEqual(h.writeCalls, []);
    assert.deepEqual(h.files, originals);
});

test('export rename rejects names that collide with built-in steps, user steps or nested scenarios', async () => {
    for (const kind of ['builtInStep', 'userStep', 'nestedScenario'] as const) {
        const h = harness();
        const other = { ...h.view.all[0], id: kind, kind, template: 'activate "WindowName" window' };
        h.state.view = { ...h.view, all: [...h.view.all, other] };
        h.state.answer = 'activate "WindowName" window';
        await assert.rejects(h.renameExport, /already exists|ambiguous/);
        assert.deepEqual(h.writeCalls, []);
    }
});
