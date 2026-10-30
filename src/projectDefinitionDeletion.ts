import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getTranslator } from './localization';
import { scanWorkspaceForScenarioCatalog } from './workspaceScanner';
import { resolveProcessScanRootFsPath } from './scenarioScanRoot';
import { collectDisabledProcessSettingsFiles } from './compilerProcessSelection';
import { parseScenarioDescriptor, parseTestInfoFromScenarioSource } from './scenarioDescriptor';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { parseExportScenarios, type ExportScenarioParseContext } from './exportScenarioParser';
import { scanCompilerLines } from './scenarioCompilerSyntax';
import type { ScenarioTarget } from './scenarioIdentity';
import { buildScenarioCatalog, type ScenarioCatalog } from './scenarioCatalog';
import type { TestInfo } from './types';
import type { ProjectDefinition, ProjectDefinitionLocation, ProjectDefinitionRange } from './projectDefinition';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ProjectDefinitionReferenceService } from './projectDefinitionReferences';
import { projectedProjectScenario, projectLibraryEnvironment } from './projectLibraryIntegration';
import { resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { parseProjectMetadataSidecar, type ProjectEntityIdentity } from './projectLibraryStore';

const t = (message: string, ...args: string[]): string => vscode.l10n.t(message, ...args);
interface DeleteResource { readonly uri: vscode.Uri; readonly recursive: boolean }
export interface ScenarioDefinitionDeletionResult {
    readonly scenario: TestInfo;
    readonly deletedUris: readonly vscode.Uri[];
}
export interface DefinitionDeletionReferenceServices {
    readonly resolver: Pick<ProjectDefinitionResolver, 'getView'>;
    readonly references: Pick<ProjectDefinitionReferenceService, 'findReferencesForDefinitions'>;
}
interface SavedSource { readonly uri: vscode.Uri; readonly text: string; readonly version?: number }

function within(candidate: string, directory: string): boolean {
    const relative = path.relative(directory, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function checkDirty(resources: readonly DeleteResource[]): void {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
        && resources.some(resource => resource.recursive ? within(document.uri.fsPath, resource.uri.fsPath)
            : document.uri.toString() === resource.uri.toString()))) {
        throw new Error(t('Save modified files before deleting definitions.'));
    }
}
async function readSource(uri: vscode.Uri): Promise<SavedSource> {
    checkDirty([{ uri, recursive: false }]);
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
    const version = document?.version;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    checkDirty([{ uri, recursive: false }]);
    if (document && (document.version !== version || document.getText() !== text)) {
        throw new Error(t('The source changed while deleting. Please retry.'));
    }
    return { uri, text, version };
}
async function checkSource(source: SavedSource): Promise<void> {
    const current = await readSource(source.uri);
    if (current.text !== source.text || source.version !== undefined && current.version !== source.version) {
        throw new Error(t('The source changed while deleting. Please retry.'));
    }
}
async function readBoundMetadata(source: vscode.Uri, kind: ProjectEntityIdentity['kind'], uid?: string): Promise<SavedSource | undefined> {
    const uri = vscode.Uri.file(`${source.fsPath}.kot.yml`);
    checkDirty([{ uri, recursive: false }]);
    const stat = await fs.lstat(uri.fsPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
        throw error;
    });
    if (!stat) { return undefined; }
    if (!stat.isFile()) { throw new Error(`Project metadata must be a regular file: ${uri.fsPath}`); }
    const saved = await readSource(uri);
    const environment = projectLibraryEnvironment();
    const root = environment.workspaceRoots.length || environment.scanRoots.length
        ? resolveProjectLibraryRoot(source.fsPath, environment.workspaceRoots, environment.scanRoots) : path.dirname(source.fsPath);
    const { identity } = parseProjectMetadataSidecar(saved.text, uri.fsPath, root);
    if (identity.kind !== kind || (identity.uid ?? '') !== (uid?.trim().toLowerCase() ?? '')) {
        throw new Error(`Project metadata identity does not match its source: ${uri.fsPath}`);
    }
    return saved;
}
function sameResources(left: readonly DeleteResource[], right: readonly DeleteResource[]): boolean {
    return left.length === right.length && left.every((item, index) => item.uri.toString() === right[index].uri.toString()
        && item.recursive === right[index].recursive);
}
async function fingerprint(resources: readonly DeleteResource[]): Promise<string> {
    checkDirty(resources);
    const hash = createHash('sha256');
    const visit = async (file: string): Promise<void> => {
        const stat = await fs.lstat(file);
        hash.update(file).update('\0');
        if (stat.isSymbolicLink()) { hash.update('link:').update(await fs.readlink(file)); }
        else if (stat.isDirectory()) {
            hash.update('directory:');
            for (const entry of (await fs.readdir(file)).sort()) { await visit(path.join(file, entry)); }
        } else { hash.update(await fs.readFile(file)); }
        hash.update('\0');
    };
    for (const resource of resources) { await visit(resource.uri.fsPath); }
    checkDirty(resources);
    return hash.digest('hex');
}

