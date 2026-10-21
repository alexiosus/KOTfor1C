import * as vscode from 'vscode';
import type { VanessaControlExecution } from './vanessaControlSession';

/** Same whole-line colors as Test Manager's existing log tracking. */
export class VanessaExecutionHighlighter implements vscode.Disposable {
    private readonly styles = new Map<VanessaControlExecution['status'], vscode.TextEditorDecorationType>();
    constructor() {
        for (const status of ['running', 'passed', 'failed', 'stopped', 'unknown'] as const) {
            const background = status === 'failed' ? 'rgba(255, 0, 0, 0.18)' : new vscode.ThemeColor(status === 'passed' ? 'diffEditor.insertedTextBackground' : 'editor.wordHighlightStrongBackground');
            this.styles.set(status, vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: background,
                borderColor: new vscode.ThemeColor(status === 'failed' ? 'editorError.border' : status === 'passed' ? 'diffEditor.insertedTextBorder' : 'editor.wordHighlightStrongBorder'),
                borderStyle: 'solid', borderWidth: '1px', overviewRulerColor: status === 'failed' ? new vscode.ThemeColor('editorError.foreground') : background,
                overviewRulerLane: vscode.OverviewRulerLane.Center, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }));
        }
    }
    render(editor: vscode.TextEditor, range?: vscode.Range, status?: VanessaControlExecution['status'], label?: string, detail?: string): void {
        this.renderMany(editor, range && status ? [{ range, status, label, detail }] : []);
    }
    renderMany(editor: vscode.TextEditor, lines: readonly { range: vscode.Range; status: VanessaControlExecution['status']; label?: string; detail?: string }[]): void {
        for (const [name, decoration] of this.styles) {
            editor.setDecorations(decoration, lines.filter(line => line.status === name).map(line => {
                const hover = new vscode.MarkdownString(); hover.appendText([line.label, line.detail].filter(Boolean).join('\n\n'));
                return { range: line.range, hoverMessage: hover };
            }));
        }
    }
    dispose(): void { for (const decoration of this.styles.values()) { decoration.dispose(); } }
}
