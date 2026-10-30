import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import { isExecutableFeatureLine, prepareSavedVanessaFeature, sameSavedVanessaFeature, type VanessaFeatureDocument } from './vanessaControlFeature';
import { sameVanessaFeaturePath, type VanessaControlSession } from './vanessaControlSession';
import { isExecutableYamlControlLine, type VanessaYamlControl } from './vanessaControlYaml';
import { VanessaBreakpointMarkers, type VanessaGutterLocation } from './vanessaControlBreakpointMarkers';

/** Separate Vanessa markers leave native debugger breakpoints and keybindings untouched. */
export function registerVanessaBreakpointCommands(context: vscode.ExtensionContext, session: VanessaControlSession, yamlControl?: VanessaYamlControl,
    nativeMarkers = new VanessaBreakpointMarkers()): void {
    const marker = vscode.window.createTextEditorDecorationType({ gutterIconPath: context.asAbsolutePath('res/icons/VanessaBreakpoint.svg'), gutterIconSize: 'contain',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed, overviewRulerColor: new vscode.ThemeColor('debugIcon.breakpointForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
    const cached = new WeakMap<vscode.TextDocument, { version: number; text: string }>();
    const rendered = new WeakMap<vscode.TextEditor, string>();
    let source: (VanessaFeatureDocument & { generation: number }) | undefined;
    let busy = false;
    const textOf = (document: vscode.TextDocument) => {
        let value = cached.get(document);
        if (value?.version !== document.version) { value = { version: document.version, text: document.getText() }; cached.set(document, value); }
        return value.text;
    };
    const current = (): VanessaFeatureDocument | undefined => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return undefined; }
        const document = editor.document;
        return { uri: document.uri.toString(), filePath: document.uri.fsPath, version: document.version, text: textOf(document),
            dirty: document.isDirty, line: editor.selection.active.line };
    };
    const update = () => {
        const snapshot = session.snapshot; const points = snapshot.breakpoints;
        const native: VanessaGutterLocation[] = [];
        if (source && source.generation !== snapshot.generation && session.ownedBreakpointsForSource(source.filePath, source.text).length) {
            source = { ...source, generation: snapshot.generation };
        }
        for (const editor of vscode.window.visibleTextEditors) {
            const matches = points && source?.generation === snapshot.generation && sameSavedVanessaFeature(source, {
                uri: editor.document.uri.toString(), text: textOf(editor.document), dirty: editor.document.isDirty }) && sameVanessaFeaturePath(points.filePath, editor.document.uri.fsPath);
            const key = matches ? `${snapshot.generation}:${editor.document.version}:${points.lines.join(',')}:${points.ownedLines.join(',')}` : '';
            if (matches) {
                native.push(...points.ownedLines.filter(line => line <= editor.document.lineCount).map(line => ({ uri: editor.document.uri.toString(), line: line - 1 })));
            }
            if (rendered.get(editor) === key) { continue; } rendered.set(editor, key);
            editor.setDecorations(marker, matches ? points.lines.filter(line => !points.ownedLines.includes(line) && line <= editor.document.lineCount).map(line => ({ range: editor.document.lineAt(line - 1).range,
                hoverMessage: points.ownedLines.includes(line) ? vscode.l10n.t('KOT breakpoint') : vscode.l10n.t('Breakpoint from Vanessa') })) : []);
        }
        if (!busy) { nativeMarkers.replace('feature', native); }
    };
    const act = async (toggle: boolean, clicked?: { uri: string; line: number }, desired?: boolean) => {
        if (busy) { return; }
        busy = true;
        try {
            if (vscode.debug.activeDebugSession) { throw new Error(vscode.l10n.t('Stop the active debugger before controlling Vanessa manually.')); }
            const initial = current();
            if (clicked && initial?.uri !== clicked.uri) { throw new Error('The active feature changed. Run the command again.'); }
            if (toggle && yamlControl && /\.yaml$/iu.test(initial?.uri ?? '')) { await yamlControl.run('toggleBreakpoint', clicked?.line, desired); return; }
            if (!initial) { throw new Error(vscode.l10n.t('Open a saved feature.')); }
            if (toggle && !isExecutableFeatureLine(initial, clicked?.line ?? initial.line)) { throw new Error(vscode.l10n.t('Place the cursor on an executable step in a saved feature.')); }
            const saved = await prepareSavedVanessaFeature(initial, { current,
                exists: async file => { try { return (await fs.stat(file)).isFile(); } catch { return false; } },
                readText: file => fs.readFile(file, 'utf8'),
                save: async () => !!await vscode.window.activeTextEditor?.document.save() });
            const isCurrent = () => { const active = current(); return !!active && sameSavedVanessaFeature(saved, active); };
            const lines = await session.synchronizeBreakpoints(saved.filePath, undefined, isCurrent, saved.text);
            const owned = session.snapshot.breakpoints!.ownedLines;
            if (toggle) {
                const line = (clicked?.line ?? initial.line) + 1;
                if (lines.includes(line) && !owned.includes(line)) {
                    void vscode.window.showInformationMessage(vscode.l10n.t('This breakpoint was created in Vanessa. Remove it there; KOT preserves existing session breakpoints.'));
                } else {
                    const keep = desired ?? !owned.includes(line);
                    await session.synchronizeBreakpoints(saved.filePath, keep ? [...new Set([...owned, line])] : owned.filter(value => value !== line), isCurrent, saved.text);
                }
            }
            source = { ...saved, generation: session.snapshot.generation }; update();
            if (!toggle) {
                if (!lines.length) { void vscode.window.showInformationMessage(vscode.l10n.t('No Vanessa breakpoints in this feature.')); return; }
                const selected = await vscode.window.showQuickPick(lines.map(line => ({ label: vscode.l10n.t('Line {0}', line), line,
                    description: owned.includes(line) ? vscode.l10n.t('KOT breakpoint') : vscode.l10n.t('Breakpoint from Vanessa') })), { title: vscode.l10n.t('Vanessa breakpoints') });
                const editor = vscode.window.activeTextEditor;
                if (selected && isCurrent() && editor && selected.line <= editor.document.lineCount) {
                    editor.selection = new vscode.Selection(selected.line - 1, 0, selected.line - 1, 0);
                    editor.revealRange(editor.document.lineAt(selected.line - 1).range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                }
            }
        } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t('Vanessa MCP command failed.')); }
        finally { busy = false; update(); }
    };
    context.subscriptions.push(marker, nativeMarkers,
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.toggleBreakpoint', () => act(true)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.listBreakpoints', () => act(false)),
        session.onDidChange(update), vscode.window.onDidChangeVisibleTextEditors(update), vscode.workspace.onDidChangeTextDocument(update));
    // Only a newly clicked plain source breakpoint in the active KOT document is
    // handed to Vanessa. Existing, conditional, and other debugger breakpoints stay intact.
    context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(event => {
        if (vscode.debug.activeDebugSession || !session.snapshot.capabilities?.breakpoints.supported) { return; }
        const active = current();
        for (const point of event.removed) {
            if (!nativeMarkers.takeRemoved(point.id) || !(point instanceof vscode.SourceBreakpoint) || point.location.uri.toString() !== active?.uri) { continue; }
            void act(true, { uri: active.uri, line: point.location.range.start.line }, false);
        }
        for (const point of event.added) {
            if (nativeMarkers.owns(point.id) || !(point instanceof vscode.SourceBreakpoint) || point.condition || point.hitCondition || point.logMessage || !point.enabled ||
                point.location.uri.toString() !== active?.uri || !/\.(feature|yaml)$/iu.test(point.location.uri.path)) { continue; }
            const clickedSource = { ...active, line: point.location.range.start.line };
            if (!isExecutableFeatureLine(clickedSource, clickedSource.line) && !isExecutableYamlControlLine(clickedSource)) { continue; }
            nativeMarkers.adopt(point, /\.yaml$/iu.test(active.uri) ? 'yaml' : 'feature');
            void act(true, { uri: active.uri, line: point.location.range.start.line }, true).finally(() => {
                nativeMarkers.discardPending(point.id);
            });
        }
    }));
}
