import { nativeInteraction } from './helpers/kotInteraction';
import * as projectSetupGateModule from '../src/projectSetupGate';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as projectFormatModule from '../src/projectFormat';
import * as projectFormatTransitionModule from '../src/projectFormatTransition';
import * as settingsPaths from '../src/kotSettingsPaths';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(root = '/project', scan?: () => Promise<void>) {
    const uri = { scheme: 'file', fsPath: root, toString: () => pathToFileURL(root).href };
    const saved = new Map<string, unknown>(); const events: Array<{ type: string; label?: string; id?: string }> = [];
    const nativeRequire = createRequire(__filename);
    const manager = { loadActiveProfileSnapshot: async () => ({ buildParameters: [] }), validateCompilerBuildParameters: () => [] };
    const workspace = { isTrusted: true, workspaceFolders: [{ uri }], textDocuments: [], onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) };
    const mocks: Record<string, unknown> = {
        vscode: { workspace,
            ProgressLocation: { Notification: 15 }, window: { withProgress: async (_options: unknown, work: (progress: { report(value: unknown): void }) => unknown) => work({ report() {} }) },
            commands: { executeCommand: async () => undefined } },
        './yamlParametersManager': { YamlParametersManager: { getInstance: () => manager } },
        './projectFormat': projectFormatModule, './projectFormatTransition': projectFormatTransitionModule,
        './projectSetupGate': projectSetupGateModule,
        './kotProjectSetup': { assertPrimarySetupFolder() {}, validateSetupSourceRoot() {}, inspectSetupProject: async () => ({ truncated: false, features: ['tests/test.feature'], metadata: [] }) },
        './kotSettingsPaths': settingsPaths,
        './oneCPlatform': { getConfiguredOneCPlatforms: () => [] },
        './workspaceScanner.js': { scanWorkspaceForScenarioCatalog: async (_uri: unknown, _token: unknown, report?: (value: unknown) => void) => {
            report?.({ label: 'Reading scenario source files…', completed: 2, total: 2 }); await scan?.();
        } }
    };
    const exports: Record<string, any> = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/kotWorkspacePanel.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { exports, require: (id: string) => id === './kotInteraction' ? nativeInteraction : (id.startsWith('node:') ? nativeRequire(id) : mocks[id] ?? {}), console: { info() {} }, process, Error });
    const panel = new exports.KotWorkspacePanel({ workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => { saved.set(key, value); } } });
    panel.panel = { webview: { postMessage: async (message: typeof events[number]) => { events.push(message); } } };
    panel.review = { id: 'review', folder: uri.toString(), draft: { run: true, mode: 'sppr' }, filesApplied: true, settingsApplied: true, profileApplied: true, platformApplied: true };
    return { panel, events, saved, manager, workspace, uri };
}

test('reviewed editor-only setup saves offline mode and its Vanessa source without requiring execution', async () => {
    const h = fixture();
    const keys = ['kotTestToolkit.editor.newScenarioLanguage', 'kotTestToolkit.runVanessa.vanessaEpfPath', 'kotTestToolkit.steps.catalogMode'];
    h.panel.model = { strings: {}, settings: keys.map(key => ({ key, configScope: 'resource' })) };
    h.panel.session = { snapshot: () => keys.map(key => ({ key, token: 'before' })) };
    const draft = { route: 'vanessa', mode: 'vanessa', language: 'en', format: 'native', sources: 'tests', libraries: '',
        run: false, platform: '', vanessa: 'local/vanessa-automation.epf', compiler: '', profileId: 'existing', catalogMode: 'offline' };
    const review = await h.panel.reviewSetup(draft, h.uri.toString());
    assert.equal(review.run, false);
    assert.equal(review.settings.find((change: any) => change.key === 'kotTestToolkit.steps.catalogMode').value, 'offline');
    assert.equal(review.settings.find((change: any) => change.key === 'kotTestToolkit.runVanessa.vanessaEpfPath').value, draft.vanessa);
    const online = await h.panel.reviewSetup({ ...draft, catalogMode: 'online' }, h.uri.toString());
    assert.equal(online.settings.find((change: any) => change.key === 'kotTestToolkit.runVanessa.vanessaEpfPath').value, draft.vanessa);
});

