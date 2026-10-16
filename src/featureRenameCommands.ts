import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseExportScenarios } from './exportScenarioParser';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';
import { planFeatureTitleRename, planExportScenarioRename, renameExportScenarioInvocation, normalizeFeatureRenameFilename } from './featureRename';
import { compileProjectDefinitionMatcher } from './projectDefinitionMatcher';
import { applyPreparedFileWrites } from './preparedFileWrites';
import { createProjectDefinitionView, normalizeProjectDefinitionTemplate, type ProjectDefinition } from './projectDefinition';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ProjectDefinitionReferenceService } from './projectDefinitionReferences';

interface Source { uri: vscode.Uri; text: string; document?: vscode.TextDocument; version?: number }
const t = (message: string): string => vscode.l10n.t(message);

async function readSource(uri: vscode.Uri): Promise<Source> {
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
    if (document?.isDirty) { throw new Error(t('Save modified files before renaming.')); }
    const version = document?.version;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    if (document && (document.isDirty || document.version !== version)) {
        throw new Error(t('The source changed while renaming. Please retry.'));
    }
    return { uri, text, document, version };
}

async function checkSources(sources: readonly Source[]): Promise<void> {
    for (const source of sources) {
        const current = await readSource(source.uri);
        if (current.text !== source.text || source.document && current.document === source.document && current.version !== source.version) {
            throw new Error(t('The source changed while renaming. Please retry.'));
        }
    }
}

function parseContext(uri: vscode.Uri, text: string, definition?: ProjectDefinition) {
    return {
        sourceUri: uri.toString(), workspaceFolderUri: definition?.workspaceFolderUri ?? '',
        profileId: definition?.profileId ?? '', libraryRootUri: definition?.libraryRootUri ?? '',
        sourceLabel: definition?.sourceLabel ?? '',
        defaultLanguage: definition?.language ?? parseStandaloneFeatureSource(text, path.basename(uri.fsPath)).language
    };
}

async function writePlans(plans: readonly { source: Source; after: string }[]): Promise<boolean> {
    await checkSources(plans.map(plan => plan.source));
    const count = await applyPreparedFileWrites(plans.map(plan => ({ key: plan.source.uri, before: plan.source.text, after: plan.after })),
        async (uri, text) => { await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8')); });
    return count > 0;
}

export async function renameStandaloneFeatureTitle(uri: vscode.Uri): Promise<boolean> {
    const source = await readSource(uri);
    const parsed = parseExportScenarios(source.text, parseContext(uri, source.text));
    if (!parsed.feature) { throw new Error(t('The feature declaration is no longer available.')); }
    const previous = parsed.feature.title;
    const answer = await vscode.window.showInputBox({
        title: t('Change feature title'), prompt: t('Feature title'), value: previous, ignoreFocusOut: true,
        validateInput: value => {
            try { planFeatureTitleRename(source.text, previous, value); return undefined; }
            catch (error) { return t((error as Error).message); }
        }
    });
    if (answer === undefined || answer.trim() === previous) { return false; }
    const plan = planFeatureTitleRename(source.text, previous, answer);
    return writePlans([{ source, after: plan.after }]);
}

export async function renameStandaloneFeatureFile(
    uri: vscode.Uri, beforeRename?: () => Promise<void>
): Promise<vscode.Uri | undefined> {
    const source = await readSource(uri);
    const answer = await vscode.window.showInputBox({
        title: t('Rename feature file'), prompt: t('Feature filename'), value: path.basename(uri.fsPath), ignoreFocusOut: true,
        validateInput: value => {
            try { normalizeFeatureRenameFilename(value); return undefined; }
            catch (error) { return t((error as Error).message); }
        }
    });
    if (answer === undefined) { return undefined; }
    const filename = normalizeFeatureRenameFilename(answer);
    if (filename === path.basename(uri.fsPath)) { return undefined; }
    const destination = vscode.Uri.joinPath(uri, '..', filename);
    try {
        await vscode.workspace.fs.stat(destination);
        throw new Error(t('A file with this name already exists.'));
    } catch (error) {
        if ((error as { code?: string }).code !== 'FileNotFound' && (error as { code?: string }).code !== 'ENOENT') { throw error; }
    }
    await checkSources([source]);
    await beforeRename?.();
    await checkSources([source]);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(uri, destination, { overwrite: false, ignoreIfExists: false });
    if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t('Unable to rename the feature file.')); }
    return destination;
}

