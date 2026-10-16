import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { findLinkedScenarioSettings, type ScenarioPropertiesSource } from './scenarioPropertiesBindings';
import { ProjectPropertyCatalogStore, readPropertyCatalogFile, serializePropertyCatalogWrite, validatePropertyCatalogName, writePropertyCatalogFile, type ProjectPropertyCatalogKey } from './projectPropertyCatalogStore';
import { getConfiguredModelDbSettingsValue, parseEtalonBasesYaml, resolveEtalonBasesFilePath, stringifyEtalonBasesYaml, type EtalonBaseDefinition } from './etalonBases';
import { getConfiguredSystemFunctions, getNewScenarioDefaults, promptForEtalonBaseProfileValues, promptForEtalonBaseValues, promptForSystemFunctionName } from './scenarioCreator';
import { YamlParametersManager } from './yamlParametersManager';
import { assertProjectMetadataSaved, projectLibraryEnvironment } from './projectLibraryIntegration';
import { getCachedProjectLibrarySnapshot, resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { getTranslator } from './localization';
import { loadProjectSystemFunctions, projectSystemFunctionStore } from './projectSystemFunctions';

export interface ScenarioPropertiesCatalogs {
    projects: string[];
    reportLevel1: string[];
    reportLevel2: string[];
    categories: string[];
    responsibles?: string[];
    systemFunctions: { name: string; uid: string }[];
    bases: { name: string; id: string; profiles: string[] }[];
    userProfiles: string[];
    settingsUserProfiles: string[];
}
export type ScenarioPropertiesCatalogKind = 'project' | 'reportLevel1' | 'reportLevel2' | 'category' | 'responsible' | 'systemFunction' | 'headerUserProfile' | 'settingsBase' | 'settingsUserProfile';
export interface ScenarioPropertiesCatalogActionRequest {
    kind: ScenarioPropertiesCatalogKind;
    mode: 'create' | 'select';
    source: ScenarioPropertiesSource;
    selectedSettings?: ScenarioPropertiesSource;
    candidates?: readonly ScenarioPropertiesSource[];
    value?: string;
    /** Native document/version guards are repeated after every asynchronous prompt. */
    assertCurrent?: () => void;
    /** Prepare owned native metadata only after all creation prompts succeed. */
    prepareWrite?: () => Promise<void>;
}
export interface ScenarioPropertiesCatalogActionResult {
    target: 'source' | 'settings';
    value: string;
    fields?: Record<string, string>;
}
const simpleCatalogKeys = { project: 'projects', reportLevel1: 'reportLevel1', reportLevel2: 'reportLevel2', category: 'categories', responsible: 'responsibles' } as const;
const simpleFieldKeys = { project: 'Проект', reportLevel1: 'УровеньОтчета1', reportLevel2: 'УровеньОтчета2', responsible: 'Ответственный' } as const;
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
function normalized(value: string): string { return value.trim().toLocaleLowerCase(); }
function names(values: readonly string[]): string[] {
    const distinct = new Map<string, string>();
    for (const value of values) {
        if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/u.test(value)) { continue; }
        if (!distinct.has(normalized(value))) { distinct.set(normalized(value), value.trim()); }
    }
    return [...distinct.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b));
}
function scalar(document: ScenarioYamlDocument, fieldPath: readonly string[]): string {
    const field = document.findFieldAtPath(fieldPath);
    if (field?.ambiguous || field && field.valueKind !== 'scalar') { throw new Error(`Ambiguous catalog field ${fieldPath.join('.')}.`); }
    return field?.value === undefined || field.value === null ? '' : String(field.value).trim();
}
function sourceHeader(source: ScenarioPropertiesSource): 'ДанныеСценария' | 'ДанныеПроцесса' {
    const document = ScenarioYamlDocument.parse(source.text); document.requireValidForEdit();
    const type = normalized(scalar(document, ['ТипФайла']));
    if (type !== 'сценарий' && type !== 'процесс') { throw new Error('Choose a scenario or process source for the property catalog.'); }
    return type === 'процесс' ? 'ДанныеПроцесса' : 'ДанныеСценария';
}
function location(source: ScenarioPropertiesSource) {
    const uri = vscode.Uri.parse(source.uri);
    if (uri.scheme !== 'file') { throw new Error('Property catalogs require a source in the configured project or test roots.'); }
    const environment = projectLibraryEnvironment();
    const root = resolveProjectLibraryRoot(uri.fsPath, environment.workspaceRoots, environment.scanRoots);
    return { uri, root, environment };
}
function legacySystemFunctions(uri: vscode.Uri): { name: string; uid: string }[] {
    const config = vscode.workspace.getConfiguration('kotTestToolkit', uri);
    const raw = config.get<{ name?: unknown; uid?: unknown }[]>('newScenarioDefaults.systemFunctions', []);
    // Preserve duplicate identities here so selection can reject them instead of silently choosing the first.
    const valid = Array.isArray(raw) ? raw.filter(value => typeof value?.name === 'string' && value.name.trim() && typeof value.uid === 'string' && guid.test(value.uid.trim()))
        .map(value => ({ name: (value.name as string).trim(), uid: normalized(value.uid as string) })) : [];
    return valid.length ? valid : getConfiguredSystemFunctions(config);
}
async function parameterWorkspace(uri: vscode.Uri): Promise<string> {
    const direct = vscode.workspace.getWorkspaceFolder(uri);
    if (direct) { return direct.uri.fsPath; }
    const { resolveScenarioScanRootFsPath, resolveProcessScanRootFsPath } = await import('./scenarioScanRoot.js');
    const inside = (root: string) => {
        const relative = path.relative(root, uri.fsPath);
        return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    };
    const owners = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file'
        && [resolveScenarioScanRootFsPath(folder.uri), resolveProcessScanRootFsPath(folder.uri)].some(inside));
    if (owners.length !== 1) { throw new Error('The source has no unique workspace for ModelDBSettings.'); }
    return owners[0].uri.fsPath;
}
async function etalonState(context: vscode.ExtensionContext, uri: vscode.Uri) {
    const workspaceRoot = await parameterWorkspace(uri);
    const parameters = await YamlParametersManager.getInstance(context).loadParameters();
    const file = resolveEtalonBasesFilePath(workspaceRoot, getConfiguredModelDbSettingsValue(parameters));
    const original = await readPropertyCatalogFile(file);
    if (original?.trim()) {
        const yaml = parseDocument(original);
        if (yaml.errors.length || yaml.warnings.length) { throw new Error('Invalid or ambiguous etalon base YAML. Fix it before changing catalog entries.'); }
    }
    const bases = parseEtalonBasesYaml(original ?? '');
    return { workspaceRoot, file, original, bases };
}
function uniqueBase(bases: readonly EtalonBaseDefinition[], id: string): EtalonBaseDefinition {
    const matches = bases.filter(base => normalized(base.databaseId) === normalized(id));
    if (!id.trim() || matches.length !== 1) { throw new Error('The selected base is missing or ambiguous. Choose a unique base.'); }
    const base = matches[0];
    if (!base.name.trim() || bases.filter(value => normalized(value.name) === normalized(base.name)).length !== 1) { throw new Error('The selected base name is missing or ambiguous.'); }
    return base;
}
function uniqueProfiles(base: EtalonBaseDefinition): string[] {
    return names(base.userProfiles.filter(profile => base.userProfiles.filter(other => normalized(other.profileName) === normalized(profile.profileName)).length === 1).map(profile => profile.profileName));
}
function selectedBase(bases: readonly EtalonBaseDefinition[], settings?: ScenarioPropertiesSource): EtalonBaseDefinition {
    if (!settings) { throw new Error('Select a test settings file first.'); }
    const document = ScenarioYamlDocument.parse(settings.text); document.requireValidForEdit();
    const base = uniqueBase(bases, scalar(document, ['ДанныеТеста', 'ИдентификаторБазы']));
    if (normalized(base.name) !== normalized(scalar(document, ['ДанныеТеста', 'ЭталоннаяБазаИмя']))) { throw new Error('The selected settings base changed or its name and identifier do not match.'); }
    return base;
}
function requireSettings(request: ScenarioPropertiesCatalogActionRequest): ScenarioPropertiesSource {
    if (!request.selectedSettings || findLinkedScenarioSettings(request.source, [request.selectedSettings]).length !== 1) { throw new Error('Select a linked test settings file first.'); }
    return request.selectedSettings;
}
function assertBasesSaved(file: string): void {
    if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === path.resolve(file))) {
        throw new Error('Save the modified etalon bases document before changing its catalog.');
    }
}

