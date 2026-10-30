import { isProjectSetupPending, onProjectSetupCompleted } from './projectSetupGate';
import path from 'node:path';
import * as vscode from 'vscode';
import { ProjectCatalogSettings, PROJECT_CATALOG_SETTINGS, type CatalogSettingsBaseline } from './projectCatalogSettings';
import { scanWorkspaceForScenarioCatalog } from './workspaceScanner';
import { getTranslator } from './localization';
import { ProjectPropertyCatalogStore, validatePropertyCatalogName, type ProjectPropertyCatalogKey, type ProjectSystemFunction } from './projectPropertyCatalogStore';
import { TestNumberingStore, type TestNumberingDefinition } from './testNumberingStore';
import type { ScenarioCatalogProvider } from './scenarioCatalog';
import { discoverProjectCatalogs } from './projectCatalogDiscovery';

interface NativeProjection { value: unknown; workspace?: unknown }
interface FolderSettings {
    folder: vscode.WorkspaceFolder;
    sync: ProjectCatalogSettings;
    disposables: vscode.Disposable[];
    timer?: ReturnType<typeof setTimeout>;
    active: boolean;
    lastError: string;
}
function equalNative(a: unknown, b: unknown): boolean {
    const normalize = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value;
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function fromNative(key: string, value: unknown): unknown {
    if (key !== 'numbering.series' && key !== 'catalogs.systemFunctions') { return value; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Use a key/value table in Workspace settings.'); }
    return Object.entries(value).map(([name, entry]) => key === 'numbering.series' ? { prefix: name, author: entry } : { name, uid: entry });
}
function toNative(key: string, value: unknown): unknown {
    if (value === undefined || key !== 'numbering.series' && key !== 'catalogs.systemFunctions') { return value; }
    const pairs = (value as Record<string, string>[]).map(entry => key === 'numbering.series' ? [entry.prefix, entry.author] : [entry.name, entry.uid]);
    if (new Set(pairs.map(([name]) => name)).size !== pairs.length) { throw new Error('Duplicate names cannot be displayed in a native settings table. Resolve the project catalog first.'); }
    return Object.fromEntries(pairs);
}

/** User-tab additions must not replace project entries hidden by that Settings scope. */
async function mergeUserCatalog(root: string, key: string, native: unknown): Promise<unknown> {
    const incoming = fromNative(key, native);
    if (!Array.isArray(incoming)) { throw new Error('A project catalog setting must contain an array.'); }
    if (key === 'numbering.series') {
        const current: TestNumberingDefinition[] = (await new TestNumberingStore(root).read()).series.map(({ prefix, author }) => ({ prefix, author }));
        for (const entry of incoming as TestNumberingDefinition[]) {
            const index = current.findIndex(old => old.prefix === entry.prefix);
            if (index < 0) { current.push(entry); } else { current[index] = entry; }
        }
        return toNative(key, current);
    }
    const properties = await new ProjectPropertyCatalogStore(root).read();
    if (key === 'catalogs.systemFunctions') {
        const current = [...properties.systemFunctions ?? []];
        for (const entry of incoming as ProjectSystemFunction[]) {
            const index = current.findIndex(old => old.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()
                || !!entry.uid && old.uid.toLocaleLowerCase() === entry.uid.toLocaleLowerCase());
            if (index < 0) { current.push(entry); } else { current[index] = entry; }
        }
        return toNative(key, current);
    }
    const field = key.slice('catalogs.'.length) as ProjectPropertyCatalogKey;
    const current = [...properties[field]];
    for (const value of incoming) {
        const name = validatePropertyCatalogName(value);
        if (!current.some(old => old.toLocaleLowerCase() === name.toLocaleLowerCase())) { current.push(name); }
    }
    return current;
}

async function containsUserCatalog(root: string, key: string, native: unknown): Promise<boolean> {
    const incoming = fromNative(key, native) as unknown[];
    if (key === 'numbering.series') {
        const current = (await new TestNumberingStore(root).read()).series;
        return (incoming as TestNumberingDefinition[]).every(entry => current.some(old => old.prefix === entry.prefix && old.author === entry.author.trim()));
    }
    const current = await new ProjectPropertyCatalogStore(root).read();
    if (key === 'catalogs.systemFunctions') {
        return (incoming as ProjectSystemFunction[]).every(entry => current.systemFunctions?.some(old => old.name.toLocaleLowerCase() === entry.name.trim().toLocaleLowerCase()
            && (!entry.uid.trim() || old.uid === entry.uid.trim().toLocaleLowerCase())));
    }
    const names = current[key.slice('catalogs.'.length) as ProjectPropertyCatalogKey];
    return incoming.every(value => names.some(name => name.toLocaleLowerCase() === validatePropertyCatalogName(value as string).toLocaleLowerCase()));
}

/** Wire ordinary Settings UI edits and Git/file changes to the same guarded project stores. */
export async function registerNativeProjectCatalogSettings(context: vscode.ExtensionContext, catalogProvider?: ScenarioCatalogProvider): Promise<vscode.Disposable> {
    const t = await getTranslator(context.extensionUri);
    const entries = new Map<string, FolderSettings>();
    const keys = Object.values(PROJECT_CATALOG_SETTINGS);
    const readGlobal = (key: string) => vscode.workspace.getConfiguration('kotTestToolkit').inspect(key)?.globalValue;
    const lastGlobal = new Map<string, unknown>(keys.map(key => [key, readGlobal(key)]));
    let settingsQueue: Promise<unknown> = Promise.resolve();
    const enqueue = (operation: () => Promise<void>) => {
        const result = settingsQueue.then(operation);
        settingsQueue = result.catch(error => {
            if (!disposed) { void vscode.window.showErrorMessage(t('Could not update project catalog settings: {0}', String(error))); }
        });
        return result;
    };
    let disposed = false;
    const report = (entry: { folder: vscode.WorkspaceFolder; active: boolean; lastError: string }, errors: string[]) => {
        if (!entry.active || disposed) { return; }
        const message = errors.join('\n');
        if (message && message !== entry.lastError) { void vscode.window.showErrorMessage(t('Project catalogs ({0}): {1}', entry.folder.name, message)); }
        entry.lastError = message;
    };
    const disposeEntry = (entry: FolderSettings) => {
        entry.active = false; if (entry.timer) { clearTimeout(entry.timer); }
        entry.disposables.forEach(disposable => disposable.dispose());
    };
    const openProjectSettings = async (entry: FolderSettings, key: string) => {
        if (!entry.active || disposed) { return; }
        if (!vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.length === 1) {
            await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', { query: `@id:kotTestToolkit.${key}`, revealSetting: { key: `kotTestToolkit.${key}`, edit: false } });
        } else {
            await vscode.commands.executeCommand('_workbench.action.openFolderSettings', entry.folder.uri);
        }
    };
    const selectProject = async () => {
        if (disposed) { return undefined; }
        const active = vscode.window.activeTextEditor?.document.uri;
        const activeFolder = active && vscode.workspace.getWorkspaceFolder(active);
        let entry = activeFolder ? entries.get(activeFolder.uri.toString()) : entries.size === 1 ? entries.values().next().value : undefined;
        if (!entry && entries.size > 1) {
            const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: t('Select the project for these catalog values') });
            entry = folder && entries.get(folder.uri.toString());
        }
        if (!entries.size) { void vscode.window.showInformationMessage(t('Open a project and edit its Workspace or Folder settings to save these catalog values.')); }
        return entry;
    };
    const importUserCatalogs = async (values: Map<string, unknown>, entry: FolderSettings) => {
        if (disposed || !values.size) { return; }
        let firstImported: string | undefined;
        for (const [key, value] of values) {
            if (!entry.active || disposed) { return; }
            try {
                const before = await entry.sync.synchronize('project');
                if (before.length) { report(entry, before); continue; }
                const merged = await mergeUserCatalog(entry.folder.uri.fsPath, key, value);
                const config = vscode.workspace.getConfiguration('kotTestToolkit', entry.folder.uri);
                const target = !vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.length === 1
                    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder;
                const scopeValue = () => target === vscode.ConfigurationTarget.Workspace ? config.inspect(key)?.workspaceValue : config.inspect(key)?.workspaceFolderValue;
                const previous = scopeValue();
                await config.update(key, merged, target);
                const errors = await entry.sync.synchronize('settings', [key]); report(entry, errors);
                if (errors.length) {
                    if (equalNative(scopeValue(), merged)) { await config.update(key, previous, target); }
                    continue;
                }
                if (!await containsUserCatalog(entry.folder.uri.fsPath, key, value)) {
                    report(entry, [t('The project setting changed during transfer. User values were kept. Retry the transfer.')]);
                    continue;
                }
                // A later User edit gets its own queued transfer; never clear that newer value.
                if (equalNative(readGlobal(key), value)) { await config.update(key, undefined, vscode.ConfigurationTarget.Global); }
                firstImported ??= key;
            } catch (error) { report(entry, [`${key}: ${t(error instanceof Error ? error.message : String(error))}`]); }
        }
        if (firstImported) { await openProjectSettings(entry, firstImported); }
    };
    const offerProjectSettings = (keys: readonly string[]) => {
        if (disposed || !keys.length) { return; }
        const transfer = t('Move values to project'); const open = t('Open project settings');
        void vscode.window.showInformationMessage(t('These catalogs are shared with the project. Edit them in Workspace or Folder settings. Values entered in User have been kept there.'), transfer, open)
            .then(action => {
                if (action !== transfer && action !== open || disposed) { return; }
                return enqueue(async () => {
                    const entry = await selectProject(); if (!entry) { return; }
                    if (action === open) { await openProjectSettings(entry, keys[0]); return; }
                    // Read again after the action: an older notification must not transfer stale input.
                    const values = new Map(keys.map(key => [key, readGlobal(key)]).filter(([, value]) => value !== undefined) as [string, unknown][]);
                    await importUserCatalogs(values, entry);
                });
            });
    };
    const rebuild = async () => {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        for (const [key, entry] of entries) {
            if (!folders.some(folder => folder.uri.toString() === key)) { disposeEntry(entry); entries.delete(key); }
        }
        for (const folder of folders) {
            const key = folder.uri.toString(); if (entries.has(key) || isProjectSetupPending(folder.uri.fsPath)) { continue; }
            const baselineKey = `kot.projectCatalogSettings:${path.resolve(folder.uri.fsPath)}`;
            const projectionKey = `kot.projectCatalogProjection:${path.resolve(folder.uri.fsPath)}`;
            const projection = structuredClone(context.workspaceState.get<Record<string, NativeProjection>>(projectionKey) ?? {});
            const entry = { folder, active: true, lastError: '', disposables: [] as vscode.Disposable[], timer: undefined as ReturnType<typeof setTimeout> | undefined,
                sync: undefined as unknown as ProjectCatalogSettings };
            const assertActive = () => {
                if (!entry.active || disposed) { throw new Error(t('The project was closed.')); }
                if (isProjectSetupPending(folder.uri.fsPath)) { throw new Error(t('The project format changed. Review and retry the operation.')); }
            };
            entry.sync = new ProjectCatalogSettings(folder.uri.fsPath, {
                translate: t,
                readLegacySystemFunctions: () => {
                    const config = vscode.workspace.getConfiguration('kotTestToolkit', folder.uri);
                    const current = config.inspect('catalogs.systemFunctions');
                    if (current?.workspaceFolderValue !== undefined || current?.workspaceValue !== undefined) { return undefined; }
                    const legacy = config.inspect<readonly ProjectSystemFunction[]>('newScenarioDefaults.systemFunctions');
                    return legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
                },
                readSetting: settingKey => {
                    const config = vscode.workspace.getConfiguration('kotTestToolkit', folder.uri);
                    const inspect = config.inspect<unknown>(settingKey);
                    const reflected = projection[settingKey];
                    // A generated Folder projection must not mask a later edit in the Workspace tab.
                    // A human Folder override keeps ordinary VS Code precedence.
                    const workspaceChanged = !!reflected && equalNative(inspect?.workspaceFolderValue, reflected.value)
                        && !equalNative(inspect?.workspaceValue, reflected.workspace);
                    const explicitValue = workspaceChanged && inspect?.workspaceValue !== undefined ? inspect.workspaceValue
                        : inspect?.workspaceFolderValue !== undefined ? inspect.workspaceFolderValue : inspect?.workspaceValue;
                    const native = explicitValue !== undefined ? explicitValue : config.get<unknown>(settingKey,
                        settingKey === 'numbering.series' || settingKey === 'catalogs.systemFunctions' ? {} : []);
                    return { value: fromNative(settingKey, native), explicit: explicitValue !== undefined,
                        userOnly: explicitValue === undefined && inspect?.globalValue !== undefined, needsReflection: workspaceChanged };
                },
                writeSetting: async (settingKey, value) => {
                    assertActive();
                    const config = vscode.workspace.getConfiguration('kotTestToolkit', folder.uri);
                    const inspect = config.inspect<unknown>(settingKey);
                    const native = toNative(settingKey, value);
                    const generated = inspect?.workspaceFolderValue === undefined
                        || !!projection[settingKey] && equalNative(inspect.workspaceFolderValue, projection[settingKey].value);
                    if (!equalNative(inspect?.workspaceFolderValue, native)) {
                        await config.update(settingKey, native, vscode.ConfigurationTarget.WorkspaceFolder);
                    }
                    if (generated && native !== undefined) { projection[settingKey] = { value: native, workspace: inspect?.workspaceValue }; }
                    else { delete projection[settingKey]; }
                    await context.workspaceState.update(projectionKey, structuredClone(projection));
                },
                readBaseline: () => context.workspaceState.get<CatalogSettingsBaseline>(baselineKey),
                writeBaseline: async baseline => { if (entry.active && !disposed) { await context.workspaceState.update(baselineKey, baseline); } },
                assertSaved: file => {
                    assertActive();
                    if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.scheme === 'file'
                        && path.resolve(document.uri.fsPath) === file)) { throw new Error(t('Save the modified project catalog before editing its settings.')); }
                },
                loadCodes: async () => (await scanWorkspaceForScenarioCatalog(folder.uri)).all.filter(info => {
                    const relative = path.relative(folder.uri.fsPath, info.yamlFileUri.fsPath);
                    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
                }).flatMap(info => [info.scenarioCode, info.processCode].filter((code): code is string => !!code))
            });
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.kot/{property-catalogs.yml,test-numbering.yml}'));
            const refresh = () => {
                if (entry.timer) { clearTimeout(entry.timer); }
                entry.timer = setTimeout(() => { void entry.sync.synchronize('project').then(errors => report(entry, errors)); }, 80);
            };
            entry.disposables.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
            entries.set(key, entry);
            await report(entry, await entry.sync.synchronize('project'));
        }
    };
    const configuration = vscode.workspace.onDidChangeConfiguration(event => {
        const changed = keys.filter(key => event.affectsConfiguration(`kotTestToolkit.${key}`));
        if (!changed.length) { return; }
        const userEdits = new Map<string, unknown>();
        for (const key of changed) {
            const current = readGlobal(key);
            if (current !== undefined && !equalNative(current, lastGlobal.get(key))) { userEdits.set(key, current); }
            lastGlobal.set(key, current);
        }
        return enqueue(async () => {
            offerProjectSettings([...userEdits.keys()]);
            for (const entry of entries.values()) {
                // Untransferred User edits stay pending instead of generating a misleading save error.
                const projectKeys = changed.filter(key => {
                    const inspect = vscode.workspace.getConfiguration('kotTestToolkit', entry.folder.uri).inspect(key);
                    return inspect?.workspaceFolderValue !== undefined || inspect?.workspaceValue !== undefined || inspect?.globalValue === undefined;
                });
                if (projectKeys.length) { report(entry, await entry.sync.synchronize('settings', projectKeys)); }
            }
        });
    });
    const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => { void rebuild(); });
    const discover = () => enqueue(async () => {
        const catalog = catalogProvider?.getScenarioCatalog();
        if (!catalog || disposed) { return; }
        for (const entry of entries.values()) {
            if (!entry.active || isProjectSetupPending(entry.folder.uri.fsPath)) { continue; }
            try {
                await discoverProjectCatalogs(entry.folder.uri.fsPath, catalog.all, file => {
                    if (!entry.active || disposed) { throw new Error(t('The project was closed.')); }
                    if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.scheme === 'file'
                        && path.resolve(document.uri.fsPath) === file)) { throw new Error(t('Save the modified project catalog before editing its settings.')); }
                });
                report(entry, await entry.sync.synchronize('project'));
            } catch (error) { report(entry, [error instanceof Error ? error.message : String(error)]); }
        }
    });
    const catalogSubscription = catalogProvider?.onDidUpdateScenarioCatalog(() => { void discover().catch(() => undefined); });
    const setupSubscription = onProjectSetupCompleted(() => { void enqueue(async () => { await rebuild(); }); });
    await rebuild();
    if (catalogProvider?.getScenarioCatalog()) { await discover(); }
    offerProjectSettings([...lastGlobal].filter(([, value]) => value !== undefined).map(([key]) => key));
    return { dispose: () => {
        disposed = true; setupSubscription.dispose(); configuration.dispose(); folders.dispose(); catalogSubscription?.dispose(); entries.forEach(disposeEntry); entries.clear();
    } };
}
