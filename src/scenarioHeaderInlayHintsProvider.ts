import * as vscode from 'vscode';
import { isScenarioYamlFile, isTestSettingsYamlFile } from './yamlValidator';
import { parsePhaseSwitcherMetadata } from './phaseSwitcherMetadata';
import { findScenarioHeaderFieldLines, findTestSettingsFieldLines } from './yamlHeaderFields';

function createActionHint(
    document: vscode.TextDocument,
    line: number,
    command: string,
    tooltipText: string,
    labelText = ' ✎ '
): vscode.InlayHint {
    const position = new vscode.Position(line, document.lineAt(line).text.length);
    const labelPart = new vscode.InlayHintLabelPart(labelText);
    labelPart.command = {
        title: tooltipText,
        command
    };

    const hint = new vscode.InlayHint(position, [labelPart], vscode.InlayHintKind.Type);
    hint.paddingLeft = true;
    hint.paddingRight = false;
    return hint;
}

export class ScenarioHeaderInlayHintsProvider implements vscode.InlayHintsProvider {
    provideInlayHints(
        document: vscode.TextDocument,
        _range: vscode.Range,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlayHint[]> {
        const hints: vscode.InlayHint[] = [];

        if (isScenarioYamlFile(document)) {
            const metadata = parsePhaseSwitcherMetadata(document.getText());
            const isMainScenario = metadata.hasTab;
            const fieldLines = findScenarioHeaderFieldLines(document);

            if (isMainScenario && fieldLines.fileTypeLine !== null) {
                hints.push(createActionHint(
                    document,
                    fieldLines.fileTypeLine,
                    'kotTestToolkit.openMainScenarioTestSettingsFromEditor',
                    vscode.l10n.t('Open test settings'),
                    ' ⚙ '
                ));
            }

            if (fieldLines.nameLine !== null) {
                hints.push(createActionHint(
                    document,
                    fieldLines.nameLine,
                    isMainScenario ? 'kotTestToolkit.renameScenarioFromEditor' : 'kotTestToolkit.changeNestedScenarioName',
                    isMainScenario ? vscode.l10n.t('Rename scenario') : vscode.l10n.t('Change nested scenario name')
                ));
            }

            if (fieldLines.codeLine !== null) {
                hints.push(createActionHint(
                    document,
                    fieldLines.codeLine,
                    isMainScenario ? 'kotTestToolkit.renameScenarioFromEditor' : 'kotTestToolkit.changeNestedScenarioCode',
                    isMainScenario ? vscode.l10n.t('Rename scenario') : vscode.l10n.t('Change nested scenario code')
                ));
            }

            if (fieldLines.systemFunctionLine !== null) {
                hints.push(createActionHint(
                    document,
                    fieldLines.systemFunctionLine,
                    'kotTestToolkit.changeScenarioSystemFunctionFromEditor',
                    vscode.l10n.t('Change system function')
                ));
            }

            if (fieldLines.systemFunctionUidLine !== null) {
                hints.push(createActionHint(
                    document,
                    fieldLines.systemFunctionUidLine,
                    'kotTestToolkit.changeScenarioSystemFunctionFromEditor',
                    vscode.l10n.t('Change system function')
                ));
            }

            return hints;
        }

        if (!isTestSettingsYamlFile(document)) {
            return hints;
        }

        const testFieldLines = findTestSettingsFieldLines(document);
        const changeScenarioTooltip = vscode.l10n.t('Change linked scenario');

        if (testFieldLines.codeLine !== null) {
            hints.push(createActionHint(document, testFieldLines.codeLine, 'kotTestToolkit.changeTestSettingsScenarioFromEditor', changeScenarioTooltip));
        }
        if (testFieldLines.nameLine !== null) {
            hints.push(createActionHint(document, testFieldLines.nameLine, 'kotTestToolkit.changeTestSettingsScenarioFromEditor', changeScenarioTooltip));
        }
        if (testFieldLines.scenarioUidLine !== null) {
            hints.push(createActionHint(document, testFieldLines.scenarioUidLine, 'kotTestToolkit.changeTestSettingsScenarioFromEditor', changeScenarioTooltip));
        }
        if (testFieldLines.scenarioNameLine !== null) {
            hints.push(createActionHint(document, testFieldLines.scenarioNameLine, 'kotTestToolkit.changeTestSettingsScenarioFromEditor', changeScenarioTooltip));
        }
        if (testFieldLines.etalonBaseNameLine !== null) {
            hints.push(createActionHint(document, testFieldLines.etalonBaseNameLine, 'kotTestToolkit.changeTestSettingsEtalonBaseFromEditor', vscode.l10n.t('Change etalon base')));
        }
        if (testFieldLines.modelDbIdLine !== null) {
            hints.push(createActionHint(document, testFieldLines.modelDbIdLine, 'kotTestToolkit.changeTestSettingsEtalonBaseFromEditor', vscode.l10n.t('Change etalon base')));
        }
        if (testFieldLines.userProfileLine !== null) {
            hints.push(createActionHint(document, testFieldLines.userProfileLine, 'kotTestToolkit.changeTestSettingsUserProfileFromEditor', vscode.l10n.t('Change test user profile')));
        }

        return hints;
    }
}