function callersOutsideDeletion(catalog: ScenarioCatalog, scenario: TestInfo, resources: readonly DeleteResource[]): TestInfo[] {
    const removed = (info: TestInfo) => resources.some(resource => resource.recursive
        ? within(info.yamlFileUri.fsPath, resource.uri.fsPath) : info.yamlFileUri.toString() === resource.uri.toString());
    const targets = catalog.all.filter(removed);
    const called = (caller: TestInfo, target: TestInfo): boolean => caller.kind === 'process'
        ? (caller.processSteps ?? []).some(step => {
            const process = target.kind === 'process';
            if (step.type !== (process ? 'process' : 'scenario')) { return false; }
            const uid = process ? step.processUid : step.scenarioUid;
            return uid?.trim() ? uid.trim().toLowerCase() === target.uid?.trim().toLowerCase()
                : (process ? step.processName : step.scenarioName)?.trim() === target.name;
        })
        : target.kind !== 'process' && (caller.nestedScenarioNames ?? []).includes(target.name);
    if (!targets.some(target => target.yamlFileUri.toString() === scenario.yamlFileUri.toString())) {
        throw new Error(t('Scenario was not found or its file identity is stale.'));
    }
    return catalog.all.filter(caller => !removed(caller) && targets.some(target => called(caller, target)));
}

