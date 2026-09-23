import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseUserStepSource } from './bslStepSourceParser';
import { buildDirectSpawnCommand, runDirectProcess } from './directProcessLaunch';
import {
    extractExportScenarioQuotedValues,
    suggestedExportScenarioParameterName,
    type ExportScenarioCommandSeed
} from './exportScenarioCreator';
import type { ProjectDefinitionIndexProvider } from './projectDefinitionIndexService';
import {
    createNewUserStepLibrarySource,
    planUserStepSourceEdit,
    type UserStepSourceEditRequest
} from './userStepCreator';
import { buildUserStepLibrary, type UserStepLibraryBuildRequest } from './userStepLibraryBuilder';

export interface UserStepLibraryRoot {
    readonly path: string;
    readonly uri: string;
    readonly label: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly templateRoot: string | null;
}

export interface UserStepCommandServices {
    readonly context: vscode.ExtensionContext;
    readonly index: ProjectDefinitionIndexProvider;
    readonly loadLibraryRoots: (resourceUri?: string) => Promise<readonly UserStepLibraryRoot[]>;
    readonly translate?: (key: string, ...args: string[]) => string;
}

interface ExistingLibraryItem extends vscode.QuickPickItem {
    readonly targetKind: 'existing';
    readonly uri: string;
    readonly root: UserStepLibraryRoot;
}

interface NewLibraryItem extends vscode.QuickPickItem {
    readonly targetKind: 'new';
}

function isCommandSeed(value: unknown): value is ExportScenarioCommandSeed {
    return !!value && typeof value === 'object';
}

function matchingRoot(
    roots: readonly UserStepLibraryRoot[],
    libraryRootUri: string | undefined
): UserStepLibraryRoot | undefined {
    return roots.find(root => root.uri === libraryRootUri);
}

async function promptStep(
    seed: ExportScenarioCommandSeed,
    t: (key: string, ...args: string[]) => string
): Promise<Omit<UserStepSourceEditRequest, 'source' | 'documentVersion' | 'expectedVersion'> | undefined> {
    const template = await vscode.window.showInputBox({
        title: t('User step template'),
        value: (seed.invocation ?? '').trim(),
        prompt: t('Enter the displayed Gherkin step including its keyword.'),
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : t('Step template must not be empty.')
    });
    if (template === undefined) {
        return undefined;
    }
    const quoted = extractExportScenarioQuotedValues(template);
    const parameterNames: string[] = [];
    for (let index = 0; index < quoted.length; index++) {
        const entered = await vscode.window.showInputBox({
            title: t('User step parameter {0}', String(index + 1)),
            value: suggestedExportScenarioParameterName(quoted[index].value, index),
            prompt: t('Enter the BSL parameter name for quoted value "{0}".', quoted[index].value),
            ignoreFocusOut: true,
            validateInput: value => {
                const normalized = value.trim().toLocaleLowerCase();
                if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(value.trim())) {
                    return t('Enter a valid BSL identifier.');
                }
                return parameterNames.some(name => name.toLocaleLowerCase() === normalized)
                    ? t('Parameter names must be unique.')
                    : undefined;
            }
        });
        if (entered === undefined) {
            return undefined;
        }
        parameterNames.push(entered.trim());
    }
    const implementationName = await vscode.window.showInputBox({
        title: t('User step implementation name'),
        value: 'НовыйШаг',
        ignoreFocusOut: true,
        validateInput: value => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value.trim())
            ? undefined
            : t('Enter a valid BSL identifier.')
    });
    if (implementationName === undefined) {
        return undefined;
    }
    const selectedKind = await vscode.window.showQuickPick([
        { label: t('Procedure'), value: 'procedure' as const },
        { label: t('Function'), value: 'function' as const }
    ], { title: t('Implementation kind'), ignoreFocusOut: true });
    if (!selectedKind) {
        return undefined;
    }
    const description = await vscode.window.showInputBox({
        title: t('User step description'),
        value: '',
        ignoreFocusOut: true
    });
    if (description === undefined) {
        return undefined;
    }
    const category = await vscode.window.showInputBox({
        title: t('User step category'),
        value: '',
        ignoreFocusOut: true
    });
    if (category === undefined) {
        return undefined;
    }
    return {
        template,
        parameterNames,
        implementationName: implementationName.trim(),
        implementationKind: selectedKind.value,
        description,
        category
    };
}

