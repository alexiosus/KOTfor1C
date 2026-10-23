import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScenarioYamlEditor } from './scenarioYamlEditor';
import type { ScenarioPropertiesDocument } from './scenarioPropertiesSession';
import type { Translator } from './localization';
import type { TestInfo } from './types';
import type { ScenarioIdentityChangeResult } from './scenarioPropertyIdentity';

export interface ScenarioPropertiesActionOptions {
    renameScenario(target: { name: string; uri: string }, value?: string, field?: 'name' | 'code'): Promise<ScenarioIdentityChangeResult | void>;
}

function inside(root: string, file: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertCurrent(document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator): void {
    if (document.isClosed || document.version !== source.version || document.getText() !== source.text) {
        throw new Error(t('The source changed. Refresh the properties and retry the action.'));
    }
}
async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; }
    catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === 'FileNotFound' || code === 'ENOENT') { return false; }
        throw error;
    }
}

async function sourceWorkspace(uri: vscode.Uri, t: Translator): Promise<vscode.Uri> {
    const direct = vscode.workspace.getWorkspaceFolder(uri);
    if (direct) { return direct.uri; }
    const { resolveScenarioScanRootFsPath, resolveProcessScanRootFsPath } = await import('./scenarioScanRoot.js');
    const owners = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file'
        && [resolveScenarioScanRootFsPath(folder.uri), resolveProcessScanRootFsPath(folder.uri)].some(root => inside(root, uri.fsPath)));
    if (owners.length !== 1) { throw new Error(t('Choose a source in one owning workspace or its configured test roots.')); }
    return owners[0].uri;
}

export async function createScenarioLaunchSettings(context: vscode.ExtensionContext, document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator): Promise<vscode.Uri | undefined> {
    const [{ readScenarioProperties }, { projectLibraryEnvironment }, { resolveProjectLibraryRoot },
        { promptForSelectedEtalonBaseValues }, { buildScenarioTestSettings }] = await Promise.all([
        import('./scenarioPropertiesModel.js'), import('./projectLibraryIntegration.js'), import('./projectLibraryMetadata.js'),
        import('./scenarioCreator.js'), import('./scenarioTestSettingsModel.js')
    ]);
    assertCurrent(document, source, t);
    if (document.uri.scheme !== 'file') { throw new Error(t('Choose a scenario in the configured project or test roots.')); }
    const model = readScenarioProperties(source.text);
    const environment = projectLibraryEnvironment();
    const owner = resolveProjectLibraryRoot(document.uri.fsPath, environment.workspaceRoots, environment.scanRoots);
    const code = model.header.find(field => field.key === 'Код')?.value.trim() ?? '';
    if (!code || /[\\/:*?"<>|\u0000-\u001f]/u.test(code) || /[. ]$/u.test(code)
        || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(code)) {
        throw new Error(t('Set a valid scenario or process code before creating launch settings. The code is used as the settings filename.'));
    }
    const user = model.header.find(field => field.key === 'ПрофильПользователя')?.value || '';
    const workspace = await sourceWorkspace(document.uri, t);
    const selectedBase = await promptForSelectedEtalonBaseValues(t, context, user, workspace.fsPath);
    if (!selectedBase) { return; }
    assertCurrent(document, source, t);
    const target = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), 'test', `${code}.yaml`));
    assertCurrent(document, source, t);
    if (target.scheme !== 'file' || target.query || target.fragment || !/\.ya?ml$/iu.test(target.fsPath)
        || resolveProjectLibraryRoot(target.fsPath, environment.workspaceRoots, environment.scanRoots) !== owner) {
        throw new Error(t('Choose a YAML path inside the source project or its configured test roots.'));
    }
    const assertTargetSaved = () => {
        if (vscode.workspace.textDocuments.some(candidate => candidate.uri.toString() === target.toString() && !candidate.isClosed && candidate.isDirty)) {
            throw new Error(t('The launch settings target has modified text. Save it before creating settings.'));
        }
    };
    assertTargetSaved();
    if (await fileExists(target)) { throw new Error(t('The launch settings path already exists: {0}', target.fsPath)); }
    assertTargetSaved();
    const text = buildScenarioTestSettings(source.text, {
        uid: randomUUID(), databaseName: selectedBase.baseName, databaseId: selectedBase.baseId, userProfile: selectedBase.userProfile
    });
    assertCurrent(document, source, t);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
    assertCurrent(document, source, t); assertTargetSaved();
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(target, { overwrite: false, ignoreIfExists: false });
    edit.insert(target, new vscode.Position(0, 0), text);
    if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t('Could not create settings. The target may have changed; refresh and retry.')); }
    // Keep the inserted native document dirty for the panel's Save test action.
    await vscode.workspace.openTextDocument(target);
    return target;
}