/** Delete the exact catalog definition. Processes never own their containing directory. */
export async function deleteScenarioDefinition(
    context: vscode.ExtensionContext, target: ScenarioTarget, referenceServices?: DefinitionDeletionReferenceServices
): Promise<ScenarioDefinitionDeletionResult | undefined> {
    const translate = await getTranslator(context.extensionUri);
    if (!target.uri) { throw new Error(translate('Choose an exact definition file to delete.')); }
    const uri = vscode.Uri.parse(target.uri);
    if (uri.scheme !== 'file') { throw new Error(translate('Choose an exact definition file to delete.')); }
    const workspace = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspace) { throw new Error(translate('Open a workspace to delete definitions.')); }
    const prepare = async () => {
        let catalog = await scanWorkspaceForScenarioCatalog(workspace.uri);
        const openSources = new Map(catalog.byUri);
        for (const document of vscode.workspace.textDocuments) {
            if (!document.isDirty || document.uri.scheme !== 'file' || !catalog.byUri.has(document.uri.toString())) { continue; }
            // Saved scans cannot see new calls in unsaved editor buffers.
            try { ScenarioYamlDocument.parse(document.getText()).requireValidForEdit(); }
            catch { throw new Error(translate('Save modified files before deleting definitions.')); }
            const projected = projectedProjectScenario(document);
            const info = projected ? { ...projected, relativePath: catalog.byUri.get(document.uri.toString())!.relativePath }
                : parseTestInfoFromScenarioSource(document.getText(), document.uri, catalog.byUri.get(document.uri.toString())!.relativePath);
            if (info) { openSources.set(document.uri.toString(), info); }
        }
        catalog = buildScenarioCatalog([...openSources.values()]);
        const scenario = catalog.byUri.get(target.uri!);
        if (!scenario || scenario.name !== target.name.trim()) { throw new Error(translate('Scenario was not found or its file identity is stale.')); }
        const source = await readSource(uri);
        ScenarioYamlDocument.parse(source.text).requireValidForEdit();
        const descriptor = parseScenarioDescriptor(source.text);
        if (descriptor.name !== scenario.name || descriptor.uid !== scenario.uid || (descriptor.kind === 'process') !== (scenario.kind === 'process')) {
            throw new Error(translate('The source changed while deleting. Please retry.'));
        }
        const resources: DeleteResource[] = [];
        if (scenario.kind === 'process') {
            if (!scenario.uid || catalog.all.filter(item => item.kind === 'process'
                && item.uid?.trim().toLowerCase() === scenario.uid!.trim().toLowerCase()).length !== 1) {
                throw new Error(translate('Process UID is missing or ambiguous in the workspace.'));
            }
            resources.push({ uri, recursive: false });
            const roots = new Set([resolveProcessScanRootFsPath(workspace.uri), path.dirname(uri.fsPath)]);
            const settings = new Set<string>();
            for (const root of roots) {
                for (const setting of await collectDisabledProcessSettingsFiles(root, [{ uid: scenario.uid, name: scenario.name }])) { settings.add(setting.filePath); }
            }
            resources.push(...[...settings].sort().map(file => ({ uri: vscode.Uri.file(file), recursive: false })));
        } else if (scenario.tabName?.trim()) {
            const directory = path.dirname(uri.fsPath);
            if (!['scen.yaml', 'meta.yaml'].includes(path.basename(uri.fsPath).toLowerCase()) || path.resolve(directory) === path.resolve(workspace.uri.fsPath)) {
                throw new Error(translate('Choose a main scenario descriptor in its own folder.'));
            }
            resources.push({ uri: vscode.Uri.file(directory), recursive: true });
        } else {
            resources.push({ uri, recursive: false });
            if (path.basename(uri.fsPath).toLowerCase() === 'meta.yaml') {
                const directory = path.dirname(uri.fsPath);
                const script = path.join(directory, 'scen.feature');
                const exists = await fs.lstat(script).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
                });
                if (exists) { resources.push({ uri: vscode.Uri.file(script), recursive: false }); }
                // Do not leave SPPR's same-identity metadata backup discoverable after deleting its descriptor.
                const original = path.join(directory, 'orig.yaml');
                const originalText = await fs.readFile(original, 'utf8').catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
                });
                if (originalText && descriptor.uid && parseScenarioDescriptor(originalText).uid === descriptor.uid) {
                    resources.push({ uri: vscode.Uri.file(original), recursive: false });
                }
            }
        }
        const metadata = await readBoundMetadata(uri, scenario.kind === 'process' ? 'process' : 'scenario', scenario.uid);
        if (metadata && !resources.some(resource => resource.recursive && within(metadata.uri.fsPath, resource.uri.fsPath))) {
            resources.push({ uri: metadata.uri, recursive: false });
        }
        checkDirty(resources);
        const callers = callersOutsideDeletion(catalog, scenario, resources);
        if (callers.length) { throw new Error(translate('The definition is referenced by other scenarios. Remove these calls before deleting: {0}',
            callers.map(caller => caller.relativePath || caller.yamlFileUri.fsPath).join('\n'))); }
        if (referenceServices) {
            const view = await referenceServices.resolver.getView(uri);
            const definitionIds = view.all.filter(definition => definition.kind === 'nestedScenario' && definition.definitionLocation
                && resources.some(resource => resource.recursive
                    ? within(vscode.Uri.parse(definition.definitionLocation!.uri).fsPath, resource.uri.fsPath)
                    : definition.definitionLocation!.uri === resource.uri.toString())).map(definition => definition.id);
            if (definitionIds.length) {
                // A strict saved scan proves coverage; a second scan also sees unsaved caller buffers.
                const saved = await referenceServices.references.findReferencesForDefinitions(definitionIds, uri,
                    { includeDeclaration: false, failOnScanError: true }, { isCancellationRequested: false });
                const open = await referenceServices.references.findReferencesForDefinitions(definitionIds, uri,
                    { includeDeclaration: false }, { isCancellationRequested: false });
                const callers = [...saved.values(), ...open.values()].flat().filter(location => !resources.some(resource => resource.recursive
                    ? within(location.uri.fsPath, resource.uri.fsPath) : location.uri.toString() === resource.uri.toString()));
                if (callers.length) { throw new Error(translate('The definition is referenced by other scenarios. Remove these calls before deleting: {0}',
                    [...new Set(callers.map(location => location.uri.fsPath))].join('\n'))); }
            }
        }
        return { scenario, resources, source, metadata, fingerprint: await fingerprint(resources) };
    };
    const plan = await prepare();
    const choice = await vscode.window.showWarningMessage(translate('Delete definition "{0}"?', plan.scenario.name), {
        modal: true, detail: translate('These files and folders will be moved to the trash:\n{0}', plan.resources.map(item => item.uri.fsPath).join('\n'))
    }, { title: translate('Delete') });
    if (!choice) { return undefined; }
    const current = await prepare();
    if (current.fingerprint !== plan.fingerprint || !sameResources(current.resources, plan.resources)) {
        throw new Error(translate('The source changed while deleting. Please retry.'));
    }
    await checkSource(plan.source);
    if (plan.metadata) { await checkSource(plan.metadata); }
    checkDirty(plan.resources);
    for (const resource of plan.resources) { await vscode.workspace.fs.delete(resource.uri, { recursive: resource.recursive, useTrash: true }); }
    return { scenario: plan.scenario, deletedUris: plan.resources.map(item => item.uri) };
}

