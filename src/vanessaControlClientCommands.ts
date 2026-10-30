import * as vscode from 'vscode';
import { VanessaDebugClientStore } from './vanessaDebugClients';
import { VanessaClientControlError } from './vanessaControlClients';
import { manageVanessaClients, type VanessaClientManagerPorts } from './vanessaControlClientWorkflow';
import type { VanessaControlSession } from './vanessaControlSession';

/** Reuses Debug clients and SecretStorage; attaching never applies or connects a client. */
export function registerVanessaClientCommands(
    context: vscode.ExtensionContext, session: VanessaControlSession, configureSaved: () => Promise<void>,
    openCatalog?: (preferredPath?: string) => Promise<void>
): void {
    const store = new VanessaDebugClientStore(context.workspaceState, context.secrets);
    let open = false;
    const ports: VanessaClientManagerPorts = {
        snapshot: () => {
            const snapshot = session.snapshot; const caps = snapshot.capabilities;
            return { generation: snapshot.generation, ready: snapshot.status === 'ready',
                read: !!caps?.clientProfilesRead.supported, write: !!caps?.clientProfilesWrite.supported,
                connect: !!caps?.clientConnect.supported, disconnect: !!caps?.clientDisconnect.supported, close: !!caps?.clientClose.supported };
        },
        configureSaved,
        loadSaved: async () => {
            try { return await store.load(); }
            catch { throw new VanessaClientControlError('Saved debug clients could not be loaded. Configure them again.'); }
        },
        run: async (work, generation) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Updating Vanessa test clients…') }, () => session.withTestClientControl(work, () => session.snapshot.generation === generation)),
        ui: {
            pick: async (title, items) => (await vscode.window.showQuickPick(items.map(item => ({
                ...item, label: vscode.l10n.t(item.label)
            })), { title: vscode.l10n.t(title), ignoreFocusOut: true }))?.id,
            acknowledgePort: async (name, port) => {
                const apply = vscode.l10n.t('Apply supported fields');
                return await vscode.window.showWarningMessage(vscode.l10n.t(
                    'Apply "{0}" to this Vanessa session? MCP cannot set or verify port {1}. Use a managed launch to apply the complete saved set.', name, String(port)
                ), { modal: true }, apply) === apply;
            },
            // A passive notification can remain visible after the interaction has finished.
            info: async message => { void vscode.window.showInformationMessage(vscode.l10n.t(message)); }
        }
    };
    if (openCatalog) {
        context.subscriptions.push(vscode.commands.registerCommand('kotTestToolkit.vanessaControl.clients', async (path?: unknown) => {
            try { await openCatalog(typeof path === 'string' && path.length <= 8192 ? path : undefined); }
            catch { void vscode.window.showErrorMessage(vscode.l10n.t('Could not open Vanessa test clients.')); }
        }));
    }
    context.subscriptions.push(vscode.commands.registerCommand(openCatalog ? 'kotTestToolkit.vanessaControl.legacyClients' : 'kotTestToolkit.vanessaControl.clients', async () => {
        if (open) { return; }
        open = true;
        try { await manageVanessaClients(ports); }
        catch (error) {
            // Session/adapter errors are fixed local messages; never display raw client/tool/secure-storage payloads.
            const message = error instanceof VanessaClientControlError || error instanceof Error ? error.message : 'The Vanessa client operation was not confirmed.';
            void vscode.window.showErrorMessage(vscode.l10n.t(message));
        } finally { open = false; }
    }));
}
