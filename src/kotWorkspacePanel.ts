import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadKotSettingsModel, type KotSettingsModel } from './kotSettingsModel';
import { createWorkspaceSettingsSession } from './kotWorkspaceConfiguration';
import { SettingsApplyError, type SettingsChange, type SettingsDraftSession, type SettingsScope } from './kotSettingsSession';
import { portableSettingPath } from './kotSettingsPaths';
import { parseKotWorkspaceRequest, workspaceActions, type KotWorkspaceRequest } from './kotWorkspaceProtocol';
import { applySetupFiles, inspectSetupProject, planNewProject, suggestSetupRoots, validateSetupSourceRoot, assertPrimarySetupFolder, selectSetupExample, type SetupFile, type SetupInspection } from './kotProjectSetup';
import { completeProjectSetup, deferProjectSetup, isProjectSetupPending } from './projectSetupGate';
import { getCompilerBuildParameterValue } from './compilerBuildParameters';
import { setupProfileParameters } from './kotSetupProfile';
import { extractVanessaVersionFromChangelog } from './vanessaVersion';
import { YamlParametersManager } from './yamlParametersManager';
import { detectInstalledOneCPlatforms, getConfiguredOneCPlatforms, saveConfiguredOneCPlatforms } from './oneCPlatform';

interface SetupDraft {
    route: 'new' | 'sppr' | 'vanessa' | 'legacy'; mode: 'sppr' | 'vanessa'; language: 'en' | 'ru'; format: 'native' | 'legacy';
    sources: string; libraries: string; run: boolean; platform: string; vanessa: string; compiler: string; profileId: string;
}
interface SetupReview {
    id: string; folder: string; draft: SetupDraft; inspection: SetupInspection; files: SetupFile[];
    settings: SettingsChange[]; profileToken: string; filesApplied: boolean; profileApplied: boolean; settingsApplied: boolean; platformsToken: string; platformApplied: boolean;
}
const progressKey = (folder: string) => `kot.setup.v1:${folder}`;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inRoot = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };

