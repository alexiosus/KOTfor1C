import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import { VanessaFeatureControl, isExecutableFeatureLine, type VanessaFeatureDocument } from './vanessaControlFeature';
import type { VanessaControlFailure, VanessaControlSession } from './vanessaControlSession';
import { isExecutableYamlControlLine, type VanessaYamlControl } from './vanessaControlYaml';
import { VanessaExecutionHighlighter } from './vanessaControlHighlighting';

/** Manual feature commands share the attached session; ordinary F5/debug launches stay independent. */
export function registerVanessaControlCommands(context: vscode.ExtensionContext, session: VanessaControlSession, yamlControl?: VanessaYamlControl,
    ensureConnected: () => Promise<boolean> = async () => true,
    trackRun?: (filePath: string) => (passed: boolean) => Promise<void>,
    failureHover?: (failure: VanessaControlFailure, document: vscode.TextDocument) => vscode.MarkdownString | undefined): void {
    const decoration = new VanessaExecutionHighlighter();
    let reportedFailure: unknown;
    let executedSource: VanessaFeatureDocument | undefined;
    const texts = new WeakMap<vscode.TextDocument, { version: number; text: string }>();
    const decorated = new WeakMap<vscode.TextEditor, string>();
    let executable: { uri: string; version: number; line: number; text: string; value: boolean } | undefined;
    let previousCanStep: boolean | undefined;
    let lastEditor = vscode.window.activeTextEditor;
    const currentEditor = () => {
        const active = vscode.window.activeTextEditor;
        if (active) { lastEditor = active; return active; }
        return lastEditor && vscode.window.visibleTextEditors.includes(lastEditor) ? lastEditor : undefined;
    };
    const textOf = (document: vscode.TextDocument) => {
        let cached = texts.get(document);
        if (cached?.version !== document.version) {
            cached = { version: document.version, text: document.getText() }; texts.set(document, cached);
        }
        return cached.text;
    };
    const labels = { running: vscode.l10n.t('Executing step…'), passed: vscode.l10n.t('Step passed'),
        failed: vscode.l10n.t('Step failed'), skipped: vscode.l10n.t('Step skipped'), stopped: vscode.l10n.t('Execution stopped'), unknown: vscode.l10n.t('Result not confirmed') };
    const current = (): VanessaFeatureDocument | undefined => {
        const editor = currentEditor();
        if (!editor) { return undefined; }
        const document = editor.document;
        return { uri: document.uri.toString(), filePath: document.uri.fsPath, version: document.version,
            text: textOf(document), dirty: document.isDirty, line: editor.selection.active.line };
    };
    const update = () => {
        const source = current();
        const snapshot = session.snapshot;
        if (source && (executable?.uri !== source.uri || executable.version !== source.version || executable.line !== source.line || executable.text !== source.text)) {
            executable = { uri: source.uri, version: source.version, line: source.line, text: source.text,
                value: isExecutableFeatureLine(source, source.line) || !!yamlControl && isExecutableYamlControlLine(source) };
        }
        const available = snapshot.status === 'detached' || snapshot.status === 'ready' && !!snapshot.capabilities?.oneStep.supported &&
            !!snapshot.capabilities.editorContent.supported && !!snapshot.capabilities.openFeature.supported;
        const canStep = !!source && available && !!executable?.value;
        if (canStep !== previousCanStep) {
            previousCanStep = canStep;
            void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaControlCanStep', canStep);
        }
        const execution = snapshot.execution;
        if (session.failure && session.failure !== reportedFailure) {
            reportedFailure = session.failure;
            void vscode.window.showErrorMessage(vscode.l10n.t('Step failed: {0}', session.failure.message));
        }
        for (const editor of vscode.window.visibleTextEditors) {
            const matches = execution && session.executionMatchesSource(editor.document.uri.fsPath, textOf(editor.document));
            const line = execution ? (execution.currentLineNumber ?? execution.lineNumber) - 1 : -1;
            const lines = new Map(execution?.steps?.map(step => [step.lineNumber - 1, step.status]));
            if (execution && (execution.status === 'running' || !lines.has(line))) { lines.set(line, execution.status); }
            const key = matches ? `${editor.document.version}:${JSON.stringify([...lines])}:${execution?.stopReason ?? ''}:${JSON.stringify(session.failure ?? '')}` : '';
            if (decorated.get(editor) === key) { continue; }
            decorated.set(editor, key);
            if (!key || !execution) { decoration.render(editor); continue; }
            decoration.renderMany(editor, [...lines].filter(([number]) => number >= 0 && number < editor.document.lineCount).map(([number, status]) => ({ range: editor.document.lineAt(number).range, status,
                label: execution.stopReason === 'breakpoint' && number === line ? vscode.l10n.t('Stopped before this step') : labels[status],
                detail: status === 'failed' && session.failure?.lineNumber === number + 1 ? session.failure.message : undefined,
                hoverMessage: status === 'failed' && session.failure?.lineNumber === number + 1 ? failureHover?.(session.failure, editor.document) : undefined })));
        }
    };
    const control = new VanessaFeatureControl({ current,
        exists: async filePath => { try { return (await fs.stat(filePath)).isFile(); } catch { return false; } },
        readText: filePath => fs.readFile(filePath, 'utf8'),
        save: async () => !!await currentEditor()?.document.save(),
        selectLine: line => {
            const editor = currentEditor();
            if (!editor) { return; }
            editor.selection = new vscode.Selection(line, 0, line, 0);
            editor.revealRange(editor.document.lineAt(line).range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        },
        execute: async (mode, filePath, line) => {
            if (vscode.debug.activeDebugSession) { throw new Error(vscode.l10n.t('Stop the active debugger before controlling Vanessa manually.')); }
            if (!context.workspaceState.get('kotTestToolkit.vanessaControl.preparationNotice', false)) {
                void vscode.window.showInformationMessage(vscode.l10n.t('Manual execution skips preceding steps and preparation. Existing Vanessa variables and test clients are reused.'));
                void context.workspaceState.update('kotTestToolkit.vanessaControl.preparationNotice', true);
            }
            executedSource = current();
            return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: mode === 'oneStep' ? vscode.l10n.t('Vanessa: execute one step') : vscode.l10n.t('Vanessa: run from this step') }, async progress => {
                let subscription: { dispose(): void } | undefined;
                let finish: ((passed: boolean) => Promise<void>) | undefined;
                try {
                    if (mode === 'runFromLine' && session.snapshot.capabilities?.breakpoints.supported && session.snapshot.capabilities.loadFeature.supported &&
                        session.snapshot.capabilities.editor.supported && session.snapshot.capabilities.runCurrent.supported) {
                        const source = executedSource;
                        await session.synchronizeBreakpoints(filePath, undefined, () => {
                            const active = current(); return !!source && active?.uri === source.uri && active.text === source.text && !active.dirty;
                        }, source?.text);
                    }
                    let previousMessage: string | undefined;
                    subscription = session.onDidChange(snapshot => {
                        const counts = snapshot.execution?.progress;
                        const message = counts ? counts.total === undefined ? String(counts.completed) : `${counts.completed} / ${counts.total}` : undefined;
                        if (message && message !== previousMessage) { previousMessage = message; progress.report({ message }); }
                    });
                    const source = executedSource;
                    if (mode === 'runFromLine') { finish = trackRun?.(filePath); }
                    await session.run(mode, filePath, line, source?.text, () => {
                        const active = current(); return !!source && active?.uri === source.uri && active.text === source.text && !active.dirty && active.line === source.line;
                    });
                    const execution = session.snapshot.execution;
                    if (execution?.status === 'passed' && execution.nextLineNumber && execution.nextLineNumber < line) {
                        void vscode.window.showInformationMessage(vscode.l10n.t('Vanessa selected an earlier line. Automatic loop traversal is unavailable for this runtime; select the next step manually.'));
                    }
                    return execution?.status === 'passed' && !vscode.debug.activeDebugSession ? execution.nextLineNumber : undefined;
                } finally { await finish?.(session.snapshot.execution?.status === 'passed'); subscription?.dispose(); update(); }
            });
        }
    });
    const run = async (mode: 'oneStep' | 'runFromLine', compiled = false, target?: vscode.Uri) => {
        try {
            if (target?.scheme) {
                const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === target.toString());
                if (!editor) { throw new Error('Open the requested source in a visible text editor.'); }
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
                }
            }
            const requested = current();
            if (!await ensureConnected()) { return; }
            const active = current();
            if (!requested || active?.uri !== requested.uri || active.text !== requested.text || active.line !== requested.line) {
                throw new Error('The active source or selection changed while connecting to Vanessa. Run the command again.');
            }
            if (yamlControl && /\.yaml$/iu.test(current()?.uri ?? '')) {
                if (mode === 'oneStep' && !compiled) { await vscode.commands.executeCommand('kotTestToolkit.vanessaControl.tryYamlStep'); }
                else { await yamlControl.run(mode); }
            }
            else { await control.run(mode); }
        }
        catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t('Vanessa MCP command failed.')); }
    };
    context.subscriptions.push(decoration,
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.oneStep', (target?: vscode.Uri) => run('oneStep', false, target)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.oneCompiledStep', (target?: vscode.Uri) => run('oneStep', true, target)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.runFromLine', (target?: vscode.Uri) => run('runFromLine', false, target)),
        session.onDidChange(update), vscode.window.onDidChangeActiveTextEditor(update),
        vscode.window.onDidChangeTextEditorSelection(update), vscode.window.onDidChangeVisibleTextEditors(update),
        vscode.workspace.onDidChangeTextDocument(update), vscode.debug.onDidStartDebugSession(update), vscode.debug.onDidTerminateDebugSession(update));
    update();
}
