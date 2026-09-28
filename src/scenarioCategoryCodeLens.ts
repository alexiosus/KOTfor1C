import * as vscode from 'vscode';
import { getTranslator, type Translator } from './localization';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import {
    buildScenarioCategoryAction,
    collectNestedScenarioCategories,
    isScenarioCategoryCommandTarget,
    SCENARIO_CATEGORY_COMMAND,
    validateScenarioCategoryValue
} from './scenarioCategory';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import { updateScenarioCategoryInMetadataContent } from './scenarioYamlMutations';

export interface ScenarioCategoryCommandServices {
    readonly resolver: ProjectDefinitionResolver;
    readonly translate?: Translator;
}

interface CategoryQuickPickItem extends vscode.QuickPickItem {
    readonly category?: string;
    readonly create?: true;
}

function toVsRange(range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
}): vscode.Range {
    return new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character
    );
}

async function promptNewCategory(
    initialValue: string,
    translate: Translator
): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
        title: translate('Nested scenario category'),
        value: initialValue,
        prompt: translate('Enter a category for the nested scenario.'),
        ignoreFocusOut: true,
        validateInput: input => validateScenarioCategoryValue(input, translate)
    });
    return value?.trim();
}

async function promptCategory(
    resource: vscode.Uri,
    currentValue: string,
    services: ScenarioCategoryCommandServices,
    translate: Translator
): Promise<string | undefined> {
    let categories: readonly string[] = [];
    try {
        categories = collectNestedScenarioCategories((await services.resolver.getView(resource)).all);
    } catch {
        // Editing remains available when the project-definition view is temporarily unavailable.
    }
    if (categories.length === 0) {
        return promptNewCategory(currentValue, translate);
    }

    const selected = await vscode.window.showQuickPick<CategoryQuickPickItem>([
        ...categories.map(category => ({
            label: category,
            category,
            picked: category.toLocaleLowerCase() === currentValue.toLocaleLowerCase()
        })),
        { label: `$(add) ${translate('Create new category…')}`, create: true }
    ], {
        title: translate('Nested scenario category'),
        placeHolder: translate('Select an existing category or create a new one'),
        ignoreFocusOut: true
    });
    if (!selected) {
        return undefined;
    }
    return selected.create
        ? promptNewCategory(currentValue, translate)
        : selected.category;
}

export class ScenarioCategoryCodeLensProvider implements vscode.CodeLensProvider {
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
        const translate = await this.translator;
        if (token.isCancellationRequested) {
            return [];
        }
        const action = buildScenarioCategoryAction(
            document.getText(),
            document.uri.toString(),
            document.version,
            translate
        );
        return action ? [new vscode.CodeLens(toVsRange(action.range), {
            title: action.title,
            command: action.command,
            arguments: [action.target]
        })] : [];
    }
}

export async function setScenarioCategoryCommand(
    rawTarget: unknown,
    services: ScenarioCategoryCommandServices
): Promise<void> {
    const translate = services.translate ?? ((message: string) => message);
    if (!isScenarioCategoryCommandTarget(rawTarget)) {
        return;
    }

    const uri = vscode.Uri.parse(rawTarget.documentUri);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.version !== rawTarget.documentVersion) {
        vscode.window.showWarningMessage(translate('The scenario changed. Run the command again.'));
        return;
    }
    if (!buildScenarioCategoryAction(
        document.getText(), document.uri.toString(), document.version, translate
    )) {
        vscode.window.showWarningMessage(translate('The nested scenario is no longer available.'));
        return;
    }

    const currentValue = parseScenarioDescriptor(document.getText()).scenarioCategory ?? '';
    const category = await promptCategory(uri, currentValue, services, translate);
    if (category === undefined) {
        return;
    }
    if (document.version !== rawTarget.documentVersion) {
        vscode.window.showWarningMessage(translate('The scenario changed. Run the command again.'));
        return;
    }

    try {
        const mutation = updateScenarioCategoryInMetadataContent(document.getText(), category);
        if (!mutation.changed) {
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            uri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            mutation.content
        );
        if (!await vscode.workspace.applyEdit(edit)) {
            vscode.window.showErrorMessage(translate('Could not update the scenario category.'));
        }
    } catch (error) {
        vscode.window.showErrorMessage(translate(
            'Could not update the scenario category: {0}',
            String(error)
        ));
    }
}

export { SCENARIO_CATEGORY_COMMAND };
