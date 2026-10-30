import * as vscode from 'vscode';
import type { VanessaControlSession } from './vanessaControlSession';
import { collectVanessaFormToolArguments } from './vanessaControlFormToolWorkflow';

/** Explicit advanced actions reflect tools/list of the attached version; no live values are persisted. */
export function registerVanessaFormToolCommands(context: vscode.ExtensionContext, session: VanessaControlSession,
    ensureConnected: () => Promise<boolean>): void {
    let working = false;
    const output = vscode.window.createOutputChannel(vscode.l10n.t('Vanessa form tools'));
    context.subscriptions.push(output, vscode.commands.registerCommand('kotTestToolkit.vanessaControl.formTools', async (elementName?: string) => {
        if (working) { return; } working = true;
        try {
            if (!await ensureConnected()) { return; }
            const generation = session.snapshot.generation;
            const tool = await vscode.window.showQuickPick(session.formTools.map(value => ({
                label: value.name, description: value.name === 'get_table_data' ? vscode.l10n.t('Database data, not UI table rows') : undefined,
                detail: value.description, tool: value
            })), { title: vscode.l10n.t('Vanessa form tools'), ignoreFocusOut: true });
            if (!tool) { return; }
            const properties = tool.tool.inputSchema.properties ?? {};
            const initial = typeof elementName === 'string' && properties.element_name ? { element_name: elementName } : {};
            const args = await collectVanessaFormToolArguments(tool.tool, {
                pick: async (title, items) => (await vscode.window.showQuickPick(items.map(item => ({ ...item, label: vscode.l10n.t(item.label) })), { title, ignoreFocusOut: true }))?.id,
                input: async (title, value, validateInput) => vscode.window.showInputBox({ title, value, ignoreFocusOut: true, validateInput })
            }, initial);
            if (!args || session.snapshot.generation !== generation) { return; }
            const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Vanessa: {0}', tool.label) },
                () => session.runFormTool(tool.tool.name, args));
            if (session.snapshot.generation !== generation) { return; }
            const content = result && typeof result === 'object' && 'content' in result ? (result as { content?: unknown }).content : undefined;
            const text = Array.isArray(content) ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
            output.clear(); output.append(text || vscode.l10n.t('The tool returned no text content.')); output.show(true);
            return ['manage_form_elements', 'execute_form_actions', 'window_management'].includes(tool.tool.name);
        } catch { void vscode.window.showErrorMessage(vscode.l10n.t('The Vanessa form tool request could not be confirmed. Refresh the connection before retrying.')); }
        finally { working = false; }
    }));
}
