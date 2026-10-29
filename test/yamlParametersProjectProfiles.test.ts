import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as activeProfiles from '../src/activeYamlParametersProfile';
import * as defaults from '../src/yamlParameterDefaults';
import * as compilerParameters from '../src/compilerBuildParameters';
import * as compilerValueValidation from '../src/compilerBuildValueValidation';
import * as vanessaCatalog from '../src/vanessaParameterCatalog';
import type { YamlParametersManager, YamlParametersProfilesSummary } from '../src/yamlParametersManager';

const legacyKey = 'kotTestToolkit.yamlParameters';
const ts = require('typescript') as typeof import('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/yamlParametersManager.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function harness(root: string | undefined, secrets = new Map<string, string>(), uri?: string) {
    const module = { exports: {} as { YamlParametersManager: { getInstance(context: unknown): YamlParametersManager } } };
    const folder = root ? { name: path.basename(root), uri: { fsPath: root, toString: () => uri ?? `file://${root}` } } : undefined;
    const writes: string[] = [];
    const warnings: string[] = [];
    const picks: Array<unknown> = [];
    const shownItems: Array<Array<{ action: string; label: string }>> = [];
    const dependencies: Record<string, unknown> = {
        vscode: {
            EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
            workspace: { workspaceFolders: folder ? [folder] : undefined, getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
            Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts), toString: () => path.join(base.fsPath, ...parts) }) },
            env: { language: 'en' },
            commands: { executeCommand: async () => undefined },
            QuickPickItemKind: { Separator: -1 },
            window: { showWarningMessage: (message: string) => { warnings.push(message); },
                showQuickPick: async (items: Array<{ action: string; label: string }>) => { shownItems.push(items); return picks.shift(); },
                showInputBox: async () => 'Copied' },
            l10n: { t: (message: string) => message }
        },
        './appContext': { getExtensionUri: () => ({ fsPath: process.cwd() }) },
        './scenarioScanRoot': { getScenarioScanRootPath: () => 'tests/', updateScenarioScanRoot: async () => false, updateProcessScanRoot: async () => false },
        './etalonBases': { getDefaultModelDbSettingsValue: () => 'model.yaml' },
        './yamlParameterDefaults': defaults, './compilerBuildParameters': compilerParameters,
        './compilerBuildValueValidation': compilerValueValidation, './activeYamlParametersProfile': activeProfiles,
        './vanessaParameterCatalog.js': vanessaCatalog
    };
    (dependencies.vscode as { workspace: object }).workspace = {
        ...(dependencies.vscode as { workspace: object }).workspace,
        fs: { readFile: async (uri: { fsPath: string }) => fs.promises.readFile(uri.fsPath) }
    };
    vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, console, process,
        require: (specifier: string) => dependencies[specifier] ?? require(specifier) });
    const manager = module.exports.YamlParametersManager.getInstance({ subscriptions: [], secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); writes.push(key); },
        delete: async (key: string) => { secrets.delete(key); writes.push(key); }
    } });
    return { manager, writes, secrets, warnings, picks, shownItems };
}

function legacyPayload() {
    return JSON.stringify({ version: 5, activeProfileId: 'drive', profiles: [{ id: 'drive', name: '1cDrive',
        buildParameters: [{ key: 'Libraries', value: '/drive/libraries' }],
        additionalVanessaParameters: [{ key: 'КаталогиБиблиотек', value: '["/drive/libraries"]', overrideExisting: true }],
        globalVanessaVariables: [{ key: 'DriveMode', value: 'production', overrideExisting: true }] }] });
}

test('a newly opened project never inherits the previous global profile or its three sections', async () => {
    const original = legacyPayload();
    const h = harness('/new-project', new Map([[legacyKey, original]]));
    const profile = await h.manager.loadActiveProfileSnapshot();
    assert.equal(profile.id, 'default');
    assert.equal(profile.buildParameters.find(row => row.key === 'Libraries')?.value, '');
    assert.equal(profile.additionalVanessaParameters.some(row => row.value.includes('/drive/')), false);
    assert.equal(profile.globalVanessaVariables.length, 0);
    assert.equal(h.secrets.get(legacyKey), original);
});