export class KotWorkspacePanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private model?: KotSettingsModel;
    private session?: SettingsDraftSession;
    private view: 'settings' | 'setup' = 'settings';
    private selectedFolder = '';
    private review?: SetupReview;
    private prepareExecution?: () => Promise<boolean>;
    bindExecution(prepare: () => Promise<boolean>): void { this.prepareExecution = prepare; }
    private cancelled = false;
    private applying = false;
    private drafts: SettingsChange[] = [];
    private readonly subscriptions: vscode.Disposable[] = [];
    constructor(private readonly context: vscode.ExtensionContext) {
        this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (this.panel && !this.applying && event.affectsConfiguration('kotTestToolkit')) { void this.panel.webview.postMessage({ type: 'configurationChanged' }); }
        }), vscode.workspace.onDidChangeWorkspaceFolders(() => { KotWorkspacePanel.initialize(this.context); if (this.panel) { void this.sendBoot(); } }));
    }
    dispose(): void { this.cancelled = true; this.panel?.dispose(); this.subscriptions.forEach(item => item.dispose()); }
    private t(message: string): string { return this.model?.strings[message] ?? message; }
    private folder(identity = this.selectedFolder): vscode.WorkspaceFolder {
        const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === identity && item.uri.scheme === 'file');
        if (!folder) { throw new Error(this.t('Open a local project folder first.')); } return folder;
    }
    private assertTrusted(): void { if (!vscode.workspace.isTrusted) { throw new Error(this.t('Trust the workspace before applying project changes.')); } }
    async open(view: 'settings' | 'setup' = 'settings'): Promise<void> {
        this.view = view;
        const override = vscode.workspace.getConfiguration('kotTestToolkit.localization').get<string>('languageOverride', 'System');
        const russian = override === 'Русский' || override === 'System' && vscode.env.language.startsWith('ru');
        this.model = await loadKotSettingsModel(this.context.extensionPath, russian);
        this.session = createWorkspaceSettingsSession(this.model);
        if (this.panel) { this.panel.reveal(); await this.sendBoot(); return; }
        const active = vscode.window.activeTextEditor?.document.uri;
        this.selectedFolder = (active && vscode.workspace.getWorkspaceFolder(active)?.uri.toString()) || vscode.workspace.workspaceFolders?.[0]?.uri.toString() || '';
        this.panel = vscode.window.createWebviewPanel('kotTestToolkit.workspace', this.t('KOT settings'), vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.joinPath(this.context.extensionUri, 'res')] });
        const panel = this.panel;
        const nonce = randomUUID().replace(/-/gu, '');
        const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, file)).toString();
        panel.webview.html = `<!doctype html><html lang="${russian ? 'ru' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource}; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('media/kotWorkspace.css')}"></head><body><div class="workbench"><aside class="navigation"><button id="brand" class="brand"><span class="brand-icon" aria-hidden="true"></span><strong>KOT for 1C</strong></button><nav id="navigation" aria-label="KOT"></nav><div id="section-navigation"></div><select id="section-select" hidden></select></aside><main id="content" tabindex="-1"><p>…</p></main></div><div id="notice" role="status" aria-live="polite"></div><script nonce="${nonce}" src="${asset('media/kotWorkspace.js')}"></script></body></html>`;
        const receive = panel.webview.onDidReceiveMessage(message => { void this.receive(message, panel); });
        const close = panel.onDidDispose(() => {
            receive.dispose(); close.dispose(); this.panel = undefined; this.cancelled = true;
            if (this.drafts.length) { void this.handleCloseDraft(); }
        });
    }
    private async handleCloseDraft(): Promise<void> {
        const closing = this.drafts; const session = this.session!;
        const apply = this.t('Apply'); const discard = this.t('Discard'); const keep = this.t('Keep draft');
        const answer = await vscode.window.showWarningMessage(this.t('KOT settings have unapplied changes.'), apply, keep, discard);
        if (this.drafts !== closing) { return; }
        if (answer === discard) { this.drafts = []; }
        else if (answer === apply) {
            try { await session.apply(closing); this.drafts = []; }
            catch (error) {
                if (error instanceof SettingsApplyError) { this.drafts = closing.filter(change => !error.applied.includes(`${change.folder}:${change.scope}:${change.key}`)); }
                void vscode.window.showErrorMessage(this.t(error instanceof Error ? error.message : String(error)));
            }
        }
    }
    private async sendBoot(): Promise<void> {
        if (!this.panel || !this.model) { return; }
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(item => item.uri.scheme === 'file').map(item => ({ id: item.uri.toString(), name: item.name, path: item.uri.fsPath }));
        if (!folders.some(folder => folder.id === this.selectedFolder)) { this.selectedFolder = folders[0]?.id ?? ''; }
        const manager = YamlParametersManager.getInstance(this.context);
        const profiles = await manager.getProfilesSummary();
        const activeProfile = await manager.loadActiveProfileSnapshot();
        await this.panel.webview.postMessage({ type: 'boot', model: this.model, view: this.view, folders, folder: this.selectedFolder,
            scope: this.selectedFolder ? 'folder' : 'user', trusted: vscode.workspace.isTrusted, platform: process.platform, primaryFolder: folders[0]?.id,
            profiles, profilePaths: { sources: getCompilerBuildParameterValue(activeProfile.buildParameters, 'TestFolder', 'ScenarioFolder'), libraries: getCompilerBuildParameterValue(activeProfile.buildParameters, 'Libraries', 'VanessaLibraries') }, progress: this.context.workspaceState.get(progressKey(this.selectedFolder)), drafts: this.drafts,
            pendingSetup: this.selectedFolder ? isProjectSetupPending(this.folder().uri.fsPath) : false });
    }
    private async receive(raw: unknown, panel: vscode.WebviewPanel): Promise<void> {
        let request: KotWorkspaceRequest;
        try { request = parseKotWorkspaceRequest(raw, (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString())); }
        catch { return; }
        const respond = async (data: unknown, error?: string, applied?: readonly string[]) => {
            if (panel === this.panel) { await panel.webview.postMessage({ type: 'response', id: request.id, data, error, applied }); }
        };
        try { await respond(await this.dispatch(request)); }
        catch (error) { await respond(undefined, this.t(error instanceof Error ? error.message : String(error)), error instanceof SettingsApplyError ? error.applied : undefined); }
    }
    private async dispatch(request: KotWorkspaceRequest): Promise<unknown> {
        const session = this.session!; const model = this.model!;
        const identity = request.folder ?? this.selectedFolder;
        if (request.folder) { this.selectedFolder = request.folder; }
        switch (request.type) {
            case 'ready': await this.sendBoot(); return;
            case 'settings': return session.snapshot(identity, request.scope ?? 'folder').map(row => ({ ...row,
                supported: request.scope !== 'folder' || !vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.length === 1
                    || ['resource', 'language-overridable', 'machine-overridable'].includes(model.settings.find(item => item.key === row.key)?.configScope ?? 'window') }));
            case 'applySettings': {
                const changes = request.data;
                if (!Array.isArray(changes) || changes.length > 200 || changes.some(change => !change || typeof change !== 'object' || !['', ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString())].includes(change.folder))) { throw new Error('Invalid settings request'); }
                this.applying = true;
                try { const applied = await session.apply(changes); this.drafts = []; return { applied }; } finally { this.applying = false; }
            }
            case 'draft': {
                if (!Array.isArray(request.data) || request.data.length > 200) { throw new Error('Invalid settings request'); }
                this.drafts = request.data as SettingsChange[]; return;
            }
            case 'openNative': {
                if (request.key && !model.settings.some(item => item.key === request.key)) { throw new Error('Unknown setting'); }
                await vscode.commands.executeCommand('workbench.action.openSettings', request.key ? `@id:${request.key}` : '@ext:AlexeyEremeev.kot-test-toolkit'); return;
            }
            case 'chooseFolder': await vscode.commands.executeCommand('vscode.openFolder'); return;
            case 'openProjectWindow': await vscode.commands.executeCommand('vscode.openFolder', this.folder(identity).uri, true); return;
            case 'loadProgress': return this.context.workspaceState.get(progressKey(identity));
            case 'retryExecution': return this.retryExecution(identity);
            case 'pickPath': return this.pickPath(request);
            case 'scan': {
                this.cancelled = false; const inspection = await inspectSetupProject(this.folder(identity).uri.fsPath, { cancelled: () => this.cancelled });
                return { ...inspection, roots: { sppr: suggestSetupRoots(inspection, 'sppr'), vanessa: suggestSetupRoots(inspection, 'vanessa') } };
            }
            case 'checkRuntime': return this.checkRuntime(this.setupDraft(request.data), identity);
            case 'reviewSetup': return this.reviewSetup(this.setupDraft(request.data), identity);
            case 'applySetup': return this.applySetup(String(request.value ?? ''));
            case 'cancel': this.cancelled = true; return;
            case 'action': if (['functions', 'numbering', 'parameters'].includes(request.action!)) { this.assertTrusted(); } await vscode.commands.executeCommand(workspaceActions[request.action!]); return;
            case 'openExample': return this.openExample(identity);
            case 'openWorkshop': return this.openWorkshop();
            case 'progress': {
                const data = request.data as { step?: unknown; draft?: unknown } | undefined;
                if (!data || !Number.isInteger(data.step) || Number(data.step) < 0 || Number(data.step) > 6) { throw new Error('Invalid setup progress'); }
                const draft = this.setupDraft(data.draft);
                const previous = this.context.workspaceState.get<{ complete?: boolean }>(progressKey(identity));
                await this.context.workspaceState.update(progressKey(identity), { step: data.step, draft, complete: previous?.complete ?? false }); return;
            }
        }
    }
    private async pickPath(request: KotWorkspaceRequest): Promise<unknown> {
        const folder = this.folder(request.folder);
        const definition = this.model!.settings.find(item => item.key === request.key);
        const setupPaths: Record<string, { pathKind: string; pathPolicy: 'relative' | 'absolute' | 'project' }> = {
            'setup.sources': { pathKind: 'directory', pathPolicy: 'project' }, 'setup.libraries': { pathKind: 'directory', pathPolicy: 'relative' },
            'setup.platform': { pathKind: 'exe', pathPolicy: 'absolute' }, 'setup.vanessa': { pathKind: 'epf', pathPolicy: 'relative' },
            'setup.compiler': { pathKind: 'epf', pathPolicy: 'project' }
        };
        const picker = definition?.pathKind ? definition : setupPaths[request.key ?? ''];
        if (!picker) { throw new Error('Unknown path setting'); }
        const directory = picker.pathKind === 'directory' || picker.pathKind === 'directories';
        const extension = picker.pathKind === 'feature' ? 'feature' : picker.pathKind === 'exe' ? 'exe' : picker.pathKind === 'json' ? 'json' : 'epf';
        const selected = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: !directory, canSelectFolders: directory,
            canSelectMany: false, openLabel: this.t('Select'), filters: directory ? undefined : { [extension.toUpperCase()]: [extension] } });
        return selected?.[0] ? portableSettingPath(folder.uri.fsPath, selected[0].fsPath, picker.pathPolicy ?? 'relative', request.scope ?? 'folder') : undefined;
    }
    private setupDraft(value: unknown): SetupDraft {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid setup draft'); }
        const draft = value as SetupDraft;
        if (!['new', 'sppr', 'vanessa', 'legacy'].includes(draft.route) || !['sppr', 'vanessa'].includes(draft.mode) || !['en', 'ru'].includes(draft.language) || !['native', 'legacy'].includes(draft.format) || typeof draft.run !== 'boolean') { throw new Error('Invalid setup draft'); }
        for (const key of ['sources', 'libraries', 'platform', 'vanessa', 'compiler', 'profileId'] as const) { if (typeof draft[key] !== 'string' || draft[key].length > 4096 || draft[key].includes('\0')) { throw new Error('Invalid setup path'); } }
        return { ...draft };
    }
    private async checkRuntime(draft: SetupDraft, identity: string): Promise<unknown> {
        const root = this.folder(identity).uri.fsPath;
        const platforms = getConfiguredOneCPlatforms();
        if (!platforms.length && process.platform === 'win32') { platforms.push(...await detectInstalledOneCPlatforms()); }
        const checks: Array<{ label: string; ok: boolean; message: string }> = [];
        checks.push({ label: this.t('Local execution'), ok: process.platform === 'win32', message: this.t(process.platform === 'win32' ? 'Windows is available.' : 'Local 1C execution currently requires Windows. You can continue with the editor.') });
        for (const [label, file, ext] of [['1C platform', draft.platform || platforms[0]?.clientExePath || '', '.exe'], ['Vanessa Automation', draft.vanessa, '.epf'], ...(draft.mode === 'sppr' ? [['SPPR compiler', draft.compiler, '.epf']] : [])]) {
            const full = path.resolve(root, file);
            const ok = !!file && path.extname(full).toLowerCase() === ext && await fs.stat(full).then(stat => stat.isFile(), () => false);
            checks.push({ label: this.t(label), ok, message: ok ? full : this.t('Select an existing file.') });
        }
        const changelog = path.join(path.dirname(path.resolve(root, draft.vanessa)), 'docs/Changelog.md');
        const version = extractVanessaVersionFromChangelog(await fs.readFile(changelog, 'utf8').catch(() => ''));
        return { checks, platforms, version };
    }
    private async reviewSetup(draft: SetupDraft, identity: string): Promise<unknown> {
        this.assertTrusted(); this.cancelled = false;
        const folder = this.folder(identity); const root = folder.uri.fsPath;
        if (!draft.sources.trim()) { throw new Error(this.t('Choose the scenario folder.')); }
        portableSettingPath(root, path.resolve(root, draft.sources), 'project', 'folder');
        assertPrimarySetupFolder(identity, vscode.workspace.workspaceFolders?.[0]?.uri.toString());
        if (draft.mode === 'sppr' && draft.compiler) { portableSettingPath(root, path.resolve(root, draft.compiler), 'project', 'folder'); }
        const inspection = await inspectSetupProject(root, { cancelled: () => this.cancelled });
        if (inspection.truncated) { throw new Error(this.t('Project inspection reached its limit. Choose a smaller project folder before applying setup.')); }
        if (draft.route === 'new' && (inspection.sppr.length || inspection.features.length || inspection.processes.length)) { throw new Error(this.t('This folder already has tests. Choose an existing-project route.')); }
        if (draft.route !== 'new' && draft.profileId === 'new') { validateSetupSourceRoot(inspection, draft.mode, draft.sources); }
        if (draft.run) {
            const runtime = await this.checkRuntime(draft, identity) as { checks: Array<{ ok: boolean }> };
            if (!draft.platform) { draft.platform = (runtime as unknown as { platforms: Array<{ clientExePath: string }> }).platforms[0]?.clientExePath ?? ''; }
            if (runtime.checks.some(check => !check.ok)) { throw new Error(this.t('Complete the environment checks or continue with the editor.')); }
        }
        const files = draft.route === 'new' ? planNewProject(draft.mode, draft.language, draft.format).map(file => ({ ...file, path: file.path.startsWith('tests/') ? path.posix.join(draft.sources.replace(/\\/gu, '/'), file.path.slice(6)) : file.path })) : [];
        const changes: SettingsChange[] = [];
        const stage = (key: string, value: unknown, scope: SettingsScope) => {
            const row = this.session!.snapshot(identity, scope).find(row => row.key === key)!; changes.push({ key, value, scope, folder: identity, token: row.token });
        };
        const target = (key: string): SettingsScope => !vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.length === 1 || this.model!.settings.find(item => item.key === key)?.configScope === 'resource' ? 'folder' : 'workspace';
        stage('kotTestToolkit.editor.newScenarioLanguage', draft.language, target('kotTestToolkit.editor.newScenarioLanguage'));
        if (draft.mode === 'sppr') { stage('kotTestToolkit.newScenarioDefaults.format', draft.format, target('kotTestToolkit.newScenarioDefaults.format')); }
        if (draft.run) {
            stage('kotTestToolkit.runVanessa.vanessaEpfPath', draft.vanessa, target('kotTestToolkit.runVanessa.vanessaEpfPath'));
            if (draft.mode === 'sppr') { stage('kotTestToolkit.paths.buildScenarioBddEpf', draft.compiler, target('kotTestToolkit.paths.buildScenarioBddEpf')); }
        }
        const manager = YamlParametersManager.getInstance(this.context); const profile = await manager.loadActiveProfileSnapshot();
        this.review = { id: randomUUID(), folder: identity, draft, inspection, files, settings: changes, profileToken: fingerprint(profile), filesApplied: false, profileApplied: false, settingsApplied: false, platformsToken: fingerprint(getConfiguredOneCPlatforms()), platformApplied: false };
        return { id: this.review.id, files: files.map(file => file.path), settings: [...changes.map(change => ({ key: change.key, value: change.value, scope: change.scope })), ...(draft.run ? [{ key: 'kotTestToolkit.platforms.catalog', value: draft.platform, scope: 'workspace' }] : [])],
            migrate: isProjectSetupPending(root) ? inspection.metadata : [], migrateLegacy: draft.route === 'legacy' || isProjectSetupPending(root) && inspection.metadata.length > 0, profile: draft.profileId === 'new' ? this.t('Create a separate profile; existing profiles remain unchanged.') : this.t('Use the selected existing profile without editing it.'), run: draft.run };
    }
    private async applySetup(id: string): Promise<unknown> {
        this.assertTrusted(); const review = this.review;
        if (!review || review.id !== id || this.applying) { throw new Error(this.t('Review the setup changes again.')); }
        const folder = this.folder(review.folder); const root = folder.uri.fsPath;
        if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && inRoot(root, document.uri.fsPath) && /\.(?:ya?ml|feature)$/iu.test(document.fileName))) { throw new Error(this.t('Save the modified scenario and metadata files before applying setup.')); }
        const manager = YamlParametersManager.getInstance(this.context);
        if (!review.profileApplied && fingerprint(await manager.loadActiveProfileSnapshot()) !== review.profileToken) { throw new Error(this.t('The active profile changed. Review setup again.')); }
        if (!review.filesApplied && (await inspectSetupProject(root)).token !== review.inspection.token) { throw new Error(this.t('The project changed. Review setup again.')); }
        this.applying = true;
        try {
            if (!review.filesApplied) { await applySetupFiles(root, review.files); review.filesApplied = true; }
            if (!review.settingsApplied) {
                try { await this.session!.apply(review.settings); review.settingsApplied = true; }
                catch (error) { if (error instanceof SettingsApplyError) { review.settings = review.settings.filter(change => !error.applied.includes(`${change.folder}:${change.scope}:${change.key}`)); } throw error; }
            }
            if (!review.profileApplied) {
                if (review.draft.profileId === 'new') {
                    const current = review.draft.route === 'new' ? manager.getDefaultParameters() : [...(await manager.loadActiveProfileSnapshot()).buildParameters];
                    await manager.createSetupProfile(`KOT · ${folder.name}`, setupProfileParameters(current, root, review.draft.sources, review.draft.libraries));
                } else { await manager.setActiveProfile(review.draft.profileId); }
                review.profileApplied = true;
            }
            if (review.draft.run && !review.platformApplied) {
                const platforms = getConfiguredOneCPlatforms();
                if (fingerprint(platforms) !== review.platformsToken) { throw new Error(this.t('The platform catalog changed. Review setup again.')); }
                await saveConfiguredOneCPlatforms([{ name: path.basename(path.dirname(path.dirname(review.draft.platform))), clientExePath: review.draft.platform },
                    ...platforms.filter(platform => platform.clientExePath.toLowerCase() !== review.draft.platform.toLowerCase())]);
                review.platformApplied = true;
            }
            completeProjectSetup(root);
            await (await import('./workspaceScanner.js')).scanWorkspaceForScenarioCatalog(folder.uri);
            await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcher');
            const profile = await manager.loadActiveProfileSnapshot();
            const compilationIssues = review.draft.mode === 'sppr' ? manager.validateCompilerBuildParameters(profile.buildParameters) : [];
            const readiness = { complete: true, executionReady: false, executionError: '', compilationIssues, editorReady: true };
            await this.context.workspaceState.update(progressKey(review.folder), { complete: true, step: 6, draft: review.draft, readiness });
            if (review.draft.run) {
                try { readiness.executionReady = await this.prepareExecution?.() ?? false; }
                catch (error) { readiness.executionError = error instanceof Error ? error.message : String(error); }
            }
            await this.context.workspaceState.update(progressKey(review.folder), { complete: true, step: 6, draft: review.draft, readiness });
            return readiness;
        } finally { this.applying = false; }
    }
    private async retryExecution(identity: string): Promise<{ executionReady: boolean }> {
        this.assertTrusted(); assertPrimarySetupFolder(identity, vscode.workspace.workspaceFolders?.[0]?.uri.toString());
        const progress = this.context.workspaceState.get<{ complete?: boolean; readiness?: object }>(progressKey(identity));
        if (!progress?.complete) { throw new Error(this.t('Review the setup changes again.')); }
        const executionReady = await this.prepareExecution?.() ?? false;
        await this.context.workspaceState.update(progressKey(identity), { ...progress, readiness: { ...progress.readiness, executionReady, executionError: '' } });
        return { executionReady };
    }
    private async openExample(identity: string): Promise<void> {
        const folder = this.folder(identity); const inspection = await inspectSetupProject(folder.uri.fsPath);
        const progress = this.context.workspaceState.get<{ draft?: SetupDraft }>(progressKey(identity));
        const file = selectSetupExample(inspection, progress?.draft?.mode ?? 'vanessa');
        if (!file) { await vscode.commands.executeCommand('kotTestToolkit.createFeature'); return; }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, file))));
    }
    private async openWorkshop(): Promise<void> {
        const parent = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: this.t('Choose a parent folder for the workshop') });
        if (!parent?.[0]) { return; }
        const target = path.join(parent[0].fsPath, 'KOT-workshop');
        if (await fs.lstat(target).then(() => true, () => false)) { throw new Error(this.t('The workshop folder already exists. Choose another parent folder.')); }
        await fs.cp(path.join(this.context.extensionPath, 'examples/kot-workshop'), target, { recursive: true, force: false, errorOnExist: true });
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), true);
    }
    static initialize(context: vscode.ExtensionContext): void {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme === 'file' && !context.workspaceState.get<{ complete?: boolean }>(progressKey(folder.uri.toString()))?.complete) { deferProjectSetup(folder.uri.fsPath); }
        }
    }
    async offerWelcome(): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
        if (!folder || this.context.globalState.get('kot.setup.hideWelcome', false)) { return; }
        const key = `kot.setup.offered:${folder.uri.toString()}`;
        if (this.context.workspaceState.get(key, false)) { return; }
        await this.context.workspaceState.update(key, true);
        const override = vscode.workspace.getConfiguration('kotTestToolkit.localization').get<string>('languageOverride', 'System');
        const russian = override === 'Русский' || override === 'System' && vscode.env.language.startsWith('ru');
        const start = russian ? 'Настроить KOT' : 'Set up KOT'; const hide = russian ? 'Больше не предлагать' : 'Do not offer again';
        const answer = await vscode.window.showInformationMessage(russian ? 'KOT: подготовим проект и покажем, где находятся основные инструменты?' : 'KOT: set up this project and find your way around the tools?', start, hide);
        if (answer === start) { await this.open('setup'); } else if (answer === hide) { await this.context.globalState.update('kot.setup.hideWelcome', true); }
    }
}
