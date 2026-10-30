import * as vscode from 'vscode';
import { LineCounter, parseDocument } from 'yaml';
import { collectCompilerFormatIssues } from './compilerFormatDiagnostics';

export function collectCompilerFormatDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
    const messages = {
        extension: vscode.l10n.t('SPPR scans *.yaml only; this .yml descriptor or settings file will be ignored.'),
        scalar: vscode.l10n.t('SPPR reads exported YAML scalars as quoted strings. Bare, flow or multiline quoted values can be misread; use a quoted single-line value or an exact | block.'),
        blockScalar: vscode.l10n.t('SPPR recognizes only the exact | marker. Folded blocks and block modifiers can be misread.'),
        indentation: vscode.l10n.t('SPPR structural YAML indentation must use multiples of four spaces.'),
        comment: vscode.l10n.t('SPPR does not skip structural or inline YAML comments outside multiline content; they can be misread.')
    };
    return collectCompilerFormatIssues(document.getText(), document.fileName).map(issue => {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(issue.line, issue.startCharacter, issue.line, issue.endCharacter),
            messages[issue.kind], vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'KOT for 1C';
        diagnostic.code = 'kotTestToolkit.compilerFormat';
        return diagnostic;
    });
}

export interface YamlIndentationTab {
    line: number;
    startCharacter: number;
    endCharacter: number;
    indentationLength: number;
    replacement: string;
}

/** Find structural tabs without treating literal, quoted or flow content as YAML indentation. */
export function collectYamlIndentationTabs(source: string): YamlIndentationTab[] {
    if (!/^[ \t]*\t[ \t]*\S/mu.test(source)) {
        return [];
    }
    const lines = source.split(/\r?\n/u);
    const lineCounter = new LineCounter();
    const parsed = parseDocument(source, { lineCounter, prettyErrors: false });
    const issueLines = new Set<number>();
    for (const error of parsed.errors) {
        if (error.code !== 'TAB_AS_INDENT' && error.code !== 'BAD_INDENT') { continue; }
        const line = lineCounter.linePos(error.pos[0]).line - 1;
        const indentation = lines[line]?.match(/^[ \t]*/u)?.[0] ?? '';
        if (indentation.includes('\t')) { issueLines.add(line); }
    }
    return Array.from(issueLines).sort((left, right) => left - right).map(line => {
        const indentation = lines[line].match(/^[ \t]*/u)![0];
        let replacement = '';
        // SPPR indexes structural levels in units of four spaces.
        for (const character of indentation) {
            replacement += character === '\t' ? ' '.repeat(4 - replacement.length % 4) : ' ';
        }
        return {
            line,
            startCharacter: indentation.indexOf('\t'),
            endCharacter: indentation.lastIndexOf('\t') + 1,
            indentationLength: indentation.length,
            replacement
        };
    });
}

function isYamlFileDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'yaml' || /\.ya?ml$/iu.test(document.fileName);
}

function matchesFileType(content: string, typeName: string): boolean {
    const escapedTypeName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`ТипФайла:\\s*["']${escapedTypeName}["']`),
        new RegExp(`ТипФайла:\\s*${escapedTypeName}`),
        new RegExp(`типфайла:\\s*["']${escapedTypeName.toLowerCase()}["']`),
        new RegExp(`типфайла:\\s*${escapedTypeName.toLowerCase()}`)
    ];

    return patterns.some(pattern => pattern.test(content));
}

function compilerFileType(document: vscode.TextDocument): string | undefined {
    if (!isYamlFileDocument(document)) {
        return undefined;
    }

    const match = document.getText().match(
        /^\uFEFF?(?:ТипФайла|типфайла):[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*?))[ \t]*(?:#.*)?$/mu
    );
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim().toLowerCase();
}

export function isProcessYamlFile(document: vscode.TextDocument): boolean {
    return compilerFileType(document) === 'процесс';
}

export function isProcessTestSettingsYamlFile(document: vscode.TextDocument): boolean {
    return compilerFileType(document) === 'настройкапроцесса';
}

export function isCompilerYamlFile(document: vscode.TextDocument): boolean {
    const type = compilerFileType(document);
    return type === 'сценарий'
        || type === 'процесс'
        || type === 'настройкатеста'
        || type === 'настройкапроцесса';
}

/**
 * Проверяет, является ли YAML файл сценарием (содержит строку "ТипФайла: Сценарий")
 */
export function isScenarioYamlFile(document: vscode.TextDocument): boolean {
    if (!isYamlFileDocument(document)) {
        return false;
    }

    return matchesFileType(document.getText(), 'Сценарий');
}

/**
 * Проверяет, является ли URI файлом сценария YAML
 */
export async function isScenarioYamlUri(uri: vscode.Uri): Promise<boolean> {
    try {
        if (!uri.fsPath.toLowerCase().endsWith('.yaml')) {
            return false;
        }

        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        return matchesFileType(content, 'Сценарий');
    } catch (error) {
        console.warn(`[YamlValidator] Error checking file ${uri.fsPath}:`, error);
        return false;
    }
}

export function isTestSettingsYamlFile(document: vscode.TextDocument): boolean {
    if (!isYamlFileDocument(document)) {
        return false;
    }

    return matchesFileType(document.getText(), 'НастройкаТеста');
}

export async function isTestSettingsYamlUri(uri: vscode.Uri): Promise<boolean> {
    try {
        if (!uri.fsPath.toLowerCase().endsWith('.yaml')) {
            return false;
        }

        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        return matchesFileType(content, 'НастройкаТеста');
    } catch (error) {
        console.warn(`[YamlValidator] Error checking file ${uri.fsPath}:`, error);
        return false;
    }
}
