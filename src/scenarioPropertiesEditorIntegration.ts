import * as vscode from 'vscode';
import { ScenarioYamlEditor, ScenarioYamlFoldingProvider } from './scenarioYamlEditor';
import { ScenarioPropertiesPanel } from './scenarioPropertiesPanel';
import { createScenarioPropertiesActions, type ScenarioPropertiesActionOptions } from './scenarioPropertiesActions';
import { isScenarioYamlFile, isProcessYamlFile } from './yamlValidator';

export const SCENARIO_PROPERTIES_EDITOR_COMMAND = 'kotTestToolkit.openScenarioEditor';

export function registerScenarioPropertiesEditor(context: vscode.ExtensionContext,
    options: ScenarioPropertiesActionOptions
): { textEditor: ScenarioYamlEditor; panel: ScenarioPropertiesPanel } {
    const textEditor = new ScenarioYamlEditor();
    const panel = new ScenarioPropertiesPanel(context, textEditor, { runAction: createScenarioPropertiesActions(context, textEditor, options) });
    context.subscriptions.push(vscode.languages.registerFoldingRangeProvider([
        { pattern: '**/*.yaml', scheme: 'file' }, { pattern: '**/*.yml', scheme: 'file' }
    ], new ScenarioYamlFoldingProvider()));
    context.subscriptions.push(panel, vscode.commands.registerCommand(SCENARIO_PROPERTIES_EDITOR_COMMAND, async (target?: unknown) => {
        try {
            const value = target && typeof target === 'object' && 'uri' in target ? (target as { uri: unknown }).uri : target;
            const uri = typeof value === 'string' ? vscode.Uri.parse(value)
                : value && typeof value === 'object' && 'scheme' in value ? value as vscode.Uri : vscode.window.activeTextEditor?.document.uri;
            await panel.open(uri);
        } catch (error) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Could not open test editor: {0}', error instanceof Error ? error.message : String(error)));
        }
    }));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider([
        { pattern: '**/*.yaml', scheme: 'file' }, { pattern: '**/*.yml', scheme: 'file' }
    ], {
        provideCodeLenses(document: vscode.TextDocument) {
            if (!isScenarioYamlFile(document) && !isProcessYamlFile(document)) { return []; }
            const lenses = [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: vscode.l10n.t('Edit scenario and properties'),
                command: SCENARIO_PROPERTIES_EDITOR_COMMAND, arguments: [document.uri]
            })];
            return lenses;
        }
    }));
    return { textEditor, panel };
}
