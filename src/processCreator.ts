import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getTranslator, type Translator } from './localization';
import { scanWorkspaceForScenarioCatalog } from './workspaceScanner';
import { resolveScenarioScanRootFsPath, resolveProcessScanRootFsPath } from './scenarioScanRoot';
import { resolveMainScenarioGroupSeed } from './scenarioCreationSeed';
import { promptForSelectedEtalonBaseValues } from './scenarioCreator';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import {
    appendCompilerProcessScenarioStep,
    buildCompilerProcessFiles,
    canEmbedCompilerProcess,
    moveCompilerProcessStep,
    removeCompilerProcessStep,
    type CompilerProcessScenario
} from './compilerProcesses';
import type { TestInfo } from './types';
import { registerCreatedProjectScenario } from './projectLibraryIntegration';
import { promptForNewTestCode } from './testNumbering';
import { promptForProcessCreationProperties, applyCreationResponsible } from './scenarioCreationProperties';

type ProcessAction = 'add' | 'done' | 'up' | 'down' | 'remove';
type ProcessQuickPickItem = vscode.QuickPickItem & { action?: ProcessAction; index?: number };
type ProcessStepQuickPickItem = vscode.QuickPickItem & { target: TestInfo };

async function pickProcessSteps(
    workspaceRoot: vscode.Uri,
    t: Translator,
    parentUid?: string
): Promise<TestInfo[] | undefined> {
    const catalog = await scanWorkspaceForScenarioCatalog(workspaceRoot);
    const processes = catalog.all.filter(info => info.kind === 'process');
    const items: ProcessStepQuickPickItem[] = catalog.all
        .filter(info => info.uid && (info.kind === 'process'
            ? canEmbedCompilerProcess(parentUid, info.uid, processes) : info.scenarioCode))
        .map(info => ({
            label: `$(${info.kind === 'process' ? 'list-ordered' : 'file'}) ${info.name}`,
            description: info.kind === 'process' ? info.processCode || info.scenarioCode : info.scenarioCode,
            detail: info.relativePath, target: info
        }));
    if (!items.length) { throw new Error(t('No scenarios or processes are available for insertion.')); }
    const selected = await vscode.window.showQuickPick(items, {
        title: t('Process steps'), placeHolder: t('Select scenarios or processes for the process'),
        canPickMany: true, ignoreFocusOut: true
    });
    if (!selected?.length) { return undefined; }
    // A referenced process may have changed while the picker was open.
    const refreshed = selected.some(item => item.target.kind === 'process')
        ? (await scanWorkspaceForScenarioCatalog(workspaceRoot)).all.filter(info => info.kind === 'process') : processes;
    return selected.map(item => {
        if (item.target.kind !== 'process') { return item.target; }
        const matches = refreshed.filter(info => info.uid?.toLowerCase() === item.target.uid!.toLowerCase());
        if (matches.length !== 1 || !canEmbedCompilerProcess(parentUid, item.target.uid!, refreshed)) {
            throw new Error(t('Cannot insert process "{0}": its references are missing, ambiguous or cyclic.', item.target.name));
        }
        return matches[0];
    });
}

function compilerStepTarget(target: TestInfo): CompilerProcessScenario {
    // Missing overrides are inherited from the referenced scenario or process by SPPR.
    return { kind: target.kind === 'process' ? 'process' : 'scenario', name: target.name, uid: target.uid, scenarioCode: target.scenarioCode };
}

async function requiredInput(t: Translator, prompt: string, initialValue?: string): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
        title: t('New process'), prompt: t(prompt), value: initialValue, ignoreFocusOut: true,
        validateInput: input => !input.trim() || /[\r\n]/.test(input) ? t('Enter a non-empty single-line value.') : undefined
    });
    return value === undefined ? undefined : value.trim();
}