interface FeatureDeletionPlan {
    readonly before: string;
    readonly after: string;
    readonly definition: ProjectDefinition;
    readonly range: ProjectDefinitionRange;
}

/** Include the selected scenario's preamble, while preserving the next scenario's tags. */
export function planExportScenarioDeletion(
    source: ExportScenarioParseContext & { readonly text: string }, definitionId: string
): FeatureDeletionPlan {
    const parsed = parseExportScenarios(source.text, source);
    const declaration = parsed.scenarios.find(item => item.definitionId === definitionId);
    const definition = parsed.definitions.find(item => item.id === definitionId);
    if (!declaration || !definition || parsed.warnings.some(warning => /syntax|parse/iu.test(warning.message))) {
        throw new Error('The exported scenario changed. Please retry.');
    }
    const parts = source.text.split(/(\r\n|\r|\n)/u);
    const lines = parts.filter((_, index) => index % 2 === 0);
    const offset = (line: number): number => parts.slice(0, line * 2).reduce((length, part) => length + part.length, 0);
    const preamble = (line: number) => {
        let start = line;
        while (start > 0 && /^(?:\s*|\s*(?:@|#|\/\/).*)$/u.test(lines[start - 1])) { start--; }
        return start;
    };
    const startLine = preamble(declaration.declarationRange.start.line);
    const endPosition = declaration.declarationRange.end;
    const scanned = scanCompilerLines(lines);
    let boundaryLine = endPosition.line;
    for (let line = declaration.declarationRange.start.line + 1; line < boundaryLine; line++) {
        if (scanned[line].kind === 'code' && /^\s*(?:Rule|Правило|Variables|Hyperlinks|Links|Переменные|Гиперссылки|Ссылки)\s*:/iu.test(lines[line])) {
            boundaryLine = line;
        }
    }
    const endsAtEof = boundaryLine === lines.length - 1;
    const endLine = endsAtEof ? boundaryLine : preamble(boundaryLine);
    const start = offset(startLine);
    const end = endsAtEof ? source.text.length : offset(endLine);
    return {
        before: source.text, after: source.text.slice(0, start) + source.text.slice(end), definition,
        range: { start: { line: startLine, character: 0 }, end: endsAtEof
            ? { line: endPosition.line, character: lines[endPosition.line].length } : { line: endLine, character: 0 } }
    };
}

function sameLocation(left: ProjectDefinitionLocation, right: ProjectDefinitionLocation): boolean {
    return left.uri === right.uri && left.range.start.line === right.range.start.line
        && left.range.start.character === right.range.start.character && left.range.end.line === right.range.end.line
        && left.range.end.character === right.range.end.character;
}

/** A built-in or EPF-backed step cannot reach this local .feature mutation. */
export async function deleteExportScenario(
    definitionId: string, resource: vscode.Uri | undefined,
    resolver: ProjectDefinitionResolver, references: ProjectDefinitionReferenceService,
    capturedLocation?: ProjectDefinitionLocation
): Promise<boolean> {
    const view = await resolver.getView(resource);
    const definition = view.byId.get(definitionId);
    if (definition?.kind !== 'exportScenario' || !definition.definitionLocation) { return false; }
    if (capturedLocation && !sameLocation(capturedLocation, definition.definitionLocation)) { throw new Error(t('The exported scenario changed. Please retry.')); }
    const uri = vscode.Uri.parse(definition.definitionLocation.uri);
    if (uri.scheme !== 'file' || !/\.feature$/iu.test(uri.fsPath)) { return false; }
    const source = await readSource(uri);
    const plan = planExportScenarioDeletion({ text: source.text, sourceUri: uri.toString(),
        workspaceFolderUri: definition.workspaceFolderUri ?? '', profileId: definition.profileId ?? '',
        libraryRootUri: definition.libraryRootUri ?? '', sourceLabel: definition.sourceLabel, defaultLanguage: definition.language ?? 'ru' }, definitionId);
    const checkReferences = async () => {
        const saved = await references.findReferences(definitionId, resource ?? uri,
            { includeDeclaration: false, failOnScanError: true }, { isCancellationRequested: false });
        const open = await references.findReferences(definitionId, resource ?? uri,
            { includeDeclaration: false }, { isCancellationRequested: false });
        const found = [...saved, ...open];
        if (found.some(location => location.uri.toString() !== uri.toString()
            || location.range.start.line < plan.range.start.line || location.range.end.line >= plan.range.end.line)) {
            throw new Error(t('The definition is referenced by other scenarios. Remove these calls before deleting: {0}',
                [...new Set(found.map(location => location.uri.fsPath))].join('\n')));
        }
    };
    await checkReferences();
    const choice = await vscode.window.showWarningMessage(t('Delete definition "{0}"?', definition.template), {
        modal: true, detail: t('Only the selected scenario block will be removed. Other scenarios in this feature will be kept.')
    }, { title: t('Delete') });
    if (!choice) { return false; }
    const current = (await resolver.getView(resource)).byId.get(definitionId);
    if (!current?.definitionLocation || !sameLocation(current.definitionLocation, definition.definitionLocation)) {
        throw new Error(t('The exported scenario changed. Please retry.'));
    }
    await checkReferences();
    await checkSource(source);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty || document.getText() !== source.text) { throw new Error(t('The source changed while deleting. Please retry.')); }
    const edit = new vscode.WorkspaceEdit();
    edit.delete(uri, new vscode.Range(plan.range.start.line, plan.range.start.character, plan.range.end.line, plan.range.end.character));
    if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t('Unable to delete the selected scenario.')); }
    if (!await document.save()) { throw new Error(t('Unable to save the feature after deleting the scenario.')); }
    return true;
}

