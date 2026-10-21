import * as vscode from 'vscode';
import { getGherkinInsertionContext } from './gherkinInsertionContext';
import { VanessaAuthoringError, prepareVanessaDraftInsertion, type VanessaInsertionTarget, type VanessaRecordingToken } from './vanessaControlAuthoring';
import type { VanessaControlSession } from './vanessaControlSession';

/** Results go to the current scenario as one undoable edit; no transient document or mandatory draft workflow. */
export function registerVanessaAuthoringCommands(context: vscode.ExtensionContext, session: VanessaControlSession, ensureConnected: () => Promise<boolean>,
    formatChecks: (text: string) => Promise<string> = async text => text): void {
    let capture: VanessaRecordingToken | undefined; let uncertain = false; let working = false; let generation = session.snapshot.generation;
    let lastObserved = session.snapshot.observed;
    let pending: string | undefined; let lastEditor = vscode.window.activeTextEditor;
    const retained: string[] = [];
    const retain = (text?: string) => { if (text?.trim() && text !== pending && !retained.includes(text)) { retained.push(text); } };
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    const results = vscode.window.createOutputChannel(vscode.l10n.t('Vanessa generated steps'), 'feature');
    const captureTarget = (): VanessaInsertionTarget | undefined => {
        const active = vscode.window.activeTextEditor;
        const editor = active?.document.uri.scheme === 'file' ? active : lastEditor;
        if (!editor || editor.document.isClosed || editor.document.uri.scheme !== 'file' || editor.selections?.length > 1) { return; }
        const document = editor.document; const position = editor.selection.active;
        const insertion = getGherkinInsertionContext(document, position);
        if (!insertion?.supported) { return; }
        const line = document.lineAt(position.line); const empty = !line.text.trim();
        const nextLine = empty ? position.line : position.line + 1;
        const offset = empty ? document.offsetAt(new vscode.Position(position.line, 0)) : nextLine >= document.lineCount ? document.getText().length : document.offsetAt(new vscode.Position(nextLine, 0));
        return { uri: document.uri.toString(), version: document.version, text: document.getText(), offset,
            length: empty ? line.text.length : 0, indentation: insertion.indentation, language: insertion.language,
            eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' };
    };
    const render = () => {
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaRecording', !!capture);
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaDraftAvailable', !!pending || retained.length > 0);
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaRecordingSupported', !!session.snapshot.capabilities?.recording.supported);
        if (capture) {
            status.text = uncertain ? '$(warning) ' + vscode.l10n.t('Vanessa recording: check state') : '$(record) ' + vscode.l10n.t('Vanessa recording');
            status.command = 'kotTestToolkit.vanessaControl.recording.stop'; status.tooltip = vscode.l10n.t('Stop recording and insert steps'); status.show();
        } else { status.hide(); }
    };
    const report = async (title: string, work: () => Promise<void>) => {
        if (working) { void vscode.window.showInformationMessage(vscode.l10n.t('A Vanessa request is still in progress.')); return; }
        working = true;
        try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t(title) }, work); }
        catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t(error instanceof VanessaAuthoringError ? error.message : 'Vanessa authoring was not confirmed. Refresh the session and retry.')); }
        finally { working = false; render(); }
    };
    const insert = async () => {
        const text = pending ?? retained.at(-1);
        if (!text) { return; }
        const target = captureTarget();
        if (!target) { throw new VanessaAuthoringError('Steps are ready. Place the cursor inside a scenario and use Insert captured steps here.'); }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        const edit = prepareVanessaDraftInsertion(target, { uri: document.uri.toString(), version: document.version, text: document.getText() }, text);
        const prefix = edit.offset > 0 && !/[\r\n]/u.test(target.text[edit.offset - 1]) && edit.length === 0 ? target.eol : '';
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        if (document.version !== target.version || document.getText() !== target.text) { throw new VanessaAuthoringError('The insertion target changed. Choose the insertion position again.'); }
        const applied = await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.offset + edit.length)), prefix + edit.text), { undoStopBefore: true, undoStopAfter: true });
        if (!applied) { throw new VanessaAuthoringError('The editor could not insert the steps. Use Insert captured steps here to retry.'); }
        if (pending === text) { pending = undefined; } else if (retained.at(-1) === text) { retained.pop(); }
    };
    const apply = async (text: string) => {
        if (!text.trim()) { void vscode.window.showInformationMessage(vscode.l10n.t('No steps were captured.')); return; }
        const previous = pending; pending = undefined; retain(previous); pending = text; await insert();
    };
    const generate = (kind: 'checks' | 'suggestions') => report(kind === 'checks' ? 'Vanessa: generating form checks…' : 'Vanessa: reading current element steps…', async () => {
        if (capture) { throw new VanessaAuthoringError('Stop recording before generating form steps.'); }
        if (!await ensureConnected()) { return; }
        const raw = await session.withAuthoringControl(authoring => authoring.formSteps(kind));
        const text = kind === 'checks' ? await formatChecks(raw) : raw;
        if (!text.trim()) { void vscode.window.showInformationMessage(vscode.l10n.t('No steps were captured.')); return; }
        const previous = pending; pending = undefined; retain(previous); pending = text;
        results.clear(); results.append(text); results.show(true);
    });
    const stopCapture = () => report('Vanessa: stopping recording and inserting steps…', async () => {
            if (!capture) { return; } const own = capture;
            let text: string | null;
            try { text = await session.withAuthoringControl(authoring => authoring.stop(own)); }
            catch (error) {
                if (capture === own && session.snapshot.generation === own.generation && error instanceof VanessaAuthoringError && error.token) {
                    capture = error.token; uncertain = true; retain(error.token.previousSteps);
                }
                throw error;
            }
            if (capture !== own || session.snapshot.generation !== own.generation) { return; }
            capture = undefined; uncertain = false;
            if (text === null) { void vscode.window.showInformationMessage(vscode.l10n.t('Recording was stopped in Vanessa. Its generated text remains in Vanessa.')); }
            else { await apply(text); }
        });
    context.subscriptions.push(status, results,
        vscode.window.onDidChangeActiveTextEditor(editor => { if (editor?.document.uri.scheme === 'file') { lastEditor = editor; } }),
        session.onDidChange(() => {
            const observedChanged = lastObserved !== session.snapshot.observed; lastObserved = session.snapshot.observed;
            if (generation !== session.snapshot.generation) { capture = undefined; uncertain = false; generation = session.snapshot.generation; }
            else if (!working && capture && observedChanged && session.snapshot.observed?.recording === false) {
                // An external Stop is already confirmed. Another RPC could stop
                // a newer recording started since this observation.
                capture = undefined; uncertain = false;
                void vscode.window.showInformationMessage(vscode.l10n.t('Recording was stopped in Vanessa. Its generated text remains in Vanessa.'));
            }
            render();
        }),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.recording.start', () => report('Vanessa: starting recording…', async () => {
            if (capture) { throw new VanessaAuthoringError('A capture is already active. Use Stop recording first.'); }
            if (!captureTarget()) { throw new VanessaAuthoringError('Place the cursor inside a YAML scenario body or a feature scenario before recording.'); }
            if (!await ensureConnected()) { return; }
            const ownGeneration = session.snapshot.generation;
            try {
                const token = await session.withAuthoringControl(authoring => authoring.start());
                if (session.snapshot.generation === ownGeneration) {
                    capture = token; uncertain = false; retain(token.previousSteps);
                    if (token.previousSteps) { void vscode.window.showInformationMessage(vscode.l10n.t('Previous recorded steps were preserved. Use Insert captured steps here or Copy captured steps to retrieve them.')); }
                }
            }
            catch (error) {
                if (session.snapshot.generation === ownGeneration && error instanceof VanessaAuthoringError && error.token) { capture = error.token; uncertain = true; retain(error.token.previousSteps); }
                throw error;
            }
        })),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.recording.stop', stopCapture),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.formChecks', () => generate('checks')),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.formSuggestions', () => generate('suggestions')),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.recording.insertHere', () => report('Vanessa: inserting steps…', insert)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.recording.copy', async () => { const text = pending ?? retained.at(-1); if (text) { await vscode.env.clipboard.writeText(text); } }));
    render();
}