function isWithinRoot(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Creates process.yaml and its linked compiler settings without replacing existing files. */
export async function handleCreateProcess(
    context: vscode.ExtensionContext,
    seed?: unknown
): Promise<vscode.Uri | undefined> {
    const t = await getTranslator(context.extensionUri);
    try {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace || workspace.uri.scheme !== 'file') {
            throw new Error(t('Open a local workspace to create a process.'));
        }
        const name = await requiredInput(t, 'Enter process name');
        if (name === undefined) { return undefined; }
        const catalog = await scanWorkspaceForScenarioCatalog(workspace.uri);
        if (catalog.all.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            throw new Error(t('A scenario or process named "{0}" already exists.', name));
        }
        const root = typeof resolveProcessScanRootFsPath === 'function' ? resolveProcessScanRootFsPath(workspace.uri) : resolveScenarioScanRootFsPath(workspace.uri);
        const selectedFolders = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: t('Select parent folder for process'), openLabel: t('Select folder'),
            defaultUri: vscode.Uri.file(root)
        });
        if (!selectedFolders?.length) { return undefined; }
        const parent = selectedFolders[0];
        if (parent.scheme !== 'file' || !isWithinRoot(path.resolve(parent.fsPath), path.resolve(root))) {
            throw new Error(t('Process destination must be inside the configured tests directory.'));
        }
        await fs.mkdir(root, { recursive: true });
        if (!isWithinRoot(await fs.realpath(parent.fsPath), await fs.realpath(root))) {
            throw new Error(t('Process destination must be inside the configured tests directory.'));
        }
        const code = await promptForNewTestCode(context, parent, { prompt: 'Enter process numeric code (digits only)', numericOnly: true,
            existingCodes: catalog.all.flatMap(info => [info.scenarioCode, info.processCode].filter((code): code is string => !!code)) });
        if (!code) { return undefined; }
        const trimmedCode = code.code;
        if (!/^\d+$/.test(trimmedCode)) { throw new Error(t('Code must contain digits only')); }
        if (catalog.all.some(item => item.processCode === trimmedCode || item.scenarioCode === trimmedCode)) {
            throw new Error(t('Scenario code "{0}" already exists.', trimmedCode));
        }
        const selected = await pickProcessSteps(workspace.uri, t);
        if (!selected) { return undefined; }
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const etalonBase = await promptForSelectedEtalonBaseValues(
            t, context, config.get<string>('newScenarioDefaults.userProfile', 'Administrator')
        );
        if (!etalonBase) { return undefined; }
        const { baseId: databaseId, baseName: databaseName, userProfile } = etalonBase;
        const header = await promptForProcessCreationProperties(parent, {
            project: config.get<string>('newScenarioDefaults.project', 'Drive'),
            reportLevel1: config.get<string>('newScenarioDefaults.reportLevel1', 'Drive'),
            reportLevel2: config.get<string>('newScenarioDefaults.mainReportLevel2', 'Parent'),
            responsible: code.author
        }, t);
        if (!header) { return undefined; }
        const processUid = uuidv4();
        const steps = selected.map(scenario => ({ scenario: compilerStepTarget(scenario), uid: uuidv4() }));
        const files = buildCompilerProcessFiles({
            name, code: trimmedCode, uid: processUid, settingsUid: uuidv4(), databaseId, databaseName, userProfile,
            project: header.project, reportLevel1: header.reportLevel1, reportLevel2: header.reportLevel2,
            steps
        });
        const folder = path.join(parent.fsPath, trimmedCode);
        const processUri = vscode.Uri.file(path.join(folder, 'process.yaml'));
        await code.claim(parent, async () => {
            // Exclusive directory creation prevents replacing an authored process or settings file.
            await fs.mkdir(folder);
            await fs.mkdir(path.join(folder, 'test'));
            await fs.mkdir(path.join(folder, 'files'));
            await fs.writeFile(path.join(folder, 'test', `${trimmedCode}.yaml`), files.settingsSource, { encoding: 'utf8', flag: 'wx' });
            const processSource = applyCreationResponsible(files.processSource, header.responsible);
            await fs.writeFile(processUri.fsPath, processSource, { encoding: 'utf8', flag: 'wx' });
            await registerCreatedProjectScenario(processUri, processSource, { groupName: resolveMainScenarioGroupSeed(seed) ?? '' });
        });
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(processUri));
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate');
        await vscode.window.showInformationMessage(t('Process "{0}" has been created successfully!', name));
        return processUri;
    } catch (error) {
        const message = (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? t('Process destination already exists. Choose another code or parent folder.')
            : error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(t('Could not create process: {0}', message));
        return undefined;
    }
}

async function resolveProcessUri(target: vscode.Uri | TestInfo | undefined, t: Translator): Promise<vscode.Uri | undefined> {
    if (target) { return 'yamlFileUri' in target ? target.yamlFileUri : target; }
    const active = vscode.window.activeTextEditor?.document;
    if (active && parseScenarioDescriptor(active.getText()).kind === 'process') { return active.uri; }
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) { throw new Error(t('Open a workspace to edit process steps.')); }
    const catalog = await scanWorkspaceForScenarioCatalog(workspace.uri);
    const picked = await vscode.window.showQuickPick(catalog.all.filter(item => item.kind === 'process').map(process => ({
        label: process.name, description: process.processCode, detail: process.relativePath, process
    })), { title: t('Select process'), ignoreFocusOut: true });
    return picked?.process.yamlFileUri;
}

