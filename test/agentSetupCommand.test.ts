import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as setup from '../src/agentSetup';
import * as store from '../src/agentStore';
import * as workspace from '../src/agentWorkspace';
import type { AgentInfobasePorts } from '../src/agentInfobases';
import * as descriptions from '../src/agentScenarioDescription';
import * as nativeSnapshot from '../src/scenarioNativeDocumentSnapshot';

async function fixture(t: test.TestContext, choices: Array<number | undefined>, trusted = true, probeFails = false, nextAction: string | null = 'Copy first request') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-ai-wizard-'));
    const extensionPath = path.join(root, 'extension'); const subscriptions: Array<{ dispose(): unknown }> = [];
    t.after(async () => { subscriptions.forEach(item => item.dispose()); await new Promise(resolve => setImmediate(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    await fs.mkdir(path.join(extensionPath, 'out'), { recursive: true });
    await fs.mkdir(path.join(extensionPath, 'res/agent/kot-testing'), { recursive: true });
    await fs.writeFile(path.join(extensionPath, 'out/agent-mcp.cjs'), 'bundled bridge');
    await fs.writeFile(path.join(extensionPath, 'res/agent/kot-testing/SKILL.md'), 'KOT skill');
    const commands = new Map<string, () => Promise<void>>(); const errors: string[] = []; const copied: string[] = [];
    const registrations: Array<{ infobase: string; name: string }> = []; const executedCommands: string[] = [];
    const commandArguments: unknown[][] = []; const notifications: Array<{ message: string; actions: string[] }> = [];
    let infobases: AgentInfobasePorts | undefined;
    let scenarioDescription: import('../src/agentService').AgentServicePorts['scenarioDescription'];
    let agentWorkspace: workspace.AgentWorkspace | undefined; let allowAccess = false;
    const accessPrompts: Array<{ message: string; modal: boolean; detail: string }> = [];
    const refreshed: string[][] = []; let standaloneRefreshes = 0;
    const documents = new Map<string, { uri: { fsPath: string }; isDirty: boolean; getText(): string; positionAt(offset: number): number; save(): Promise<boolean>; text: string }>();
    const updates: Array<{ key: string; value: unknown; target: number }> = []; let probes = 0; let picks = 0;
    const l10n = { t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/gu, (_, index: string) => String(args[Number(index)])) };
    const status: any = { shown: 0, disposed: false, show() { this.shown++; }, dispose() { this.disposed = true; } };
    let startServer = async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'a'.repeat(64) });
    let closeServer = async () => {};
    const host = {
        l10n, ConfigurationTarget: { Workspace: 2 }, ProgressLocation: { Notification: 15 },
        StatusBarAlignment: { Left: 1 }, ThemeColor: class { constructor(readonly id: string) {} },
        Range: class { constructor(readonly start: number, readonly end: number) {} },
        WorkspaceEdit: class { edits: Array<{ uri: { fsPath: string }; text: string }> = []; replace(uri: { fsPath: string }, _range: unknown, text: string) { this.edits.push({ uri, text }); } },
        Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
        workspace: { isTrusted: trusted, workspaceFolders: [{ uri: { fsPath: root } }], textDocuments: [],
            openTextDocument: async (uri: { fsPath: string }) => {
                let document = documents.get(uri.fsPath);
                if (!document) {
                    const fileText = await fs.readFile(uri.fsPath, 'utf8'); const bom = fileText.startsWith('\uFEFF') ? '\uFEFF' : '';
                    document = { uri, isDirty: false, text: fileText.replace(/^\uFEFF/u, ''), getText() { return this.text; }, positionAt: offset => offset,
                        async save() { await fs.writeFile(this.uri.fsPath, bom + this.text); this.isDirty = false; return true; } };
                    documents.set(uri.fsPath, document);
                }
                return document;
            },
            applyEdit: async (edit: { edits: Array<{ uri: { fsPath: string }; text: string }> }) => {
                for (const item of edit.edits) { const document = documents.get(item.uri.fsPath)!; document.text = item.text; document.isDirty = true; } return true;
            },
            getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'runtime.directory' ? '.runtime' : fallback,
                update: async (key: string, value: unknown, target: number) => { updates.push({ key, value, target }); } }),
            onDidChangeConfiguration: () => ({ dispose() {} }) },
        window: { createStatusBarItem: (id: string, alignment: number, priority: number) => { Object.assign(status, { id, alignment, priority }); return status; },
            showTextDocument: async () => {},
            showQuickPick: async (items: unknown[]) => { const choice = choices[picks++]; return choice === undefined ? undefined : items[choice]; },
            withProgress: async (_options: unknown, work: (progress: { report(value: unknown): void }) => unknown) => work({ report() {} }),
            showInformationMessage: async (message: string, ...actions: string[]) => { notifications.push({ message, actions }); return nextAction ?? undefined; },
            showWarningMessage: async (message: string, options: { modal: boolean; detail: string }, action: string) => { accessPrompts.push({ message, ...options }); return allowAccess ? action : undefined; },
            showErrorMessage: async (message: string) => { errors.push(message); } },
        env: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
        commands: { registerCommand: (name: string, command: () => Promise<void>) => { commands.set(name, command); return { dispose() {} }; },
            executeCommand: async (name: string, ...args: unknown[]) => { executedCommands.push(name); commandArguments.push(args); } }
    };
    const mocks: Record<string, unknown> = {
        vscode: host, 'node:fs/promises': fs, 'node:fs': { readFileSync }, 'node:path': path,
        './agentStore': store, './agentWorkspace': workspace,
        './agentScenarioDescription': descriptions,
        './scenarioNativeDocumentSnapshot': nativeSnapshot,
        './projectLibraryIntegration': { projectLibraryEnvironment: () => ({ workspaceRoots: [root], scanRoots: [root] }), assertProjectMetadataSaved() {} },
        './scenarioScanRoot': { getScenarioScanRootPath: () => '.' },
        './formExplorerPaths': { getFormExplorerConfigurationSourceDirectory: () => undefined },
        './infobasePicker': { registerInfobaseInLauncher: async (infobase: string, name: string) => {
            registrations.push({ infobase, name }); return { status: 'added', registeredName: name, sourceFilePath: 'ibases.v8i' };
        } },
        './agentSetup': { ...setup, configureAgentClient: (folder: string, directory: string, client: setup.AgentSetupClient, launch: setup.AgentSetupServer, skill: string) =>
            setup.configureAgentClient(folder, directory, client, JSON.parse(JSON.stringify(launch)), skill), checkAgentSetup: async (launch: setup.AgentSetupServer) => {
            probes++; assert.equal(await fs.readFile(launch.args[0], 'utf8'), 'bundled bridge');
            if (probeFails) { throw new Error('Install Node.js 20 or newer, then restart VS Code.'); }
            return { node: 'v20.11.0', tools: 34, workflows: 6 };
        } },
        './agentMcpServer': { AgentMcpServer: class { start() { return startServer(); } close() { return closeServer(); } } },
        './agentService': { AgentService: class { constructor(readonly workspace: workspace.AgentWorkspace, readonly store: unknown, ports: { infobases: AgentInfobasePorts; scenarioDescription: typeof scenarioDescription }) { agentWorkspace = workspace; infobases = ports.infobases; scenarioDescription = ports.scenarioDescription; } async dispose() {} } }
    };
    const exports: Record<string, any> = {};
    vm.runInNewContext(ts.transpileModule(readFileSync('src/agentExtension.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { exports, console, process, Buffer, Error, setTimeout, clearTimeout, require: (name: string) => name === './kotInteraction' ? nativeInteraction : (mocks[name] ?? {}) });
    exports.registerAgentExtension({ extensionPath, extensionUri: { fsPath: extensionPath }, subscriptions }, { session: { snapshot: {} },
        provider: { refreshFromExternalStateChange: async (value: { changedSourceUris: Array<{ fsPath: string }> }) => { refreshed.push(value.changedSourceUris.map(uri => uri.fsPath)); } },
        standalone: { refresh: async () => { standaloneRefreshes++; } } });
    return { root, errors, copied, updates, registrations, executedCommands, commandArguments, notifications, get infobases() { return infobases!; },
        status, host, commands, startServer: (value: typeof startServer) => { startServer = value; }, closeServer: (value: typeof closeServer) => { closeServer = value; },
        descriptions: () => scenarioDescription!, refreshed, documents, standaloneRefreshes: () => standaloneRefreshes,
        workspace: () => agentWorkspace!, accessPrompts, allowAccess: (value: boolean) => { allowAccess = value; }, stop: commands.get('kotTestToolkit.agent.stop')!,
        probes: () => probes, picks: () => picks, run: commands.get('kotTestToolkit.agent.setup')! };
}

test('the status bar reflects actual startup and serialized shutdown before a restart', async t => {
    const h = await fixture(t, []);
    assert.equal(h.status.id, 'kotTestToolkit.agentServer'); assert.equal(h.status.priority, 18);
    assert.match(h.status.text, /stopped/u); assert.equal(h.status.command, 'kotTestToolkit.agent.start');
    let releaseStart!: () => void; const ready = new Promise<void>(resolve => { releaseStart = resolve; });
    let enteredStart!: () => void; const listening = new Promise<void>(resolve => { enteredStart = resolve; });
    let starts = 0; h.startServer(async () => { starts++; enteredStart(); await ready; return { url: 'http://127.0.0.1:1234/mcp', token: 'private-status-token' }; });
    const first = h.commands.get('kotTestToolkit.agent.start')!(); await listening;
    let secondFinished = false; const second = h.commands.get('kotTestToolkit.agent.start')!().then(() => { secondFinished = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(secondFinished, false);
    assert.match(h.status.text, /loading~spin.*starting/u); assert.equal(h.status.command, undefined);
    releaseStart(); await Promise.all([first, second]);
    assert.equal(starts, 1); assert.match(h.status.text, /running/u); assert.equal(h.status.command, 'kotTestToolkit.agent.stop');
    assert.match(h.status.tooltip, /127\.0\.0\.1:1234/u); assert.doesNotMatch(h.status.tooltip, /private-status-token/u);
    let releaseClose!: () => void; const closed = new Promise<void>(resolve => { releaseClose = resolve; });
    let closes = 0; h.closeServer(async () => { closes++; await closed; });
    const stopped = h.stop(); const stoppedAgain = h.stop(); await new Promise(resolve => setImmediate(resolve));
    assert.match(h.status.text, /loading~spin.*stopping/u); assert.equal(h.status.command, undefined);
    const restarted = h.commands.get('kotTestToolkit.agent.start')!(); assert.equal(starts, 1);
    releaseClose(); await Promise.all([stopped, stoppedAgain, restarted]);
    assert.equal(closes, 1); assert.equal(starts, 2); assert.match(h.status.text, /running/u);
    await h.stop(); assert.match(h.status.text, /stopped/u); assert.equal(h.status.backgroundColor, undefined);
    assert.deepEqual(h.updates, []); assert.deepEqual(h.errors, []);
});

test('startup failures show an error and a successful retry clears it', async t => {
    const h = await fixture(t, []);
    h.startServer(async () => { throw new Error('Cannot listen'); });
    await h.commands.get('kotTestToolkit.agent.start')!();
    assert.match(h.status.text, /error/u); assert.equal(h.status.backgroundColor.id, 'statusBarItem.errorBackground');
    assert.equal(h.status.command, 'kotTestToolkit.agent.start'); assert.deepEqual(h.errors, ['Cannot listen']);
    h.startServer(async () => ({ url: 'http://127.0.0.1:4321/mcp', token: 'private-status-token' }));
    await h.commands.get('kotTestToolkit.agent.start')!();
    assert.match(h.status.text, /running/u); assert.equal(h.status.backgroundColor, undefined);
    await h.stop(); assert.match(h.status.text, /stopped/u);
    h.host.workspace.isTrusted = false; await h.commands.get('kotTestToolkit.agent.start')!();
    assert.match(h.status.text, /error/u);
    assert.ok(h.errors.some(message => message.includes('Trust this workspace')));
});

test('external paths require a native user decision, preserve agent settings and expire with the server', async t => {
    const h = await fixture(t, [0, 0]); await h.run(); assert.deepEqual(h.errors, []);
    const destination = path.join(path.dirname(h.root), path.basename(h.root) + '-external-base');
    const updates = JSON.stringify(h.updates);
    await assert.rejects(h.workspace().resolve(destination, true), /outside/);
    h.allowAccess(true);
    assert.equal(await h.workspace().resolve(destination, true), destination);
    assert.equal(await h.workspace().resolve(path.join(destination, '1Cv8.1CD'), true), path.join(destination, '1Cv8.1CD'));
    assert.equal(h.accessPrompts.length, 2); assert.equal(h.accessPrompts[1].modal, true);
    assert.ok(h.accessPrompts[1].detail.includes(destination)); assert.match(h.accessPrompts[1].detail, /read or change/);
    assert.equal(JSON.stringify(h.updates), updates);
    await h.stop();
    await assert.rejects(h.workspace().resolve(destination + '-other', true), /outside/);
    assert.equal(h.accessPrompts.length, 2);
});

for (const bom of ['', '\uFEFF']) {
test(`the description adapter saves ${bom ? 'BOM' : 'plain UTF-8'} through the native editor and refreshes properties/catalogs`, async t => {
    const h = await fixture(t, [0, 0]); await h.run(); assert.deepEqual(h.errors, []);
    const file = path.join(h.root, 'scen.yaml');
    await fs.writeFile(file, bom + 'ДанныеСценария:\n    Имя: Purchase\nТекстСценария: |\n    Then total is 400\n');
    const before = await h.descriptions()('read', file) as descriptions.AgentScenarioDescription;
    const saved = await h.descriptions()('set', file, { description: 'Проверяет сумму покупки.', expectedRevision: before.revision }) as descriptions.AgentScenarioDescription;
    assert.equal(saved.description, 'Проверяет сумму покупки.'); assert.equal(saved.saved, true);
    assert.ok((await fs.readFile(file, 'utf8')).includes('Проверяет сумму покупки.'));
    assert.equal((await fs.readFile(file, 'utf8')).startsWith('\uFEFF'), !!bom);
    assert.equal(h.documents.get(file)?.isDirty, false);
    assert.deepEqual(h.refreshed, [[file]]); assert.equal(h.standaloneRefreshes(), 1);
});
}

test('the extension registers agent environments through the launcher service and refreshes the infobase sidebar', async t => {
    const h = await fixture(t, [0, 0]); await h.run(); assert.deepEqual(h.errors, []);
    const file = path.join(h.root, 'operations/base/infobase');
    const result = await h.infobases.register(file, 'KOT Agent project abcdef12');
    assert.deepEqual(h.registrations, [{ infobase: file, name: 'KOT Agent project abcdef12' }]);
    assert.equal(result.status, 'added'); assert.equal(result.registeredName, 'KOT Agent project abcdef12');
    assert.deepEqual(h.executedCommands, ['kotTestToolkit.refreshInfobaseSidebar']);
});

for (const choices of [[undefined], [0, undefined], [2, undefined]]) {
    test(`cancelling setup at step ${choices.length} for client ${choices[0] ?? 'none'} does not start services or write settings`, async t => {
        const h = await fixture(t, choices); await h.run();
        assert.equal(h.probes(), 0); assert.deepEqual(h.updates, []); assert.deepEqual(h.errors, []);
        await assert.rejects(fs.stat(path.join(h.root, '.runtime')), { code: 'ENOENT' });
    });
}

test('untrusted projects cannot start the AI connection wizard', async t => {
    const h = await fixture(t, [0, 0], false); await h.run();
    assert.equal(h.picks(), 0); assert.equal(h.probes(), 0); assert.match(h.errors[0], /trust/u);
});

for (const [client, clientIndex, modeIndex, execution, policy] of [['codex', 0, 0, true, 'tests'], ['claude', 1, 1, false, 'read-only']] as const) {
    test(`${client} wizard checks the bridge before installing project settings and applying ${policy} mode`, async t => {
        const h = await fixture(t, [clientIndex, modeIndex]); await h.run();
        assert.deepEqual(h.errors, []); assert.equal(h.probes(), 1);
        assert.deepEqual(h.updates, [{ key: 'allowExecution', value: execution, target: 2 }, { key: 'repairPolicy', value: policy, target: 2 }, { key: 'enabled', value: true, target: 2 }]);
        const config = await fs.readFile(path.join(h.root, client === 'codex' ? '.codex/config.toml' : '.mcp.json'), 'utf8');
        assert.match(config, /agent-mcp\.cjs/u);
        assert.equal(await fs.readFile(path.join(h.root, client === 'codex' ? '.agents/skills/kot-testing/SKILL.md' : '.claude/skills/kot-testing/SKILL.md'), 'utf8'), 'KOT skill');
        assert.match(h.copied[0], /kot-testing/u);
    });
}

for (const client of [0, 2]) {
    test(`a failed bridge check leaves client ${client} integration and permissions untouched`, async t => {
        const h = await fixture(t, [client, 0], true, true); await h.run();
        assert.match(h.errors[0], /Install Node/u); assert.deepEqual(h.updates, []); assert.deepEqual(h.copied, []);
        assert.match(h.status.text, /running/u);
        await assert.rejects(fs.stat(path.join(h.root, '.codex/config.toml')), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(h.root, '.runtime/agent/connect-mcp-client.md')), { code: 'ENOENT' });
    });
}

for (const [mode, execution, policy] of [[0, true, 'tests'], [1, false, 'read-only'], [2, true, 'all']] as const) {
    test(`generic MCP setup checks the bridge and exports ${policy} configuration without editing client files or copying credentials`, async t => {
        const h = await fixture(t, [2, mode], true, false, 'Copy MCP configuration');
        const existing = { '.mcp.json': '{"mcpServers":{"other":{"command":"mine"}}}\n', '.codex/config.toml': '# My config\n',
            '.agents/skills/kot-testing/SKILL.md': 'Custom Codex skill', '.claude/skills/kot-testing/SKILL.md': 'Custom Claude skill' };
        for (const [file, text] of Object.entries(existing)) { const target = path.join(h.root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); }
        await h.run();
        assert.deepEqual(h.errors, []); assert.equal(h.probes(), 1);
        assert.deepEqual(h.updates, [{ key: 'allowExecution', value: execution, target: 2 }, { key: 'repairPolicy', value: policy, target: 2 }, { key: 'enabled', value: true, target: 2 }]);
        const directory = path.join(h.root, '.runtime/agent');
        const configuration = JSON.parse(h.copied[0]);
        assert.deepEqual(configuration, { mcpServers: { kot: { command: 'node', args: [path.join(directory, 'agent-mcp.cjs'), '--connection', path.join(directory, 'connection.json')] } } });
        const instructions = await fs.readFile(path.join(directory, 'connect-mcp-client.md'), 'utf8');
        assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/u.exec(instructions)![1]), configuration);
        assert.match(instructions, /same computer/u); assert.match(instructions, /kot_workflow/u);
        for (const text of [h.copied[0], instructions]) { assert.ok(!text.includes('a'.repeat(64))); assert.ok(!text.includes('Bearer ')); }
        assert.deepEqual(h.executedCommands, ['markdown.showPreview']);
        assert.equal((h.commandArguments[0][0] as { fsPath: string }).fsPath, path.join(directory, 'connect-mcp-client.md'));
        assert.deepEqual(h.notifications[0].actions, ['Copy MCP configuration', 'Copy first request', 'Open AI testing guide']);
        for (const [file, text] of Object.entries(existing)) { assert.equal(await fs.readFile(path.join(h.root, file), 'utf8'), text); }
    });
}

test('generic MCP setup provides a first request that works without client skills or prompts', async t => {
    const h = await fixture(t, [2, 1]); await h.run();
    assert.deepEqual(h.errors, []);
    for (const tool of ['kot_project', 'kot_runtime', 'kot_workflow']) { assert.ok(h.copied[0].includes(tool)); }
    assert.ok(!h.copied[0].includes('kot-testing skill'));
    assert.match(h.copied[0], /before running tests or changing sources/u);
    const instructions = await fs.readFile(path.join(h.root, '.runtime/agent/connect-mcp-client.md'), 'utf8');
    assert.ok(instructions.includes(h.copied[0]));
    for (const file of ['.mcp.json', '.codex', '.claude', '.agents']) { await assert.rejects(fs.stat(path.join(h.root, file)), { code: 'ENOENT' }); }
});

test('generic MCP completion can open the full guide', async t => {
    const h = await fixture(t, [2, 1], true, false, 'Open AI testing guide'); await h.run();
    assert.deepEqual(h.errors, []); assert.deepEqual(h.copied, []);
    assert.deepEqual(h.executedCommands, ['markdown.showPreview', 'markdown.showPreview']);
    assert.equal((h.commandArguments[1][0] as { fsPath: string }).fsPath, path.join(h.root, 'extension/docs/guides/ai-agent.md'));
});

test('generic setup copies the checked server even if the runtime export was edited while KOT was running', async t => {
    const h = await fixture(t, [2, 1, 2, 1], true, false, 'Copy MCP configuration');
    await h.run(); assert.deepEqual(h.errors, []);
    await fs.writeFile(path.join(h.root, '.runtime/agent/mcp.json'), JSON.stringify({ mcpServers: { foreign: { command: 'unexpected', token: 'private-token' } } }));
    await h.run();
    assert.deepEqual(h.errors, []); assert.equal(h.probes(), 2);
    assert.equal(h.copied.length, 2); assert.equal(h.copied[1], h.copied[0]);
    assert.ok(!h.copied[1].includes('private-token'));
});
