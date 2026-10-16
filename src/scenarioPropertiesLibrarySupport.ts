import path from 'node:path';
import * as vscode from 'vscode';
import type { StepLibraryItem } from './stepLibraryModel';
import type { StepLibraryFavoritesService } from './stepLibraryFavorites';
import type { StandaloneFeatureService } from './standaloneFeatureService';
import { FeaturePropertiesController, type FeaturePropertiesHost } from './featurePropertiesController';
import { FEATURE_EDITOR_COMMAND, type FeatureEditorActionKind } from './featureEditorActions';
import { readFeatureProperties, type FeaturePropertiesDocument } from './featurePropertiesModel';
import { parseExportScenarios } from './exportScenarioParser';

export interface PropertiesLibrarySupport {
    favorite(uri: string): { canFavorite: boolean; favorite: boolean };
    toggleFavorite(uri: string): Promise<void>;
    sourceForGenerated(uri: vscode.Uri): Promise<vscode.Uri | undefined>;
    createFeatureController(documents: Pick<FeaturePropertiesHost, 'readDocument' | 'replaceDocument' | 'saveDocument'>): FeaturePropertiesController;
    onDidChange(listener: () => void): vscode.Disposable;
}
interface Options {
    favoriteItems(uri: vscode.Uri): Promise<readonly StepLibraryItem[]>;
    onDidChangeIndex(listener: () => void): vscode.Disposable;
    favorites: StepLibraryFavoritesService; standalone: StandaloneFeatureService;
    sourceForGenerated(uri: vscode.Uri): Promise<vscode.Uri | undefined>;
    renameExport(uri: vscode.Uri, line: number): Promise<boolean>;
}
export function createPropertiesLibrarySupport(options: Options): PropertiesLibrarySupport {
    const listeners = new Set<() => void>();
    const loading = new Map<string, Promise<unknown>>();
    const items = new Map<string, readonly StepLibraryItem[]>();
    let generation = 0;
    const fire = () => { for (const listener of listeners) { listener(); } };
    const find = (uri: string): StepLibraryItem | undefined => {
        const resource = vscode.Uri.parse(uri, true);
        const cached = items.get(uri);
        if (!cached && !loading.has(uri)) {
            const current = generation;
            const pending = options.favoriteItems(resource).then(values => { if (current === generation) { items.set(uri, values); fire(); } }, () => undefined);
            loading.set(uri, pending);
            void pending.finally(() => { if (loading.get(uri) === pending) { loading.delete(uri); } });
        }
        const matches = cached?.filter(item => item.capturedLocation?.uri === uri) ?? [];
        return matches.find(item => ['main', 'process', 'standalone', 'nested'].includes(item.sourceGroup))
            ?? (matches.length === 1 ? matches[0] : undefined);
    };
    const favorite = (uri: string) => { const item = find(uri); return { canFavorite: !!item, favorite: !!item && options.favorites.isFavorite(item) }; };
    const toggleFavorite = async (uri: string) => {
        if (!items.has(uri)) { items.set(uri, await options.favoriteItems(vscode.Uri.parse(uri, true))); }
        const item = find(uri); if (!item) { throw new Error('Select a single test to change its favorite state.'); }
        await options.favorites.toggle(item);
    };
    return {
        favorite, toggleFavorite, sourceForGenerated: options.sourceForGenerated,
        onDidChange: listener => {
            listeners.add(listener);
            const subscriptions = [options.onDidChangeIndex(() => { generation++; items.clear(); loading.clear(); listener(); }), options.favorites.onDidChange(listener), options.standalone.onDidChange(listener), options.standalone.onDidRefresh(listener)];
            return { dispose: () => { listeners.delete(listener); subscriptions.forEach(value => value.dispose()); } };
        },
        createFeatureController: documents => new FeaturePropertiesController({
            ...documents,
            decorate: async document => {
                const feature = options.standalone.find(document.uri);
                return { ...favorite(document.uri), ...(feature ? { standalone: { groupId: feature.groupId,
                    groups: options.standalone.getSnapshot().groups.filter(group => {
                        const ordering = options.standalone.getSnapshot().ordering;
                        return !ordering || ordering.groupRoots[group.id]?.includes(ordering.featureRoots[feature.id]);
                    }).map(group => ({ id: group.id, name: group.name })), jsonPath: feature.jsonPath } } : {}) };
            },
            action: async (action, document, value, line) => {
                const uri = vscode.Uri.parse(document.uri, true);
                if (action === 'favorite') { await toggleFavorite(document.uri); return; }
                if (action === 'copyPath') { await vscode.env.clipboard.writeText(uri.fsPath); return; }
                if (action === 'structure') {
                    await vscode.commands.executeCommand(FEATURE_EDITOR_COMMAND, { uri: document.uri, version: document.version, line, kind: value as FeatureEditorActionKind }); return;
                }
                if (action === 'openSource' || action === 'openScenario') {
                    const source = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(source, { preview: false, ...(line === undefined ? {} : { selection: new vscode.Range(line, 0, line, 0) }) }); return;
                }
                if (action === 'renameScenario') { await renameScenario(document, line!, documents, options); return; }
                const feature = options.standalone.find(document.uri);
                if (!feature) { throw new Error('This action requires a standalone feature test.'); }
                if (action === 'group') {
                    if (value === '__new__') {
                        const name = await vscode.window.showInputBox({ title: vscode.l10n.t('New group'), ignoreFocusOut: true });
                        if (!name?.trim()) { return; }
                        // Use the destination project's store, rather than the first workspace root.
                        const group = await options.standalone.createGroupForFeature(feature.id, name);
                        await options.standalone.moveFeature(feature.id, group.id);
                    } else { await options.standalone.moveFeature(feature.id, value ?? ''); }
                } else if (action === 'chooseJson') {
                    const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                        defaultUri: vscode.Uri.file(path.dirname(uri.fsPath)), filters: { JSON: ['json'] } });
                    if (selected?.[0]) { await options.standalone.setLaunchJson(feature.id, selected[0].fsPath); }
                } else if (action === 'generateJson') { await vscode.commands.executeCommand('kotTestToolkit.generateFeatureJson', uri); }
                else if (action === 'openJson') {
                    if (!feature.jsonPath) { throw new Error('No launch JSON is associated with this feature.'); }
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(feature.jsonPath)), { preview: false });
                } else if (action === 'run') { await vscode.commands.executeCommand('kotTestToolkit.runFeature', uri); }
            }
        })
    };
}
async function renameScenario(document: FeaturePropertiesDocument, line: number,
    documents: Pick<FeaturePropertiesHost, 'readDocument' | 'replaceDocument'>, options: Options): Promise<void> {
    const model = readFeatureProperties(document);
    const parsed = parseExportScenarios(document.text, { sourceUri: document.uri, workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: model.language });
    if (parsed.definitions.some(item => item.definitionLocation?.range.start.line === line)) {
        await options.renameExport(vscode.Uri.parse(document.uri, true), line); return;
    }
    const scenario = model.scenarios.find(item => item.line === line)!;
    const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Rename scenario'), value: scenario.title, ignoreFocusOut: true,
        validateInput: value => !value.trim() || /[\r\n\0]/u.test(value) ? vscode.l10n.t('The name must be a non-empty single line.') : undefined });
    if (name === undefined || name.trim() === scenario.title) { return; }
    const current = await documents.readDocument(document.uri);
    if (current.version !== document.version) { throw new Error('The feature changed. Refresh the form and retry.'); }
    const lines = document.text.split(/(?<=\n)/u); const original = lines[line];
    lines[line] = original.replace(/(:\s*)[^\r\n]*/u, (_match, prefix: string) => prefix + name.trim());
    if (!await documents.replaceDocument(document, lines.join(''))) { throw new Error('The feature changed. Refresh the form and retry.'); }
}