/** Only names and stock identities cross the host boundary; credentials stay in the etalon mechanism. */
export async function loadScenarioPropertiesCatalogs(context: vscode.ExtensionContext, source: ScenarioPropertiesSource,
    candidates: readonly ScenarioPropertiesSource[] = [], selectedSettings?: ScenarioPropertiesSource,
    parseCandidate: (source: ScenarioPropertiesSource) => ScenarioYamlDocument = source => ScenarioYamlDocument.parse(source.text)): Promise<ScenarioPropertiesCatalogs> {
    sourceHeader(source);
    const { uri, root, environment } = location(source);
    const configurationUri = vscode.Uri.file(await parameterWorkspace(uri));
    const defaults = getNewScenarioDefaults(vscode.workspace.getConfiguration('kotTestToolkit', configurationUri));
    const metadata = getCachedProjectLibrarySnapshot(root)?.metadata ?? {};
    const [stored, etalon, functions] = await Promise.all([
        new ProjectPropertyCatalogStore(root).read(),
        etalonState(context, uri),
        loadProjectSystemFunctions(uri, legacySystemFunctions(configurationUri))
    ]);
    const values = { projects: [defaults.project, ...stored.projects], reportLevel1: [defaults.reportLevel1, ...stored.reportLevel1],
        reportLevel2: [defaults.mainReportLevel2, defaults.nestedReportLevel2, ...stored.reportLevel2],
        responsibles: [...stored.responsibles],
        categories: [...stored.categories, ...Object.values(metadata).map(value => value.category ?? '')] };
    let snapshots = [...candidates];
    if (!candidates.length) {
        const { scanWorkspaceForScenarioCatalog } = await import('./workspaceScanner.js');
        const scanned = await scanWorkspaceForScenarioCatalog(vscode.Uri.file(await parameterWorkspace(uri)));
        snapshots = await Promise.all(scanned.all.filter(info => {
            try { return resolveProjectLibraryRoot(info.yamlFileUri.fsPath, environment.workspaceRoots, environment.scanRoots) === root; } catch { return false; }
        }).map(async info => ({ uri: info.yamlFileUri.toString(), text: (await vscode.workspace.openTextDocument(info.yamlFileUri)).getText() })));
    }
    for (const candidate of [...snapshots.filter(value => value.uri !== source.uri), source]) {
        try {
            if (location(candidate).root !== root) { continue; }
            const document = parseCandidate(candidate); document.requireValidForEdit();
            const type = normalized(scalar(document, ['ТипФайла']));
            const header = type === 'сценарий' ? 'ДанныеСценария' : type === 'процесс' ? 'ДанныеПроцесса' : undefined;
            if (header) {
                values.projects.push(scalar(document, [header, 'Проект']));
                values.reportLevel1.push(scalar(document, [header, 'УровеньОтчета1']));
                values.reportLevel2.push(scalar(document, [header, 'УровеньОтчета2']));
                values.responsibles.push(scalar(document, [header, 'Ответственный']));
            }
            values.categories.push(scalar(document, ['KOTМетаданные', 'Категория']), scalar(document, ['metadata', 'category']));
        } catch { /* A broken unrelated YAML file cannot contribute safe catalog values. */ }
    }
    const bases = etalon.bases.flatMap(base => {
        try { uniqueBase(etalon.bases, base.databaseId); return [{ name: base.name, id: base.databaseId, profiles: uniqueProfiles(base) }]; }
        catch { return []; }
    });
    let settingsUserProfiles: string[] = [];
    if (selectedSettings) {
        try {
            if (findLinkedScenarioSettings(source, [selectedSettings]).length === 1) { settingsUserProfiles = uniqueProfiles(selectedBase(etalon.bases, selectedSettings)); }
        } catch { /* A stale base pair leaves the profile selector empty until the user selects a valid base. */ }
    }
    return { projects: names(values.projects), reportLevel1: names(values.reportLevel1), reportLevel2: names(values.reportLevel2), categories: names(values.categories),
        responsibles: names(values.responsibles), systemFunctions: functions, bases, userProfiles: names(bases.flatMap(base => base.profiles)), settingsUserProfiles };
}