test('setup reviews the MXL mode with project settings but stores the local File Workshop path in User scope', async () => {
    const h = fixture();
    const keys = ['kotTestToolkit.editor.newScenarioLanguage', 'kotTestToolkit.steps.catalogMode', 'kotTestToolkit.files.mxlOpeningMode', 'kotTestToolkit.paths.fileWorkshopExe'];
    h.panel.model = { strings: {}, settings: keys.map(key => ({ key, configScope: 'resource' })) };
    h.panel.session = { snapshot: () => keys.map(key => ({ key, token: 'before' })) };
    const draft = { route: 'vanessa', mode: 'vanessa', language: 'ru', format: 'native', sources: 'tests', libraries: '',
        run: false, platform: '', vanessa: '', compiler: '', profileId: 'existing', catalogMode: 'online', mxlOpeningMode: 'fileWorkshop', fileWorkshop: 'C:\\1C files\\1cv8fv.exe' };
    const review = await h.panel.reviewSetup(draft, h.uri.toString());
    assert.equal(review.settings.find((change: any) => change.key === 'kotTestToolkit.files.mxlOpeningMode').value, 'fileWorkshop');
    const program = review.settings.find((change: any) => change.key === 'kotTestToolkit.paths.fileWorkshopExe');
    assert.equal(program.value, draft.fileWorkshop); assert.equal(program.scope, 'user');
    draft.mxlOpeningMode = 'platform';
    const platform = await h.panel.reviewSetup(draft, h.uri.toString());
    assert.ok(!platform.settings.some((change: any) => change.key === 'kotTestToolkit.paths.fileWorkshopExe'));
    assert.throws(() => h.panel.setupDraft({ ...draft, mxlOpeningMode: 'unrecognized' }), /Invalid MXL/u);
});

test('an explicitly skipped environment check preserves execution paths without requiring file checks or an empty platform', async () => {
    const h = fixture();
    const keys = ['kotTestToolkit.editor.newScenarioLanguage', 'kotTestToolkit.newScenarioDefaults.format', 'kotTestToolkit.runVanessa.vanessaEpfPath',
        'kotTestToolkit.paths.buildScenarioBddEpf', 'kotTestToolkit.steps.catalogMode'];
    h.panel.model = { strings: {}, settings: keys.map(key => ({ key, configScope: 'resource' })) };
    h.panel.session = { snapshot: () => keys.map(key => ({ key, token: 'before' })) };
    h.panel.checkRuntime = async () => { throw new Error('Should not check environment when explicitly skipped'); };
    const draft = { route: 'sppr', mode: 'sppr', language: 'ru', format: 'native', sources: 'tests', libraries: '', run: true,
        platform: '', vanessa: 'tools/missing-va.epf', compiler: 'build/missing-compiler.epf', profileId: 'existing', catalogMode: 'online', skipRuntimeCheck: true };
    const review = await h.panel.reviewSetup(draft, h.uri.toString());
    assert.equal(review.skipRuntimeCheck, true); assert.equal(review.run, true);
    assert.equal(review.settings.find((change: any) => change.key === 'kotTestToolkit.paths.buildScenarioBddEpf').value, draft.compiler);
    assert.equal(review.settings.find((change: any) => change.key === 'kotTestToolkit.runVanessa.vanessaEpfPath').value, draft.vanessa);
    assert.ok(!review.settings.some((change: any) => change.key === 'kotTestToolkit.platforms.catalog'));
    assert.throws(() => h.panel.setupDraft({ ...draft, skipRuntimeCheck: 'yes' }), /Invalid runtime check/u);
    await assert.rejects(h.panel.reviewSetup({ ...draft, skipRuntimeCheck: false }, h.uri.toString()), /Should not check environment/u);
});

test('setup completes and persists readiness without waiting for Vanessa interaction', async () => {
    const h = fixture(); let prepareCalled = false;
    h.panel.bindExecution(() => { prepareCalled = true; return new Promise(() => {}); });
    let result: any;
    void h.panel.applySetup('review', 'request').then((value: unknown) => { result = value; });
    await flush();
    assert.equal(result?.complete, true);
    assert.equal(prepareCalled, false);
    assert.equal((h.saved.values().next().value as any).step, 6);
    assert.ok(h.events.some(event => event.type === 'setupProgress' && event.id === 'request' && event.label === 'Reading scenario source files…'));
});

