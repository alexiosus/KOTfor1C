import { kotWindow } from './kotInteraction';
import * as vscode from 'vscode';
import path from 'node:path';
import type { VanessaControlSession } from './vanessaControlSession';
import { VanessaSettingsReport } from './vanessaControlSettingsReport';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

/** A snapshot of the selected profile's Additional tab, prepared by the parameters editor. */
export interface VanessaSettingsProfileSource {
    readonly profileName: string;
    readonly parameters: string;
    readonly basePath: string;
}

export function registerVanessaSettingsCommands(context: vscode.ExtensionContext, session: VanessaControlSession, ensureConnected: () => Promise<boolean>): void {
    let working = false;
    const reportView = new VanessaSettingsReport(context, session);
    context.subscriptions.push(reportView);
    context.subscriptions.push(vscode.commands.registerCommand('kotTestToolkit.vanessaControl.settings', async (source?: VanessaSettingsProfileSource) => {
        if (working) { return; } working = true;
        try {
            if (!await ensureConnected()) { return; }
            if (!session.snapshot.capabilities?.settingsRead?.supported) {
                void kotUi.showInformationMessage(vscode.l10n.t('This Vanessa version does not expose runtime settings. Use project launch parameters or update Vanessa.')); return;
            }
            const generation = session.snapshot.generation;
            const current = () => generation === session.snapshot.generation;
            const action = await kotUi.showQuickPick([
                { label: vscode.l10n.t('Browse and edit Vanessa settings'), action: 'edit' },
                ...(session.snapshot.capabilities.settingsWrite?.supported ? [
                    ...(source ? [{ label: vscode.l10n.t('Apply additional parameters from profile "{0}"…', source.profileName), action: 'applyProfile' }] : []),
                    { label: vscode.l10n.t('Apply a VAParams JSON file to this session…'), action: 'apply' }
                ] : []),
                { label: vscode.l10n.t('Edit profile launch parameters…'), action: 'profile' }
            ], { title: vscode.l10n.t('Vanessa session settings') });
            if (!action || !current()) { return; }
            if (action.action === 'profile') {
                await vscode.commands.executeCommand('kotTestToolkit.openYamlParametersManager', 'additional'); return;
            }
            const list = await session.withSettingsControl(settings => settings.list(), current);
            if (!list.ok) { reportView.show(list); return; }
            if (action.action === 'apply' || action.action === 'applyProfile') {
                let parameters: string; let base: string;
                if (action.action === 'applyProfile') {
                    if (!source || typeof source.parameters !== 'string' || typeof source.basePath !== 'string' || !path.isAbsolute(source.basePath)) {
                        throw new Error('Invalid profile settings source.');
                    }
                    parameters = source.parameters; base = source.basePath;
                } else {
                    const files = await kotUi.showOpenDialog({ title: vscode.l10n.t('Select VAParams JSON'), canSelectMany: false, filters: { JSON: ['json'] } });
                    if (!files?.[0] || !current()) { return; }
                    parameters = new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(files[0])).replace(/^\uFEFF/u, '');
                    base = path.dirname(files[0].fsPath);
                }
                const preview = await session.withSettingsControl(settings => settings.apply(parameters, base, list.revision, true), current);
                if (!await reportView.confirm(preview, list.items ?? [], current) || !current()) { return; }
                const report = await session.withSettingsControl(settings => settings.apply(parameters, base, preview.revision, false), current);
                reportView.show(report, list.items, 'result'); return;
            }
            const selected = await kotUi.showQuickPick((list.items ?? []).filter(row => typeof row.key === 'string').map(row => ({
                label: row.synonym || row.key, description: row.password_mode ? '••••' : row.current,
                detail: `${row.key} — ${row.hint ?? ''}`, key: row.key
            })), { title: vscode.l10n.t('Vanessa settings'), matchOnDescription: true, matchOnDetail: true });
            if (!selected || !current()) { return; }
            const original = await session.withSettingsControl(settings => settings.get(selected.key), current);
            const item = original.item;
            if (!original.ok || !item || !item.editable || !session.snapshot.capabilities?.settingsWrite?.supported) { reportView.show(original); return; }
            const value = await kotUi.showInputBox({ title: item.synonym || item.key, value: item.current,
                prompt: item.hint, password: item.password_mode, ignoreFocusOut: true });
            if (value === undefined || value === item.current || !current()) { return; }
            const report = await session.withSettingsControl(settings => settings.set(item.key, value, original.revision, item.current), current);
            if (!report.ok || report.errors.length || report.warnings.length) { reportView.show(report, list.items, 'result'); }
            else { void kotUi.showInformationMessage(vscode.l10n.t('Vanessa setting applied.')); }
        } catch { reportView.unconfirmed(); void kotUi.showErrorMessage(vscode.l10n.t('The Vanessa settings operation was not confirmed. Refresh the connection and review the active settings.')); }
        finally { working = false; }
    }));
}
