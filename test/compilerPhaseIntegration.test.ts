import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import * as artifacts from '../src/compilerArtifacts';
import * as syntax from '../src/scenarioCompilerSyntax';
import * as parameters from '../src/compilerBuildParameters';
import * as preflight from '../src/compilerBuildPreflight';
import * as sourceSelection from '../src/compilerBuildSourceSelection';
import * as runtimeIdentity from '../src/scenarioRuntimeIdentity';
import * as processSelection from '../src/compilerProcessSelection';
import * as compilerProcesses from '../src/compilerProcesses';
import * as compilerReports from '../src/compilerBuildReport';
import * as compilerManifestStore from '../src/compilerBuildManifestStore';
import * as compilerRuntime from '../src/compilerBuildRuntime';
import * as artifactPaths from '../src/workspaceArtifactPath';
import * as controlSourceMapping from '../src/vanessaControlSourceMapping';

function fixture(dependencies: Record<string, unknown> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-compiler-ui-'));
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
    const shown: { file: string; line?: number }[] = [];
    const notifications: string[] = [];
    const previews: string[] = [];
    const vscode = {
        commands: { executeCommand: async (command: string, resource: ReturnType<typeof uri>) => { if (command === 'markdown.showPreview') { previews.push(resource.fsPath); } } },
        EventEmitter: class {}, Uri: { file: uri, parse: (value: string) => uri(value.slice('file://'.length)), joinPath: (base: ReturnType<typeof uri>, ...segments: string[]) => uri(path.join(base.fsPath, ...segments)) },
        RelativePattern: class { constructor(public baseUri: ReturnType<typeof uri>, public pattern: string) {} },
        ProgressLocation: { Notification: 1 },
        workspace: {
            textDocuments: [] as Array<{ uri: ReturnType<typeof uri>; isDirty: boolean }>,
            workspaceFolders: [{ uri: uri(root) }],
            getConfiguration: () => ({ get: () => '' }),
            fs: { readFile: async (value: ReturnType<typeof uri>) => fs.promises.readFile(value.fsPath),
                writeFile: async (value: ReturnType<typeof uri>, bytes: Buffer) => fs.promises.writeFile(value.fsPath, bytes),
                createDirectory: async (value: ReturnType<typeof uri>) => fs.promises.mkdir(value.fsPath, { recursive: true }),
                stat: async (value: ReturnType<typeof uri>) => fs.promises.stat(value.fsPath) },
            findFiles: async () => fs.readdirSync(root).filter(file => file.endsWith('.yaml')).map(file => uri(path.join(root, file))),
            openTextDocument: async (value: ReturnType<typeof uri>) => {
                const source = await fs.promises.readFile(value.fsPath, 'utf8');
                return { uri: value, getText: () => source, lineCount: source.split('\n').length,
                    lineAt: (line: number) => ({ range: { start: { line, character: 0 }, end: { line, character: 2 } } }) };
            }
        },
        Selection: class { constructor(public start: { line: number }, public end: { line: number }) {} },
        TextEditorRevealType: { InCenter: 1 },
        window: { showWarningMessage() {}, showInformationMessage: async () => undefined,
            showErrorMessage: async (text: string) => { notifications.push(text); },
            withProgress: async (_options: unknown, work: any) => work({ report() {} }, { onCancellationRequested() {} }),
            showTextDocument: async (document: { uri: ReturnType<typeof uri> }) => {
            const item: { file: string; line?: number } = { file: document.uri.fsPath }; shown.push(item);
            return { set selection(value: { start: { line: number } }) { item.line = value.start.line; }, revealRange() {} };
        } }
    };
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/phaseSwitcher.ts'), 'utf8');
    const module = { exports: {} as Record<string, any> };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        module, exports: module.exports, Buffer, console, process,
        require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : name === 'vscode' ? vscode : name === 'fs' ? fs : name === 'path' ? path : name === 'os' ? os
            : name === './compilerArtifacts' ? artifacts : name === './scenarioCompilerSyntax' ? syntax
            : name === './compilerBuildParameters' ? parameters
            : name === './compilerBuildPreflight' ? preflight : name === './compilerBuildSourceSelection' ? sourceSelection
            : name === './compilerProcessSelection' ? processSelection : name === './compilerProcesses' ? compilerProcesses
            : name === './compilerBuildReport' ? compilerReports
            : name === './compilerBuildManifestStore' ? { ...compilerManifestStore,
                // Bridge JSON objects from the VM test realm into the real filesystem adapter's realm.
                captureCompilerBuildInputs: (request: Parameters<typeof compilerManifestStore.captureCompilerBuildInputs>[0]) =>
                    compilerManifestStore.captureCompilerBuildInputs({ ...request, configuration: JSON.parse(JSON.stringify(request.configuration)) }) }
                : name === './compilerBuildRuntime' ? compilerRuntime
            : name === './workspaceArtifactPath' ? artifactPaths
            : name === './vanessaControlSourceMapping' ? controlSourceMapping
            : name === './scenarioRuntimeIdentity' ? runtimeIdentity
            : name === './deferredLoader' ? { createDeferredLoader: (factory: any) => factory } : {}
    });
    const provider = Object.create(module.exports.PhaseSwitcherProvider.prototype);
    const scenario = (name: string, uid: string) => ({ name, uid, yamlFileUri: uri(path.join(root, `${name}.yaml`)), tabName: 'Smoke' });
    return { root, uri, shown, provider, scenario, vscode, notifications, previews, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('SPPR preflight blocks the actual build entry point before startup 1C, isolation or artifact clearing', async () => {
    const manager = { loadParameters: async () => [{ key: 'ScenarioFolder', value: '' }], validateCompilerBuildParameters: () => [],
        loadActiveProfileSnapshot: async (): Promise<unknown> => ({ id: 'default', name: 'Default', buildParameters: await manager.loadParameters(), additionalVanessaParameters: [], globalVanessaVariables: [] }) };
    const f = fixture({ './yamlParametersManager.js': { YamlParametersManager: { getInstance: () => manager } } });
    try {
        const info = { ...f.scenario('Process', 'flow'), kind: 'process' };
        manager.loadParameters = async () => [{ key: 'ScenarioFolder', value: f.root }];
        fs.writeFileSync(info.yamlFileUri.fsPath, 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "flow"\n    Имя: "Process"\nШагиПроцесса:\n');
        fs.writeFileSync(path.join(f.root, 'test.yaml'), `ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n    UID: "test-flow"\n    UIDПроцесса: "flow"\nПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: "Many"\n        ТипПараметра: "Строка"\n        Значение: "${Array.from({ length: 101 }, (_, i) => i).join(';')}"\n`);
        const key = info.yamlFileUri.toString();
        const catalog = { all: [info], byUri: new Map([[key, info]]), byName: new Map([['Process', [info]]]) };
        const output: string[] = []; const sideEffects: string[] = [];
        Object.assign(f.provider, {
            _context: {}, _activeBuildProcesses: new Set(), _view: { webview: { postMessage() {} } },
            t: (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/gu, (_, index) => args[Number(index)] ?? ''),
            hasAnyScenarioRunsInProgress: () => false, getOutputChannel: () => ({ clear() {}, appendLine: (text: string) => output.push(text) }),
            outputInfo: (_channel: unknown, text: string) => output.push(text), outputError: (_channel: unknown, text: string) => output.push(text),
            ensureFreshScenarioCatalog: async () => catalog,
            getMainScenarioSelectionSnapshotForBuild: async () => ({ enabledKeys: [key], disabledKeys: [], enabledNames: ['Process'], disabledNames: [], total: 1 }),
            buildScenarioFilterDecision: () => ({}), applyScenarioFilterToBuildParameters: (value: unknown) => value,
            ensureSharedStartupInfobaseReady: async () => { sideEffects.push('start-1C'); },
            clearScenarioRunArtifactsAndNotify: () => sideEffects.push('clear-artifacts'),
            temporarilyMoveDisabledScenarioTestFilesForBuild: async () => { sideEffects.push('isolate'); }
            , resolveBuildRuntimeRootUri: () => f.uri(path.join(f.root, 'runtime'))
        });
        await f.provider._handleRunAssembleScriptTypeScript('0');
        assert.ok(output.some(text => /101 parameter combinations/u.test(text)), output.join('\n'));
        assert.ok(f.notifications.some(text => /SPPR preflight failed/u.test(text)));
        assert.deepEqual(sideEffects, []); assert.equal(f.provider._isBuildInProgress, false);
        assert.deepEqual(fs.readdirSync(f.root).sort(), ['Process.yaml', 'runtime', 'test.yaml']);
        assert.deepEqual(f.previews, [path.join(f.root, 'runtime/compiler-build-report.md')]);
        assert.match(fs.readFileSync(f.previews[0], 'utf8'), /101 parameter combinations/u);
        f.vscode.workspace.textDocuments.push({ uri: info.yamlFileUri, isDirty: true });
        await assert.rejects(f.provider.verifyCompilerBuildPreflight([{ key: 'ScenarioFolder', value: f.root }], [key], catalog, f.root, {}), /Save selected compiler sources/u);
    } finally { f.dispose(); }
});

test('opening an existing Windows report makes its links relative before showing the preview in the current checkout', async () => {
    const f = fixture();
    try {
        const report = path.join(f.root, '.vscode/kot-runtime/compiler-build-report.md');
        fs.mkdirSync(path.dirname(report), { recursive: true });
        f.provider._lastCompilerBuildReportPath = report;
        fs.writeFileSync(report, '# Compiler build report\n\nLog: [log](<vscode://file/c:/Mac/Home/.vscode/kot-runtime/compiler-parts/1/yaml_build_log.txt>)\n\n'
            + 'Source: [Test:163](<file:///c:/Mac/Home/Parent%20scenarios/scen.yaml#L163>)\n');
        await f.provider.openCompilerBuildReport();
        const updated = fs.readFileSync(report, 'utf8');
        assert.match(updated, /\[Test:163\]\(<\.\.\/\.\.\/Parent%20scenarios\/scen.yaml#L163>\)/u);
        assert.match(updated, /\[log\]\(<compiler-parts\/1\/yaml_build_log\.txt>\)/u);
        assert.doesNotMatch(updated, /vscode:|file:|c:\//iu);
        assert.deepEqual(f.previews, [report]);
        await f.provider.openCompilerBuildReport();
        assert.equal(fs.readFileSync(report, 'utf8'), updated);
    } finally { f.dispose(); }
});

test('successful compiler entry point certifies final feature bytes only after settings restoration and rejects changed inputs', async () => {
    for (const changed of [false, true]) {
        let buildParameters: Array<{ key: string; value: string }> = [];
        let executable = '';
        const manager = { loadActiveProfileSnapshot: async () => ({ id: 'default', name: 'Default', buildParameters,
            additionalVanessaParameters: [], globalVanessaVariables: [] }), validateCompilerBuildParameters: () => [],
            createYamlParametersFile: async (file: string, rows: Array<{ key: string; value: string }>) => {
                await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, JSON.stringify(Object.fromEntries(rows.map(row => [row.key, row.value]))));
            } };
        const f = fixture({ './yamlParametersManager.js': { YamlParametersManager: { getInstance: () => manager } },
            './oneCPlatform.js': { resolveOneCPlatformForLaunch: async () => ({ clientExePath: executable }) } });
        try {
            const sources = path.join(f.root, 'sources'); const output = path.join(f.root, 'features');
            fs.mkdirSync(sources); executable = path.join(f.root, 'compiler.epf'); fs.writeFileSync(executable, 'fixture compiler');
            buildParameters = [{ key: 'ScenarioFolder', value: sources }, { key: 'ProcessFolder', value: sources }, { key: 'FeatureFolder', value: output }];
            const info = { ...f.scenario('Main', 'main'), yamlFileUri: f.uri(path.join(sources, 'scen.yaml')) };
            const source = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: "main"\n    Имя: "Main"\n    Код: "Main"\nТекстСценария: |\n    And Delay 1\n';
            fs.writeFileSync(info.yamlFileUri.fsPath, source);
            const disabled = path.join(sources, 'disabled.yaml'); fs.writeFileSync(disabled, '# temporarily isolated settings\n');
            const temporary = path.join(f.root, 'disabled-temporary');
            const key = info.yamlFileUri.toString(); const catalog = { all: [info], byUri: new Map([[key, info]]), byName: new Map([['Main', [info]]]) };
            const outputLines: string[] = []; const events: string[] = [];
            Object.assign(f.provider, {
                _context: {}, _activeBuildProcesses: new Set(), _view: { webview: { postMessage() {} } },
                t: (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/gu, (_, index) => args[Number(index)] ?? ''),
                hasAnyScenarioRunsInProgress: () => false, isMainScenario: () => true,
                getOutputChannel: () => ({ clear() {}, appendLine: (text: string) => outputLines.push(text) }),
                outputInfo: (_channel: unknown, text: string) => outputLines.push(text), outputError: (_channel: unknown, text: string) => outputLines.push(text), outputAdvanced() {},
                ensureFreshScenarioCatalog: async () => catalog,
                getMainScenarioSelectionSnapshotForBuild: async () => ({ enabledKeys: [key], disabledKeys: [], isolatedDisabledKeys: [], enabledNames: ['Main'], disabledNames: [], total: 1 }),
                buildScenarioFilterDecision: () => ({}), applyScenarioFilterToBuildParameters: (value: unknown) => value,
                getProjectPaths: () => ({ buildScenarioBddEpf: f.uri(executable) }),
                resolveBuildRuntimeRootUri: () => f.uri(path.join(f.root, 'runtime')),
                ensureSharedStartupInfobaseReady: async () => ({ infobaseDirectory: '/fixture-base', authentication: {} }),
                buildStartupParams: () => [], buildBuildScenarioBddArgs: (settings: string) => [settings],
                clearScenarioRunArtifactsAndNotify() {}, rearmScenarioArtifactBuildRootWatcher() {},
                updateScenarioBuildArtifacts: async () => {}, ensureUniqueVanessaRuntimePathsForArtifacts: async () => {}, ensureCombinedScenarioJsonArtifacts: async () => {}, sendRunArtifactsStateToWebview() {},
                prepareBuildErrorsFolder: async (directory: { fsPath: string }) => fs.promises.mkdir(path.join(directory.fsPath, 'BuildErrors'), { recursive: true }),
                temporarilyMoveDisabledScenarioTestFilesForBuild: async () => {
                    await fs.promises.rename(disabled, temporary); events.push('isolated');
                    return { temporaryRootUri: null, movedFiles: [{ sourceUri: f.uri(disabled), temporaryUri: f.uri(temporary) }], mode: 'legacy' };
                },
                restoreTemporarilyMovedDisabledScenarioFiles: async () => {
                    assert.equal(await compilerManifestStore.readCompilerBuildManifest(output), undefined, 'no manifest before restoration');
                    await fs.promises.rename(temporary, disabled); events.push('restored'); return 0;
                },
                execute1CProcess: async (_exe: string, args: string[]) => {
                    assert.equal(fs.existsSync(disabled), false);
                    const settings = JSON.parse(await fs.promises.readFile(args.at(-1)!, 'utf8'));
                    await fs.promises.writeFile(settings.ResultFile, '0');
                    await fs.promises.writeFile(settings.JUnitFile, '<testsuites><testsuite name="Compile" tests="1" failures="0" errors="0"><testcase name="Main"/></testsuite></testsuites>');
                    await fs.promises.writeFile(path.join(settings.FeatureFolder, 'Main.feature'), '# language: en\nFeature: Main\nScenario: Safe\n    And Delay RecordGLAccountsParameterFromPipeline\n');
                    await fs.promises.writeFile(path.join(settings.FeatureFolder, 'Main.str'), '{}');
                    if (changed) { await fs.promises.writeFile(info.yamlFileUri.fsPath, source + '# changed during build\n'); }
                }
            });
            await f.provider._handleRunAssembleScriptTypeScript('1');
            assert.deepEqual(events, ['isolated', 'restored'], outputLines.join('\n'));
            assert.ok(outputLines.some(line => line.includes('completed successfully')), outputLines.join('\n'));
            const manifest = await compilerManifestStore.readCompilerBuildManifest(output);
            assert.equal(!!manifest, !changed, outputLines.join('\n'));
            if (manifest) {
                const files = await compilerManifestStore.readCompilerBuildManifestArtifacts(output, manifest);
                assert.ok(files.contents[0].featureContent.includes('And Delay 1'), 'fingerprint uses postprocessed output');
                assert.ok(manifest.inputs.files.some(file => file.uri === f.uri(disabled).toString()), 'restored settings are included');
                const captured = await f.provider.loadVanessaYamlControlBuild();
                assert.equal(captured.manifest.inputs.digest, manifest.inputs.digest);
                assert.equal(captured.outputRoot, output); assert.ok(Object.isFrozen(captured));
                f.vscode.workspace.textDocuments.push({ uri: f.uri(disabled), isDirty: true });
                await assert.rejects(f.provider.loadVanessaYamlControlBuild(), /Save YAML sources and dependencies/u);
            }
        } finally { f.dispose(); }
    }
});

test('direct process edits mark the process and callers stale before refreshing the catalog', () => {
    const f = fixture();
    try {
        const uri = f.uri(path.join(f.root, 'process.yaml'));
        const process = { scenarioKey: 'process', scenarioName: 'Old process', sourceUri: uri };
        const parent = { scenarioKey: 'parent', scenarioName: 'Parent', sourceUri: f.uri(path.join(f.root, 'parent.yaml')) };
        Object.assign(f.provider, {
            _scenarioBuildArtifacts: new Map([['process', process], ['parent', parent]]),
            _staleBuiltScenarioNames: new Set(), _scenarioExecutionStates: new Map(),
            getScenarioNamesRelatedToUri: () => ['New process'], getScenarioNamesByArtifactSourceUri: () => ['Old process'],
            buildCallersByCalleeFromCache: () => new Map([['Old process', new Set(['Parent'])]]),
            sendRunArtifactsStateToWebview: () => {}, invalidateScenarioCatalog: () => {}
        });
        f.provider.notifyProcessSourceFilesChanged([uri]);
        assert.deepEqual([...f.provider._staleBuiltScenarioNames].sort(), ['parent', 'process']);
    } finally { f.dispose(); }
});

test('grouped features associate every tagged scenario with their shared JSON across worker namespaces', async () => {
    const f = fixture();
    try {
        const a = f.scenario('A', 'uid-a'); const b = f.scenario('B', 'uid-b'); const c = f.scenario('C', 'uid-c');
        const all = [a, b, c];
        const catalog = { all, byUri: new Map(all.map(info => [info.yamlFileUri.toString(), info])), byName: new Map(all.map(info => [info.name, [info]])) };
        Object.assign(f.provider, { _scenarioBuildArtifacts: new Map(), _staleBuiltScenarioNames: new Set(), _scenarioExecutionStates: new Map(), _scenarioLastLaunchContexts: new Map(), getScenarioCatalog: () => catalog,
            pruneScenarioBuildArtifactsByCache() {}, updateStandaloneCompiledExclusions() {}, clearFeatureStepHighlightsForScenarios() {}, wasScenarioArtifactRebuiltSince: () => true,
            resolveScenarioNameForFeatureArtifact: async () => null, normalizeScenarioLookupKey: (value: string) => value.toLowerCase(), tryResolveScenarioByName: () => null });
        const files = ['part-1/group', 'part-2/group'].map(stem => path.join(f.root, stem));
        for (const [index, file] of files.entries()) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(`${file}.feature`, index === 0 ? '@UIDСценария=uid-a\nScenario: A\n@UIDСценария=uid-b\nScenario: B\n' : '@UIDСценария=uid-c\nScenario: C\n');
            fs.writeFileSync(`${file}.json`, '{}');
        }
        await f.provider.updateScenarioBuildArtifacts(files.map(file => f.uri(`${file}.feature`)), f.uri(f.root), undefined, files.map(file => f.uri(`${file}.json`)));
        assert.equal(f.provider._scenarioBuildArtifacts.size, 3);
        assert.equal(f.provider._scenarioBuildArtifacts.get(a.yamlFileUri.toString()).jsonPath, `${files[0]}.json`);
        assert.equal(f.provider._scenarioBuildArtifacts.get(b.yamlFileUri.toString()).jsonPath, `${files[0]}.json`);
        assert.equal(f.provider._scenarioBuildArtifacts.get(c.yamlFileUri.toString()).jsonPath, `${files[1]}.json`);
    } finally { f.dispose(); }
});

test('compiler .str navigation uses UID and body-relative line and falls back for unmapped lines', async () => {
    const f = fixture();
    try {
        const info = f.scenario('Nested', 'nested-uid');
        fs.writeFileSync(info.yamlFileUri.fsPath, 'ДанныеСценария:\n  Имя: Nested\nТекстСценария: |\n  Given first\n  And second\n');
        const feature = path.join(f.root, 'built.feature');
        fs.writeFileSync(`${feature.slice(0, -8)}.str`, JSON.stringify({ ДанныеСценария: [{ UIDСценария: 'nested-uid', СтрокаЛин: 10, СтрокаОриг: 2, УровеньВложенности: 1 }] }));
        f.provider.getScenarioCatalog = () => ({ all: [info] });
        assert.equal(await f.provider.openCompilerSourceAtFeatureLine(feature, 10), true);
        assert.deepEqual(f.shown, [{ file: info.yamlFileUri.fsPath, line: 4 }]);
        assert.equal(await f.provider.openCompilerSourceAtFeatureLine(feature, 11), false);
        assert.equal(f.shown.length, 1);
    } finally { f.dispose(); }
});

test('shared artifact members receive running and final states from a single launch', () => {
    const f = fixture();
    try {
        const keys = ['a', 'b'];
        Object.assign(f.provider, { _scenarioExecutionStates: new Map(), _scenarioBuildArtifacts: new Map(keys.map(key => [key, { scenarioKey: key, scenarioName: key, featurePath: '/group.feature', jsonPath: '/group.json' }])),
            resolveRuntimeKeyForScenario: (_: string, key: string) => key, getScenarioBuildArtifact: (_: string, key: string) => f.provider._scenarioBuildArtifacts.get(key),
            isTrackedRunSelectedForScenario: () => false });
        for (const method of ['setActiveTrackedRunForScenario', 'stopLiveRunLogWatcher', 'clearRunningFeatureStepHighlight', 'clearFailedFeatureStepHighlight', 'startFeatureStepTracker', 'stopFeatureStepTracker', 'captureFailedStepHighlight', 'refreshScenarioHighlightsBySelectedRunSource', 'sendRunArtifactsStateToWebview']) { f.provider[method] = () => {}; }
        f.provider.t = (text: string) => text;
        f.provider.setScenarioExecutionState('a', 'running', undefined, '/run.log', 'a');
        assert.equal(f.provider._scenarioExecutionStates.get('b')?.status, 'running');
        f.provider.setScenarioExecutionState('a', 'failed', 'failed', '/run.log', 'a');
        assert.equal(f.provider._scenarioExecutionStates.get('b')?.status, 'failed');
        f.provider.setScenarioExecutionState('a', 'idle', undefined, undefined, 'a');
        assert.equal(f.provider._scenarioExecutionStates.size, 0);
    } finally { f.dispose(); }
});

test('feature-only compilation does not start the built-in launcher', () => {
    const f = fixture();
    try {
        f.provider.t = (text: string) => text;
        assert.equal(f.provider.resolveScenarioLaunchTarget('Feature only', { featurePath: '/only.feature' }), null);
    } finally { f.dispose(); }
});

test('compiler error checker includes errors and nested reports even alongside passing JUnit', async () => {
    const f = fixture();
    try {
        fs.mkdirSync(path.join(f.root, 'nested'));
        fs.writeFileSync(path.join(f.root, 'junit.xml'), '<testsuite tests="1" failures="0" errors="0"><testcase name="passed"/></testsuite>');
        fs.writeFileSync(path.join(f.root, 'nested', 'error.xml'), '<Ошибка><Описание>Failure</Описание></Ошибка>');
        f.provider.t = (text: string) => text;
        f.provider.outputError = () => {};
        const result = await f.provider.checkBuildErrors(f.uri(f.root), {});
        assert.equal(result.hasErrors, true);
        assert.equal(result.errorCount, 1);
    } finally { f.dispose(); }
});


test('changing one grouped source makes every bundle member stale', () => {
    const f = fixture();
    try {
        Object.assign(f.provider, { _scenarioBuildArtifacts: new Map(['a', 'b'].map(key => [key, { scenarioKey: key, scenarioName: key, featurePath: '/group.feature' }])),
            _staleBuiltScenarioNames: new Set(), _scenarioExecutionStates: new Map(), buildCallersByCalleeFromCache: () => new Map() });
        f.provider.markBuiltArtifactsAsStale(['a']);
        assert.equal(f.provider._staleBuiltScenarioNames.has('a'), true);
        assert.equal(f.provider._staleBuiltScenarioNames.has('b'), true);
    } finally { f.dispose(); }
});

test('artifact discovery includes every worker namespace for a selected model database', () => {
    const f = fixture();
    try {
        f.provider.resolveFeatureFolderUriFromBuildParameters = () => f.uri('/features');
        assert.equal(f.provider.resolveFeatureArtifactsRootUri(f.uri(f.root), [{ key: 'ModelDBid', value: 'QA' }, { key: 'ThreadsCount', value: '3' }]).fsPath, '/features');
    } finally { f.dispose(); }
});


test('nested-process builds use exclusion filters even when few scenarios are enabled', () => {
    const f = fixture();
    try {
        const snapshot = { total: 4, enabledNames: ['One'], disabledNames: ['Two', 'Three', 'Four'] };
        assert.deepEqual(JSON.parse(JSON.stringify(f.provider.buildScenarioFilterDecision(snapshot, true))), { key: 'Exceptscenario', names: ['Two', 'Three', 'Four'] });
        const result = f.provider.applyScenarioFilterToBuildParameters([{ key: 'Scenario_Filter', value: 'One' }], { key: 'Exceptscenario', names: ['Two'] });
        assert.equal(result.some((item: { key: string }) => item.key === 'Scenario_Filter'), false);
    } finally { f.dispose(); }
});