test('the workspace page forwards catalog preparation for settings and setup without blocking project application', async () => {
    const h = fixture(); let changed!: (event: { workspaceFolderUri: typeof h.uri }) => void;
    const progress = { phase: 'exporting', completed: 3, total: 10 };
    (h.workspace as any).getConfiguration = () => ({ get: (key: string, fallback: unknown) => key === 'steps.catalogMode' ? 'offline' : fallback });
    h.panel.bindStepCatalogs({ getPreparationState: () => progress, onDidChangePreparation: (callback: typeof changed) => { changed = callback; return { dispose() {} }; } });
    changed({ workspaceFolderUri: h.uri }); await flush();
    const event = h.events.find(event => event.type === 'catalogProgress') as any;
    assert.equal(event.folder, h.uri.toString()); assert.equal(event.catalog.mode, 'offline');
    assert.deepEqual(event.catalog.progress, progress);
    assert.equal((await h.panel.applySetup('review', 'apply')).complete, true);
});

test('setup reserves application before asynchronous preflight and releases it on error', async () => {
    const h = fixture(); h.panel.review.profileApplied = false;
    const profile = { buildParameters: [] };
    h.panel.review.profileToken = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    let reject!: (error: Error) => void;
    h.manager.loadActiveProfileSnapshot = () => new Promise((_resolve, fail) => { reject = fail; });
    const first = h.panel.applySetup('review', 'first');
    await assert.rejects(h.panel.applySetup('review', 'second'), /Review the setup changes again/u);
    reject(new Error('Profile unavailable'));
    await assert.rejects(first, /Profile unavailable/u);
    assert.equal(h.panel.applying, false);
});

test('a failed Vanessa preparation retains completed setup and can be retried', async () => {
    const h = fixture(); await h.panel.applySetup('review', 'apply');
    let fail!: (error: Error) => void;
    h.panel.bindExecution(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = h.panel.retryExecution(h.uri.toString());
    await assert.rejects(h.panel.retryExecution(h.uri.toString()), /already in progress/u);
    fail(new Error('Launch failed'));
    await assert.rejects(first, /Launch failed/u);
    const saved = h.saved.values().next().value as any;
    assert.equal(saved.complete, true);
    assert.equal(saved.readiness.executionError, 'Launch failed');
    h.panel.bindExecution(async () => true);
    assert.equal((await h.panel.retryExecution(h.uri.toString())).executionReady, true);
    assert.equal((h.saved.values().next().value as any).readiness.executionError, '');
});

test('environment setup with an old completed window state does not enable the project format', async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'kot-legacy-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const h=fixture(root);await h.panel.applySetup('review','legacy');
    assert.equal(projectFormatModule.projectFormat(root).kind,'legacy');assert.equal(projectSetupGateModule.isProjectSetupPending(root),true);
});
test('an explicit reviewed transition writes the branch marker and preserves legacy sources while importing', async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'kot-explicit-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const h=fixture(root,async()=>{assert.equal(projectFormatModule.projectFormat(root).kind,'v3');assert.equal(projectSetupGateModule.projectTransitionPreservesSource(path.join(root,'scen.yaml')),true);});
    h.panel.review.draft.transition=true;h.panel.review.projectFormat=projectFormatModule.projectFormat(root);
    await h.panel.applySetup('review','transition');assert.equal(projectFormatModule.projectFormat(root).kind,'v3');assert.equal(projectSetupGateModule.projectTransitionPreservesSource(root),false);
});
test('failed transition revokes its marker and leaves the branch in legacy mode', async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'kot-failed-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const h=fixture(root,async()=>{throw new Error('Import interrupted');});h.panel.review.draft.transition=true;
    await assert.rejects(h.panel.applySetup('review','failed'),/interrupted/u);
    assert.equal(projectFormatModule.projectFormat(root).kind,'legacy');assert.equal(projectSetupGateModule.projectTransitionPreservesSource(root),false);
});
