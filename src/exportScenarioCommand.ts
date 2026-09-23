import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    deriveExportScenarioDraft,
    extractExportScenarioQuotedValues,
    planExportScenarioEdit,
    suggestedExportScenarioParameterName,
    type ExportScenarioCommandSeed
} from './exportScenarioCreator';
import { parseExportScenarios } from './exportScenarioParser';
import type { ScenarioLanguage } from './gherkinDefinitionKeywords';
import type { ProjectDefinitionIndexProvider } from './projectDefinitionIndexService';

export interface ExportScenarioLibraryRoot {
    readonly uri: string;
    readonly label: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
}

export interface ExportScenarioCommandServices {
    readonly index: ProjectDefinitionIndexProvider;
    readonly loadLibraryRoots: (resourceUri?: string) => Promise<readonly ExportScenarioLibraryRoot[]>;
    readonly translate?: (key: string, ...args: string[]) => string;
}

interface ExistingTarget {
    readonly uri: string;
    readonly root: ExportScenarioLibraryRoot;
    readonly titles: string[];
}

interface ExistingTargetItem extends vscode.QuickPickItem {
    readonly targetKind: 'existing';
    readonly target: ExistingTarget;
}

interface CreateTargetItem extends vscode.QuickPickItem {
    readonly targetKind: 'create';
}

function isCommandSeed(value: unknown): value is ExportScenarioCommandSeed {
    return !!value && typeof value === 'object';
}

function rootForDefinition(
    roots: readonly ExportScenarioLibraryRoot[],
    libraryRootUri: string | undefined
): ExportScenarioLibraryRoot | undefined {
    return roots.find(root => root.uri === libraryRootUri);
}

async function promptParameterNames(
    title: string,
    t: (key: string, ...args: string[]) => string
): Promise<readonly string[] | undefined> {
    const values = extractExportScenarioQuotedValues(title);
    const result: string[] = [];
    for (let index = 0; index < values.length; index++) {
        const entered = await vscode.window.showInputBox({
            title: t('Export scenario parameter {0}', String(index + 1)),
            value: suggestedExportScenarioParameterName(values[index].value, index),
            prompt: t('Enter the parameter name for quoted value "{0}".', values[index].value),
            ignoreFocusOut: true,
            validateInput: value => {
                const normalized = value.trim().toLocaleLowerCase();
                if (!normalized) {
                    return t('Parameter name must not be empty.');
                }
                return result.some(name => name.toLocaleLowerCase() === normalized)
                    ? t('Parameter names must be unique.')
                    : undefined;
            }
        });
        if (entered === undefined) {
            return undefined;
        }
        result.push(entered.trim());
    }
    return result;
}

