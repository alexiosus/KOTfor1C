import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTranslator, type Translator } from './localization';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { scanWorkspaceForScenarioCatalog } from './workspaceScanner';
import { updateCompilerProcessIdentity } from './compilerProcesses';
import { prepareScenarioIdentityFileChanges } from './scenarioIdentityFiles';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import type { ScenarioIdentityChangeResult } from './scenarioPropertyIdentity';
import { createScenarioPropertiesHost } from './scenarioPropertiesPanel';
import { findLinkedScenarioSettings } from './scenarioPropertiesBindings';
import { projectLibraryEnvironment } from './projectLibraryIntegration';

async function editorDocument(target: vscode.Uri | undefined, t: Translator): Promise<vscode.TextDocument> {
    const document = target ? await vscode.workspace.openTextDocument(target) : vscode.window.activeTextEditor?.document;
    if (!document) { throw new Error(t('No active editor.')); }
    if (document.uri.scheme !== 'file') { throw new Error(t('Choose a process YAML descriptor.')); }
    return document;
}

function workspaceFor(document: vscode.TextDocument, t: Translator): vscode.Uri {
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri) || vscode.workspace.workspaceFolders?.[0];
    if (!workspace) { throw new Error(t('Open a workspace to edit process steps.')); }
    return workspace.uri;
}

async function linkedSettings(document: vscode.TextDocument): Promise<vscode.Uri[]> {
    const source = { uri: document.uri.toString(), text: document.getText(), version: document.version, dirty: document.isDirty };
    const host = createScenarioPropertiesHost({ runAction: async () => undefined });
    return findLinkedScenarioSettings(source, await host.listSettings(source)).map(settings => vscode.Uri.parse(settings.uri));
}

export async function openProcessTestSettingsFromEditor(context: vscode.ExtensionContext, target?: vscode.Uri): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    try {
        const document = await editorDocument(target, t);
        const descriptor = parseScenarioDescriptor(document.getText());
        if (descriptor.kind !== 'process' || !descriptor.uid) { throw new Error(t('Choose a process YAML descriptor.')); }
        const files = await linkedSettings(document);
        if (!files.length) { throw new Error(t('Run settings file was not found for process "{0}".', descriptor.name || '')); }
        const selected = files.length === 1 ? files[0] : (await vscode.window.showQuickPick(files.map(uri => ({
            label: path.basename(uri.fsPath), detail: uri.fsPath, uri
        })), { title: t('Select process run settings'), ignoreFocusOut: true }))?.uri;
        if (selected) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(selected), { preview: false }); }
    } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
}

export async function changeProcessIdentityFromEditor(
    context: vscode.ExtensionContext, field: 'name' | 'code', target?: vscode.Uri, directValue?: string
): Promise<ScenarioIdentityChangeResult | void> {
    const t = await getTranslator(context.extensionUri);
    try {
        const document = await editorDocument(target, t);
        const source = document.getText(); const version = document.version;
        const descriptor = parseScenarioDescriptor(source);
        if (descriptor.kind !== 'process' || !descriptor.uid || !descriptor.name) { throw new Error(t('Choose a process YAML descriptor.')); }
        if (document.isDirty) { throw new Error(t('Save modified files before changing process identity.')); }
        const workspace = workspaceFor(document, t);
        let catalog = await scanWorkspaceForScenarioCatalog(workspace);
        const definitions = catalog.all.filter(info => info.kind === 'process' && info.uid?.toLowerCase() === descriptor.uid!.toLowerCase());
        if (definitions.length !== 1 || definitions[0].yamlFileUri.toString() !== document.uri.toString()) { throw new Error(t('Process UID is missing or ambiguous in the workspace.')); }
        const initial = field === 'name' ? descriptor.name : descriptor.scenarioCode || '';
        const validateInput = (input: string): string | undefined => {
            const value = input.trim();
            if (!value || /[\r\n]/u.test(value)) { return t('Enter a non-empty single-line value.'); }
            if (field === 'code' && !/^\d+$/u.test(value)) { return t('Process code must contain digits only.'); }
            if (catalog.all.some(info => info.yamlFileUri.toString() !== document.uri.toString()
                && (field === 'name' ? info.name : info.scenarioCode || '').trim().toLowerCase() === value.toLowerCase())) {
                return t('Process name or code is already used in the workspace.');
            }
            return undefined;
        };
        const next = directValue ?? await vscode.window.showInputBox({
            title: t(field === 'name' ? 'Rename process' : 'Change process code'),
            prompt: t(field === 'name' ? 'Enter new process name' : 'Enter new process numeric code'),
            value: initial, ignoreFocusOut: true, validateInput
        });
        if (next === undefined || next.trim() === initial) { return; }
        if (document.version !== version || document.getText() !== source) { throw new Error(t('Process changed while editing. Run the command again.')); }
        catalog = await scanWorkspaceForScenarioCatalog(workspace);
        const refreshedDefinitions = catalog.all.filter(info => info.kind === 'process' && info.uid?.toLowerCase() === descriptor.uid!.toLowerCase());
        if (refreshedDefinitions.length !== 1 || refreshedDefinitions[0].yamlFileUri.toString() !== document.uri.toString()) { throw new Error(t('Process UID is missing or ambiguous in the workspace.')); }
        const validation = validateInput(next);
        if (validation) { throw new Error(validation); }
        const settings = await linkedSettings(document);
        const files = new Map(catalog.all.filter(info => info.kind === 'process').map(info => [info.yamlFileUri.toString(), info.yamlFileUri]));
        files.set(document.uri.toString(), document.uri);
        for (const uri of settings) { files.set(uri.toString(), uri); }
        const writes = [];
        for (const uri of files.values()) {
            const before = await fs.readFile(uri.fsPath, 'utf8');
            if (uri.toString() === document.uri.toString() && !nativeDocumentTextMatchesFileText(source, before)) { throw new Error(t('Process changed while editing. Run the command again.')); }
            const after = updateCompilerProcessIdentity(before, { uid: descriptor.uid, oldName: descriptor.name,
                name: field === 'name' ? next.trim() : descriptor.name, oldCode: descriptor.scenarioCode,
                ...(field === 'code' ? { code: next.trim() } : {}) });
            if (after !== before) { writes.push({ key: uri, before, after }); }
        }
        const environment = projectLibraryEnvironment();
        const fileChanges = await prepareScenarioIdentityFileChanges({
            sourceUri: document.uri, uid: descriptor.uid, oldCode: descriptor.scenarioCode || '', code: field === 'code' ? next.trim() : descriptor.scenarioCode || '', moveFiles: field === 'code',
            relatedUris: settings, definitionUris: catalog.all.map(info => info.yamlFileUri),
            protectedDirectories: [...environment.workspaceRoots, ...environment.scanRoots]
        });
        for (const write of writes) {
            if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === write.key.toString() && doc.isDirty)) { throw new Error(t('Save modified files before changing process identity.')); }
            if (await fs.readFile(write.key.fsPath, 'utf8') !== write.before) { throw new Error(t('Process changed while editing. Run the command again.')); }
        }
        if (document.version !== version || document.getText() !== source || document.isDirty) { throw new Error(t('Process changed while editing. Run the command again.')); }
        await fileChanges.apply(writes);
        const result = fileChanges.result;
        const changedUris = writes.map(write => {
            let file = write.key.fsPath;
            for (const move of result.uriMoves) {
                const oldPath = vscode.Uri.parse(move.oldUri).fsPath;
                const relative = path.relative(oldPath, file);
                if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { file = path.join(vscode.Uri.parse(move.newUri).fsPath, relative); }
            }
            return vscode.Uri.file(file);
        });
        await vscode.commands.executeCommand('kotTestToolkit._processSourceFilesChanged', changedUris);
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
        return result;
    } catch (error) {
        if (directValue !== undefined) { throw error; }
        await vscode.window.showErrorMessage(t('Could not edit process: {0}', error instanceof Error ? error.message : String(error)));
    }
}

