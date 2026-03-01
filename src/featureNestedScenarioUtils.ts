import * as vscode from 'vscode';

const FEATURE_NESTED_SCENARIO_CALL_REGEX = /^(\s*\*(?:And|But|Then|When|Given|И|Но|Тогда|Когда|Допустим|Если)\s+)(.+?)\s*$/i;

interface FeatureNestedScenarioStackEntry {
    scenarioName: string;
    scenarioLine: number;
    scenarioIndent: number;
    scenarioNameStart: number;
    scenarioNameEnd: number;
}

export interface FeatureNestedScenarioContext {
    scenarioName: string;
    scenarioLine: number;
    scenarioIndent: number;
    scenarioNameRange: vscode.Range;
}

function getFeatureLineIndent(lineText: string): number {
    let indent = 0;
    for (let index = 0; index < lineText.length; index++) {
        const char = lineText[index];
        if (char === ' ') {
            indent += 1;
            continue;
        }
        if (char === '\t') {
            indent += 4;
            continue;
        }
        break;
    }
    return indent;
}

function isIgnorableFeatureLine(lineText: string): boolean {
    const trimmed = lineText.replace(/^\uFEFF/, '').trim();
    return trimmed.length === 0 || trimmed.startsWith('#');
}

function parseFeatureNestedScenarioCall(lineText: string, lineNumber: number): FeatureNestedScenarioStackEntry | null {
    const match = lineText.match(FEATURE_NESTED_SCENARIO_CALL_REGEX);
    if (!match || !match[2]) {
        return null;
    }

    const scenarioName = match[2].trim();
    if (!scenarioName) {
        return null;
    }

    const nameStart = match[1].length;
    return {
        scenarioName,
        scenarioLine: lineNumber,
        scenarioIndent: getFeatureLineIndent(lineText),
        scenarioNameStart: nameStart,
        scenarioNameEnd: nameStart + scenarioName.length
    };
}

function toContext(document: vscode.TextDocument, entry: FeatureNestedScenarioStackEntry): FeatureNestedScenarioContext {
    return {
        scenarioName: entry.scenarioName,
        scenarioLine: entry.scenarioLine,
        scenarioIndent: entry.scenarioIndent,
        scenarioNameRange: new vscode.Range(
            entry.scenarioLine,
            entry.scenarioNameStart,
            entry.scenarioLine,
            entry.scenarioNameEnd
        )
    };
}

export function getFeatureNestedScenarioContextAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): FeatureNestedScenarioContext | null {
    if (document.lineCount <= 0) {
        return null;
    }

    const targetLine = Math.min(Math.max(0, position.line), document.lineCount - 1);
    const stack: FeatureNestedScenarioStackEntry[] = [];

    for (let lineIndex = 0; lineIndex <= targetLine; lineIndex++) {
        const lineText = document.lineAt(lineIndex).text;
        const callEntry = parseFeatureNestedScenarioCall(lineText, lineIndex);
        if (callEntry) {
            while (stack.length > 0 && stack[stack.length - 1].scenarioIndent >= callEntry.scenarioIndent) {
                stack.pop();
            }
            stack.push(callEntry);
            if (lineIndex === targetLine) {
                return toContext(document, callEntry);
            }
            continue;
        }

        if (isIgnorableFeatureLine(lineText)) {
            continue;
        }

        const currentIndent = getFeatureLineIndent(lineText);
        while (stack.length > 0 && currentIndent <= stack[stack.length - 1].scenarioIndent) {
            stack.pop();
        }
    }

    const enclosing = stack.length > 0 ? stack[stack.length - 1] : null;
    return enclosing ? toContext(document, enclosing) : null;
}

export function getFeatureNestedScenarioContextAtLine(
    document: vscode.TextDocument,
    lineNumber: number
): FeatureNestedScenarioContext | null {
    if (document.lineCount <= 0) {
        return null;
    }
    const safeLine = Math.min(Math.max(0, lineNumber), document.lineCount - 1);
    return getFeatureNestedScenarioContextAtPosition(document, new vscode.Position(safeLine, 0));
}
