import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { SpprCompilerExportError } from '../src/spprCompilerExport';

function fixture(options: { cancelSource?: boolean; cancelSave?: boolean; cancelProgress?: boolean; trusted?: boolean; authRetry?: boolean; runningSource?: string } = {}) {
    class Uri {
        constructor(readonly fsPath: string) {}
        static file(file: string) { return new Uri(file); }
        static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.fsPath, ...parts)); }
    }
    const folder = { uri: Uri.file(path.resolve('artifacts/command-project')) };
    const source = path.resolve('source-sppr');
    const prepared: string[] = []; const requests: any[] = []; const updates: unknown[][] = []; const errors: string[] = [];
    const reports: unknown[] = []; let prompts = 0; let picks = 0; let saves = 0; let platformPickers = 0;
    let registered!: () => Promise<string | undefined>;
    const token = { isCancellationRequested: options.cancelProgress ?? false };
    const t = (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_, index: string) => args[Number(index)] ?? '');
    const mocks: Record<string, unknown> = {
        vscode: { Uri, ProgressLocation: { Notification: 15 }, ConfigurationTarget: { Workspace: 2 },
            commands: { registerCommand: (_name: string, callback: typeof registered) => { registered = callback; return {}; } },
            workspace: { isTrusted: options.trusted !== false, workspaceFolders: [folder], getWorkspaceFolder: () => folder,
                getConfiguration: () => ({ get: (_key: string, fallback: string) => fallback, update: async (...args: unknown[]) => { updates.push(args); } }) },
            window: { showSaveDialog: async () => { saves++; return options.cancelSave ? undefined : Uri.joinPath(folder.uri, 'build', 'exported.epf'); },
                withProgress: async (_options: unknown, callback: (progress: unknown, cancellation: unknown) => Promise<unknown>) => callback({ report: (value: unknown) => reports.push(value) }, token),
                showInformationMessage() {}, showErrorMessage: (message: string) => errors.push(message) } },
        './localization': { getTranslator: async () => t },
        './infobaseManager': { pickManagedInfobasePath: async (_context: unknown, _t: unknown, selection: unknown) => { picks++; assert.deepEqual(JSON.parse(JSON.stringify(selection)), {
            allowBuildOnly: false, allowCreateNew: false, allowedKinds: ['file', 'server'], placeHolder: 'Select the SPPR infobase containing the compiler' }); return options.cancelSource ? undefined : source; },
            getCachedInfobaseAuthentication: () => null, getManagedInfobasePreferredPlatformClientExePath: () => undefined,
            isInfobaseAuthenticationError: (message: string) => message.includes('not authenticated'),
            promptAndCacheInfobaseAuthentication: async () => { prompts++; return { username: 'compiler-user', password: 'private' }; } },
        './oneCInfobaseConnection': { getFileInfobasePath: () => source, buildInfobaseConnectionArgument: (base: string) => `File=${base}` },
        './oneCInfobasePlatform': { runningOneCInfobasePlatform: async () => options.runningSource },
        './oneCPlatform': { resolveOneCDesignerExePath: (client: string) => client + '-designer',
            resolveOneCPlatformForLaunch: async (_t: unknown, selection: { promptUser: boolean }) => { platformPickers++; assert.equal(selection.promptUser, false); return { clientExePath: 'default-platform' }; } },
        './sharedStartupPlatform': { resolveSharedStartupPlatform: async () => ({ clientExePath: 'running-service-platform' }) },
        './startupInfobase': { ensureSharedStartupInfobaseReady: async (_context: unknown, client: string) => { prepared.push(client); return { infobaseDirectory: 'service-ib', authentication: { username: 'service-user', password: '' } }; } },
        './kotSettingsPaths': { portableSettingPath: (_root: string, selected: string) => path.relative(folder.uri.fsPath, selected).split(path.sep).join('/') },
        './spprCompilerExport': { SpprCompilerExportError, exportSpprCompiler: async (request: any, dependencies: any) => {
            requests.push(request);
            if (options.authRetry && requests.length === 1) { throw new SpprCompilerExportError('reading', 'User is not authenticated'); }
            dependencies.progress('reading'); const build = await dependencies.prepareBuild(); requests.at(-1).build = build;
            return request.destination;
        } },
        './directProcessLaunch': {}, './vanessaControlRedaction': { redactVanessaDiagnosticText: (value: string) => value }
    };
    const module = { exports: {} as { exportSpprCompilerFromInfobase(...args: unknown[]): Promise<string | undefined>; registerSpprCompilerExportCommand(context: unknown): void } };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/spprCompilerExportCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, process: { platform: 'win32', env: {} }, require: (name: string) => name.startsWith('node:') ? require(name) : mocks[name] });
    const context = { extensionUri: Uri.file(path.resolve('.')), subscriptions: [] };
    module.exports.registerSpprCompilerExportCommand(context);
    return { draft: () => module.exports.exportSpprCompilerFromInfobase(context, folder, 'build/draft.epf'), palette: () => registered(),
        requests, updates, prepared, errors, reports, prompts: () => prompts, picks: () => picks, saves: () => saves, platformPickers: () => platformPickers };
}

test('wizard/settings export returns a relative draft path and independently respects the running service platform', async () => {
    const h = fixture({ runningSource: 'source-running-platform' });
    assert.equal(await h.draft(), 'build/exported.epf'); assert.deepEqual(h.updates, []);
    assert.equal(h.requests[0].source.executable, 'source-running-platform-designer'); assert.equal(h.platformPickers(), 0);
    assert.equal(h.requests[0].build.executable, 'running-service-platform-designer'); assert.deepEqual(h.prepared, ['running-service-platform']);
    assert.equal(h.reports.length, 1); assert.equal(h.prompts(), 0);
});

test('palette export saves the compiler path and retries only a source authentication failure', async () => {
    const h = fixture({ authRetry: true });
    assert.equal(await h.palette(), 'build/exported.epf'); assert.equal(h.prompts(), 1);
    assert.equal(h.requests.length, 2); assert.equal(h.requests[0].source.args.includes('/P'), false);
    assert.equal(h.requests[1].source.args.at(-1), 'private'); assert.equal(h.requests[1].source.args.at(-3), 'compiler-user');
    assert.equal(h.requests[1].source.executable, 'default-platform-designer');
    assert.deepEqual(h.updates, [['paths.buildScenarioBddEpf', 'build/exported.epf', 2]]); assert.deepEqual(h.errors, []);
});

for (const option of ['cancelSource', 'cancelSave', 'cancelProgress'] as const) {
    test(`${option} does not prepare the service IB or change settings`, async () => {
        const h = fixture({ [option]: true }); assert.equal(await h.draft(), undefined);
        assert.deepEqual(h.requests, []); assert.deepEqual(h.prepared, []); assert.deepEqual(h.updates, []);
        if (option === 'cancelSource') { assert.equal(h.saves(), 0); }
    });
}

test('untrusted workspace cannot open a source picker or launch 1C', async () => {
    const h = fixture({ trusted: false }); await assert.rejects(h.draft(), /Trust the workspace/u);
    assert.equal(h.picks(), 0); assert.deepEqual(h.requests, []);
});
