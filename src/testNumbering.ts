import path from 'node:path';
import * as vscode from 'vscode';
import { TestNumberingStore, validateNewTestCode, type TestNumberingSeries } from './testNumberingStore';
import { ProjectPropertyCatalogStore } from './projectPropertyCatalogStore';
import { projectLibraryEnvironment } from './projectLibraryIntegration';
import { resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { scanWorkspaceForScenarioCatalog } from './workspaceScanner';
import { getTranslator, type Translator } from './localization';

export interface NewTestCode {
    code: string;
    author?: string;
    root: string;
    claim(destination?: vscode.Uri, create?: () => Promise<void>): Promise<void>;
}
type SeriesChoice = vscode.QuickPickItem & { action?: 'manual' | 'new' | 'catalog'; series?: TestNumberingSeries };

function rootFor(target: vscode.Uri): string {
    if (target.scheme !== 'file') { throw new Error('Test numbering requires a local project.'); }
    const environment = projectLibraryEnvironment();
    return resolveProjectLibraryRoot(target.fsPath, environment.workspaceRoots, environment.scanRoots);
}
function assertSaved(file: string): void {
    if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.scheme === 'file'
        && path.resolve(document.uri.fsPath) === path.resolve(file))) { throw new Error('Save the modified test numbering catalog before issuing a code.'); }
}
function storeFor(root: string): TestNumberingStore {
    const file = path.join(root, '.kot', 'test-numbering.yml');
    return new TestNumberingStore(root, { beforeWrite: () => assertSaved(file) });
}
function stateKey(root: string): string { return `kot.testNumbering.series:${root}`; }
async function loadCodes(target: vscode.Uri, root: string): Promise<string[]> {
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file' && folder.uri.fsPath === root)
        ?? vscode.workspace.workspaceFolders?.[0];
    const catalog = await scanWorkspaceForScenarioCatalog(workspace?.uri ?? target);
    return catalog.all.filter(info => {
        const relative = path.relative(root, info.yamlFileUri.fsPath);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }).flatMap(info => [info.scenarioCode, info.processCode].filter((value): value is string => !!value?.trim()));
}

async function addSeries(store: TestNumberingStore, target: vscode.Uri, t: Translator): Promise<TestNumberingSeries | undefined> {
    const prefix = await vscode.window.showInputBox({
        title: t('Test numbering'), prompt: t('Enter the six-digit tester prefix, including leading zeroes'),
        placeHolder: '000012', ignoreFocusOut: true,
        validateInput: value => /^\d{6}$/u.test(value.trim()) ? undefined : t('A numbering prefix must contain exactly six digits.')
    });
    if (prefix === undefined) { return undefined; }
    const catalogFile = path.join(path.dirname(store.filePath), 'property-catalogs.yml');
    const properties = new ProjectPropertyCatalogStore(path.dirname(path.dirname(store.filePath)), { beforeWrite: () => assertSaved(catalogFile) });
    const names = (await properties.read()).responsibles;
    const choice = await vscode.window.showQuickPick([
        ...names.map(value => ({ label: value, value, action: undefined })),
        { label: `$(add) ${t('Create responsible…')}`, value: undefined, action: 'create' }
    ], { title: t('Series author'), ignoreFocusOut: true });
    if (!choice) { return undefined; }
    const author = choice.value ?? await vscode.window.showInputBox({
        title: t('Series author'), prompt: t('Enter responsible name'), ignoreFocusOut: true,
        validateInput: value => value.trim() && !/[\r\n\0]/u.test(value) ? undefined : t('Name cannot be empty')
    });
    if (author === undefined) { return undefined; }
    assertSaved(store.filePath);
    const entry = await store.addSeries(prefix.trim(), author.trim(), await loadCodes(target, path.dirname(path.dirname(store.filePath))));
    await properties.add('responsibles', author);
    return entry;
}