/** Reuse the established identity, catalog and project workflows with the panel's bound URI. */
export function createScenarioPropertiesActions(
    context: vscode.ExtensionContext,
    textEditor: ScenarioYamlEditor,
    options: ScenarioPropertiesActionOptions
): import('./scenarioPropertiesSession').ScenarioPropertiesHost['runAction'] {
    async function savedSource(document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator): Promise<void> {
        assertCurrent(document, source, t);
        if (document.isDirty) { throw new Error(t('Save source changes before changing identity or generating a description.')); }
    }
    async function inRawEditor(document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator,
        operation: (editor: vscode.TextEditor) => Promise<void>, allowDirty = false): Promise<void> {
        const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === document.uri.toString());
        const rawEditor = await vscode.window.showTextDocument(document, {
            viewColumn: visible?.viewColumn ?? vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
            preview: false, preserveFocus: false
        });
        if (allowDirty) { assertCurrent(document, source, t); } else { await savedSource(document, source, t); }
        await operation(rawEditor);
    }
    async function replace(document: vscode.TextDocument, source: ScenarioPropertiesDocument, text: string, t: Translator): Promise<void> {
        assertCurrent(document, source, t);
        if (text === source.text) { return; }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(source.text.length)), text);
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t('Could not apply the properties action. Refresh and retry.')); }
    }
    async function saveMetadataBeforeCreation(source: ScenarioPropertiesDocument, t: Translator): Promise<void> {
        const { createScenarioPropertiesHost } = await import('./scenarioPropertiesPanel.js');
        const host = createScenarioPropertiesHost({ runAction: async () => undefined });
        const metadata = await host.readMetadata(source);
        if (metadata?.dirty && !await host.saveDocument(metadata.uri)) { throw new Error(t('Could not save metadata before creating a catalog item.')); }
    }
    async function catalogChoice(action: string, source: ScenarioPropertiesDocument, selectedUri: string | null, raw: string | undefined, t: Translator,
        candidates?: import('./scenarioPropertiesBindings').ScenarioPropertiesSource[]): Promise<void> {
        if (!raw) { throw new Error(t('Missing property catalog target.')); }
        const spec = JSON.parse(raw) as { field: string; section: string; documentUri: string; documentVersion: number; value?: string };
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri));
        assertCurrent(document, source, t);
        const metadata = spec.section === 'metadata';
        const expectedMetadataUri = source.uri + '.kot.yml';
        if (metadata ? ![source.uri, expectedMetadataUri].includes(spec.documentUri) : spec.documentUri !== source.uri && spec.documentUri !== selectedUri) {
            throw new Error(t('The property target is not bound to the selected test/settings.'));
        }
        let targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(spec.documentUri));
        let target: ScenarioPropertiesDocument = { uri: spec.documentUri, version: spec.documentVersion, text: targetDocument.getText(), dirty: targetDocument.isDirty };
        assertCurrent(targetDocument, target, t);
        const settingsDocument = selectedUri ? await vscode.workspace.openTextDocument(vscode.Uri.parse(selectedUri)) : undefined;
        const selectedSettings = settingsDocument ? { uri: selectedUri!, version: settingsDocument.version, text: settingsDocument.getText(), dirty: settingsDocument.isDirty } : undefined;
        const targetKind = !metadata && target.uri !== source.uri ? 'settings' : 'source';
        const kinds: Record<string, import('./scenarioPropertiesCatalogs').ScenarioPropertiesCatalogKind> = {
            Проект: 'project', УровеньОтчета1: 'reportLevel1', УровеньОтчета2: 'reportLevel2', Ответственный: 'responsible', ФункцияСистемы: 'systemFunction', category: 'category',
            ЭталоннаяБазаИмя: 'settingsBase', ПрофильПользователя: targetKind === 'settings' ? 'settingsUserProfile' : 'headerUserProfile'
        };
        const kind = kinds[spec.field];
        if (!kind || metadata !== (kind === 'category')) { throw new Error(t('Unsupported property catalog target.')); }
        const { readScenarioProperties } = await import('./scenarioPropertiesModel.js');
        const targetModel = readScenarioProperties(metadata ? source.text : target.text);
        const targetHeader = targetModel.kind === 'scenario' ? 'ДанныеСценария' : targetModel.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеТеста';
        if (!metadata && (spec.section !== targetHeader || !targetModel.header.some(field => field.key === spec.field))) {
            throw new Error(t('Unsupported property catalog target.'));
        }
        const { runScenarioPropertiesCatalogAction } = await import('./scenarioPropertiesCatalogs.js');
        const guard = () => {
            assertCurrent(document, source, t); assertCurrent(targetDocument, target, t);
            if (settingsDocument && selectedSettings) { assertCurrent(settingsDocument, selectedSettings, t); }
        };
        const result = await runScenarioPropertiesCatalogAction(context, { kind, mode: action === 'createChoice' ? 'create' : 'select', source, selectedSettings, candidates,
            prepareWrite: async () => {
                guard(); await saveMetadataBeforeCreation(source, t); assertCurrent(document, source, t);
                if (!metadata) { assertCurrent(targetDocument, target, t); }
                else if (targetDocument.getText() !== target.text || targetDocument.isClosed) { throw new Error(t('The document changed. Refresh the properties and retry the edit.')); }
                target = { ...target, version: targetDocument.version, dirty: targetDocument.isDirty };
                guard();
            }, value: spec.value, assertCurrent: guard });
        if (!result) { return; }
        assertCurrent(document, source, t); assertCurrent(targetDocument, target, t);
        const { applyScenarioPropertyEdit, applyScenarioSystemFunction, applyYamlMapField } = await import('./scenarioPropertiesModel.js');
        if (metadata) {
            const { createScenarioPropertiesHost } = await import('./scenarioPropertiesPanel.js');
            const host = createScenarioPropertiesHost({ runAction: async () => undefined });
            if (target.uri === source.uri) {
                target = await host.ensureMetadata(source);
                targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
            }
            await replace(targetDocument, target, applyYamlMapField(target.text, ['metadata', 'category'], result.value), t);
        } else if (kind === 'systemFunction') {
            await replace(targetDocument, target, applyScenarioSystemFunction(target.text, result.fields!.ФункцияСистемы, result.fields!.UIDФункцияСистемы), t);
        } else {
            if ((result.target === 'settings') !== (targetKind === 'settings')) { throw new Error(t('The catalog result belongs to another document.')); }
            const fields = result.fields ?? { [spec.field]: result.value };
            let text = target.text;
            for (const [field, value] of Object.entries(fields)) {
                text = kind === 'responsible' && field === 'UIDОтветственный'
                    ? applyYamlMapField(text, [spec.section, field], value)
                    : applyScenarioPropertyEdit(text, { section: spec.section, field, value });
            }
            await replace(targetDocument, target, text, t);
        }
    }
    async function createSettings(document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator): Promise<void> {
        await createScenarioLaunchSettings(context, document, source, t);
    }
    async function addNested(document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator): Promise<void> {
        const [{ readScenarioProperties, addScenarioPropertyRecord }, { scanWorkspaceForScenarioCatalog }] = await Promise.all([
            import('./scenarioPropertiesModel.js'), import('./workspaceScanner.js')
        ]);
        assertCurrent(document, source, t);
        const model = readScenarioProperties(source.text);
        if (model.kind !== 'scenario') { throw new Error(t('Choose a scenario to add nested declarations.')); }
        const workspace = await sourceWorkspace(document.uri, t);
        const catalog = await scanWorkspaceForScenarioCatalog(workspace);
        const uidCounts = new Map<string, number>();
        for (const entry of catalog.all) {
            if (entry.kind !== 'process' && entry.uid?.trim()) {
                const key = entry.uid.trim().toLowerCase(); uidCounts.set(key, (uidCounts.get(key) || 0) + 1);
            }
        }
        const currentUid = model.header.find(field => field.key === 'UID')?.value.toLowerCase();
        const existing = new Set(model.sections.find(section => section.key === 'ВложенныеСценарии')?.records?.map(record => record.key.toLowerCase()));
        const candidates = catalog.all.filter(entry => entry.kind !== 'process' && entry.uid?.trim()
            && uidCounts.get(entry.uid.trim().toLowerCase()) === 1 && entry.yamlFileUri.toString() !== document.uri.toString()
            && entry.uid.trim().toLowerCase() !== currentUid && !existing.has(entry.uid.trim().toLowerCase()));
        if (!candidates.length) { throw new Error(t('No unique scenario definitions are available to add.')); }
        const selected = await vscode.window.showQuickPick(candidates.map(entry => ({ label: entry.name, description: entry.scenarioCode || '',
            detail: entry.yamlFileUri.fsPath, entry })), { title: t('Add nested scenario'), ignoreFocusOut: true });
        if (!selected) { return; }
        const fresh = await scanWorkspaceForScenarioCatalog(workspace);
        assertCurrent(document, source, t);
        const matches = fresh.all.filter(entry => entry.kind !== 'process' && entry.uid?.trim().toLowerCase() === selected.entry.uid!.trim().toLowerCase());
        if (matches.length !== 1 || matches[0].yamlFileUri.toString() !== selected.entry.yamlFileUri.toString() || matches[0].name !== selected.entry.name) {
            throw new Error(t('The selected scenario changed or its UID is ambiguous. Refresh and choose it again.'));
        }
        await replace(document, source, addScenarioPropertyRecord(source.text, { section: 'ВложенныеСценарии' }, {
            UIDВложенныйСценарий: matches[0].uid!, ИмяСценария: matches[0].name
        }), t);
    }
    async function openReference(document: vscode.TextDocument, source: ScenarioPropertiesDocument, value: string | undefined, t: Translator): Promise<void> {
        const [{ readScenarioProperties }, { scanWorkspaceForScenarioCatalog }] = await Promise.all([
            import('./scenarioPropertiesModel.js'), import('./workspaceScanner.js')
        ]);
        assertCurrent(document, source, t);
        const model = readScenarioProperties(document.getText());
        const section = model.kind === 'process' ? 'ШагиПроцесса' : 'ВложенныеСценарии';
        const records = model.sections.find(item => item.key === section)?.records?.filter(record => record.key === value) || [];
        if (records.length !== 1) { throw new Error(t('The referenced record is missing or stale. Refresh the properties.')); }
        const fields = new Map(records[0].fields.map(field => [field.key, field.value]));
        const process = section === 'ШагиПроцесса' && fields.get('ТипШага') === '1';
        const uid = (process ? fields.get('ВложенныйПроцессUID') : section === 'ШагиПроцесса' ? fields.get('СценарийUID') || fields.get('Сценарий') : fields.get('UIDВложенныйСценарий'))?.trim().toLowerCase();
        const name = (process ? fields.get('ВложенныйПроцессНаименование') : section === 'ШагиПроцесса' ? fields.get('СценарийНаименование') : fields.get('ИмяСценария'))?.trim().toLowerCase();
        if (!uid && !name) { throw new Error(t('The referenced definition has no UID or name.')); }
        const catalog = await scanWorkspaceForScenarioCatalog(await sourceWorkspace(document.uri, t));
        assertCurrent(document, source, t);
        const matches = catalog.all.filter(entry => (entry.kind === 'process') === process
            && (uid ? entry.uid?.trim().toLowerCase() === uid : entry.name.trim().toLowerCase() === name));
        if (matches.length !== 1) { throw new Error(t('The referenced definition is missing or ambiguous. Choose a unique definition.')); }
        if (process) { await vscode.commands.executeCommand('kotTestToolkit.openScenarioEditor', matches[0].yamlFileUri); }
        else { await textEditor.open(matches[0].yamlFileUri); }
    }
    async function newGroup(document: vscode.TextDocument, source: ScenarioPropertiesDocument, t: Translator): Promise<void> {
        const [{ projectedProjectScenario, projectLibraryEnvironment, assertProjectMetadataSaved, persistProjectMetadata },
            { createProjectLibraryStore, resolveProjectLibraryRoot }] = await Promise.all([
            import('./projectLibraryIntegration.js'), import('./projectLibraryMetadata.js')
        ]);
        assertCurrent(document, source, t);
        const info = projectedProjectScenario(document);
        if (!info || document.uri.scheme !== 'file') { throw new Error(t('Choose a scenario or process in a project.')); }
        const environment = projectLibraryEnvironment();
        const owner = resolveProjectLibraryRoot(document.uri.fsPath, environment.workspaceRoots, environment.scanRoots);
        const name = await vscode.window.showInputBox({ title: t('New group'), prompt: t('Enter group name'), ignoreFocusOut: true,
            validateInput: value => value.trim() && !/[\r\n\0]/u.test(value) ? undefined : t('Group name cannot be empty.') });
        if (!name?.trim()) { return; }
        if (/[\r\n\0]/u.test(name)) { throw new Error(t('Enter a single-line group name.')); }
        assertCurrent(document, source, t); await saveMetadataBeforeCreation(source, t);
        assertCurrent(document, source, t); assertProjectMetadataSaved(owner);
        const store = createProjectLibraryStore(owner, environment.workspaceRoots, environment.scanRoots, assertProjectMetadataSaved);
        const group = await store.ensureGroup(name.trim(), info.kind === 'process' ? 'process' : 'main');
        assertCurrent(document, source, t);
        if (!await persistProjectMetadata(document, { groupId: group.id })) { throw new Error(t('Could not assign the new group to this source.')); }
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcher', { refreshCache: true });
    }
    return async (action, source, settings, value, catalogs) => {
        if (action === 'convertRole') { return vscode.commands.executeCommand('kotTestToolkit.convertScenarioRole', vscode.Uri.parse(source.uri), value === 'main'); }
        if (action === 'convertFormat') { return vscode.commands.executeCommand('kotTestToolkit.convertScenarioFormat', vscode.Uri.parse(source.uri)); }
        if (action === 'openFeature') {
            const sourceFiles = await (await import('./spprScenarioFiles.js')).resolveScenarioSourceUris(vscode.Uri.parse(source.uri));
            if (sourceFiles?.format === 'native') { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sourceFiles.scriptUri), { preview: false }); }
            return;
        }
        if (action === 'run') { await vscode.commands.executeCommand('kotTestToolkit.runTestFromSource', vscode.Uri.parse(source.uri)); return; }
        if (action === 'copyPath') {
            if (!value || ![source.uri, settings, source.uri + '.kot.yml'].includes(value)) { throw new Error('The property target is not bound to the selected test/settings.'); }
            const target = vscode.Uri.parse(value, true);
            if (target.scheme !== 'file') { throw new Error('Choose a scenario or process source.'); }
            await vscode.env.clipboard.writeText(target.fsPath); return;
        }
        if (action === 'openSource' || action === 'openSettings') {
            const target = action === 'openSource' ? source.uri : settings;
            if (!target) { throw new Error(vscode.l10n.t('Select a test settings file first.')); }
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(target)), { preview: false });
            return;
        }
        if (action === 'openText') { await textEditor.open(vscode.Uri.parse(source.uri)); return; }
        const { getTranslator } = await import('./localization.js');
        const t = await getTranslator(context.extensionUri);
        const uri = vscode.Uri.parse(source.uri);
        const document = await vscode.workspace.openTextDocument(uri);
        const execute = async (command: string, target = uri): Promise<void> => { await vscode.commands.executeCommand(command, target); };
        if (['base', 'users'].includes(action)) {
            if (!settings) { throw new Error(t('Select a test settings file first.')); }
            const selected = vscode.Uri.parse(settings);
            await execute(action === 'base' ? 'kotTestToolkit.changeTestSettingsEtalonBaseFromEditor' : 'kotTestToolkit.changeTestSettingsUserProfileFromEditor', selected);
            return;
        }
        if (action === 'createChoice' || action === 'catalogChoice') { await catalogChoice(action, source, settings, value, t, catalogs?.candidates); return; }
        assertCurrent(document, source, t);
        if (action === 'openMetadata') { await execute('kotTestToolkit.openProjectMetadata'); return; }
        if (action === 'changeGroup') { await execute('kotTestToolkit.changeScenarioGroup'); return; }
        if (action === 'newGroup') { await newGroup(document, source, t); return; }
        if (action === 'createSettings') { await createSettings(document, source, t); return; }
        if (action === 'addNested') { await addNested(document, source, t); return; }
        if (action === 'openReference') { await openReference(document, source, value, t); return; }
        if (action === 'fillParameters' || action === 'fillNested') {
            if (/(?:^|[\\/])meta\.yaml$/u.test(document.fileName)) {
                const { clearAndFillNestedScenarios, clearAndFillScenarioParameters } = await import('./commandHandlers.js');
                if (action === 'fillParameters') { await clearAndFillScenarioParameters(document, true); }
                else { await clearAndFillNestedScenarios(document, true); }
                if (!await document.save()) { throw new Error(t('Could not save synchronized SPPR metadata. Unsaved changes were retained.')); }
                return;
            }
            await inRawEditor(document, source, t, async () => {
                await vscode.commands.executeCommand(action === 'fillParameters' ? 'kotTestToolkit.checkAndFillScriptParameters' : 'kotTestToolkit.checkAndFillNestedScenarios');
            }, true); return;
        }
        const { readScenarioProperties } = await import('./scenarioPropertiesModel.js');
        const model = readScenarioProperties(source.text);
        if (action === 'systemFunction' && value !== undefined) {
            const { getProjectScenarioDefaults } = await import('./scenarioCreator.js');
            const choices = (await getProjectScenarioDefaults(uri)).systemFunctions;
            assertCurrent(document, source, t);
            const matches = choices.filter(choice => choice.uid === value);
            if (matches.length !== 1 || model.kind !== 'scenario') { throw new Error(t('Select a configured system function.')); }
            const { applyScenarioSystemFunction } = await import('./scenarioPropertiesModel.js');
            const updated = applyScenarioSystemFunction(source.text, matches[0].name, matches[0].uid);
            await replace(document, source, updated, t); return;
        }
        if (action === 'addSteps') {
            if (model.kind !== 'process') { throw new Error(t('Choose a process to add steps.')); }
            await execute('kotTestToolkit.addProcessSteps'); return;
        }
        if (!['rename', 'changeCode', 'systemFunction', 'aiDescription'].includes(action)) { throw new Error(t('Unknown test properties action.')); }
        if ((value !== undefined && ['rename', 'changeCode'].includes(action) || action === 'aiDescription') && document.isDirty) {
            assertCurrent(document, source, t);
            if (!await document.save()) { throw new Error(t('Could not save source before changing identity.')); }
            source = { uri: source.uri, text: document.getText(), version: document.version, dirty: document.isDirty };
        }
        await savedSource(document, source, t);
        if ((action === 'rename' || action === 'changeCode') && value !== undefined) {
            if (model.kind === 'process') {
                const { changeProcessIdentityFromEditor } = await import('./processEditorCommands.js');
                return changeProcessIdentityFromEditor(context, action === 'rename' ? 'name' : 'code', uri, value);
            } else {
                assertCurrent(document, source, t);
                return options.renameScenario({ name: model.title, uri: source.uri }, value, action === 'rename' ? 'name' : 'code');
            }
            return;
        }
        if ((action === 'rename' || action === 'changeCode') && model.kind === 'process') {
            await execute(action === 'rename' ? 'kotTestToolkit.renameProcessFromEditor' : 'kotTestToolkit.changeProcessCodeFromEditor'); return;
        }
        if (action === 'rename') { await options.renameScenario({ name: model.title, uri: source.uri }); return; }
        if (action === 'changeCode') {
            const { projectedProjectScenario } = await import('./projectLibraryIntegration.js');
            const info: TestInfo | null = projectedProjectScenario(document);
            assertCurrent(document, source, t);
            if (info?.tabName) { await options.renameScenario({ name: model.title, uri: source.uri }); }
            else { await inRawEditor(document, source, t, async () => { await vscode.commands.executeCommand('kotTestToolkit.changeNestedScenarioCode'); }); }
            return;
        }
        if (action === 'systemFunction') {
            await inRawEditor(document, source, t, async () => { await vscode.commands.executeCommand('kotTestToolkit.changeScenarioSystemFunctionFromEditor'); }); return;
        }
        const { handleGenerateScenarioDescriptionWithAi } = await import('./scenarioAiDescription.js');
        assertCurrent(document, source, t);
        await inRawEditor(document, source, t, editor => handleGenerateScenarioDescriptionWithAi(editor));
    };
}
