import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as templates from '../src/featureTemplate';
import * as launch from '../src/standaloneFeatureLaunch';

function uri(fsPath: string) { return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` }; }
async function harness(t: test.TestContext) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-feature-creator-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const source = path.join(process.cwd(), 'src/featureCreator.ts');
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const compiled = ts.transpileModule(fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : 'export {};', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const settings = new Map<string, unknown>();
    const errors: string[] = [];
    const opened: string[] = [];
    const prompts: string[] = [];
    let confirm = false;
    let cancelled = false;
    const profile = { id: 'selected', name: 'QA', buildParameters: [{ key: 'LaunchDBFolder', value: 'bases/qa' }], additionalVanessaParameters: [{ key: 'Custom.Profile', value: '42', overrideExisting: true }], globalVanessaVariables: [] };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject, exports: moduleObject.exports, console, Buffer,
        require: (specifier: string) => {
            if (specifier === 'vscode') { return {
                Uri: { file: uri },
                workspace: { workspaceFolders: [{ uri: uri(root) }], getWorkspaceFolder: () => ({ uri: uri(root) }), getConfiguration: () => ({ get: (key: string, fallback?: unknown) => settings.get(key) ?? fallback }), openTextDocument: async (target: { fsPath: string }) => { opened.push(target.fsPath); return {}; } },
                window: { showTextDocument: async () => {}, showErrorMessage: async (message: string) => { errors.push(message); }, showInputBox: async () => undefined,
                    showQuickPick: async (items: Array<{ id?: string }>, options: { title: string }) => { prompts.push(options.title); return cancelled ? undefined : items.find(item => item.id === 'selected') ?? items[0]; },
                    showWarningMessage: async (_message: string, _options: unknown, action: string) => confirm ? action : undefined,
                    showSaveDialog: async (options: { defaultUri: unknown }) => options.defaultUri }
            }; }
            if (specifier === './localization') { return { getTranslator: async () => (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_match, index) => args[Number(index)] ?? '') }; }
            if (specifier === './gherkinLanguage') { return { getConfiguredScenarioLanguage: () => settings.get('editor.newScenarioLanguage') ?? 'en' }; }
            if (specifier === './scenarioScanRoot') { return { resolveScenarioScanRootFsPath: () => path.join(root, 'tests') }; }
            if (specifier === './featureTemplate') { return templates; }
            if (specifier === './standaloneFeatureLaunch') { return launch; }
            if (specifier === './yamlParametersManager') { return { YamlParametersManager: { getInstance: () => ({ getProfilesSummary: async () => ({ activeProfileId: 'active', profiles: [{ id: 'active', name: 'Current' }, { id: 'selected', name: 'QA' }] }), loadProfileSnapshot: async (id: string) => id === 'selected' ? profile : undefined }) } }; }
            return require(specifier);
        }
    });
    return { root, settings, errors, opened, prompts, setConfirm(value: boolean) { confirm = value; }, setCancelled(value: boolean) { cancelled = value; },
        api: moduleObject.exports as { createFeature(context: unknown, options?: unknown): Promise<{ fsPath: string } | undefined>; generateFeatureJson(context: unknown, featureUri: unknown): Promise<{ fsPath: string } | undefined> }, context: { extensionUri: uri('/extension') } };
}

test('creates a nested feature under the configured tests root and opens the created file', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.createFeature, 'function');
    const destination = path.join(h.root, 'tests/sales/order.feature');
    const result = await h.api.createFeature(h.context, { destinationUri: uri(destination), featureTitle: 'Orders', scenarioTitle: 'Create order', language: 'ru', tags: [] });
    assert.equal(result?.fsPath, destination);
    const content = await fs.promises.readFile(destination, 'utf8');
    assert.match(content, /Функционал: Orders/u);
    assert.match(content, /Сценарий: Create order/u);
    assert.deepEqual(h.opened, [destination]);
    assert.deepEqual(h.errors, []);
});

test('refuses feature overwrite, an escaped destination and unreadable custom templates', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.createFeature, 'function');
    const existing = path.join(h.root, 'tests/order.feature');
    await fs.promises.mkdir(path.dirname(existing), { recursive: true });
    await fs.promises.writeFile(existing, 'Authored feature', 'utf8');
    const options = { featureTitle: 'Order', scenarioTitle: 'Create', language: 'en', tags: [] };
    assert.equal(await h.api.createFeature(h.context, { ...options, destinationUri: uri(existing) }), undefined);
    assert.equal(await fs.promises.readFile(existing, 'utf8'), 'Authored feature');
    const outside = path.join(h.root, 'outside.feature');
    assert.equal(await h.api.createFeature(h.context, { ...options, destinationUri: uri(outside) }), undefined);
    assert.equal(fs.existsSync(outside), false);
    h.settings.set('editor.newFeatureTemplatePath', 'missing.feature');
    assert.equal(await h.api.createFeature(h.context, { ...options, destinationUri: uri(path.join(h.root, 'tests/new.feature')) }), undefined);
    assert.equal(fs.existsSync(path.join(h.root, 'tests/new.feature')), false);
    assert.equal(h.errors.length, 3);
});

test('uses a workspace-relative custom template with default configured language', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.createFeature, 'function');
    h.settings.set('editor.newScenarioLanguage', 'ru');
    h.settings.set('editor.newFeatureTemplatePath', 'custom.feature');
    await fs.promises.writeFile(path.join(h.root, 'custom.feature'), '#language: {{language}}\nФункционал: {{featureTitle}}\nСценарий: {{scenarioTitle}}\n\tИ готово\n', 'utf8');
    const destination = path.join(h.root, 'tests/custom.feature');
    await h.api.createFeature(h.context, { featureTitle: 'Заказ', scenarioTitle: 'Создать', destinationUri: uri(destination), tags: [] });
    assert.equal(await fs.promises.readFile(destination, 'utf8'), '#language: ru\nФункционал: Заказ\nСценарий: Создать\n\tИ готово\n');
});

test('generates adjacent JSON from the chosen profile and preserves authored custom settings on approved replacement', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.generateFeatureJson, 'function');
    const feature = path.join(h.root, 'tests/order.feature');
    const output = path.join(h.root, 'tests/order.json');
    await fs.promises.mkdir(path.dirname(feature), { recursive: true });
    await fs.promises.writeFile(feature, 'Feature: Order\nScenario: Create\n', 'utf8');
    const original = '\uFEFF{"Custom":{"Authored":true},"featurepath":"/all"}';
    await fs.promises.writeFile(output, original, 'utf8');
    assert.equal(await h.api.generateFeatureJson(h.context, uri(feature)), undefined);
    assert.equal(await fs.promises.readFile(output, 'utf8'), original);
    h.setConfirm(true);
    const result = await h.api.generateFeatureJson(h.context, uri(feature));
    assert.equal(result?.fsPath, output);
    const data = JSON.parse(await fs.promises.readFile(output, 'utf8'));
    assert.equal(data.featurepath, feature);
    assert.deepEqual(data.Custom, { Authored: true, Profile: 42 });
    assert.equal(data.TestClient.datatestclients[0].Name, 'QA');
    assert.deepEqual(h.opened, [output]);
    assert.deepEqual(h.errors, []);
});

test('cancelling profile selection creates no launch JSON', async t => {
    const h = await harness(t);
    assert.equal(typeof h.api.generateFeatureJson, 'function');
    const feature = path.join(h.root, 'tests/order.feature');
    await fs.promises.mkdir(path.dirname(feature), { recursive: true });
    await fs.promises.writeFile(feature, 'Feature: Order\nScenario: Create\n', 'utf8');
    h.setCancelled(true);
    assert.equal(await h.api.generateFeatureJson(h.context, uri(feature)), undefined);
    assert.equal(fs.existsSync(path.join(h.root, 'tests/order.json')), false);
});
