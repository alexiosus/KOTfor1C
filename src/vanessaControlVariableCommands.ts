import * as vscode from 'vscode';
import { VanessaVariablesPanelModel, type VanessaVariableEdit } from './vanessaControlVariablesPanel';
import { VanessaVariableControlError, type VanessaRuntimeVariable, type VanessaVariableScope } from './vanessaControlVariables';
import type { VanessaControlSession } from './vanessaControlSession';

const VIEW = 'kotTestToolkit.vanessaVariables';
type VariableNode = { scope: VanessaVariableScope; variable?: VanessaRuntimeVariable; edit?: VanessaVariableEdit };

/** Runtime values live only in this visible view, never workspace settings, YAML, or session snapshots. */
export function registerVanessaVariableCommands(context: vscode.ExtensionContext, session: VanessaControlSession): void {
    const events = new vscode.EventEmitter<VariableNode | undefined>();
    const model = new VanessaVariablesPanelModel({
        snapshot: () => ({ generation: session.snapshot.generation, ready: session.snapshot.status === 'ready', busy: session.busy,
            read: !!session.snapshot.capabilities?.variablesRead.supported, write: !!session.snapshot.capabilities?.variablesWrite.supported }),
        run: (work, generation, isCurrent) => session.withVariableControl(work, () => session.snapshot.generation === generation && (!isCurrent || isCurrent()))
    }, () => events.fire(undefined));
    const scopeLabel = (scope: VanessaVariableScope) => scope === 'local' ? vscode.l10n.t('Local context ($var$)') : vscode.l10n.t('Saved context ($$var$$)');
    const view = vscode.window.createTreeView<VariableNode>(VIEW, { treeDataProvider: {
        onDidChangeTreeData: events.event,
        getChildren: node => {
            if (!node) { return ['local', 'global'].map(scope => ({ scope: scope as VanessaVariableScope })); }
            if (node.variable) { return []; }
            return model.state.rows.filter(row => row.scope === node.scope).map(variable => ({ scope: node.scope, variable,
                edit: session.snapshot.capabilities?.variablesWrite.supported && model.state.status === 'ready' ? model.beginEdit(variable.scope, variable.name) : undefined }));
        },
        getTreeItem: node => {
            const row = node.variable;
            const item = new vscode.TreeItem(row ? `${row.name} = ${row.representation}` : scopeLabel(node.scope),
                row ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
            item.id = row ? `${node.scope}:${row.name}` : node.scope;
            item.contextValue = row && node.edit ? node.scope === 'local' ? 'vanessaLocalVariable' : 'vanessaGlobalVariable' : '';
            if (row) {
                // Plain text only: runtime values are not trusted Markdown or commands.
                item.tooltip = `${row.name}\n${row.representation}\n\n${vscode.l10n.t('MCP returns a text representation without its 1C type. Replacing it stores a string.')}`;
                item.iconPath = new vscode.ThemeIcon('symbol-variable');
            } else { item.description = String(model.state.rows.filter(value => value.scope === node.scope).length); }
            return item;
        }
    } });
    const messages = {
        idle: vscode.l10n.t('Refresh to read variables from the attached Vanessa session.'),
        ready: undefined,
        loading: vscode.l10n.t('Loading runtime variables…'),
        unavailable: vscode.l10n.t('Attach to a ready Vanessa session with manage_variables support.'),
        error: vscode.l10n.t('Could not read runtime variables. Refresh the session and retry.')
    };
    const render = () => { view.message = messages[model.state.status]; events.fire(undefined); };
    const changes = events.event(() => { view.message = messages[model.state.status]; });
    const report = async (work: () => Promise<unknown>) => {
        try { await work(); } catch (error) {
            void vscode.window.showErrorMessage(vscode.l10n.t(error instanceof VanessaVariableControlError ? error.message : 'The Vanessa variable operation was not confirmed. Refresh the variables.'));
        }
    };
    const write = async (node?: VariableNode) => {
        let edit = node?.edit;
        if (!edit) {
            await model.refresh();
            const captured = model.beginEdit('local', '');
            const scope = await vscode.window.showQuickPick((['local', 'global'] as const).map(value => ({ label: scopeLabel(value), value })), {
                title: vscode.l10n.t('New runtime string variable'), ignoreFocusOut: true });
            if (!scope) { return; }
            const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Runtime variable name'), ignoreFocusOut: true });
            if (!name) { return; }
            edit = model.beginEdit(scope.value, name);
            if (edit.generation !== captured.generation || edit.lifetime !== captured.lifetime) {
                throw new VanessaVariableControlError('The Vanessa session or variable panel changed. Refresh the variables.');
            }
        }
        const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Set string value: {0}', edit.name),
            prompt: vscode.l10n.t('MCP returns a text representation without its 1C type. Replacing it stores a string.'),
            value: edit.expected ?? '', ignoreFocusOut: true });
        if (value === undefined) { return; }
        if (edit.expected !== undefined) {
            const replace = vscode.l10n.t('Replace with string');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Replace the runtime value of "{0}" with a string?', edit.name), { modal: true }, replace) !== replace) { return; }
        }
        await model.set(edit, value);
    };
    context.subscriptions.push(events, changes, view, { dispose: () => model.dispose() },
        session.onDidChange(() => {
            model.sessionChanged();
            if (!session.busy && session.snapshot.status === 'ready' && model.state.status === 'idle') { void model.refresh(); }
            render();
        }),
        view.onDidChangeVisibility(event => { model.setVisible(event.visible); if (event.visible) { void model.refresh(); } render(); }),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.variables', () => report(async () => {
            await vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaVariablesVisible', true);
            await vscode.commands.executeCommand(`${VIEW}.focus`);
            model.setVisible(true); await model.refresh(); render();
        })),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.variables.refresh', () => report(() => model.refresh())),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.variables.set', (node?: VariableNode) => report(() => write(node))),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.variables.delete', (node?: VariableNode) => report(async () => {
            if (!node?.edit || !node.variable) { return; }
            const remove = vscode.l10n.t('Delete variable');
            if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete local runtime variable "{0}"?', node.variable.name), { modal: true }, remove) === remove) { await model.delete(node.edit); }
        })));
    model.setVisible(view.visible);
    if (view.visible) { void model.refresh(); }
    render();
}
