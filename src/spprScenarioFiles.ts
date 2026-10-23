import * as path from 'node:path';
import * as vscode from 'vscode';
import { joinNativeSpprScenario, convertSpprScenarioFiles, type SpprScenarioFormat } from './spprScenarioFormat';
import { waitForProjectLibraryIdle } from './projectLibraryStore';

export interface ScenarioSourceUris {
    readonly format: SpprScenarioFormat;
    readonly metadataUri: vscode.Uri;
    readonly scriptUri: vscode.Uri;
}

async function readSourceText(uri: vscode.Uri): Promise<string> {
    const open = (vscode.workspace.textDocuments ?? []).find(document => !document.isClosed && document.uri.toString() === uri.toString());
    return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

/** A scen.feature belongs to SPPR only when its adjacent metadata declares a scenario. */
export async function resolveScenarioSourceUris(uri: vscode.Uri): Promise<ScenarioSourceUris | undefined> {
    const name = path.posix.basename(uri.path ?? uri.fsPath.replace(/\\/gu, '/'));
    if (name !== 'meta.yaml' && name !== 'scen.feature') {
        return /\.yaml$/iu.test(name) ? { format: 'legacy', metadataUri: uri, scriptUri: uri } : undefined;
    }
    const metadataUri = name === 'meta.yaml' ? uri : vscode.Uri.joinPath(uri, '..', 'meta.yaml');
    const scriptUri = name === 'scen.feature' ? uri : vscode.Uri.joinPath(uri, '..', 'scen.feature');
    try {
        const metadata = await readSourceText(metadataUri);
        if (!/^\uFEFF?ТипФайла:[ \t]*["']?Сценарий["']?[ \t]*\r?$/mu.test(metadata)) { return undefined; }
        await vscode.workspace.fs.stat(scriptUri);
        return { format: 'native', metadataUri, scriptUri };
    } catch { return undefined; }
}

/** Read-only compatibility view for parsers that expect embedded ТекстСценария. Never save it over meta.yaml. */
export async function readScenarioSource(uri: vscode.Uri): Promise<string> {
    const source = await resolveScenarioSourceUris(uri);
    if (source?.format !== 'native') { return readSourceText(uri); }
    const metadata = await readSourceText(source.metadataUri);
    // A read-only parser view can complete a final line while the source editor is still typing it.
    return joinNativeSpprScenario(metadata.endsWith('\n') ? metadata : metadata + '\n', await readSourceText(source.scriptUri));
}

/** Keep metadata identity for catalogs while source navigation targets the paired script. */
export async function resolveScenarioScriptLocation(location: import('./projectDefinition').ProjectDefinitionLocation): Promise<import('./projectDefinition').ProjectDefinitionLocation> {
    if (!/(?:^|\/)meta\.yaml$/u.test(location.uri)) { return location; }
    const source = await resolveScenarioSourceUris(vscode.Uri.parse(location.uri));
    if (source?.format !== 'native') { return location; }
    const lines = (await readSourceText(source.scriptUri)).split(/\r\n|\r|\n/u);
    const first = lines.findIndex(line => line.trim() && !/^\s*(?:#|\/\/)/u.test(line));
    const line = Math.max(0, first);
    const character = /^\s*/u.exec(lines[line] ?? '')![0].length;
    return { uri: source.scriptUri.toString(), range: { start: { line, character }, end: { line, character } } };
}

export async function readNativeScenarioMetadata(uri: vscode.Uri): Promise<{ uri: vscode.Uri; text: string } | undefined> {
    const source = await resolveScenarioSourceUris(uri);
    return source?.format === 'native' ? { uri: source.metadataUri, text: await readSourceText(source.metadataUri) } : undefined;
}

export async function handleConvertScenarioFormat(uri?: vscode.Uri, targetFormat?: SpprScenarioFormat, silent = false): Promise<import('./scenarioPropertyIdentity').ScenarioIdentityChangeResult | undefined> {
    const selected = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!selected) { return; }
    try {
        if (selected.scheme !== 'file') { throw new Error(vscode.l10n.t('SPPR format conversion requires local files.')); }
        const name = path.basename(selected.fsPath);
        if (!['scen.yaml', 'meta.yaml', 'scen.feature'].includes(name)) {
            throw new Error(vscode.l10n.t('Select scen.yaml, meta.yaml or scen.feature to convert the SPPR scenario.'));
        }
        const sourceFormat = name === 'scen.yaml' ? 'legacy' : 'native';
        const target = targetFormat ?? (sourceFormat === 'legacy' ? 'native' : 'legacy');
        const directory = path.dirname(selected.fsPath);
        const assertSaved = () => {
            const affected = new Set(['scen.yaml', 'meta.yaml', 'scen.feature', 'scen.yaml.kot.yml', 'meta.yaml.kot.yml'].map(file => path.join(directory, file)));
            if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && affected.has(document.uri.fsPath))) {
                throw new Error(vscode.l10n.t('Save the SPPR scenario, script and metadata before converting its format.'));
            }
        };
        await waitForProjectLibraryIdle();
        const destination = await convertSpprScenarioFiles(selected.fsPath, target, assertSaved);
        const editorUri = target === 'native' ? vscode.Uri.file(path.join(directory, 'scen.feature')) : vscode.Uri.file(destination);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(editorUri), { preview: false });
        // Opening Properties here would wait on the action queue that called this conversion.
        await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcher', {
            refreshCache: true,
            changedSourceUris: sourceFormat === target ? [] : ['scen.yaml', 'meta.yaml', 'scen.feature'].map(file => vscode.Uri.file(path.join(directory, file)).toString())
        });
        if (!silent) { void vscode.window.showInformationMessage(vscode.l10n.t('SPPR scenario format converted successfully.')); }
        const oldUri = vscode.Uri.file(path.join(directory, sourceFormat === 'legacy' ? 'scen.yaml' : 'meta.yaml')).toString();
        const newUri = vscode.Uri.file(destination).toString();
        return { sourceUri: newUri, uriMoves: [{ oldUri, newUri }, { oldUri: oldUri + '.kot.yml', newUri: newUri + '.kot.yml' }] };
    } catch (error) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not convert SPPR scenario format: {0}', error instanceof Error ? error.message : String(error)));
    }
}