export async function createUserStepCommand(
    rawSeed: unknown,
    services: UserStepCommandServices
): Promise<void> {
    const t = services.translate ?? ((key: string) => key);
    const seed = isCommandSeed(rawSeed) ? rawSeed : {};
    const resource = typeof seed.documentUri === 'string'
        ? vscode.Uri.parse(seed.documentUri)
        : vscode.window.activeTextEditor?.document.uri;
    const roots = await services.loadLibraryRoots(resource?.toString());
    if (roots.length === 0) {
        vscode.window.showWarningMessage(t('No project library roots are configured in the active profile.'));
        return;
    }
    const snapshot = await services.index.ensureReady(resource);
    const byUri = new Map<string, ExistingLibraryItem>();
    for (const definition of snapshot.definitions) {
        if (definition.kind !== 'userStep' || !definition.definitionLocation) {
            continue;
        }
        const configuredRoot = matchingRoot(roots, definition.libraryRootUri);
        const root = configuredRoot ?? roots.find(item => item.workspaceFolderUri === definition.workspaceFolderUri);
        if (!root || byUri.has(definition.definitionLocation.uri)) {
            continue;
        }
        byUri.set(definition.definitionLocation.uri, {
            targetKind: 'existing',
            label: `$(file-code) ${path.basename(vscode.Uri.parse(definition.definitionLocation.uri).fsPath)}`,
            description: root.label,
            detail: definition.sourceLabel,
            uri: definition.definitionLocation.uri,
            root
        });
    }
    const newItem: NewLibraryItem = {
        targetKind: 'new',
        label: `$(add) ${t('Create new user-step source library')}`
    };
    const selected = await vscode.window.showQuickPick<ExistingLibraryItem | NewLibraryItem>(
        [...byUri.values(), newItem],
        {
            title: t('Create user step'),
            placeHolder: t('Select an existing source library or create a new one'),
            ignoreFocusOut: true
        }
    );
    if (!selected) {
        return;
    }
    const step = await promptStep(seed, t);
    if (!step) {
        return;
    }

    if (selected.targetKind === 'new') {
        const selectedRoot = roots.length === 1
            ? { root: roots[0] }
            : await vscode.window.showQuickPick(
                roots.map(root => ({ label: root.label, detail: root.path, root })),
                { title: t('Select project library root'), ignoreFocusOut: true }
            );
        if (!selectedRoot) {
            return;
        }
        if (!selectedRoot.root.templateRoot) {
            vscode.window.showErrorMessage(t('Vanessa TemplateEpfUF was not resolved from the active profile.'));
            return;
        }
        const libraryName = await vscode.window.showInputBox({
            title: t('User-step library name'),
            value: 'CustomSteps',
            ignoreFocusOut: true,
            validateInput: value => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value.trim())
                ? undefined
                : t('Enter a valid BSL identifier.')
        });
        if (!libraryName) {
            return;
        }
        const created = await createNewUserStepLibrarySource({
            libraryRootPath: selectedRoot.root.path,
            libraryName: libraryName.trim(),
            templateRoot: selectedRoot.root.templateRoot,
            step: {
                ...step,
                source: '',
                documentVersion: 0,
                expectedVersion: 0
            }
        });
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(created.modulePath));
        const parsed = parseUserStepSource(document.getText(), {
            sourceUri: document.uri.toString(),
            workspaceFolderUri: selectedRoot.root.workspaceFolderUri,
            profileId: selectedRoot.root.profileId,
            libraryRootUri: selectedRoot.root.uri,
            sourceLabel: libraryName.trim()
        });
        const declaration = parsed.declarations.find(item => item.name === step.implementationName);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        if (declaration) {
            const position = new vscode.Position(
                declaration.bodyRange.start.line,
                declaration.bodyRange.start.character
            );
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(
                declaration.declarationRange.start.line,
                declaration.declarationRange.start.character,
                declaration.declarationRange.end.line,
                declaration.declarationRange.end.character
            ));
        }
        vscode.window.showInformationMessage(t(
            'User-step source library created. Build target: {0}',
            created.targetEpfPath
        ));
        return;
    }

    const targetUri = vscode.Uri.parse(selected.uri);
    const document = await vscode.workspace.openTextDocument(targetUri);
    const source = document.getText();
    const version = document.version;
    const parsed = parseUserStepSource(source, {
        sourceUri: selected.uri,
        workspaceFolderUri: selected.root.workspaceFolderUri,
        profileId: selected.root.profileId,
        libraryRootUri: selected.root.uri,
        sourceLabel: selected.description ?? selected.root.label
    });
    const plan = planUserStepSourceEdit(parsed, {
        ...step,
        source,
        documentVersion: document.version,
        expectedVersion: version
    });
    if (document.version !== plan.documentVersion) {
        vscode.window.showWarningMessage(t('The user-step module changed. Run the command again.'));
        return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of plan.edits) {
        workspaceEdit.replace(
            targetUri,
            new vscode.Range(document.positionAt(edit.startOffset), document.positionAt(edit.endOffset)),
            edit.newText
        );
    }
    if (!await vscode.workspace.applyEdit(workspaceEdit)) {
        vscode.window.showErrorMessage(t('Could not create the user step.'));
        return;
    }
    const updated = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(updated, { preview: false });
    const cursor = new vscode.Position(plan.cursor.line, plan.cursor.character);
    editor.selection = new vscode.Selection(cursor, cursor);
    editor.revealRange(new vscode.Range(
        plan.implementationRange.start.line,
        plan.implementationRange.start.character,
        plan.implementationRange.end.line,
        plan.implementationRange.end.character
    ));
}

