import * as vscode from 'vscode';
import { isScenarioYamlFile } from './yamlValidator';
import { parsePhaseSwitcherMetadata } from './phaseSwitcherMetadata';

interface ScenarioHeaderFieldLines {
    nameLine: number | null;
    codeLine: number | null;
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

        const fieldLines = this.findScenarioHeaderFieldLines(document);
        const hints: vscode.InlayHint[] = [];

        if (fieldLines.nameLine !== null) {
            hints.push(this.createActionHint(
                document,
                fieldLines.nameLine,
                isMainScenario ? 'kotTestToolkit.renameScenarioFromEditor' : 'kotTestToolkit.changeNestedScenarioName',
                isMainScenario ? vscode.l10n.t('Rename scenario') : vscode.l10n.t('Change nested scenario name')
            ));
        }

        if (fieldLines.codeLine !== null) {
            hints.push(this.createActionHint(
                document,
                fieldLines.codeLine,
                isMainScenario ? 'kotTestToolkit.renameScenarioFromEditor' : 'kotTestToolkit.changeNestedScenarioCode',
                isMainScenario ? vscode.l10n.t('Rename scenario') : vscode.l10n.t('Change nested scenario code')
            ));
        }

        return hints;
    }

    private createActionHint(
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

    private getYamlIndent(line: string): number {
        const normalized = line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
        const match = normalized.match(/^(\s*)/);
        return match ? match[1].length : 0;
    }

    private isIgnorableYamlLine(line: string): boolean {
        const trimmed = line.replace(/^\uFEFF/, '').trim();
        return trimmed.length === 0 || trimmed.startsWith('#');
    }

    private isYamlKeyLine(trimmedNoBom: string): boolean {
        return /^[^:#][^:]*:\s*(.*)$/.test(trimmedNoBom);
    }

    private findYamlSectionEnd(
        lines: string[],
        startIndex: number,
        startIndent: number
    ): number {
        for (let index = startIndex + 1; index < lines.length; index++) {
            const line = lines[index];
            if (this.isIgnorableYamlLine(line)) {
                continue;
            }

            const indent = this.getYamlIndent(line);
            const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
            if (indent <= startIndent && this.isYamlKeyLine(trimmedNoBom)) {
                return index;
            }
        }
        return lines.length;
    }

    private findScenarioHeaderFieldLines(document: vscode.TextDocument): ScenarioHeaderFieldLines {
        const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
        let scenarioDataStart = -1;

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
            if (this.getYamlIndent(line) === 0 && trimmedNoBom === 'ДанныеСценария:') {
                scenarioDataStart = index;
                break;
            }
        }

        if (scenarioDataStart === -1) {
            return { nameLine: null, codeLine: null };
        }

        const sectionIndent = this.getYamlIndent(lines[scenarioDataStart]);
        const sectionEnd = this.findYamlSectionEnd(lines, scenarioDataStart, sectionIndent);
        let nameLine: number | null = null;
        let codeLine: number | null = null;

        for (let index = scenarioDataStart + 1; index < sectionEnd; index++) {
            const line = lines[index];
            if (this.isIgnorableYamlLine(line)) {
                continue;
            }
            if (this.getYamlIndent(line) <= sectionIndent) {
                continue;
            }

            if (nameLine === null && /^\s*Имя:\s*.+$/.test(line)) {
                nameLine = index;
                continue;
            }

            if (codeLine === null && /^\s*Код:\s*.+$/.test(line)) {
                codeLine = index;
            }

            if (nameLine !== null && codeLine !== null) {
                break;
            }
        }

        return { nameLine, codeLine };
    }
}
