import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as featureController from '../src/featurePropertiesController';
import * as featureModel from '../src/featurePropertiesModel';
import * as featureActions from '../src/featureEditorActions';
import * as exportParser from '../src/exportScenarioParser';
import { StepLibraryFavoritesService } from '../src/stepLibraryFavorites';

function harness(exported = false) {
    const uri = pathToFileURL('/tests/demo.feature').toString();
    let document = { uri, text: (exported ? '@ExportScenarios\n' : '') + 'Feature: Demo\nScenario: Ready\n', version: 1 };
    let answer: string | undefined; let loads = 0; let changed: () => void = () => undefined;
    const commands: any[] = []; const moves: any[] = []; const renames: any[] = []; const values = new Map<string, unknown>();
    const favorites = new StepLibraryFavoritesService({ get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
        update: async (key, value) => { values.set(key, value); } });
    const parse = (value: string) => ({ fsPath: fileURLToPath(value), toString: () => value });
    const api = { Uri: { parse, file: (value: string) => parse(pathToFileURL(value).toString()) }, l10n: { t: (value: string) => value },
        window: { showInputBox: async () => answer }, commands: { executeCommand: async (...args: any[]) => { commands.push(args); } },
        env: { clipboard: { writeText: async (value: string) => commands.push(['copy', value]) } } };
    const deps: Record<string, unknown> = { vscode: api, './featurePropertiesController': featureController,
        './featurePropertiesModel': featureModel, './featureEditorActions': featureActions, './exportScenarioParser': exportParser };
    const ts = require('typescript'); const module = { exports: {} as typeof import('../src/scenarioPropertiesLibrarySupport') };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/scenarioPropertiesLibrarySupport.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
        { module, exports: module.exports, require: (name: string) => deps[name] ?? require(name) });
    const feature = { id: uri, groupId: '', uri };
    const support = module.exports.createPropertiesLibrarySupport({
        favoriteItems: async () => { loads++; return [{ id: 'standaloneFeature#' + uri, sourceGroup: 'standalone', capturedLocation: { uri } }] as any; },
        onDidChangeIndex: listener => { changed = listener; return { dispose() {} }; }, favorites,
        standalone: { find: (id: string) => id === uri ? feature : undefined,
            getSnapshot: () => ({ groups: [{ id: 'mine', name: 'Mine' }, { id: 'other', name: 'Other' }], ordering: { featureRoots: { [uri]: '/tests' }, groupRoots: { mine: ['/tests'], other: ['/other'] } } }),
            createGroupForFeature: async (id: string, name: string) => { moves.push(['create', id, name]); return { id: 'new', name }; },
            moveFeature: async (...args: any[]) => { moves.push(['move', ...args]); },
            onDidChange: () => ({ dispose() {} }), onDidRefresh: () => ({ dispose() {} }) } as any,
        sourceForGenerated: async () => undefined, renameExport: async (...args: any[]) => { renames.push(args); return true; }
    });
    const controller = support.createFeatureController({ readDocument: async () => ({ ...document }), saveDocument: async () => true,
        replaceDocument: async (_before, text) => { document = { ...document, text, version: document.version + 1 }; return true; } });
    const request = (action: string, extra = {}) => controller.handle({ command: 'featureAction', action, uri, version: document.version, ...extra });
    return { support, controller, request, uri, commands, moves, renames, document: () => document,
        answer: (value: string) => { answer = value; }, loads: () => loads, invalidate: () => changed() };
}
test('Properties favorites load without delaying the document and share Library state', async () => {
    const h = harness(); let updates = 0; const subscription = h.support.onDidChange(() => { updates++; });
    assert.equal(h.support.favorite(h.uri).canFavorite, false); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.support.favorite(h.uri).canFavorite, true); assert.equal(h.loads(), 1);
    await h.support.toggleFavorite(h.uri); assert.equal(h.support.favorite(h.uri).favorite, true);
    assert.ok(updates >= 2); h.invalidate(); assert.equal(h.support.favorite(h.uri).canFavorite, false);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.loads(), 2); subscription.dispose();
});
test('feature actions carry the native URI/version and create groups in the selected project', async () => {
    const h = harness(); await h.controller.open(h.uri);
    assert.deepEqual(JSON.parse(JSON.stringify(h.controller.state?.standalone?.groups)), [{ id: 'mine', name: 'Mine' }]);
    await h.request('structure', { line: 0, value: 'background' });
    assert.deepEqual(JSON.parse(JSON.stringify(h.commands.at(-1))), ['kotTestToolkit.editFeatureStructure', { uri: h.uri, version: 1, line: 0, kind: 'background' }]);
    h.answer('New'); await h.request('group', { value: '__new__' });
    assert.deepEqual(h.moves, [['create', h.uri, 'New'], ['move', h.uri, 'new']]);
});
test('renaming an exported scenario delegates to the reference-aware command; ordinary names edit the native document', async () => {
    const exported = harness(true); await exported.controller.open(exported.uri); await exported.request('renameScenario', { line: 2 });
    assert.equal(exported.renames.length, 1); assert.equal(exported.document().version, 1);
    const ordinary = harness(); ordinary.answer('Renamed'); await ordinary.controller.open(ordinary.uri); await ordinary.request('renameScenario', { line: 1 });
    assert.equal(ordinary.renames.length, 0); assert.match(ordinary.document().text, /Scenario: Renamed\n/u);
});
