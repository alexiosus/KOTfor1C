import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectDefinitionView } from './projectDefinition';
import { getConfiguredScenarioLanguage } from './gherkinLanguage';
import { VanessaYamlTrialControl, type VanessaYamlTrial, type VanessaYamlTrialPorts } from './vanessaControlYamlTrial';
import { prepareVanessaSelection } from './vanessaControlSelection';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import { sameVanessaFeaturePath, type VanessaControlFailure, type VanessaControlSession } from './vanessaControlSession';
import type { VanessaFeatureDocument } from './vanessaControlFeature';
import { VanessaExecutionHighlighter } from './vanessaControlHighlighting';

/** Runtime fragments never replace the user's native YAML document. */
export function registerVanessaYamlTrialCommand(context: vscode.ExtensionContext, session: VanessaControlSession,
    getDefinitions: (uri: vscode.Uri) => Promise<ProjectDefinitionView>, ensureConnected: () => Promise<boolean> = async () => true,
    failureHover?: (failure: VanessaControlFailure, document: vscode.TextDocument) => vscode.MarkdownString | undefined): {
        isFailedLine(document: vscode.TextDocument, line: number): boolean
    } {
    const decoration = new VanessaExecutionHighlighter();
    let directory: Promise<string> | undefined; let disposed = false; let sequence = 0;
    let selected: { trial: VanessaYamlTrial; file: string; generation: number } | undefined;
    const texts = new WeakMap<vscode.TextDocument, { version: number; text: string }>();
    const rendered = new WeakMap<vscode.TextEditor, string>();
    const textOf = (document: vscode.TextDocument) => {
        let value = texts.get(document);
        if (value?.version !== document.version) { value = { version: document.version, text: document.getText() }; texts.set(document, value); }
        return value.text;
    };
    const current = (): VanessaFeatureDocument | undefined => {
        const editor = vscode.window.activeTextEditor;
        return editor ? { uri: editor.document.uri.toString(), filePath: editor.document.uri.fsPath, text: textOf(editor.document),
            dirty: editor.document.isDirty, version: editor.document.version, line: editor.selection.active.line } : undefined;
    };
    const render = () => {
        const snapshot = session.snapshot; const execution = snapshot.execution;
        const active = selected?.generation === snapshot.generation && execution && sameVanessaFeaturePath(selected.file, execution.filePath) ? selected : undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            const line = active ? active.trial.sourceLines[(execution!.currentLineNumber ?? execution!.lineNumber) - active.trial.lineNumber] ?? active.trial.source.line : -1;
            const matches = active && editor.document.uri.toString() === active.trial.source.uri && !editor.document.isDirty && textOf(editor.document) === active.trial.source.text;
            const key = matches && line >= 0 && line < editor.document.lineCount ? `${editor.document.version}:${line}:${execution!.status}:${JSON.stringify(session.failure ?? '')}` : '';
            if (rendered.get(editor) === key) { continue; } rendered.set(editor, key);
            const label = execution?.status === 'passed' ? vscode.l10n.t('Step trial passed') : execution?.status === 'failed' ? vscode.l10n.t('Step trial failed')
                : execution?.status === 'running' ? vscode.l10n.t('Trying step…') : vscode.l10n.t('Step trial result not confirmed');
            const hover = key && execution?.status === 'failed' && session.failure ? failureHover?.({ ...session.failure,
                filePath: editor.document.uri.fsPath, lineNumber: line + 1, scenarioName: undefined }, editor.document) : undefined;
            decoration.render(editor, key ? editor.document.lineAt(line).range : undefined, execution?.status, label, session.failure?.message, hover);
        }
    };
    const ports: VanessaYamlTrialPorts = { current,
        save: async () => !!await vscode.window.activeTextEditor?.document.save(),
        readText: file => fs.readFile(file, 'utf8'),
        getDefinitions: source => getDefinitions(vscode.Uri.parse(source.uri)),
        defaultLanguage: () => getConfiguredScenarioLanguage(),
        materialize: async trial => {
            if (disposed) { throw new Error('Vanessa step control has been closed.'); }
            directory ??= fs.mkdtemp(path.join(os.tmpdir(), 'kot-vanessa-step-trial-'));
            const root = await directory;
            const file = path.join(root, `step-${++sequence}.feature`);
            await fs.writeFile(file, trial.featureText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            return file;
        },
        execute: async (file, trial, isCurrent) => {
            if (disposed || vscode.debug.activeDebugSession) { throw new Error('Stop the active debugger before controlling Vanessa manually.'); }
            if (!context.workspaceState.get('kotTestToolkit.vanessaControl.trialNotice', false)) {
                void vscode.window.showInformationMessage(vscode.l10n.t('A step trial executes only the selected ordinary Vanessa step and its payload. Preceding preparation is skipped; current runtime variables and test clients are reused.'));
                void context.workspaceState.update('kotTestToolkit.vanessaControl.trialNotice', true);
            }
            selected = { trial, file, generation: session.snapshot.generation };
            try {
                await session.run('oneStep', file, trial.lineNumber, trial.featureText, isCurrent);
                if (session.snapshot.execution?.status === 'passed' && isCurrent()) {
                    const editor = vscode.window.activeTextEditor;
                    const lines = trial.source.text.split(/\r\n|\r|\n/u);
                    let next = trial.sourceLines.at(-1)! + 1;
                    while (next < lines.length && (!lines[next].trim() || /^\s*(?:#|\/\/)/u.test(lines[next]))) { next++; }
                    if (editor && next < editor.document.lineCount) {
                        editor.selection = new vscode.Selection(next, 0, next, 0);
                        editor.revealRange(editor.document.lineAt(next).range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                    }
                }
            } finally { render(); }
        }
    };
    const control = new VanessaYamlTrialControl(ports);
    context.subscriptions.push(decoration,
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.tryYamlStep', async () => {
            try {
                const requested = current();
                if (!await ensureConnected()) { return; }
                const active = current();
                if (!requested || active?.uri !== requested.uri || active.text !== requested.text || active.line !== requested.line) {
                    throw new Error('The active source or selection changed while connecting to Vanessa. Run the command again.');
                }
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Vanessa: try YAML step') }, () => control.run());
            }
            catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t('Vanessa MCP command failed.')); }
        }),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.runSelection', async () => {
            try {
                const editor = vscode.window.activeTextEditor; const source = current();
                if (!editor || !source || editor.selection.isEmpty || editor.selections.length !== 1) { throw new Error('Select one range of ordinary Vanessa steps.'); }
                const selection = editor.selection;
                if (!await ensureConnected()) { return; }
                const start = selection.start.line;
                const end = selection.end.line - (selection.end.character === 0 ? 1 : 0);
                const isCurrent = () => {
                    const active = vscode.window.activeTextEditor;
                    return !disposed && !vscode.debug.activeDebugSession && active?.document.uri.toString() === source.uri &&
                        active.document.getText() === source.text && !active.document.isDirty && active.selection.isEqual(selection);
                };
                if (source.dirty && !await editor.document.save()) { throw new Error('Save the source before running the selection.'); }
                if (!isCurrent() || !nativeDocumentTextMatchesFileText(source.text, await fs.readFile(source.filePath, 'utf8'))) { throw new Error('The selected source changed. Select the steps again.'); }
                const definitions = await getDefinitions(editor.document.uri);
                if (!isCurrent()) { throw new Error('The selected source changed. Select the steps again.'); }
                const trial = prepareVanessaSelection(source, start, end, definitions, getConfiguredScenarioLanguage());
                const file = await ports.materialize(trial);
                if (!isCurrent()) { throw new Error('The selected source changed. Select the steps again.'); }
                selected = { trial, file, generation: session.snapshot.generation };
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Vanessa: run selected steps') },
                    () => session.run('runFromLine', file, trial.lineNumber, trial.featureText, isCurrent));
            } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t('Vanessa MCP command failed.')); }
            finally { render(); }
        }), session.onDidChange(render), vscode.window.onDidChangeVisibleTextEditors(render), vscode.workspace.onDidChangeTextDocument(render),
        { dispose: () => { disposed = true; void directory?.then(root => fs.rm(root, { recursive: true, force: true })).catch(() => { /* Own transient files may already be gone. */ }); } });
    return { isFailedLine: (document, line) => {
        const execution = session.snapshot.execution;
        if (!selected || selected.generation !== session.snapshot.generation || execution?.status !== 'failed'
            || !sameVanessaFeaturePath(selected.file, execution.filePath) || document.isDirty
            || document.uri.toString() !== selected.trial.source.uri || textOf(document) !== selected.trial.source.text) { return false; }
        return line === (selected.trial.sourceLines[(execution.currentLineNumber ?? execution.lineNumber) - selected.trial.lineNumber] ?? selected.trial.source.line);
    } };
}
