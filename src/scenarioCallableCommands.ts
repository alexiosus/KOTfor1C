import { permitsNativeScenario, assertProjectFormat3, projectFormatRoot } from './projectFormat';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseDocument } from 'yaml';
import { nestedExportDraft, nestedToExport, appendConvertedExport, exportToNested, rewriteCallableCall, validateCallableName, validateNestedExportTitle, callableConversionErrorText, stringifyCallableMetadata, type CallableParameter } from './scenarioCallableConversion';
import { applyCallableFileConversion, type CallableFileChange } from './scenarioCallableFiles';
import { resolveScenarioSourceUris } from './spprScenarioFiles';
import { joinNativeSpprScenario, splitLegacySpprScenario } from './spprScenarioFormat';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import { scanCompilerLines } from './scenarioCompilerSyntax';
import { compileProjectDefinitionMatcher } from './projectDefinitionMatcher';
import { createProjectDefinitionView, sameProjectDefinitionSource, type ProjectDefinition } from './projectDefinition';
import { readScenarioProperties, addScenarioPropertyRecord, removeScenarioPropertyRecord } from './scenarioPropertiesModel';
import { getNewScenarioDefaults } from './scenarioCreator';
import { waitForProjectLibraryIdle } from './projectLibraryStore';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import type { ScenarioCatalog } from './scenarioCatalog';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ProjectDefinitionReferenceService } from './projectDefinitionReferences';
import type { ExportScenarioLibraryRoot } from './exportScenarioCommand';

export interface CallableConversionServices {
    resolver: ProjectDefinitionResolver;
    references: ProjectDefinitionReferenceService;
    catalog(): ScenarioCatalog | null | undefined;
    loadLibraryRoots(resource: string): Promise<readonly ExportScenarioLibraryRoot[]>;
    listLibraryFeatureUris?(resource: string): Promise<readonly string[]>;
    withLibraryFolder(resource: string, folder: string, operation: () => Promise<void>): Promise<void>;
    scenarioRoots?(): readonly string[];
    sourceForGenerated?(uri: vscode.Uri): Promise<vscode.Uri | undefined>;
    refresh(changedSourceUris?: readonly vscode.Uri[]): Promise<void>;
}
const t = (message: string, ...args: string[]): string => vscode.l10n.t(message, ...args);
const within = (file: string, root: string): boolean => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const convertedDocuments = new WeakMap<vscode.TextDocument, { version: number; documentText: string; diskText: string | undefined }>();
function documentMatchesConversion(document: vscode.TextDocument, diskText: string | undefined): boolean {
    if (diskText !== undefined && nativeDocumentTextMatchesFileText(document.getText(), diskText)) { return true; }
    const previous = convertedDocuments.get(document);
    return !!previous && previous.version === document.version && previous.documentText === document.getText() && previous.diskText === diskText;
}