/** Relink process settings, preserving their independent name, code and parameter overrides. */
export async function changeProcessTestSettingsFromEditor(context: vscode.ExtensionContext, target?: vscode.Uri): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    try {
        const document = await editorDocument(target, t);
        const source = document.getText(); const version = document.version;
        if (document.isDirty) { throw new Error(t('Save modified files before changing process identity.')); }
        const yaml = ScenarioYamlDocument.parse(source); yaml.requireValidForEdit();
        if (String(yaml.findFieldAtPath(['ТипФайла'])?.value).trim().toLowerCase() !== 'настройкапроцесса') { throw new Error(t('Choose process run settings YAML.')); }
        const catalog = await scanWorkspaceForScenarioCatalog(workspaceFor(document, t));
        const selected = await vscode.window.showQuickPick(catalog.all.filter(info => info.kind === 'process' && info.uid).map(info => ({
            label: info.name, description: info.processCode, detail: info.relativePath, info
        })), { title: t('Change linked process'), ignoreFocusOut: true });
        if (!selected) { return; }
        if (document.version !== version || document.getText() !== source) { throw new Error(t('Process changed while editing. Run the command again.')); }
        const refreshed = await scanWorkspaceForScenarioCatalog(workspaceFor(document, t));
        const definitions = refreshed.all.filter(info => info.kind === 'process' && info.uid?.toLowerCase() === selected.info.uid!.toLowerCase());
        if (definitions.length !== 1 || definitions[0].yamlFileUri.toString() !== selected.info.yamlFileUri.toString()) { throw new Error(t('Process UID is missing or ambiguous in the workspace.')); }
        if (document.version !== version || document.getText() !== source) { throw new Error(t('Process changed while editing. Run the command again.')); }
        const fields = [['UIDПроцесса', definitions[0].uid!], ['ПроцессНаименование', definitions[0].name]] as const;
        const edit = new vscode.WorkspaceEdit();
        for (const [name, value] of fields) {
            const field = yaml.findField('ДанныеТеста', name);
            if (!field || field.ambiguous || field.valueKind !== 'scalar' || !field.valueRange) { throw new Error(t('Process settings reference fields are missing or ambiguous.')); }
            edit.replace(document.uri, new vscode.Range(document.positionAt(field.valueRange.start), document.positionAt(field.valueRange.end)), JSON.stringify(value));
        }
        if (!await vscode.workspace.applyEdit(edit) || !await document.save()) { throw new Error(t('Could not save process settings.')); }
        const previousUid = String(yaml.findField('ДанныеТеста', 'UIDПроцесса')?.value || '').trim().toLowerCase();
        const previous = catalog.all.filter(info => info.kind === 'process' && info.uid?.toLowerCase() === previousUid);
        await vscode.commands.executeCommand('kotTestToolkit._processSourceFilesChanged', [document.uri, definitions[0].yamlFileUri, ...previous.map(info => info.yamlFileUri)]);
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
    } catch (error) { await vscode.window.showErrorMessage(t('Could not edit process: {0}', error instanceof Error ? error.message : String(error))); }
}