function baseResult(base: EtalonBaseDefinition, settings: ScenarioPropertiesSource): ScenarioPropertiesCatalogActionResult {
    const document = ScenarioYamlDocument.parse(settings.text);
    const current = scalar(document, ['ДанныеТеста', 'ПрофильПользователя']);
    const profiles = uniqueProfiles(base);
    const profile = profiles.find(value => normalized(value) === normalized(current)) ?? profiles[0] ?? '';
    return { target: 'settings', value: base.databaseId, fields: { ЭталоннаяБазаИмя: base.name, ИдентификаторБазы: base.databaseId, ПрофильПользователя: profile } };
}

/** Creates real shared entries or validates a native dropdown selection. The caller edits its bound document. */
export async function runScenarioPropertiesCatalogAction(context: vscode.ExtensionContext, request: ScenarioPropertiesCatalogActionRequest): Promise<ScenarioPropertiesCatalogActionResult | undefined> {
    request.assertCurrent?.();
    const header = sourceHeader(request.source);
    const { uri, root, environment } = location(request.source);
    if (request.mode !== 'create' && request.mode !== 'select') { throw new Error('Unknown property catalog action.'); }
    const t = await getTranslator(context.extensionUri);
    request.assertCurrent?.();
    const simpleKey = simpleCatalogKeys[request.kind as keyof typeof simpleCatalogKeys] as ProjectPropertyCatalogKey | undefined;
    if (simpleKey) {
        const sourceDocument = ScenarioYamlDocument.parse(request.source.text);
        const previousResponsible = request.kind === 'responsible' ? scalar(sourceDocument, [header, 'Ответственный']) : '';
        const previousResponsibleUid = request.kind === 'responsible' ? scalar(sourceDocument, [header, 'UIDОтветственный']) : '';
        const result = (value: string): ScenarioPropertiesCatalogActionResult => ({ target: 'source', value,
            ...(request.kind === 'responsible' ? { fields: { Ответственный: value,
                ...(previousResponsibleUid && normalized(value) !== normalized(previousResponsible) ? { UIDОтветственный: '' } : {}) } } : {}) });
        if (request.mode === 'select') {
            const catalog = await loadScenarioPropertiesCatalogs(context, request.source, request.candidates, request.selectedSettings);
            request.assertCurrent?.();
            if (request.value === '') { return result(''); }
            const matches = (catalog[simpleKey] ?? []).filter(value => value === request.value);
            if (matches.length !== 1) { throw new Error('The selected catalog item is missing or stale. Refresh and choose it again.'); }
            return result(matches[0]);
        }
        const label = request.kind === 'category' ? t('Enter category name') : t('Enter {0}', request.kind === 'project' ? 'Проект' : simpleFieldKeys[request.kind as keyof typeof simpleFieldKeys]);
        const value = await vscode.window.showInputBox({ prompt: label, ignoreFocusOut: true,
            validateInput: value => { try { validatePropertyCatalogName(value); return undefined; } catch { return t('Enter a nonempty single-line name.'); } } });
        if (value === undefined) { return undefined; }
        await request.prepareWrite?.();
        request.assertCurrent?.(); assertProjectMetadataSaved(root);
        const name = await new ProjectPropertyCatalogStore(root, { beforeWrite: () => { request.assertCurrent?.(); assertProjectMetadataSaved(root); } }).add(simpleKey, value);
        request.assertCurrent?.(); return result(name);
    }
    if (request.kind === 'systemFunction') {
        if (header !== 'ДанныеСценария') { throw new Error('Choose a scenario for the system function.'); }
        const configurationUri = vscode.Uri.file(await parameterWorkspace(uri));
        request.assertCurrent?.();
        const functions = await loadProjectSystemFunctions(uri, legacySystemFunctions(configurationUri));
        request.assertCurrent?.();
        const choose = (value: string): ScenarioPropertiesCatalogActionResult => {
            const matches = functions.filter(item => item.uid === normalized(value));
            if (matches.length !== 1) { throw new Error('The selected system function is missing or ambiguous.'); }
            return { target: 'source', value: matches[0].uid, fields: { ФункцияСистемы: matches[0].name, UIDФункцияСистемы: matches[0].uid } };
        };
        if (request.mode === 'select') { return choose(request.value ?? ''); }
        const value = await promptForSystemFunctionName(t);
        if (value === undefined) { return undefined; }
        const name = validatePropertyCatalogName(value);
        await request.prepareWrite?.();
        request.assertCurrent?.();
        const store = projectSystemFunctionStore(uri, request.assertCurrent);
        const entry = await store.addSystemFunction(name, randomUUID());
        request.assertCurrent?.();
        return { target: 'source', value: entry.uid, fields: { ФункцияСистемы: entry.name, UIDФункцияСистемы: entry.uid } };
    }
    if (!['settingsBase', 'settingsUserProfile', 'headerUserProfile'].includes(request.kind)) { throw new Error('Unknown property catalog kind.'); }
    const settings = request.kind === 'headerUserProfile' ? undefined : requireSettings(request);
    const state = await etalonState(context, uri);
    request.assertCurrent?.();
    if (request.mode === 'select') {
        if (request.kind === 'settingsBase') { return baseResult(uniqueBase(state.bases, request.value ?? ''), settings!); }
        const profiles = request.kind === 'settingsUserProfile' ? uniqueProfiles(selectedBase(state.bases, settings))
            : names(state.bases.flatMap(base => { try { uniqueBase(state.bases, base.databaseId); return uniqueProfiles(base); } catch { return []; } }));
        if (request.value !== '' && !profiles.includes(request.value ?? '')) { throw new Error('The selected profile is missing, ambiguous or does not belong to this base.'); }
        return { target: settings ? 'settings' : 'source', value: request.value!, fields: { ПрофильПользователя: request.value! } };
    }
    assertBasesSaved(state.file);
    let bases: EtalonBaseDefinition[];
    let result: ScenarioPropertiesCatalogActionResult;
    if (request.kind === 'settingsBase') {
        const base = await promptForEtalonBaseValues(t, state.workspaceRoot);
        if (!base) { return undefined; }
        validatePropertyCatalogName(base.name); validatePropertyCatalogName(base.databaseId);
        if (state.bases.some(value => normalized(value.name) === normalized(base.name) || normalized(value.databaseId) === normalized(base.databaseId))) { throw new Error('An etalon base with this name or identifier already exists.'); }
        if (!uniqueProfiles(base).length) {
            const profile = await promptForEtalonBaseProfileValues(t);
            if (!profile) { return undefined; }
            base.userProfiles = [profile];
        }
        bases = [...state.bases, base]; result = baseResult(base, settings!);
    } else {
        let base: EtalonBaseDefinition;
        if (settings) { base = selectedBase(state.bases, settings); }
        else {
            const choices = state.bases.flatMap(base => { try { uniqueBase(state.bases, base.databaseId); return [{ label: base.name, description: base.databaseId, id: base.databaseId }]; } catch { return []; } });
            if (!choices.length) { throw new Error('Create an etalon base before creating its user profile.'); }
            const selected = await vscode.window.showQuickPick(choices, { title: t('Etalon base'), ignoreFocusOut: true });
            if (!selected) { return undefined; }
            request.assertCurrent?.(); base = uniqueBase(state.bases, selected.id);
        }
        const profile = await promptForEtalonBaseProfileValues(t);
        if (!profile) { return undefined; }
        const name = validatePropertyCatalogName(profile.profileName);
        if (base.userProfiles.some(value => normalized(value.profileName) === normalized(name))) { throw new Error('A user profile with this name already exists for the base.'); }
        bases = state.bases.map(value => value === base ? { ...base, userProfiles: [...base.userProfiles, { ...profile, profileName: name }] } : value);
        result = { target: settings ? 'settings' : 'source', value: name, fields: { ПрофильПользователя: name } };
    }
    await request.prepareWrite?.();
    request.assertCurrent?.();
    await serializePropertyCatalogWrite(state.file, () => writePropertyCatalogFile(state.file, stringifyEtalonBasesYaml(bases), state.original, () => {
        request.assertCurrent?.(); assertProjectMetadataSaved(root); assertBasesSaved(state.file);
    }));
    request.assertCurrent?.(); return result;
}