async function chooseExistingFeature(services: CallableConversionServices, resource: vscode.Uri, roots: readonly ExportScenarioLibraryRoot[], base: string): Promise<vscode.Uri | undefined> {
    const choices: Array<vscode.QuickPickItem & { targetKind: 'library' | 'browse'; uri?: vscode.Uri }> = [];
    const seen = new Set<string>();
    for (const value of await services.listLibraryFeatureUris?.(resource.toString()) ?? []) {
        const uri = vscode.Uri.parse(value);
        if (uri.scheme !== 'file' || !/\.feature$/iu.test(uri.fsPath) || /[\\/](?:kot-runtime|\.kot)[\\/]/iu.test(uri.fsPath)) { continue; }
        const root = roots.find(root => within(uri.fsPath, vscode.Uri.parse(root.uri).fsPath));
        if (!root) { continue; }
        const key = /^[a-z]:[\\/]|^\\\\/iu.test(uri.fsPath) ? uri.fsPath.toLowerCase() : uri.fsPath;
        if (seen.has(key)) { continue; } seen.add(key);
        if (await resolveScenarioSourceUris(uri) || await services.sourceForGenerated?.(uri)) { continue; }
        choices.push({ targetKind: 'library', uri, label: path.basename(uri.fsPath),
            description: path.relative(vscode.Uri.parse(root.uri).fsPath, uri.fsPath), detail: root.label || vscode.Uri.parse(root.uri).fsPath });
    }
    choices.sort((left, right) => left.label.localeCompare(right.label) || (left.description ?? '').localeCompare(right.description ?? ''));
    choices.push({ targetKind: 'browse', label: `$(folder-opened) ${t('Choose another feature file…')}` });
    const selected = await vscode.window.showQuickPick(choices, { title: t('Existing feature file'),
        placeHolder: t('Select a library feature or choose another file'), matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
    if (!selected) { return; }
    return selected.targetKind === 'library' ? selected.uri : (await vscode.window.showOpenDialog({ title: t('Existing feature file'),
        defaultUri: vscode.Uri.file(base), canSelectMany: false, canSelectFolders: false, filters: { Feature: ['feature'] } }))?.[0];
}
interface Archive { version: 1; title: string; source: string; format: 'legacy' | 'native'; sidecar?: string; originalFolder?: string }
function readArchives(text: string | undefined): Archive[] {
    if (text === undefined) { return []; }
    const data = JSON.parse(text);
    const entries: Archive[] = data?.version === 2 && Array.isArray(data.scenarios) ? data.scenarios : [data];
    if (entries.some(item => !item || item.version !== 1 || typeof item.title !== 'string' || typeof item.source !== 'string'
        || !['legacy', 'native'].includes(item.format) || item.sidecar !== undefined && typeof item.sidecar !== 'string'
        || item.originalFolder !== undefined && typeof item.originalFolder !== 'string')
        || new Set(entries.map(item => item.title)).size !== entries.length) {
        throw new Error('The export signature differs from its archived nested scenario. Review the archive before conversion.');
    }
    return entries;
}
function writeArchives(archives: readonly Archive[]): string | undefined {
    return archives.length ? JSON.stringify(archives.length === 1 ? archives[0] : { version: 2, scenarios: archives }, null, 2) + '\n' : undefined;
}

/** One adapter for editor/Properties/Library. Every dialog completes before any file is changed. */
export async function handleConvertCallableScenario(services: CallableConversionServices, selected?: vscode.Uri, selectedLine?: number): Promise<{ sourceUri: string } | undefined> {
    try {
        const target = selected ?? vscode.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== 'file') { throw new Error(t('Choose a local nested or exported scenario.')); }
        const originals = new Map<string, string>();
        const outputs = new Map<string, string | undefined>();
        const saved = async (uri: vscode.Uri): Promise<string> => {
            const open = vscode.workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === uri.toString());
            if (open?.isDirty) { throw new Error(t('Save modified files before converting scenarios.')); }
            const text = await fs.readFile(uri.fsPath, 'utf8');
            if (open && (open.isDirty || !documentMatchesConversion(open, text))) { throw new Error(t('The source changed. Retry the conversion.')); }
            if (originals.has(uri.fsPath) && originals.get(uri.fsPath) !== text) {
                throw new Error(t('The source changed. Retry the conversion.'));
            }
            originals.set(uri.fsPath, text);
            return text;
        };
        const savedOptional = async (file: string): Promise<string | undefined> => {
            try { return await saved(vscode.Uri.file(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
        };
        const assertSaved = async () => {
            const affected = new Set([...originals.keys(), ...outputs.keys()].map(file => vscode.Uri.file(file).toString()));
            if (vscode.workspace.textDocuments.some(document => !document.isClosed && affected.has(document.uri.toString())
                && (document.isDirty || ![originals.get(document.uri.fsPath), outputs.get(document.uri.fsPath)]
                    .some(text => documentMatchesConversion(document, text))))) {
                throw new Error(t('The source changed. Retry the conversion.'));
            }
        };
        const pair = await resolveScenarioSourceUris(target);
        const uri = pair?.metadataUri ?? target;
        const view = await services.resolver.ensureReady(uri);
        const expandNestedCalls = async (source: string, resource: vscode.Uri, ancestors: ReadonlySet<string>): Promise<string> => {
            const { metadata, script } = splitLegacySpprScenario(source);
            const lines = script.split(/\r\n|\n/u); const scanned = scanCompilerLines(lines); const expanded: string[] = [];
            for (const [index, line] of lines.entries()) {
                if (scanned[index].kind !== 'code') { expanded.push(line); continue; }
                const resolution = await services.resolver.resolve(resource, line, view);
                if (resolution.kind === 'ambiguous') { throw new Error(t('A scenario call is ambiguous or changed. Conversion was cancelled.')); }
                if (resolution.kind !== 'unique' || resolution.match.definition.kind !== 'nestedScenario') { expanded.push(line); continue; }
                const location = resolution.match.definition.definitionLocation;
                if (!location) { throw new Error(t('The source changed. Retry the conversion.')); }
                const nestedUri = vscode.Uri.parse(location.uri);
                if (ancestors.has(location.uri) || ancestors.size >= 32) { throw new Error(t('Cyclic or excessively deep nested scenario calls cannot be exported.')); }
                const nestedPair = await resolveScenarioSourceUris(nestedUri);
                if (!nestedPair) { throw new Error(t('The source changed. Retry the conversion.')); }
                const nestedMetadata = await saved(nestedPair.metadataUri);
                const nestedSource = nestedPair.format === 'native' ? joinNativeSpprScenario(nestedMetadata, await saved(nestedPair.scriptUri)) : nestedMetadata;
                const language = /#\s*language\s*:\s*(ru|en)\b/iu.exec(script)?.[1]?.toLowerCase();
                const nestedLanguage = /#\s*language\s*:\s*(ru|en)\b/iu.exec(splitLegacySpprScenario(nestedSource).script)?.[1]?.toLowerCase();
                if (language && nestedLanguage && language !== nestedLanguage) { throw new Error(t('Use the same Gherkin language in nested scenarios before export conversion.')); }
                if (nestedExportDraft(nestedSource).parameters.length || resolution.match.definition.parameters.length) {
                    throw new Error(t('Expand parameterized nested calls before export conversion. Parameterless nested calls are expanded automatically.'));
                }
                const tags = parseDocument(nestedMetadata).toJS().ТегиСценария;
                if (Array.isArray(tags) && tags.length) { throw new Error(t('Move nested scenario tags into the caller before export conversion.')); }
                const files = await fs.readdir(path.join(path.dirname(nestedUri.fsPath), 'files')).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error;
                });
                if (files.length) { throw new Error(t('Nested scenario attachments require a compiler build before export conversion.')); }
                const child = await expandNestedCalls(nestedSource, nestedPair.metadataUri, new Set([...ancestors, location.uri]));
                const childLines = splitLegacySpprScenario(child).script.split(/\r\n|\n/u).filter(value => !/^\s*#\s*language\s*:/iu.test(value));
                while (childLines.length && !childLines[0].trim()) { childLines.shift(); }
                while (childLines.length && !childLines.at(-1)!.trim()) { childLines.pop(); }
                const width = Math.min(...childLines.filter(value => value.trim()).map(value => /^[ \t]*/u.exec(value)![0].length));
                const indent = /^[ \t]*/u.exec(line)![0];
                expanded.push(`${indent}# ${line.trim()}`, ...childLines.map(value => value.trim() ? indent + value.slice(width) : ''));
            }
            return joinNativeSpprScenario(metadata, expanded.join(source.includes('\r\n') ? '\r\n' : '\n'));
        };
        let definition: ProjectDefinition | undefined;
        let resultUri: vscode.Uri;
        let parameters: readonly CallableParameter[];
        let newTitle: string;
        let direction: 'export' | 'nested';
        let sourceUid: string;
        if (pair) {
            const metadata = await saved(uri);
            const source = pair.format === 'native' ? joinNativeSpprScenario(metadata, await saved(pair.scriptUri)) : metadata;
            const descriptor = parseScenarioDescriptor(source);
            definition = view.all.find(item => item.kind === 'nestedScenario' && sameProjectDefinitionSource(item.definitionLocation?.uri, uri.toString()));
            if (!definition || !descriptor.uid || descriptor.kind === 'process') { throw new Error(t('Only nested scenarios can be converted to exported scenarios.')); }
            const catalog = services.catalog();
            if (catalog?.all.some(item => item.uid?.toLowerCase() === descriptor.uid!.toLowerCase() && item.yamlFileUri.toString() !== uri.toString())) {
                throw new Error(t('The source UID is ambiguous. Resolve duplicate definitions before converting the test role.'));
            }
            if (catalog?.all.some(item => item.kind === 'process' && item.processSteps?.some(step => step.scenarioUid?.toLowerCase() === descriptor.uid!.toLowerCase()
                || !step.scenarioUid && step.scenarioName === descriptor.name))) {
                throw new Error(t('This scenario is used by a process. A process step cannot directly call an exported scenario.'));
            }
            const draft = nestedExportDraft(source);
            const answer = await vscode.window.showInputBox({ title: t('Convert to exported scenario'), value: draft.title,
                prompt: t('Keep every scenario parameter as a quoted argument in the name.'), ignoreFocusOut: true,
                validateInput: value => { try { validateNestedExportTitle(draft.parameters, value); return undefined; } catch (error) { return callableConversionErrorText(error, t); } } });
            if (answer === undefined) { return; }
            const expandedSource = await expandNestedCalls(source, uri, new Set([uri.toString()]));
            const converted = nestedToExport(expandedSource, answer); newTitle = answer.trim(); parameters = converted.parameters; direction = 'export'; sourceUid = descriptor.uid;
            const roots = await services.loadLibraryRoots(uri.toString());
            const sameFolder = roots.some(root => within(uri.fsPath, vscode.Uri.parse(root.uri).fsPath));
            const base = sameFolder || !roots.length ? path.dirname(uri.fsPath) : vscode.Uri.parse(roots[0].uri).fsPath;
            const name = (descriptor.scenarioCode || 'exports').replace(/[\\/:*?"<>|]/gu, '_');
            const choice = await vscode.window.showQuickPick([
                { label: t('New feature file'), mode: 'new' as const }, { label: t('Existing feature file'), mode: 'existing' as const }
            ], { title: t('Export destination'), ignoreFocusOut: true });
            if (!choice) { return; }
            const destination = choice.mode === 'new'
                ? await vscode.window.showSaveDialog({ title: t('Export scenario file'), defaultUri: vscode.Uri.file(path.join(base, `${name}.feature`)), filters: { Feature: ['feature'] } })
                : await chooseExistingFeature(services, uri, roots, base);
            if (!destination) { return; }
            if (destination.scheme !== 'file' || !/\.feature$/iu.test(destination.fsPath) || originals.has(destination.fsPath)) { throw new Error(t('Choose a new local .feature file for the export library.')); }
            if (path.dirname(destination.fsPath) !== path.dirname(uri.fsPath) && (await fs.readdir(path.join(path.dirname(uri.fsPath), 'files')).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error;
            })).length) { throw new Error(t('This scenario has attachments. Convert in the same folder to preserve file paths.')); }
            const sidecar = await savedOptional(uri.fsPath + '.kot.yml');
            const archive: Archive = { version: 1, title: newTitle, source, format: pair.format,
                originalFolder: path.relative(path.dirname(destination.fsPath), path.dirname(uri.fsPath)), ...(sidecar === undefined ? {} : { sidecar }) };
            outputs.set(uri.fsPath, undefined); if (pair.format === 'native') { outputs.set(pair.scriptUri.fsPath, undefined); }
            if (sidecar !== undefined) { outputs.set(uri.fsPath + '.kot.yml', undefined); }
            const archives = choice.mode === 'existing' ? readArchives(await savedOptional(destination.fsPath + '.kot-nested.json')) : [];
            if (archives.some(item => item.title === newTitle)) { throw new Error(t('A step or scenario with this name already exists.')); }
            const feature = choice.mode === 'existing' ? appendConvertedExport(await saved(destination), converted.feature) : converted.feature;
            outputs.set(destination.fsPath, feature); outputs.set(destination.fsPath + '.kot-nested.json', writeArchives([...archives, archive]));
            resultUri = destination;
        } else {
            const feature = await saved(uri);
            const choices = view.all.filter(item => item.kind === 'exportScenario' && sameProjectDefinitionSource(item.definitionLocation?.uri, uri.toString()));
            if (!choices.length) { throw new Error(t('Choose an exported scenario declaration.')); }
            const line = selectedLine ?? (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString() ? vscode.window.activeTextEditor.selection.active.line : undefined);
            definition = choices.find(item => item.definitionLocation?.range.start.line === line);
            if (!definition) { definition = choices.length === 1 ? choices[0] : (await vscode.window.showQuickPick(choices.map(item => ({ label: item.template, definition: item })), { title: t('Choose exported scenario'), ignoreFocusOut: true }))?.definition; }
            if (!definition) { return; }
            const archiveText = await savedOptional(uri.fsPath + '.kot-nested.json');
            const archives = readArchives(archiveText);
            const archive = archives.find(item => item.title === definition!.template) ?? (choices.length === 1 && archives.length === 1 ? archives[0] : undefined);
            const answer = await vscode.window.showInputBox({ title: t('Convert to nested scenario'), value: archive ? parseScenarioDescriptor(archive.source).name : definition.template.replace(/(["']).*?\1/gu, '').replace(/\s+/gu, ' ').trim(),
                prompt: t('Enter nested scenario name'), ignoreFocusOut: true, validateInput: value => { try { validateCallableName(value); return undefined; } catch (error) { return t((error as Error).message); } } });
            if (answer === undefined) { return; }
            const converted = exportToNested(feature, definition.definitionLocation!.range.start.line, answer, archive?.source);
            const roots = services.scenarioRoots?.() ?? [];
            const code = ((archive ? parseScenarioDescriptor(archive.source).scenarioCode : answer) || 'nested').replace(/[\\/:*?"<>|]/gu, '_');
            const previousFolder = archive?.originalFolder === undefined ? path.dirname(uri.fsPath) : path.resolve(path.dirname(uri.fsPath), archive.originalFolder);
            const folder = roots.length && !roots.some(root => within(previousFolder, root)) ? path.join(roots[0], code) : previousFolder;
            const preferredFormat = !permitsNativeScenario(folder) ? 'legacy' : archive?.format ?? vscode.workspace.getConfiguration('kotTestToolkit', uri).get<string>('newScenarioDefaults.format', 'native');
            const destination = await vscode.window.showSaveDialog({ title: t('Nested scenario file'), defaultUri: vscode.Uri.file(path.join(folder, preferredFormat === 'native' ? 'meta.yaml' : 'scen.yaml')), filters: { YAML: ['yaml'] } });
            if (!destination) { return; }
            if (destination.scheme !== 'file' || roots.length && !roots.some(root => within(destination.fsPath, root))) { throw new Error(t('Choose a destination inside a configured SPPR scenario folder.')); }
            if (!['scen.yaml', 'meta.yaml'].includes(path.basename(destination.fsPath))) { throw new Error(t('Choose scen.yaml or meta.yaml as the nested scenario filename.')); }
            let source = converted.source;
            if (!archive) {
                const defaults = getNewScenarioDefaults(vscode.workspace.getConfiguration('kotTestToolkit', destination));
                const yaml = parseDocument(splitLegacySpprScenario(source).metadata);
                const used = new Set((services.catalog()?.all ?? []).map(item => item.scenarioCode?.toLowerCase()).filter(Boolean));
                const baseCode = answer.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'nested'; let newCode = baseCode; let suffix = 2;
                while (used.has(newCode.toLowerCase())) { newCode = `${baseCode}_${suffix++}`; }
                for (const [key, value] of Object.entries({ Код: newCode, Проект: defaults.project,
                    ФункцияСистемы: defaults.systemFunctions[0].name, UIDФункцияСистемы: defaults.systemFunctions[0].uid,
                    РазрешеноИспользоватьВДругихФункциях: defaults.allowCrossFunctionUsage ? 'Да' : 'Нет', ПрофильПользователя: defaults.userProfile,
                    УровеньОтчета1: defaults.reportLevel1, УровеньОтчета2: defaults.nestedReportLevel2 })) { yaml.setIn(['ДанныеСценария', key], value); }
                source = joinNativeSpprScenario(stringifyCallableMetadata(yaml).replace(/\n/gu, source.includes('\r\n') ? '\r\n' : '\n'), splitLegacySpprScenario(source).script);
            }
            const uid = parseScenarioDescriptor(source).uid;
            if (!uid) { throw new Error(t('The converted scenario has no readable UID.')); }
            sourceUid = uid;
            if (services.catalog()?.all.some(item => item.uid?.toLowerCase() === sourceUid.toLowerCase())) { throw new Error(t('The nested scenario UID already exists. Resolve duplicate definitions before conversion.')); }
            if (services.catalog()?.all.some(item => item.name.trim().toLowerCase() === answer.trim().toLowerCase())) { throw new Error(t('A step or scenario with this name already exists.')); }
            parameters = converted.parameters; newTitle = answer.trim(); direction = 'nested';
            const native = path.basename(destination.fsPath) === 'meta.yaml';
            if (native) { assertProjectFormat3(projectFormatRoot(destination.fsPath)); }
            outputs.set(uri.fsPath, converted.remaining);
            outputs.set(destination.fsPath, native ? splitLegacySpprScenario(source).metadata : source);
            if (native) { outputs.set(path.join(path.dirname(destination.fsPath), 'scen.feature'), splitLegacySpprScenario(source).script); }
            if (archive?.sidecar) { outputs.set(destination.fsPath + '.kot.yml', archive.sidecar); }
            if (archive) { outputs.set(uri.fsPath + '.kot-nested.json', writeArchives(archives.filter(item => item !== archive))); }
            resultUri = native ? vscode.Uri.joinPath(destination, '..', 'scen.feature') : destination;
        }
        const proposed: ProjectDefinition = { ...definition, id: 'conversion-target', kind: direction === 'export' ? 'exportScenario' : 'nestedScenario', template: newTitle,
            parameters: direction === 'export' ? parameters.map((item, index) => ({ name: item.name, index, source: 'quoted' })) : [] };
        if (view.all.some(item => item.id !== definition!.id && (compileProjectDefinitionMatcher(item).match(newTitle) || compileProjectDefinitionMatcher(proposed).match(item.template)))) {
            throw new Error(t('A step or scenario with this name already exists.'));
        }
        const proposedView = createProjectDefinitionView('callable-conversion', [...view.all.filter(item => item.id !== definition!.id), proposed]);
        const locations = await services.references.findReferences(definition.id, uri, { includeDeclaration: false, failOnScanError: true }, { isCancellationRequested: false });
        const grouped = new Map<string, Set<number>>();
        const generated = new Map<string, boolean>();
        for (const location of locations) {
            const key = location.uri.toString();
            if (/\.feature$/iu.test(location.uri.fsPath)) {
                if (!generated.has(key)) { generated.set(key, /[\\/]kot-runtime[\\/]tests[\\/]/iu.test(location.uri.fsPath) || !!await services.sourceForGenerated?.(location.uri)); }
                if (generated.get(key)) { continue; }
            }
            const lines = grouped.get(key) ?? new Set<number>(); lines.add(location.range.start.line); grouped.set(key, lines);
        }
        for (const [key, lines] of grouped) {
            const caller = vscode.Uri.parse(key); const pair = await resolveScenarioSourceUris(caller);
            if (direction === 'nested' && (!pair || pair.format !== 'native' && !/ТипФайла:\s*["']?Сценарий/u.test(await saved(caller)))) {
                throw new Error(t('A standalone feature calls this export. Only SPPR scenarios can call a nested scenario.'));
            }
            let content = await saved(caller);
            if (outputs.has(caller.fsPath)) { throw new Error(t('Recursive or internal calls must be removed before conversion.')); }
            for (const line of [...lines].sort((a, b) => b - a)) {
                const invocation = content.split(/\r\n|\n/u)[line];
                const resolution = await services.resolver.resolve(caller, invocation, view);
                if (resolution.kind !== 'unique' || resolution.match.definition.id !== definition.id) { throw new Error(t('A scenario call is ambiguous or changed. Conversion was cancelled.')); }
                const rewritten = rewriteCallableCall(content, line, { direction, oldTitle: definition.template, title: newTitle, parameters });
                const rewrittenLine = rewritten.split(/\r\n|\n/u)[line];
                const next = await services.resolver.resolve(caller, rewrittenLine, proposedView);
                if (next.kind !== 'unique' || next.match.definition.id !== proposed.id) { throw new Error(t('A converted call would be ambiguous. Conversion was cancelled.')); }
                content = rewritten;
            }
            if (pair) {
                const metadataPath = pair.metadataUri.fsPath;
                const metadata = caller.fsPath === metadataPath ? content : await saved(pair.metadataUri);
                let updated = metadata;
                const existing = readScenarioProperties(metadata).sections.find(section => section.key === 'ВложенныеСценарии')?.records ?? [];
                if (direction === 'export') {
                    for (const record of existing.filter(item => item.fields.some(field => field.key === 'UIDВложенныйСценарий' && field.value.toLowerCase() === sourceUid.toLowerCase()))) {
                        updated = removeScenarioPropertyRecord(updated, { section: 'ВложенныеСценарии', recordKey: record.key });
                    }
                } else if (!existing.some(item => item.fields.some(field => field.key === 'UIDВложенныйСценарий' && field.value.toLowerCase() === sourceUid.toLowerCase()))) {
                    updated = addScenarioPropertyRecord(updated, { section: 'ВложенныеСценарии' }, { UIDВложенныйСценарий: sourceUid, ИмяСценария: newTitle });
                }
                if (metadataPath === caller.fsPath) { content = updated; } else { outputs.set(metadataPath, updated); }
            }
            outputs.set(caller.fsPath, content);
        }
        for (const file of originals.keys()) { if (!outputs.has(file)) { outputs.set(file, originals.get(file)); } }
        const changes: CallableFileChange[] = [...outputs].map(([file, after]) => ({ path: file, before: originals.get(file), after }));
        await waitForProjectLibraryIdle(); await assertSaved();
        const opened = vscode.workspace.textDocuments.filter(document => !document.isClosed && outputs.has(document.uri.fsPath))
            .map(document => ({ document, version: document.version, documentText: document.getText() }));
        const commit = () => applyCallableFileConversion(changes, assertSaved);
        if (direction === 'export') { await services.withLibraryFolder(uri.toString(), path.dirname(resultUri.fsPath), commit); }
        else { await commit(); }
        // Bind the exact model/version to our completed write, never to another writer's bytes.
        for (const snapshot of opened) {
            if (!snapshot.document.isClosed && !snapshot.document.isDirty && snapshot.document.version === snapshot.version
                && snapshot.document.getText() === snapshot.documentText) {
                convertedDocuments.set(snapshot.document, { version: snapshot.version, documentText: snapshot.documentText, diskText: outputs.get(snapshot.document.uri.fsPath) });
            }
        }
        await services.refresh(changes.filter(change => change.before !== change.after).map(change => vscode.Uri.file(change.path)));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(resultUri), { preview: false });
        void vscode.window.showInformationMessage(t('Scenario converted successfully. Existing calls were updated.'));
        return { sourceUri: resultUri.toString() };
    } catch (error) { void vscode.window.showErrorMessage(t('Could not convert the scenario: {0}', callableConversionErrorText(error, t))); }
}