export async function renameExportScenario(
    definitionId: string, resource: vscode.Uri | undefined,
    resolver: ProjectDefinitionResolver, references: ProjectDefinitionReferenceService
): Promise<boolean> {
    const view = await resolver.getView(resource);
    const definition = view.byId.get(definitionId);
    if (definition?.kind !== 'exportScenario' || !definition.definitionLocation) { return false; }
    const uri = vscode.Uri.parse(definition.definitionLocation.uri);
    const source = await readSource(uri);
    const context = parseContext(uri, source.text, definition);
    const validate = (value: string, currentView = view) => {
        const plan = planExportScenarioRename({ ...context, text: source.text }, definitionId, value);
        const candidate = { ...definition, template: value.trim(), normalizedTemplate: value.trim() };
        if (currentView.all.some(item => item.id !== definitionId
            && compileProjectDefinitionMatcher(candidate).match(item.template))) {
            throw new Error('A step or scenario with this name already exists.');
        }
        return plan;
    };
    const answer = await vscode.window.showInputBox({
        title: t('Rename export scenario'), prompt: t('Enter new scenario name'), value: definition.template, ignoreFocusOut: true,
        validateInput: value => { try { validate(value); return undefined; } catch (error) { return t((error as Error).message); } }
    });
    if (answer === undefined || answer.trim() === definition.template) { return false; }
    const currentView = await resolver.getView(resource);
    if (!currentView.byId.has(definitionId)) { throw new Error(t('The exported scenario changed. Please retry.')); }
    const plan = validate(answer, currentView);
    const renamedDefinition = {
        ...definition, template: answer.trim(), normalizedTemplate: normalizeProjectDefinitionTemplate(answer)
    };
    const proposedView = createProjectDefinitionView(`rename:${currentView.identity}`,
        currentView.all.map(item => item.id === definitionId ? renamedDefinition : item));
    const locations = await references.findReferences(definitionId, resource ?? uri,
        { includeDeclaration: false, failOnScanError: true }, { isCancellationRequested: false });
    const plans = new Map<string, { source: Source; after: string }>([[uri.toString(), { source, after: plan.after }]]);
    const handled = new Set<string>();
    for (const location of locations) {
        const key = location.uri.toString();
        const line = location.range.start.line;
        const referenceKey = `${key}\0${line}`;
        if (handled.has(referenceKey)) { continue; }
        handled.add(referenceKey);
        let target = plans.get(key);
        if (!target) {
            const referenceSource = await readSource(location.uri);
            target = { source: referenceSource, after: referenceSource.text };
            plans.set(key, target);
        }
        const invocation = target.source.text.split(/\r\n|\r|\n/u)[line];
        if (invocation === undefined) { throw new Error(t('The source changed while renaming. Please retry.')); }
        const resolution = await resolver.resolve(location.uri, invocation, currentView);
        if (resolution.kind !== 'unique' || resolution.match.definition.id !== definitionId) {
            throw new Error(t('A scenario call is ambiguous or changed. Rename was cancelled.'));
        }
        const updated = renameExportScenarioInvocation(definition, answer.trim(), invocation);
        if (updated === null) { throw new Error(t('The source changed while renaming. Please retry.')); }
        const proposedResolution = await resolver.resolve(location.uri, updated, proposedView);
        if (proposedResolution.kind !== 'unique' || proposedResolution.match.definition.id !== definitionId) {
            throw new Error(t('A scenario call is ambiguous or changed. Rename was cancelled.'));
        }
        const parts = target.after.split(/(\r\n|\r|\n)/u);
        parts[line * 2] = updated;
        target.after = parts.join('');
    }
    return writePlans([...plans.values()]);
}
