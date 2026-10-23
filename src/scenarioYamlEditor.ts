import * as vscode from 'vscode';
import { resolveScenarioSourceUris } from './spprScenarioFiles';

const SERVICE_SECTIONS = new Set([
    'ДанныеСценария', 'ДанныеПроцесса', 'ПараметрыСценария',
    'ВложенныеСценарии', 'ТегиСценария', 'ТегиПроцесса', 'KOTМетаданные'
]);

export interface ScenarioYamlFoldRange { readonly start: number; readonly end: number; readonly header?: boolean }

/** Add a single header region without inserting comment markers into compiler YAML. */
export function scenarioYamlFoldRanges(text: string): ScenarioYamlFoldRange[] {
    const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
    if (!/^ТипФайла:\s*["']?(?:Сценарий|Процесс)["']?\s*$/imu.test(lines.join('\n'))) { return []; }
    const body = lines.findIndex(line => /^(?:ТекстСценария|ШагиПроцесса):/u.test(line));
    const result: ScenarioYamlFoldRange[] = body > 1 ? [{ start: 0, end: body - 1, header: true }] : [];
    const sectionStarts = lines.flatMap((line, index) => /^([^\s:#][^:]*):\s*(?:\|[+-]?\d*\s*)?$/u.test(line) ? [index] : []);
    for (const start of sectionStarts) {
        const next = lines.findIndex((line, index) => index > start && /^[^\s#]/u.test(line));
        let end = next < 0 ? lines.length - 1 : next - 1;
        while (end > start && !lines[end].trim()) { end--; }
        if (end > start && lines.slice(start + 1, end + 1).some(line => /^[ \t]+\S/u.test(line))) { result.push({ start, end }); }
    }
    return result;
}

export function scenarioDefaultFoldLines(text: string, fileName?: string): number[] {
    if (/(?:^|[\\/])meta\.yaml$/u.test(fileName ?? '')) { return []; }
    const ranges = scenarioYamlFoldRanges(text);
    const header = ranges.find(range => range.header);
    return header ? [header.start, ...scenarioServiceSectionLines(text).filter(line => line > header.end)] : scenarioServiceSectionLines(text);
}

export class ScenarioYamlFoldingProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        return scenarioYamlFoldRanges(document.getText()).map(range => new vscode.FoldingRange(range.start, range.end,
            range.header ? vscode.FoldingRangeKind.Region : undefined));
    }
}

/** Empty sections have no fold range: selecting them could fold the following body. */
export function scenarioServiceSectionLines(text: string): number[] {
    const lines = text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
    const result: number[] = [];
    for (let index = 0; index < lines.length; index++) {
        const section = /^([^\s:#][^:]*):\s*(?:#.*)?$/u.exec(lines[index]);
        if (!section || !SERVICE_SECTIONS.has(section[1])) { continue; }
        let next = index + 1;
        while (next < lines.length && (!lines[next].trim() || /^\s*#/u.test(lines[next]))) { next++; }
        if (next < lines.length && /^[ \t]+\S/u.test(lines[next])) { result.push(index); }
    }
    return result;
}

/** Property mode uses the original document and its ordinary save/Undo lifecycle. */
export class ScenarioYamlEditor {
    async open(source: vscode.Uri): Promise<vscode.TextEditor> {
        const paired = /(?:^|[\\/])(?:meta\.yaml|scen\.feature)$/u.test(source.fsPath ?? '') ? await resolveScenarioSourceUris(source) : undefined;
        const document = await vscode.workspace.openTextDocument(paired?.format === 'native' ? paired.scriptUri : source);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        if (paired?.format === 'native' || document.isClosed || vscode.window.activeTextEditor?.document !== document) { return editor; }
        const selectionLines = scenarioDefaultFoldLines(document.getText(), document.fileName);
        if (selectionLines.length) {
            await vscode.commands.executeCommand('editor.fold', { levels: 1, direction: 'down', selectionLines });
        }
        return editor;
    }
}
