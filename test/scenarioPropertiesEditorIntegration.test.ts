import * as editorActionControls from '../src/editorActionControls';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function harness() {
    const commands = new Map<string, (target?: unknown) => Promise<void>>();
    const opened: unknown[] = [];
    const registrations: Array<{ selector: unknown; provider: { provideCodeLenses(document: unknown): unknown[] } }> = [];
    const source = { scheme: 'file', fsPath: '/project/scen.yaml', toString: () => 'file:///project/scen.yaml' };
    const errors: string[] = [];
    let showActions = true;
    const host = {
        workspace: { getConfiguration: () => ({ inspect: () => undefined, get: () => showActions }) },
        window: { activeTextEditor: { document: { uri: source } }, showErrorMessage: (message: string) => { errors.push(message); } },
        commands: { registerCommand: (id: string, handler: (target?: unknown) => Promise<void>) => { commands.set(id, handler); return { dispose() {} }; } },
        languages: { registerFoldingRangeProvider: () => ({ dispose() {} }), registerCodeLensProvider: (selector: unknown, provider: (typeof registrations)[number]['provider']) => { registrations.push({ selector, provider }); return { dispose() {} }; } },
        Range: class { constructor(readonly line: number) {} },
        CodeLens: class { constructor(readonly range: unknown, readonly command: { command: string; arguments: unknown[] }) {} },
        Uri: { parse: (value: string) => value === source.toString() ? source : source },
        l10n: { t: (message: string, ...args: string[]) => message.replace('{0}', args[0] ?? '') }
    };
    const dependencies: Record<string, unknown> = {
        vscode: host, './editorActionControls': editorActionControls,
        './scenarioYamlEditor': { ScenarioYamlEditor: class {}, ScenarioYamlFoldingProvider: class {} },
        './scenarioPropertiesPanel': { ScenarioPropertiesPanel: class { async open(uri: unknown) { opened.push(uri); } dispose() {} } },
        './scenarioPropertiesActions': { createScenarioPropertiesActions: () => async () => undefined },
        './yamlValidator': { isScenarioYamlFile: (document: { getText(): string }) => /ТипФайла: Сценарий/u.test(document.getText()),
            isProcessYamlFile: (document: { getText(): string }) => /ТипФайла: Процесс/u.test(document.getText()) }
    };
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as typeof import('../src/scenarioPropertiesEditorIntegration') };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/scenarioPropertiesEditorIntegration.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name], console });
    const context = { subscriptions: [] as { dispose(): void }[] };
    module.exports.registerScenarioPropertiesEditor(context as any, { renameScenario: async () => undefined });
    return { source, opened, commands, registrations, errors, setActions: (value: boolean) => { showActions = value; } };
}

test('editor command routes active and explicit Library source targets to the authored URI', async () => {
    const h = harness();
    await h.commands.get('kotTestToolkit.openScenarioEditor')!();
    await h.commands.get('kotTestToolkit.openScenarioEditor')!({ uri: h.source.toString() });
    assert.deepEqual(h.opened, [h.source, h.source]);
    assert.deepEqual(h.errors, []);
});

test('compiler descriptors expose the property editor without offering it on run settings', () => {
    const h = harness(); const provider = h.registrations[0].provider;
    const raw = provider.provideCodeLenses({ uri: h.source, getText: () => 'ТипФайла: Сценарий' });
    const process = provider.provideCodeLenses({ uri: h.source, getText: () => 'ТипФайла: Процесс' });
    assert.equal(raw.length, 1); assert.equal(process.length, 1);
    assert.equal(provider.provideCodeLenses({ uri: h.source, getText: () => 'ТипФайла: НастройкаТеста' }).length, 0);
});

test('Properties editor action follows the YAML visibility preference', () => {
    const h = harness(); h.setActions(false);
    assert.equal(h.registrations[0].provider.provideCodeLenses({ uri: h.source, getText: () => 'ТипФайла: Сценарий' }).length, 0);
});