test('different project windows independently persist profiles and restore their active selections', async () => {
    const secrets = new Map<string, string>();
    const drive = harness('/drive', secrets);
    const demo = harness('/workshop', secrets);
    const driveId = await drive.manager.createSetupProfile('Drive', [{ key: 'Libraries', value: '/drive/libraries' }]);
    const demoId = await demo.manager.createSetupProfile('Workshop', [{ key: 'Libraries', value: 'libraries' }]);
    assert.equal((await harness('/drive', secrets).manager.loadActiveProfileSnapshot()).id, driveId);
    assert.equal((await harness('/workshop', secrets).manager.loadActiveProfileSnapshot()).id, demoId);
    assert.notEqual(drive.writes[0], demo.writes[0]);
    assert.equal(secrets.has(legacyKey), false);
    assert.equal((await drive.manager.getProfilesSummary()).profiles.some(profile => profile.id === demoId), false);
    await demo.manager.setActiveProfile('default');
    assert.equal((await harness('/workshop', secrets).manager.loadActiveProfileSnapshot()).id, 'default');
    assert.equal((await harness('/drive', secrets).manager.loadActiveProfileSnapshot()).id, driveId);
});

test('the root URI scopes Windows projects without converting drive paths into UNC identities', async () => {
    const secrets = new Map<string, string>();
    const first = harness('C:\\Mac\\Home\\demo', secrets, 'file:///c%3A/Mac/Home/demo');
    const other = harness('C:\\Mac\\Home\\drive', secrets, 'file:///c%3A/Mac/Home/drive');
    await first.manager.saveParameters([{ key: 'Libraries', value: 'libraries' }]);
    assert.equal((await other.manager.loadActiveProfileSnapshot()).buildParameters.find(row => row.key === 'Libraries')?.value, '');
    assert.equal((await harness('C:\\Mac\\Home\\demo', secrets, 'file:///c%3A/Mac/Home/demo').manager.loadParameters()).find(row => row.key === 'Libraries')?.value, 'libraries');
});

test('the empty window has its own profile and cannot replace a project profile', async () => {
    const secrets = new Map<string, string>();
    const project = harness('/workshop', secrets);
    await project.manager.saveParameters([{ key: 'Libraries', value: 'libraries' }]);
    await harness(undefined, secrets).manager.saveParameters([{ key: 'Libraries', value: '/other' }]);
    assert.equal((await harness('/workshop', secrets).manager.loadParameters()).find(row => row.key === 'Libraries')?.value, 'libraries');
});

test('an explicit legacy import copies all sections while preserving the global original and other projects', async () => {
    const original = legacyPayload();
    const secrets = new Map([[legacyKey, original]]);
    const h = harness('/drive', secrets);
    const importProfile = (h.manager as YamlParametersManager & { importLegacyProfile(id: string): Promise<boolean> }).importLegacyProfile;
    assert.equal(typeof importProfile, 'function');
    assert.equal(await importProfile.call(h.manager, 'drive'), true);
    const profile = await h.manager.loadActiveProfileSnapshot();
    assert.notEqual(profile.id, 'drive');
    assert.equal(profile.name, '1cDrive');
    assert.equal(profile.buildParameters.find(row => row.key === 'Libraries')?.value, '/drive/libraries');
    assert.equal(profile.additionalVanessaParameters[0].value, '["/drive/libraries"]');
    assert.equal(profile.globalVanessaVariables[0].value, 'production');
    await h.manager.saveParameters([{ key: 'Libraries', value: '/edited' }]);
    assert.equal(secrets.get(legacyKey), original);
    assert.equal((await harness('/other', secrets).manager.loadActiveProfileSnapshot()).name, 'Default');
    const before = [...secrets];
    assert.equal(await importProfile.call(h.manager, 'missing'), false);
    assert.deepEqual([...secrets], before);
});

test('new setup profiles use clean Vanessa settings and GlobalVars, while explicit copying remains independent', async () => {
    const original = legacyPayload();
    const h = harness('/project', new Map([[legacyKey, original]]));
    await h.manager.importLegacyProfile('drive');
    await h.manager.createSetupProfile('New', [{ key: 'Libraries', value: 'libraries' }]);
    const profile = await h.manager.loadActiveProfileSnapshot();
    assert.equal(profile.additionalVanessaParameters.some(row => row.value.includes('/drive/')), false);
    assert.equal(profile.globalVanessaVariables.length, 0);
    assert.equal(profile.additionalVanessaParameters.find(row => row.key === 'ИспользоватьКомпонентуVanessaExt')?.value, 'true');
});

async function manageProfiles(manager: YamlParametersManager): Promise<YamlParametersProfilesSummary> {
    const state = await manager.getProfilesSummary();
    const internal = manager as unknown as {
        manageProfiles(panel: unknown, message: unknown): Promise<void>;
        postProfilesStateUpdated: () => Promise<boolean>;
    };
    // The webview and artifact rebuild are external to the native profile picker.
    internal.postProfilesStateUpdated = async () => false;
    const profiles = await Promise.all(state.profiles.map(profile => manager.loadProfileSnapshot(profile.id)));
    await internal.manageProfiles({ webview: { postMessage: async () => true } }, { activeProfileId: state.activeProfileId, profiles });
    return manager.getProfilesSummary();
}