export async function deleteStandaloneFeature(uri: vscode.Uri, expectedTitle?: string): Promise<boolean> {
    if (uri.scheme !== 'file' || !/\.feature$/iu.test(uri.fsPath)) { return false; }
    const prepare = async () => {
        const source = await readSource(uri);
        const parsed = parseExportScenarios(source.text, { sourceUri: uri.toString(), workspaceFolderUri: '', profileId: '', libraryRootUri: '',
            sourceLabel: '', defaultLanguage: /^\s*(?:Feature|Functionality|Ability|Business Need)\s*:/imu.test(source.text) ? 'en' : 'ru' });
        if (!parsed.feature || parsed.feature.hasExportTag || parsed.scenarios.some(scenario => scenario.exported)
            || expectedTitle !== undefined && parsed.feature.title !== expectedTitle) { throw new Error(t('The feature changed. Please retry.')); }
        const metadata = await readBoundMetadata(uri, 'feature');
        const resources: DeleteResource[] = [{ uri, recursive: false }, ...(metadata ? [{ uri: metadata.uri, recursive: false }] : [])];
        return { source, metadata, resources, title: parsed.feature.title, fingerprint: await fingerprint(resources) };
    };
    const plan = await prepare();
    const choice = await vscode.window.showWarningMessage(t('Delete definition "{0}"?', plan.title), {
        modal: true, detail: t('These files and folders will be moved to the trash:\n{0}', plan.resources.map(resource => resource.uri.fsPath).join('\n'))
    }, { title: t('Delete') });
    if (!choice) { return false; }
    const current = await prepare();
    if (current.fingerprint !== plan.fingerprint || !sameResources(current.resources, plan.resources)) {
        throw new Error(t('The source changed while deleting. Please retry.'));
    }
    await checkSource(plan.source);
    if (plan.metadata) { await checkSource(plan.metadata); }
    checkDirty(plan.resources);
    for (const resource of plan.resources) { await vscode.workspace.fs.delete(resource.uri, { recursive: resource.recursive, useTrash: true }); }
    return true;
}