async function chooseSeries(context: vscode.ExtensionContext, target: vscode.Uri, store: TestNumberingStore, root: string, t: Translator, manage = false): Promise<TestNumberingSeries | 'manual' | undefined> {
    assertSaved(store.filePath);
    const catalog = await store.read();
    const configuration = vscode.workspace.getConfiguration('kotTestToolkit', target);
    const configured = configuration.get<string>('numbering.prefix', '').trim();
    if (!/^(?:|manual|[0-9]{6})$/u.test(configured)) { throw new Error(t('A numbering prefix must contain exactly six digits.')); }
    const remembered = configured || context.workspaceState.get<string>(stateKey(root));
    const current = catalog.series.find(entry => entry.prefix === remembered);
    if (!manage && configured && configured !== 'manual' && !current) {
        throw new Error(t('The configured numbering prefix is not defined in this project. Add it in Workspace settings: Numbering Series.'));
    }
    const choices: SeriesChoice[] = [
        ...catalog.series.map(series => ({ label: `${series.prefix}xxx`, description: series.author, series,
            detail: series.prefix === remembered ? t('Current series') : undefined })),
        { label: `$(add) ${t('Add tester series…')}`, action: 'new' },
        { label: t('Enter codes manually'), action: 'manual' },
        ...(manage ? [{ label: `$(go-to-file) ${t('Open numbering YAML')}`, action: 'catalog' as const }] : [])
    ];
    const preferredIndex = choices.findIndex(choice => current ? choice.series?.prefix === current.prefix : remembered === 'manual' && choice.action === 'manual');
    if (preferredIndex > 0) { choices.unshift(...choices.splice(preferredIndex, 1)); }
    const choice = await vscode.window.showQuickPick(choices, {
        title: t('Author and numbering series'), placeHolder: t('Select your tester series or add it to the project'), ignoreFocusOut: true,
    });
    if (!choice) { return undefined; }
    if (choice.action === 'catalog') {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(store.filePath)));
        return undefined;
    }
    const selected = choice.action === 'new' ? await addSeries(store, target, t) : choice.action === 'manual' ? 'manual' : choice.series;
    if (selected !== undefined) {
        const prefix = selected === 'manual' ? 'manual' : selected.prefix;
        await context.workspaceState.update(stateKey(root), prefix);
        if (configured) {
            const inspected = configuration.inspect<string>('numbering.prefix');
            const scope = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
                : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await configuration.update('numbering.prefix', prefix, scope);
        }
    }
    return selected;
}

export async function promptForNewTestCode(context: vscode.ExtensionContext, target: vscode.Uri, options: {
    prompt: string; initialValue?: string; numericOnly?: boolean; existingCodes?: readonly string[];
}): Promise<NewTestCode | undefined> {
    const t = await getTranslator(context.extensionUri);
    try {
        const root = rootFor(target); const store = storeFor(root);
        const series = await chooseSeries(context, target, store, root, t);
        if (!series) { return undefined; }
        const codes = options.existingCodes ? [...options.existingCodes] : await loadCodes(target, root);
        const initial = series === 'manual' ? options.initialValue : await store.suggest(series.prefix, codes);
        const code = await vscode.window.showInputBox({
            title: t('Test code'), prompt: t(options.prompt), value: initial, ignoreFocusOut: true,
            validateInput: value => {
                const invalid = validateNewTestCode(value.trim(), options.numericOnly);
                if (invalid) { return t(invalid); }
                return codes.some(code => code.toLocaleLowerCase() === value.trim().toLocaleLowerCase()) ? t('Scenario code "{0}" already exists.', value.trim()) : undefined;
            }
        });
        if (code === undefined) { return undefined; }
        const value = code.trim(); const invalid = validateNewTestCode(value, options.numericOnly);
        if (invalid) { throw new Error(t(invalid)); }
        const effective = (await store.read()).series.find(entry => /^\d{9}$/u.test(value) && value.startsWith(entry.prefix));
        return { code: value, author: effective?.author, root, claim: async (destination, create) => {
            if (destination && rootFor(destination) !== root) { throw new Error(t('Choose a destination in the same project as the selected numbering series.')); }
            assertSaved(store.filePath);
            try { await store.claim(value, () => loadCodes(target, root), effective, create); }
            catch (error) { throw new Error(error instanceof Error ? t(error.message) : String(error)); }
        } };
    } catch (error) {
        await vscode.window.showErrorMessage(t('Could not select a test code: {0}', error instanceof Error ? t(error.message) : String(error)));
        return undefined;
    }
}

export async function handleManageTestNumbering(context: vscode.ExtensionContext): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    try {
        const target = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!target) { throw new Error(t('No workspace folder is open.')); }
        const root = rootFor(target);
        await chooseSeries(context, target, storeFor(root), root, t, true);
    } catch (error) { await vscode.window.showErrorMessage(t('Could not configure test numbering: {0}', error instanceof Error ? t(error.message) : String(error))); }
}
