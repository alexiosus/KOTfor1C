import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import { VanessaYamlControl, type VanessaYamlBuild, type VanessaYamlTarget } from './vanessaControlYaml';
import { mapFeatureLineToYaml } from './vanessaControlSourceMapping';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import { sameVanessaFeaturePath, type VanessaControlSession } from './vanessaControlSession';
import type { VanessaFeatureDocument } from './vanessaControlFeature';
import { VanessaExecutionHighlighter } from './vanessaControlHighlighting';
import type { VanessaBreakpointMarkers, VanessaGutterLocation } from './vanessaControlBreakpointMarkers';

/** Uses the existing session and compiler output. The native YAML editor remains the source of truth. */
export function createVanessaYamlControl(context: vscode.ExtensionContext, session: VanessaControlSession,
    loadBuild: () => Promise<VanessaYamlBuild | undefined>, nativeMarkers?: VanessaBreakpointMarkers): VanessaYamlControl {
    const status = new VanessaExecutionHighlighter();
    const points = vscode.window.createTextEditorDecorationType({ gutterIconPath: context.asAbsolutePath('res/icons/VanessaBreakpoint.svg'), gutterIconSize: 'contain',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed, overviewRulerColor: new vscode.ThemeColor('debugIcon.breakpointForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
    const texts = new WeakMap<vscode.TextDocument, { version: number; text: string }>();
    const rendered = new WeakMap<vscode.TextEditor, string>();
    let selected: { target: VanessaYamlTarget; generation: number } | undefined;
    let mappedKey = '';
    let mappedExecution: { uri: string; lineIndex: number } | undefined;
    let mappedPoints: Array<{ uri: string; lineIndex: number; featureLine: number }> = [];
    const textOf = (document: vscode.TextDocument) => {
        let value = texts.get(document);
        if (value?.version !== document.version) { value = { version: document.version, text: document.getText() }; texts.set(document, value); }
        return value.text;
    };
    const current = (): VanessaFeatureDocument | undefined => {
        const editor = vscode.window.activeTextEditor;
        return editor ? { uri: editor.document.uri.toString(), filePath: editor.document.uri.fsPath, text: textOf(editor.document),
            version: editor.document.version, dirty: editor.document.isDirty, line: editor.selection.active.line } : undefined;
    };
    const render = () => {
        const native: VanessaGutterLocation[] = [];
        const snapshot = session.snapshot; const execution = snapshot.execution; const breakpoints = snapshot.breakpoints;
        const active = selected?.generation === snapshot.generation ? selected.target : undefined;
        const executionMatches = active && execution && sameVanessaFeaturePath(active.filePath, execution.filePath) && execution.lineNumber === active.location.lineNumber;
        const pointsMatch = active && breakpoints && sameVanessaFeaturePath(active.filePath, breakpoints.filePath);
        const key = active ? `${snapshot.generation}:${active.location.feature}:${executionMatches ? `${execution.currentLineNumber ?? execution.lineNumber}:${execution.status}:${execution.stopReason}` : ''}:${pointsMatch ? breakpoints.lines.join(',') : ''}` : '';
        if (key !== mappedKey) {
            mappedKey = key; mappedExecution = undefined; mappedPoints = [];
            if (active && executionMatches) {
                const mapped = mapFeatureLineToYaml(active.build, active.location.worker, active.location.feature, execution.currentLineNumber ?? execution.lineNumber);
                if (mapped.kind === 'unique') { mappedExecution = mapped.location; }
            }
            if (active && pointsMatch) {
                for (const line of breakpoints.lines) {
                    const mapped = mapFeatureLineToYaml(active.build, active.location.worker, active.location.feature, line);
                    if (mapped.kind === 'unique') { mappedPoints.push({ ...mapped.location, featureLine: line }); }
                }
            }
        }
        for (const editor of vscode.window.visibleTextEditors) {
            const source = active?.build.sources.find(item => item.uri === editor.document.uri.toString());
            const matches = source && !editor.document.isDirty && nativeDocumentTextMatchesFileText(textOf(editor.document), source.text);
            const editorKey = matches ? `${mappedKey}:${editor.document.version}` : '';
            if (matches) { native.push(...mappedPoints.filter(item => item.uri === source.uri && breakpoints?.ownedLines.includes(item.featureLine) && item.lineIndex < editor.document.lineCount)
                .map(item => ({ uri: source.uri, line: item.lineIndex }))); }
            if (rendered.get(editor) === editorKey) { continue; } rendered.set(editor, editorKey);
            const location = matches && mappedExecution?.uri === source.uri && mappedExecution.lineIndex < editor.document.lineCount ? mappedExecution : undefined;
            const label = execution?.stopReason === 'breakpoint' ? vscode.l10n.t('Stopped before this step') : execution?.status === 'passed'
                ? vscode.l10n.t(execution.mode === 'oneStep' ? 'Step passed' : 'Run passed') : execution?.status === 'failed' ? vscode.l10n.t('Step failed')
                    : execution?.status === 'running' ? vscode.l10n.t('Executing step…') : vscode.l10n.t('Result not confirmed');
            status.render(editor, location ? editor.document.lineAt(location.lineIndex).range : undefined, execution?.status, label, session.failure?.message);
            editor.setDecorations(points, matches ? mappedPoints.filter(item => (!nativeMarkers || !breakpoints?.ownedLines.includes(item.featureLine)) && item.uri === source.uri && item.lineIndex < editor.document.lineCount).map(item => ({
                range: editor.document.lineAt(item.lineIndex).range, hoverMessage: `${vscode.l10n.t(breakpoints?.ownedLines.includes(item.featureLine)
                    ? 'KOT breakpoint' : 'Breakpoint from Vanessa')}: ${active!.location.feature}:${item.featureLine}` })) : []);
        }
        nativeMarkers?.replace('yaml', native);
    };
    const control = new VanessaYamlControl({ current, loadBuild,
        save: async () => !!await vscode.window.activeTextEditor?.document.save(),
        readText: file => fs.readFile(file, 'utf8'),
        choose: async locations => {
            const selected = await vscode.window.showQuickPick(locations.map(location => ({ location,
                label: `${location.feature}:${location.lineNumber}`, description: vscode.l10n.t('Build part {0}', location.worker) })),
            { title: vscode.l10n.t('Choose compiled invocation'), placeHolder: vscode.l10n.t('This YAML step occurs more than once in the compiled tests.') });
            return selected?.location;
        },
        selectLine: line => {
            const editor = vscode.window.activeTextEditor; if (!editor) { return; }
            editor.selection = new vscode.Selection(line, 0, line, 0);
            editor.revealRange(editor.document.lineAt(line).range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        },
        perform: async (mode, target) => {
            if (vscode.debug.activeDebugSession) { throw new Error('Stop the active debugger before controlling Vanessa manually.'); }
            const isCurrent = () => { const source = current(); return source?.uri === target.source.uri && source.text === target.source.text && !source.dirty && source.line === target.source.line; };
            selected = { target, generation: session.snapshot.generation }; mappedKey = ''; render();
            try {
                if (mode === 'toggleBreakpoint') {
                    const lines = await session.synchronizeBreakpoints(target.filePath, undefined, isCurrent, target.featureText);
                    const owned = session.snapshot.breakpoints!.ownedLines; const line = target.location.lineNumber;
                    if (lines.includes(line) && !owned.includes(line)) {
                        void vscode.window.showInformationMessage(vscode.l10n.t('This breakpoint was created in Vanessa. Remove it there; KOT preserves existing session breakpoints.'));
                    } else {
                        const keep = target.breakpointDesired ?? !owned.includes(line);
                        await session.synchronizeBreakpoints(target.filePath, keep ? [...new Set([...owned, line])] : owned.filter(value => value !== line), isCurrent, target.featureText);
                    }
                    return { passed: false };
                }
                if (!context.workspaceState.get('kotTestToolkit.vanessaControl.preparationNotice', false)) {
                    void vscode.window.showInformationMessage(vscode.l10n.t('Manual execution skips preceding steps and preparation. Existing Vanessa variables and test clients are reused.'));
                    void context.workspaceState.update('kotTestToolkit.vanessaControl.preparationNotice', true);
                }
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                    title: vscode.l10n.t(mode === 'oneStep' ? 'Vanessa: execute one step' : 'Vanessa: run from this step') }, async () => {
                    if (mode === 'runFromLine' && session.snapshot.capabilities?.breakpoints.supported && session.snapshot.capabilities.loadFeature.supported &&
                        session.snapshot.capabilities.editor.supported && session.snapshot.capabilities.runCurrent.supported) {
                        await session.synchronizeBreakpoints(target.filePath, undefined, isCurrent, target.featureText);
                    }
                    await session.run(mode, target.filePath, target.location.lineNumber, target.featureText, isCurrent);
                });
                return { passed: session.snapshot.execution?.status === 'passed', nextLineNumber: session.snapshot.execution?.nextLineNumber };
            } finally { render(); }
        }
    });
    context.subscriptions.push(status, points, session.onDidChange(render), vscode.window.onDidChangeVisibleTextEditors(render), vscode.workspace.onDidChangeTextDocument(render));
    return control;
}