async function saveProcessSteps(document: vscode.TextDocument, source: string, version: number, updated: string, t: Translator): Promise<boolean> {
    if (document.version !== version || document.getText() !== source) { throw new Error(t('Process changed while editing steps. Run the command again.')); }
    if (updated === source) { return false; }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(source.length)), updated);
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) { throw new Error(t('Could not save process steps.')); }
    try { await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcherFromCreate'); }
    catch (error) { await vscode.window.showErrorMessage(t('Process steps were saved, but Test Manager could not refresh: {0}', error instanceof Error ? error.message : String(error))); }
    return true;
}

async function addProcessSteps(document: vscode.TextDocument, t: Translator): Promise<boolean> {
    const source = document.getText(); const version = document.version;
    const descriptor = parseScenarioDescriptor(source);
    if (descriptor.kind !== 'process' || !descriptor.uid) { throw new Error(t('Choose a process YAML descriptor.')); }
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) { throw new Error(t('Open a workspace to edit process steps.')); }
    const selected = await pickProcessSteps(workspace.uri, t, descriptor.uid);
    if (!selected) { return false; }
    let updated = source;
    for (const target of selected) { updated = appendCompilerProcessScenarioStep(updated, compilerStepTarget(target), uuidv4()); }
    return saveProcessSteps(document, source, version, updated, t);
}

export async function handleAddProcessSteps(context: vscode.ExtensionContext, target?: vscode.Uri | TestInfo): Promise<boolean> {
    const t = await getTranslator(context.extensionUri);
    try {
        const uri = await resolveProcessUri(target, t);
        if (!uri) { return false; }
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        return await addProcessSteps(document, t);
    } catch (error) { await vscode.window.showErrorMessage(t('Could not edit process steps: {0}', error instanceof Error ? t(error.message) : String(error))); return false; }
}

/** Adds, removes or moves whole records, preserving existing parameter bindings and custom fields. */
export async function handleEditProcessSteps(
    context: vscode.ExtensionContext,
    target?: vscode.Uri | TestInfo
): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    try {
        const processUri = await resolveProcessUri(target, t);
        if (!processUri) { return; }
        const document = await vscode.workspace.openTextDocument(processUri);
        await vscode.window.showTextDocument(document);
        for (;;) {
            const source = document.getText();
            const version = document.version;
            const descriptor = parseScenarioDescriptor(source);
            if (descriptor.kind !== 'process') { throw new Error(t('Choose a process YAML descriptor.')); }
            const steps = descriptor.processSteps ?? [];
            const items: ProcessQuickPickItem[] = [
                { label: t('Add process steps'), action: 'add' },
                ...steps.map((step, index) => ({ label: `${index + 1}. ${step.name ?? step.scenarioName ?? step.processName ?? step.uid ?? ''}`, index })),
                { label: t('Done'), action: 'done' }
            ];
            const picked = await vscode.window.showQuickPick(items, { title: t('Process steps: {0}', descriptor.name ?? ''), ignoreFocusOut: true });
            if (!picked || picked.action === 'done') { return; }
            let updated = source;
            if (picked.action === 'add') {
                if (document.version !== version || document.getText() !== source) { throw new Error(t('Process changed while editing steps. Run the command again.')); }
                await addProcessSteps(document, t);
                continue;
            } else if (picked.index !== undefined) {
                const index = picked.index;
                const actions: ProcessQuickPickItem[] = [
                    ...(index > 0 ? [{ label: t('Move up'), action: 'up' as const }] : []),
                    ...(index < steps.length - 1 ? [{ label: t('Move down'), action: 'down' as const }] : []),
                    { label: t('Remove step'), action: 'remove' }
                ];
                const action = await vscode.window.showQuickPick(actions, { title: picked.label, ignoreFocusOut: true });
                if (!action) { continue; }
                updated = action.action === 'remove' ? removeCompilerProcessStep(source, index)
                    : moveCompilerProcessStep(source, index, index + (action.action === 'up' ? -1 : 1));
            }
            await saveProcessSteps(document, source, version, updated, t);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(t('Could not edit process steps: {0}', message));
    }
}