test('legacy import is discoverable in the native profile picker and cancellation keeps the current profile', async () => {
    const h = harness('/project', new Map([[legacyKey, legacyPayload()]]));
    h.picks.push({ action: 'importLegacy' }, undefined);
    assert.equal((await manageProfiles(h.manager)).activeProfileId, 'default');
    assert.ok(h.shownItems[0].some(item => item.action === 'importLegacy'));
    assert.equal(h.shownItems[1][0].label, '1cDrive');
    assert.equal((await h.manager.getProfilesSummary()).profiles.length, 1);
    h.picks.push({ action: 'importLegacy' }, { profileId: 'drive' });
    await manageProfiles(h.manager);
    assert.equal((await h.manager.loadActiveProfileSnapshot()).name, '1cDrive');
    assert.equal(h.secrets.get(legacyKey), legacyPayload());
});

test('explicit duplication retains all three sections and gives the copy an independent identity', async () => {
    const h = harness('/project', new Map([[legacyKey, legacyPayload()]]));
    await h.manager.importLegacyProfile('drive');
    const before = await h.manager.loadActiveProfileSnapshot();
    h.picks.push({ action: 'duplicate' });
    await manageProfiles(h.manager);
    const after = await h.manager.loadActiveProfileSnapshot();
    assert.notEqual(after.id, before.id);
    assert.equal(after.name, 'Copied');
    assert.deepEqual(after.buildParameters, before.buildParameters);
    assert.deepEqual(after.additionalVanessaParameters, before.additionalVanessaParameters);
    assert.deepEqual(after.globalVanessaVariables, before.globalVanessaVariables);
});

test('the workshop starts with its own portable libraries, English generator and tutorial globals', async () => {
    const root = path.resolve('examples/kot-workshop');
    const h = harness(root, new Map([[legacyKey, legacyPayload()]]));
    const profile = await h.manager.loadActiveProfileSnapshot();
    assert.equal(profile.name, 'KOT Workshop');
    assert.equal(profile.buildParameters.find(row => row.key === 'Libraries')?.value, 'libraries');
    assert.equal(profile.buildParameters.find(row => row.key === 'CreateJson')?.value.toLowerCase(), 'false');
    assert.equal(profile.additionalVanessaParameters.find(row => row.key === 'КаталогиБиблиотек')?.value, '["libraries"]');
    assert.equal(profile.additionalVanessaParameters.find(row => row.key === 'ЯзыкГенератораGherkin')?.value, 'en');
    assert.ok(profile.globalVanessaVariables.length > 0);
    await h.manager.saveParameters([{ key: 'Libraries', value: 'my-library' }]);
    assert.equal((await harness(root, h.secrets).manager.loadParameters()).find(row => row.key === 'Libraries')?.value, 'my-library');
});

test('invalid project seed falls back to clean defaults without importing or rewriting global settings', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-project-profile-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.kot'));
    fs.writeFileSync(path.join(root, '.kot/parameter-profiles.json'), '{invalid');
    const original = legacyPayload();
    const h = harness(root, new Map([[legacyKey, original]]));
    assert.equal((await h.manager.loadActiveProfileSnapshot()).id, 'default');
    assert.equal(h.secrets.get(legacyKey), original);
    assert.equal(h.writes.length, 0);
    assert.equal(h.warnings.length, 1);
});

test('project-supplied profile text stays data inside the manager webview bootstrap', async () => {
    const h = harness('/project');
    const text = '</script><section>profile</section>$&$`';
    const profile = { id: text, name: text, buildParameters: [{ key: 'Libraries', value: text }],
        additionalVanessaParameters: [{ key: 'Custom', value: text, overrideExisting: false }],
        globalVanessaVariables: [{ key: 'Value', value: text, overrideExisting: false }] };
    const manager = h.manager as unknown as { getWebviewContent(...args: unknown[]): Promise<string> };
    const html = await manager.getWebviewContent({ cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri },
        profile.buildParameters, profile.additionalVanessaParameters, profile.globalVanessaVariables, profile.id, [profile]);
    const serialized = html.match(/window\.__profiles = (.+);/u)?.[1];
    assert.ok(serialized, 'render the actual manager bootstrap rather than its error fallback');
    assert.equal(html.includes(text), false, 'data must never terminate an inline script');
    assert.equal(JSON.parse(serialized)[0].name, text, 'escaping must retain the original profile data');
});
