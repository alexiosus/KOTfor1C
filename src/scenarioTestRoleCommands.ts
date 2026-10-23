import * as vscode from 'vscode';
import { convertScenarioTestRole } from './scenarioTestRole';
import { resolveScenarioSourceUris } from './spprScenarioFiles';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import { readScenarioProperties } from './scenarioPropertiesModel';
import { createScenarioPropertiesHost } from './scenarioPropertiesPanel';
import { createScenarioLaunchSettings } from './scenarioPropertiesActions';
import { findLinkedScenarioSettings } from './scenarioPropertiesBindings';
import { projectLibraryEnvironment } from './projectLibraryIntegration';
import { resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { getTranslator } from './localization';

/** Shared role conversion entry point; it never re-enters the Properties action queue. */
export async function handleConvertScenarioRole(context: vscode.ExtensionContext, target?: vscode.Uri, targetMain?: boolean): Promise<import('./scenarioPropertyIdentity').ScenarioIdentityChangeResult | undefined> {
    const t = await getTranslator(context.extensionUri);
    try {
        const selected = target ?? vscode.window.activeTextEditor?.document.uri;
        if (!selected || selected.scheme !== 'file') { throw new Error(t('Choose a local scenario or process.')); }
        const pair = await resolveScenarioSourceUris(selected);
        const uri = pair?.metadataUri ?? selected;
        const host = createScenarioPropertiesHost({ runAction: async () => undefined });
        const source = await host.readDocument(uri.toString()); const descriptor = parseScenarioDescriptor(source.text);
        const kind = readScenarioProperties(source.text).kind;
        if (!['scenario', 'process'].includes(kind) || !descriptor.uid) { throw new Error(t('Choose a scenario or process descriptor with a UID.')); }
        const candidates = await host.listSettings(source);
        if (candidates.some(candidate => {
            if (candidate.uri === source.uri) { return false; }
            const other = parseScenarioDescriptor(candidate.text);
            return other.uid?.toLowerCase() === descriptor.uid!.toLowerCase() && other.kind === descriptor.kind;
        })) { throw new Error(t('The source UID is ambiguous. Resolve duplicate definitions before converting the test role.')); }
        const settings = findLinkedScenarioSettings(source, candidates);
        const env = projectLibraryEnvironment(); const root = resolveProjectLibraryRoot(uri.fsPath, env.workspaceRoots, env.scanRoots);
        const guard = async (paths: readonly string[] = []) => {
            const affected = new Set([source.uri, source.scriptUri, ...settings.map(setting => setting.uri), ...paths.map(file => vscode.Uri.file(file).toString())]);
            if (vscode.workspace.textDocuments.some(document => !document.isClosed && document.isDirty && affected.has(document.uri.toString()))) {
                throw new Error(t('Save the source and launch settings before converting the test role.'));
            }
            const current = await host.readDocument(source.uri);
            if (current.text !== source.text || current.version !== source.version || current.scriptText !== source.scriptText) {
                throw new Error(t('The source changed. Refresh the properties and retry the action.'));
            }
        };
        await guard();
        const main = targetMain ?? settings.length === 0;
        const result = await convertScenarioTestRole({ root, sourcePath: uri.fsPath, uid: descriptor.uid,
            kind: kind as 'scenario' | 'process', targetMain: main,
            settingsPaths: settings.map(setting => vscode.Uri.parse(setting.uri).fsPath), assertCurrent: guard });
        if (result === 'needsSettings') {
            const document = await vscode.workspace.openTextDocument(uri);
            const created = await createScenarioLaunchSettings(context, document, source, t);
            if (!created) { return; }
            if (!await (await vscode.workspace.openTextDocument(created)).save()) { throw new Error(t('Could not save the new launch settings. Unsaved text is retained.')); }
        }
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcher', {
            refreshCache: true,
            changedSourceUris: result === 'unchanged' ? [] : [source.uri, ...(source.scriptUri ? [source.scriptUri] : []), ...settings.map(setting => setting.uri)]
        });
        void vscode.window.showInformationMessage(t(main ? 'Converted to a main test.' : 'Converted to a nested test. Launch settings were archived.'));
        return { sourceUri: source.uri, uriMoves: [] };
    } catch (error) {
        void vscode.window.showErrorMessage(t('Could not convert the test role: {0}', error instanceof Error ? error.message : String(error)));
    }
}

export async function showScenarioConversions(context: vscode.ExtensionContext, target?: vscode.Uri, line?: number): Promise<import('./scenarioPropertyIdentity').ScenarioIdentityChangeResult | undefined> {
    const selected = target ?? vscode.window.activeTextEditor?.document.uri;
    if (!selected) { return; }
    const t = await getTranslator(context.extensionUri);
    try {
        const pair = await resolveScenarioSourceUris(selected); const uri = pair?.metadataUri ?? selected;
        if (!pair && /\.feature$/iu.test(uri.fsPath)) {
            await vscode.commands.executeCommand('kotTestToolkit.convertCallableScenario', uri, line); return;
        }
        const host = createScenarioPropertiesHost({ runAction: async () => undefined });
        const source = await host.readDocument(uri.toString()); const descriptor = parseScenarioDescriptor(source.text);
        const kind = readScenarioProperties(source.text).kind;
        if (!['scenario', 'process'].includes(kind) || !descriptor.uid) { throw new Error(t('Choose a scenario or process descriptor with a UID.')); }
        const main = findLinkedScenarioSettings(source, await host.listSettings(source)).length > 0;
        const choices = [{ label: t(main ? 'Convert to nested test' : 'Convert to main test…'), action: 'role' },
            ...(!main && kind === 'scenario' ? [{ label: t('Convert to exported scenario…'), action: 'callable' }] : []),
            ...(kind === 'scenario' && /[\\/](?:scen|meta)\.yaml$/u.test(uri.fsPath)
                ? [{ label: t('Convert source format…'), action: 'format' }] : [])];
        const choice = await vscode.window.showQuickPick(choices, { title: t('Conversions'), ignoreFocusOut: true });
        if (choice?.action === 'role') { return handleConvertScenarioRole(context, uri, !main); }
        if (choice?.action === 'format') { return (await import('./spprScenarioFiles.js')).handleConvertScenarioFormat(uri); }
        if (choice?.action === 'callable') { await vscode.commands.executeCommand('kotTestToolkit.convertCallableScenario', uri); }
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
}