export async function createExportScenarioCommand(
    rawSeed: unknown,
    services: ExportScenarioCommandServices
): Promise<void> {
    const t = services.translate ?? ((key: string) => key);
    const seed = isCommandSeed(rawSeed) ? rawSeed : {};
    const resource = typeof seed.documentUri === 'string'
        ? vscode.Uri.parse(seed.documentUri)
        : vscode.window.activeTextEditor?.document.uri;

    const roots = await services.loadLibraryRoots(resource?.toString());
    if (roots.length === 0) {
        const action = t('Open active profile parameters');
        const selected = await vscode.window.showWarningMessage(
            t('No project library roots are configured in the active profile.'),
            action
        );
        if (selected === action) {
            await vscode.commands.executeCommand('kotTestToolkit.openYamlParametersManager');
        }
        return;
    }

    // This is intentionally demand-driven: activation never waits for the local index.
    const snapshot = await services.index.ensureReady(resource);

    const existingByUri = new Map<string, ExistingTarget>();
    for (const definition of snapshot.definitions) {
        if (definition.kind !== 'exportScenario' || !definition.definitionLocation) {
            continue;
        }
        const root = rootForDefinition(roots, definition.libraryRootUri)
            ?? (definition.libraryRootUri
                ? {
                    uri: definition.libraryRootUri,
                    label: definition.sourceLabel,
                    workspaceFolderUri: definition.workspaceFolderUri ?? snapshot.workspaceFolderUri,
                    profileId: definition.profileId ?? snapshot.profileId
                }
                : undefined);
        if (!root) {
            continue;
        }
        const uri = definition.definitionLocation.uri;
        const current = existingByUri.get(uri) ?? { uri, root, titles: [] };
        current.titles.push(definition.template);
        existingByUri.set(uri, current);
    }
    const existingItems: ExistingTargetItem[] = [...existingByUri.values()]
        .sort((left, right) => left.uri.localeCompare(right.uri))
        .map(target => ({
            targetKind: 'existing',
            label: `$(file) ${path.posix.basename(vscode.Uri.parse(target.uri).path)}`,
            description: target.root.label,
            detail: target.titles.slice(0, 3).join(' · '),
            target
        }));
    const createItem: CreateTargetItem = {
        targetKind: 'create',
        label: `$(add) ${t('Create new export feature')}`
    };
    const selectedTarget = await vscode.window.showQuickPick<ExistingTargetItem | CreateTargetItem>(
        [...existingItems, createItem],
        {
            title: t('Create exported scenario'),
            placeHolder: t('Select an existing export feature or create a new one'),
            ignoreFocusOut: true
        }
    );
    if (!selectedTarget) {
        return;
    }

    const draft = deriveExportScenarioDraft(seed);
    const enteredTitle = await vscode.window.showInputBox({
        title: t('Export scenario title'),
        value: draft.title,
        prompt: t('Enter the callable Gherkin text without Given, When, Then or And.'),
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : t('Scenario title must not be empty.')
    });
    if (enteredTitle === undefined) {
        return;
    }
    const parameterNames = await promptParameterNames(enteredTitle, t);
    if (!parameterNames) {
        return;
    }

    let targetUri: vscode.Uri;
    let root: ExportScenarioLibraryRoot;
    let document: vscode.TextDocument | undefined;
    const createNewFile = selectedTarget.targetKind === 'create';
    let language: ScenarioLanguage = seed.language ?? 'ru';
    let featureTitle: string | undefined;
    let confirmAddExportTag = false;

    if (selectedTarget.targetKind === 'create') {
        if (roots.length === 1) {
            root = roots[0];
        } else {
            const selectedRoot = await vscode.window.showQuickPick(
                roots.map(item => ({ label: item.label, detail: item.uri, root: item })),
                { title: t('Select project library root'), ignoreFocusOut: true }
            );
            if (!selectedRoot) {
                return;
            }
            root = selectedRoot.root;
        }
        const selectedLanguage = await vscode.window.showQuickPick([
            { label: 'Русский', language: 'ru' as const },
            { label: 'English', language: 'en' as const }
        ], { title: t('Select export feature language'), ignoreFocusOut: true });
        if (!selectedLanguage) {
            return;
        }
        language = selectedLanguage.language;
        const fileName = await vscode.window.showInputBox({
            title: t('Export feature file name'),
            value: 'export-scenarios.feature',
            ignoreFocusOut: true,
            validateInput: value => /^[^\\/:*?"<>|]+\.feature$/iu.test(value.trim())
                ? undefined
                : t('Enter a valid .feature file name without a path.')
        });
        if (!fileName) {
            return;
        }
        featureTitle = await vscode.window.showInputBox({
            title: t('Feature title'),
            value: language === 'ru' ? 'Экспортные сценарии' : 'Export scenarios',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : t('Feature title must not be empty.')
        });
        if (featureTitle === undefined) {
            return;
        }
        targetUri = vscode.Uri.joinPath(vscode.Uri.parse(root.uri), fileName.trim());
        try {
            await vscode.workspace.fs.stat(targetUri);
            vscode.window.showErrorMessage(t('File already exists: {0}', targetUri.fsPath));
            return;
        } catch {
            // The new target must not exist.
        }
    } else {
        root = selectedTarget.target.root;
        targetUri = vscode.Uri.parse(selectedTarget.target.uri);
        document = await vscode.workspace.openTextDocument(targetUri);
        const parsed = parseExportScenarios(document.getText(), {
            sourceUri: targetUri.toString(),
            workspaceFolderUri: root.workspaceFolderUri,
            profileId: root.profileId,
            libraryRootUri: root.uri,
            sourceLabel: root.label,
            defaultLanguage: language
        });
        language = parsed.language;
        if (!parsed.feature?.hasExportTag) {
            const add = t('Add @ExportScenarios');
            const answer = await vscode.window.showWarningMessage(
                t('The selected feature is not tagged @ExportScenarios. Add the tag?'),
                { modal: true },
                add
            );
            if (answer !== add) {
                return;
            }
            confirmAddExportTag = true;
        }
    }

    const currentText = document?.getText() ?? '';
    const currentVersion = document?.version ?? 0;
    const plan = planExportScenarioEdit({
        text: currentText,
        version: currentVersion,
        sourceUri: targetUri.toString(),
        workspaceFolderUri: root.workspaceFolderUri,
        profileId: root.profileId,
        libraryRootUri: root.uri,
        sourceLabel: root.label,
        defaultLanguage: language
    }, {
        expectedVersion: currentVersion,
        title: enteredTitle,
        parameterNames,
        confirmAddExportTag,
        createNewFile,
        language,
        featureTitle
    });

    if (document && document.version !== plan.documentVersion) {
        vscode.window.showWarningMessage(t('The export feature changed. Run the command again.'));
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    if (createNewFile) {
        edit.createFile(targetUri, { ignoreIfExists: false, overwrite: false });
        edit.insert(targetUri, new vscode.Position(0, 0), plan.edits[0].newText);
    } else if (document) {
        for (const item of plan.edits) {
            edit.replace(
                targetUri,
                new vscode.Range(document.positionAt(item.startOffset), document.positionAt(item.endOffset)),
                item.newText
            );
        }
    }
    if (!await vscode.workspace.applyEdit(edit)) {
        vscode.window.showErrorMessage(t('Could not create the exported scenario.'));
        return;
    }
    const updated = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(updated, { preview: false });
    const cursor = new vscode.Position(plan.cursor.line, plan.cursor.character);
    editor.selection = new vscode.Selection(cursor, cursor);
    editor.revealRange(new vscode.Range(
        plan.declarationRange.start.line,
        plan.declarationRange.start.character,
        plan.declarationRange.end.line,
        plan.declarationRange.end.character
    ));
}
