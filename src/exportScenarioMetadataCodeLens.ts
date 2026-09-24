import * as vscode from 'vscode';
import {
    planExportScenarioMetadataEdit,
    type ExportScenarioEditSource,
    type ExportScenarioMetadataKind
} from './exportScenarioCreator';
import {
    buildExportScenarioMetadataActions,
    collectExportScenarioCategories,
    EXPORT_SCENARIO_METADATA_COMMAND,
    getExportScenarioMetadataInputDefault,
    type ExportScenarioMetadataCommandTarget
} from './exportScenarioMetadata';
import { parseExportScenarios } from './exportScenarioParser';
import { getScenarioLanguageForDocument } from './gherkinLanguage';
import { getTranslator, type Translator } from './localization';
import type { ProjectDefinitionIndexProvider } from './projectDefinitionIndexService';

export interface ExportScenarioMetadataCommandServices {
    readonly index: ProjectDefinitionIndexProvider;
    readonly translate?: Translator;
}

interface CategoryQuickPickItem extends vscode.QuickPickItem {
    readonly category?: string;
    readonly create?: true;
}

const INPUT_TITLES: Readonly<Record<ExportScenarioMetadataKind, string>> = {
    category: 'Export scenario category',
    description: 'Export scenario description',
    usageExample: 'Export scenario usage example'
};

function createEditSource(document: vscode.TextDocument): ExportScenarioEditSource {
    const workspaceFolderUri = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? '';
    return {
        text: document.getText(),
        version: document.version,
        sourceUri: document.uri.toString(),
        workspaceFolderUri,
        profileId: '',
        libraryRootUri: '',
        sourceLabel: 'Project exports',
        defaultLanguage: getScenarioLanguageForDocument(document)
    };
}

function isMetadataCommandTarget(value: unknown): value is ExportScenarioMetadataCommandTarget {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<ExportScenarioMetadataCommandTarget>;
    return typeof candidate.documentUri === 'string'
        && Number.isInteger(candidate.documentVersion)
        && !!candidate.scenarioStart
        && Number.isInteger(candidate.scenarioStart.line)
        && Number.isInteger(candidate.scenarioStart.character)
        && (candidate.kind === 'category'
            || candidate.kind === 'description'
            || candidate.kind === 'usageExample');
}

function validateMetadataValue(value: string, t: Translator): string | undefined {
    if (!value.trim()) {
        return t('Metadata value must not be empty.');
    }
    return /[\r\n]/u.test(value)
        ? t('Metadata value must fit on a single line.')
        : undefined;
}

async function promptNewValue(
    kind: ExportScenarioMetadataKind,
    initialValue: string,
    t: Translator
): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
        title: t(INPUT_TITLES[kind]),
        value: initialValue,
        prompt: t('Enter the metadata value to add above the exported scenario.'),
        ignoreFocusOut: true,
        validateInput: input => validateMetadataValue(input, t)
    });
    return value?.trim();
}

async function promptCategory(
    resource: vscode.Uri,
    services: ExportScenarioMetadataCommandServices,
    t: Translator
): Promise<string | undefined> {
    let categories: readonly string[] = [];
    try {
        const snapshot = await services.index.ensureReady(resource);
        categories = collectExportScenarioCategories(snapshot.definitions);
    } catch {
        // Metadata editing remains available even while the project index is unavailable.
    }
    if (categories.length === 0) {
        return promptNewValue('category', '', t);
    }

    const createItem: CategoryQuickPickItem = {
        label: `$(add) ${t('Create new category…')}`,
        create: true
    };
    const selected = await vscode.window.showQuickPick<CategoryQuickPickItem>([
        ...categories.map(category => ({ label: category, category })),
        createItem
    ], {
        title: t('Export scenario category'),
        placeHolder: t('Select an existing category or create a new one'),
        ignoreFocusOut: true
    });
    if (!selected) {
        return undefined;
    }
    return selected.create
        ? promptNewValue('category', '', t)
        : selected.category;
}

export class ExportScenarioMetadataCodeLensProvider implements vscode.CodeLensProvider {
    private readonly translator: Promise<Translator>;

    constructor(extensionUri: vscode.Uri) {
        this.translator = getTranslator(extensionUri);
    }

    async provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested) {
            return [];
        }
        const t = await this.translator;
        if (token.isCancellationRequested) {
            return [];
        }
        return buildExportScenarioMetadataActions(createEditSource(document), t).map(action =>
            new vscode.CodeLens(
                new vscode.Range(
                    action.range.start.line,
                    action.range.start.character,
                    action.range.end.line,
                    action.range.end.character
                ),
                {
                    title: action.title,
                    command: action.command,
                    arguments: [action.target]
                }
            )
        );
    }
}

export async function addExportScenarioMetadataCommand(
    rawTarget: unknown,
    services: ExportScenarioMetadataCommandServices
): Promise<void> {
    const t = services.translate ?? ((message: string) => message);
    if (!isMetadataCommandTarget(rawTarget)) {
        return;
    }

    const uri = vscode.Uri.parse(rawTarget.documentUri);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.version !== rawTarget.documentVersion) {
        vscode.window.showWarningMessage(t('The export feature changed. Run the command again.'));
        return;
    }

    const source = createEditSource(document);
    const parsed = parseExportScenarios(source.text, source);
    const scenario = parsed.scenarios.find(candidate =>
        candidate.exported
        && candidate.declarationRange.start.line === rawTarget.scenarioStart.line
        && candidate.declarationRange.start.character === rawTarget.scenarioStart.character
    );
    if (!scenario) {
        vscode.window.showWarningMessage(t('The exported scenario is no longer available.'));
        return;
    }

    const value = rawTarget.kind === 'category'
        ? await promptCategory(uri, services, t)
        : await promptNewValue(
            rawTarget.kind,
            getExportScenarioMetadataInputDefault(rawTarget.kind, scenario.title, parsed.language),
            t
        );
    if (value === undefined) {
        return;
    }
    if (document.version !== rawTarget.documentVersion) {
        vscode.window.showWarningMessage(t('The export feature changed. Run the command again.'));
        return;
    }

    try {
        const plan = planExportScenarioMetadataEdit(createEditSource(document), {
            expectedVersion: rawTarget.documentVersion,
            scenarioStart: rawTarget.scenarioStart,
            kind: rawTarget.kind,
            value
        });
        const edit = new vscode.WorkspaceEdit();
        for (const item of plan.edits) {
            edit.replace(
                uri,
                new vscode.Range(document.positionAt(item.startOffset), document.positionAt(item.endOffset)),
                item.newText
            );
        }
        if (!await vscode.workspace.applyEdit(edit)) {
            vscode.window.showErrorMessage(t('Could not add export scenario metadata.'));
        }
    } catch (error) {
        vscode.window.showErrorMessage(t('Could not add export scenario metadata: {0}', String(error)));
    }
}

export { EXPORT_SCENARIO_METADATA_COMMAND };