async function discoverBuildRequests(roots: readonly UserStepLibraryRoot[]): Promise<Array<{
    readonly label: string;
    readonly detail: string;
    readonly request: UserStepLibraryBuildRequest;
}>> {
    const result: Array<{ label: string; detail: string; request: UserStepLibraryBuildRequest }> = [];
    for (const root of roots) {
        const sourceRoot = path.join(root.path, 'step_definitions-src');
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const rootXmlPath = path.join(sourceRoot, entry.name, 'Обработка.xml');
            if (!await fs.promises.stat(rootXmlPath).then(stat => stat.isFile()).catch(() => false)) {
                continue;
            }
            result.push({
                label: entry.name,
                detail: root.label,
                request: {
                    rootXmlPath,
                    targetEpfPath: path.join(root.path, 'step_definitions', `${entry.name}.epf`)
                }
            });
        }
    }
    return result.sort((left, right) => left.label.localeCompare(right.label));
}

export async function buildUserStepLibraryCommand(
    rawRequest: unknown,
    services: UserStepCommandServices
): Promise<void> {
    const t = services.translate ?? ((key: string) => key);
    const resource = vscode.window.activeTextEditor?.document.uri;
    const roots = await services.loadLibraryRoots(resource?.toString());
    let request: UserStepLibraryBuildRequest | undefined;
    if (
        rawRequest
        && typeof rawRequest === 'object'
        && 'rootXmlPath' in rawRequest
        && 'targetEpfPath' in rawRequest
        && typeof rawRequest.rootXmlPath === 'string'
        && typeof rawRequest.targetEpfPath === 'string'
    ) {
        request = { rootXmlPath: rawRequest.rootXmlPath, targetEpfPath: rawRequest.targetEpfPath };
    } else {
        const choices = await discoverBuildRequests(roots);
        const selected = await vscode.window.showQuickPick(choices, {
            title: t('Build user-step library'),
            placeHolder: t('Select a source library to build'),
            ignoreFocusOut: true
        });
        request = selected?.request;
    }
    if (!request) {
        if (roots.length === 0) {
            vscode.window.showWarningMessage(t('No project library roots are configured in the active profile.'));
        }
        return;
    }

    const output = vscode.window.createOutputChannel('KOT User-step Library Build');
    services.context.subscriptions.push(output);
    output.show(true);
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Building user-step library...'),
            cancellable: true
        }, async (_progress, token) => {
            const { resolveOneCDesignerExePath, resolveOneCPlatformForLaunch } = await import('./oneCPlatform.js');
            const { ensureSharedStartupInfobaseReady } = await import('./startupInfobase.js');
            return buildUserStepLibrary(request!, {
                pickPlatform: () => resolveOneCPlatformForLaunch(t, {
                    title: t('Build user-step library'),
                    placeHolder: t('Select 1C platform for the build')
                }),
                ensureStartupInfobase: async clientExePath => {
                    const startup = await ensureSharedStartupInfobaseReady(services.context, clientExePath, {
                        showOutputPanel: false,
                        progressTitle: t('Preparing startup infobase for user-step build')
                    });
                    return {
                        infobaseDirectory: startup.infobaseDirectory,
                        authentication: startup.authentication
                    };
                },
                runProcess: async (command, cancellationToken) => {
                    const processResult = await runDirectProcess(
                        buildDirectSpawnCommand(command.executable, command.args),
                        {
                            cwd: command.cwd,
                            token: cancellationToken,
                            onCommand: display => output.appendLine(display)
                        }
                    );
                    if (processResult.stdout) {
                        output.appendLine(processResult.stdout);
                    }
                    if (processResult.stderr) {
                        output.appendLine(processResult.stderr);
                    }
                    return processResult;
                },
                fileSystem: {
                    mkdir: (target, options) => fs.promises.mkdir(target, options).then(() => undefined),
                    stat: target => fs.promises.stat(target),
                    rename: (from, to) => fs.promises.rename(from, to),
                    rm: (target, options) => fs.promises.rm(target, options)
                },
                now: () => Date.now(),
                resolveDesignerPath: resolveOneCDesignerExePath,
                log: message => output.appendLine(message)
            }, token);
        });
        if (result.kind === 'success') {
            vscode.window.showInformationMessage(t('User-step library built: {0}', result.targetEpfPath));
        }
    } catch (error) {
        output.appendLine(String(error));
        vscode.window.showErrorMessage(t('User-step library build failed: {0}', String(error)));
    }
}
