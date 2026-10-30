import { editorActionsAreEnabled } from './editorActionControls';
import * as vscode from 'vscode';
import { ScenarioYamlEditor, ScenarioYamlFoldingProvider } from './scenarioYamlEditor';
import { ScenarioPropertiesPanel } from './scenarioPropertiesPanel';
import { createScenarioPropertiesActions, type ScenarioPropertiesActionOptions } from './scenarioPropertiesActions';
import { isScenarioYamlFile, isProcessYamlFile } from './yamlValidator';
import type { Translator } from './localization';

export const SCENARIO_PROPERTIES_EDITOR_COMMAND = 'kotTestToolkit.openScenarioEditor';

export function registerScenarioPropertiesEditor(context: vscode.ExtensionContext,
    options: ScenarioPropertiesActionOptions, translate?: Translator
): { textEditor: ScenarioYamlEditor; panel: ScenarioPropertiesPanel } {
    const t: Translator = translate ?? ((message, ...args) => vscode.l10n.t(message, ...args));
    const textEditor = new ScenarioYamlEditor();
    const panel = new ScenarioPropertiesPanel(context, textEditor, { translate: t, runAction: createScenarioPropertiesActions(context, textEditor, options), onDisplayOrderChanged: options.onDisplayOrderChanged });
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
            void vscode.window.showErrorMessage(t('Could not open test editor: {0}', error instanceof Error ? error.message : String(error)));
        }
    }));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider([
        { pattern: '**/*.yaml', scheme: 'file' }, { pattern: '**/*.yml', scheme: 'file' }
    ], {
        onDidChangeCodeLenses: listener => vscode.workspace.onDidChangeConfiguration(event => {
            if (['editor.showActionButtons', 'editor.showYamlActionButtons'].some(key => event.affectsConfiguration('kotTestToolkit.' + key))) { listener(); }
        }),
        provideCodeLenses(document: vscode.TextDocument) {
            if (!editorActionsAreEnabled(document.uri.toString(), vscode.workspace.getConfiguration('kotTestToolkit', document.uri))) { return []; }
            if (!isScenarioYamlFile(document) && !isProcessYamlFile(document)) { return []; }
            const lenses = [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: t('Edit scenario and properties'),
                command: SCENARIO_PROPERTIES_EDITOR_COMMAND, arguments: [document.uri]
            })];
            return lenses;
        }
    }));
    return { textEditor, panel };
}
