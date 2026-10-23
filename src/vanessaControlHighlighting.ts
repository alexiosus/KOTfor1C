import * as vscode from 'vscode';
import type { VanessaControlExecution } from './vanessaControlSession';

interface ExecutionPaint {
    readonly range: vscode.Range;
    readonly status: VanessaControlExecution['status'];
    readonly label?: string;
    readonly detail?: string;
    readonly hoverMessage?: vscode.MarkdownString | vscode.MarkdownString[];
}
const priority = { passed: 0, unknown: 1, stopped: 2, running: 3, failed: 4 };
const sources = new WeakMap<vscode.TextEditor, Map<VanessaExecutionHighlighter, readonly ExecutionPaint[]>>();
let styles: Map<ExecutionPaint['status'], vscode.TextEditorDecorationType> | undefined;
let owners = 0;

/** Log tracking and MCP contribute to one paint per line, so translucent colors never stack. */
export class VanessaExecutionHighlighter implements vscode.Disposable {
    private readonly editors = new Set<WeakRef<vscode.TextEditor>>();
    private readonly registered = new WeakSet<vscode.TextEditor>();
    private disposed = false;
    constructor() {
        owners++;
        if (styles) { return; }
        styles = new Map();
        for (const status of ['running', 'passed', 'failed', 'stopped', 'unknown'] as const) {
            const background = status === 'failed' ? 'rgba(255, 0, 0, 0.18)' : new vscode.ThemeColor(status === 'passed' ? 'diffEditor.insertedTextBackground' : 'editor.wordHighlightStrongBackground');
            styles.set(status, vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: background,
                borderColor: new vscode.ThemeColor(status === 'failed' ? 'editorError.border' : status === 'passed' ? 'diffEditor.insertedTextBorder' : 'editor.wordHighlightStrongBorder'),
                borderStyle: 'solid', borderWidth: '1px', overviewRulerColor: status === 'failed' ? new vscode.ThemeColor('editorError.foreground') : background,
                overviewRulerLane: vscode.OverviewRulerLane.Center, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }));
        }
    }
    render(editor: vscode.TextEditor, range?: vscode.Range, status?: VanessaControlExecution['status'], label?: string, detail?: string): void {
        this.renderMany(editor, range && status ? [{ range, status, label, detail }] : []);
    }
    renderMany(editor: vscode.TextEditor, lines: readonly ExecutionPaint[]): void {
        if (this.disposed) { return; }
        const layers = sources.get(editor) ?? new Map<VanessaExecutionHighlighter, readonly ExecutionPaint[]>();
        if (lines.length) {
            layers.set(this, lines); sources.set(editor, layers);
            if (!this.registered.has(editor)) { this.registered.add(editor); this.editors.add(new WeakRef(editor)); }
        } else { layers.delete(this); }
        const selected = new Map<number, { line: ExecutionPaint; hovers: vscode.MarkdownString[] }>();
        for (const values of layers.values()) {
            for (const line of values) {
                const previous = selected.get(line.range.start.line);
                const hover = new vscode.MarkdownString(); hover.appendText([line.label, line.detail].filter(Boolean).join('\n\n'));
                const hovers = line.hoverMessage ? [line.hoverMessage].flat() : line.label || line.detail ? [hover] : [];
                if (!previous || priority[line.status] > priority[previous.line.status]) {
                    selected.set(line.range.start.line, { line, hovers });
                } else if (line.status === previous.line.status) { previous.hovers.push(...hovers); }
            }
        }
        for (const [status, decoration] of styles ?? []) {
            editor.setDecorations(decoration, [...selected.values()].filter(item => item.line.status === status)
                .map(item => ({ range: item.line.range, hoverMessage: item.hovers })));
        }
    }
    dispose(): void {
        if (this.disposed) { return; }
        for (const ref of this.editors) { const editor = ref.deref(); if (editor) { this.renderMany(editor, []); } }
        this.editors.clear(); this.disposed = true;
        if (--owners === 0) { for (const style of styles?.values() ?? []) { style.dispose(); } styles = undefined; }
    }
}
