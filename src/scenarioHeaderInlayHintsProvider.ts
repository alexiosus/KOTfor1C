import * as vscode from 'vscode';
import { isScenarioYamlFile } from './yamlValidator';
import { parsePhaseSwitcherMetadata } from './phaseSwitcherMetadata';

interface ScenarioHeaderFieldLines {
    nameLine: number | null;
    codeLine: number | null;
    systemFunctionLine: number | null;
    systemFunctionUidLine: number | null;
}

function createActionHint(
    document: vscode.TextDocument,
    line: number,
    command: string,
    tooltipText: string
): vscode.InlayHint {
    const position = new vscode.Position(line, document.lineAt(line).text.length);
    const labelPart = new vscode.InlayHintLabelPart(' ✎ ');
    labelPart.command = {
        title: tooltipText,
        command
    };

    const hint = new vscode.InlayHint(position, [labelPart], vscode.InlayHintKind.Type);
    hint.paddingLeft = true;
    hint.paddingRight = false;
    return hint;
}

function getYamlIndent(line: string): number {
    const normalized = line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
    const match = normalized.match(/^(\s*)/);
    return match ? match[1].length : 0;
}

function isIgnorableYamlLine(line: string): boolean {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    return trimmed.length === 0 || trimmed.startsWith('#');
}

function isYamlKeyLine(trimmedNoBom: string): boolean {
    return /^[^:#][^:]*:\s*(.*)$/.test(trimmedNoBom);
}

function findYamlSectionEnd(
    lines: string[],
    startIndex: number,
    startIndent: number
): number {
    for (let index = startIndex + 1; index < lines.length; index++) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            continue;
        }

        const indent = getYamlIndent(line);
        const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
        if (indent <= startIndent && isYamlKeyLine(trimmedNoBom)) {
            return index;
        }
    }
    return lines.length;
}

export function findScenarioHeaderFieldLines(document: vscode.TextDocument): ScenarioHeaderFieldLines {
    const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
    let scenarioDataStart = -1;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
        if (getYamlIndent(line) === 0 && trimmedNoBom === 'ДанныеСценария:') {
            scenarioDataStart = index;
            break;
        }
    }

    if (scenarioDataStart === -1) {
        return { nameLine: null, codeLine: null, systemFunctionLine: null, systemFunctionUidLine: null };
    }

    const sectionIndent = getYamlIndent(lines[scenarioDataStart]);
    const sectionEnd = findYamlSectionEnd(lines, scenarioDataStart, sectionIndent);
    let nameLine: number | null = null;
    let codeLine: number | null = null;
    let systemFunctionLine: number | null = null;
    let systemFunctionUidLine: number | null = null;

    for (let index = scenarioDataStart + 1; index < sectionEnd; index++) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            continue;
        }
        if (getYamlIndent(line) <= sectionIndent) {
            continue;
        }

        if (nameLine === null && /^\s*Имя:\s*.+$/.test(line)) {
            nameLine = index;
            continue;
        }

        if (codeLine === null && /^\s*Код:\s*.+$/.test(line)) {
            codeLine = index;
            continue;
        }

        if (systemFunctionLine === null && /^\s*ФункцияСистемы:\s*.+$/.test(line)) {
            systemFunctionLine = index;
            continue;
        }

        if (systemFunctionUidLine === null && /^\s*UIDФункцияСистемы:\s*.+$/.test(line)) {
            systemFunctionUidLine = index;
        }

        if (
            nameLine !== null
            && codeLine !== null
            && systemFunctionLine !== null
            && systemFunctionUidLine !== null
        ) {
            break;
        }
    }

    return { nameLine, codeLine, systemFunctionLine, systemFunctionUidLine };
}

export class ScenarioHeaderInlayHintsProvider implements vscode.InlayHintsProvider {
    provideInlayHints(
        document: vscode.TextDocument,
        _range: vscode.Range,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlayHint[]> {
        if (!isScenarioYamlFile(document)) {
            return [];
        }

        const metadata = parsePhaseSwitcherMetadata(document.getText());
        const isMainScenario = metadata.hasTab;

        const fieldLines = findScenarioHeaderFieldLines(document);
        const hints: vscode.InlayHint[] = [];

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
}
