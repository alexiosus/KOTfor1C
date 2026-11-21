import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as vscode from 'vscode';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ProjectDefinitionReferenceService } from './projectDefinitionReferences';
import type { PhaseSwitcherProvider } from './phaseSwitcher';
import { sameProjectDefinitionSource } from './projectDefinition';
import { AgentWorkspace, agentHash } from './agentWorkspace';
import { getCompilerScenarioBody, scanCompilerLines, parseCompilerParameterBinding } from './scenarioCompilerSyntax';
import { kotCancellationRequested } from './kotInteraction';
import { parseExportScenarios } from './exportScenarioParser';

interface Ports {
    definitions?: ProjectDefinitionResolver; references?: ProjectDefinitionReferenceService;
    provider: Pick<PhaseSwitcherProvider, 'ensureFreshScenarioCatalog'>;
}
const cancelled = () => { if (kotCancellationRequested()) { throw new Error('Definition query was cancelled.'); } };
const token = { get isCancellationRequested() { return kotCancellationRequested(); } };
const sameSource = (left: string | undefined, right: string) => sameProjectDefinitionSource(left, right)
    || !!left && /^file:/iu.test(left) && /[\\/]meta\.yaml$/iu.test(fileURLToPath(left)) && /[\\/]scen\.feature$/iu.test(fileURLToPath(right))
        && sameProjectDefinitionSource(pathToFileURL(path.dirname(fileURLToPath(left))).href, pathToFileURL(path.dirname(fileURLToPath(right))).href);

export async function agentReferences(ports: Ports, workspace: AgentWorkspace, source: vscode.Uri, input: Record<string, unknown>) {
    if (!ports.definitions || !ports.references) { throw new Error('Project definition services are unavailable.'); }
    const view = await ports.definitions.getView(source);
    const definitions = input.definitionId ? [view.byId.get(input.definitionId as string)].filter(value => !!value)
        : view.all.filter(value => sameSource(value.definitionLocation?.uri, source.toString()) || sameSource(value.implementationLocation?.uri, source.toString()));
    if (!definitions.length) { throw new Error('No matching definition. Read kot_project and select a current definition ID or its source.'); }
    const matches = await ports.references.findReferencesForDefinitions(definitions.map(value => value.id), source,
        { includeDeclaration: false, failOnScanError: true }, token);
    cancelled();
    const rows = [...matches].flatMap(([definitionId, locations]) => locations.map(location => ({ definitionId, location })));
    const offset = input.offset as number ?? 0; const limit = input.limit as number ?? 50;
    const references = [];
    for (const row of rows.slice(offset, offset + limit)) {
        cancelled();
        const excerpt = await workspace.read(row.location.uri.fsPath, row.location.range.start.line + 1, 1);
        references.push({ definitionId: row.definitionId, path: excerpt.path, range: row.location.range, invocation: excerpt.text, sha256: excerpt.sha256 });
    }
    if ((await ports.definitions.getView(source)).identity !== view.identity) { throw new Error('Definitions changed during the query. Refresh and retry.'); }
    return { identity: view.identity, definitions, references, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : undefined, completeScan: true };
}

/** Static calls retain each occurrence and arguments; they do not assert that a branch executed. */
export async function agentCallGraph(ports: Ports, workspace: AgentWorkspace, source: vscode.Uri, input: Record<string, unknown>) {
    if (!ports.definitions) { throw new Error('Project definitions are unavailable.'); }
    const view = await ports.definitions.getView(source);
    const catalog = await ports.provider.ensureFreshScenarioCatalog();
    const depthLimit = input.depth as number ?? 8; const limit = input.limit as number ?? 300;
    const queue: Array<{ uri: string; depth: number; ancestors: string[]; declarationLine?: number }> = [{ uri: source.toString(), depth: 0, ancestors: [] }]; const visited = new Set<string>();
    const nodes: Array<{ uri: string; source: string; depth: number; sha256: string; declarationLine?: number }> = []; const edges: Record<string, unknown>[] = [];
    const unresolved: Record<string, unknown>[] = []; let truncated = false;
    const nodeKey = (file: string, declarationLine?: number) => (process.platform === 'win32' ? file.toLowerCase() : file) + (declarationLine === undefined ? '' : '#' + declarationLine);
    const enqueue = (uri: string | undefined, depth: number, ancestors: string[], declarationLine?: number) => {
        if (!uri) { return; }
        if (depth > depthLimit) { truncated = true; return; }
        if (!ancestors.includes(nodeKey(fileURLToPath(uri), declarationLine))) { queue.push({ uri, depth, ancestors, declarationLine }); }
    };
    while (queue.length && nodes.length < limit && edges.length < limit) {
        cancelled(); const current = queue.shift()!;
        const file = await workspace.resolve(fileURLToPath(current.uri));
        const key = nodeKey(file, current.declarationLine);
        if (visited.has(key)) { continue; } visited.add(key);
        let bodyFile = file;
        if (path.basename(file).toLowerCase() === 'meta.yaml') {
            const sibling = path.join(path.dirname(file), 'scen.feature');
            try { await fs.stat(sibling); bodyFile = await workspace.resolve(sibling); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
        if ((await fs.stat(bodyFile)).size > 16 * 1024 * 1024) { throw new Error('Choose a text scenario smaller than 16 MiB.'); }
        const text = await fs.readFile(bodyFile, 'utf8');
        if (Buffer.byteLength(text) > 16 * 1024 * 1024 || text.includes('\0')) { throw new Error('Choose a text scenario smaller than 16 MiB.'); }
        nodes.push({ uri: current.uri, source: pathToFileURL(bodyFile).href, depth: current.depth, sha256: agentHash(text), declarationLine: current.declarationLine });
        const descriptor = catalog.all.find(value => value.kind === 'process' && sameProjectDefinitionSource(value.yamlFileUri.toString(), current.uri));
        const ancestors = [...current.ancestors, key];
        if (descriptor) {
            for (const [index, step] of (descriptor.processSteps ?? []).entries()) {
                if (edges.length >= limit) { truncated = true; break; }
                const uid = step.type === 'process' ? step.processUid : step.scenarioUid;
                const name = step.type === 'process' ? step.processName : step.scenarioName;
                const targets = catalog.all.filter(value => (value.kind === 'process') === (step.type === 'process')
                    && (uid ? value.uid?.toLowerCase() === uid.toLowerCase() : value.name === name));
                edges.push({ from: current.uri, step: index, reference: step, targets: targets.map(value => value.yamlFileUri.toString()), ambiguous: targets.length > 1, missing: !targets.length });
                if (targets.length === 1) { enqueue(targets[0].yamlFileUri.toString(), current.depth + 1, ancestors); }
            }
            continue;
        }
        let body = /\.feature$/iu.test(bodyFile) ? null : getCompilerScenarioBody(text);
        if (/\.feature$/iu.test(bodyFile) && current.declarationLine !== undefined) {
            const parsed = parseExportScenarios(text, { sourceUri: current.uri, workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' });
            const declaration = parsed.scenarios.find(value => value.titleRange.start.line === current.declarationLine);
            if (declaration) {
                body = { startLine: declaration.declarationRange.start.line,
                    lines: text.split(/\r\n|\r|\n/u).slice(declaration.declarationRange.start.line, declaration.declarationRange.end.line + (declaration.declarationRange.end.character ? 1 : 0)) };
            }
        }
        const lines = body?.lines ?? text.split(/\r\n|\r|\n/u); const scanned = scanCompilerLines(lines);
        for (let index = 0; index < lines.length; index++) {
            cancelled(); if (edges.length >= limit) { truncated = true; break; }
            if (scanned[index].kind !== 'code' || !/^\s*(?:\*\s*)?(?:Given|When|Then|And|But|If|Do|К тому же|Затем|Пусть|То|А|Также|Иначе|Допустим|Если|Когда|Тогда|Но|И|Дано|Цикл)\s+/iu.test(lines[index])) { continue; }
            const resolution = await ports.definitions.resolve(undefined, lines[index], view);
            const line = index + (body?.startLine ?? 0);
            if (resolution.kind === 'missing') {
                unresolved.push({ source: pathToFileURL(bodyFile).href, line, invocation: lines[index] });
                if (unresolved.length >= limit) { truncated = true; break; } continue;
            }
            const matches = resolution.kind === 'unique' ? [resolution.match] : resolution.matches;
            const bindings: Record<string, unknown>[] = [];
            for (let next = index + 1; next < lines.length; next++) {
                if (!lines[next].trim() || scanned[next].kind === 'comment') { continue; }
                const binding = scanned[next].kind === 'code' ? parseCompilerParameterBinding(lines[next]) : null;
                if (binding) { bindings.push({ ...binding, line: next + (body?.startLine ?? 0) }); continue; }
                if (bindings.length && ['table', 'docString'].includes(scanned[next].kind)) {
                    const last = bindings[bindings.length - 1]; last.continuation = [...(last.continuation as string[] ?? []), lines[next]]; continue;
                }
                break;
            }
            for (const match of matches) {
                if (edges.length >= limit) { truncated = true; break; }
                const target = match.definition.implementationLocation ?? match.definition.definitionLocation;
                const declarationLine = match.definition.kind === 'exportScenario' ? target?.range.start.line : undefined;
                edges.push({ from: current.uri, source: pathToFileURL(bodyFile).href, line, invocation: lines[index], definitionId: match.definition.id,
                    kind: match.definition.kind, arguments: match.arguments, bindings, target, ambiguous: resolution.kind === 'ambiguous',
                    cycle: !!target && /^file:/iu.test(target.uri) && ancestors.includes(nodeKey(fileURLToPath(target.uri), declarationLine)) });
                if (resolution.kind === 'unique' && ['nestedScenario', 'exportScenario'].includes(match.definition.kind)) { enqueue(target?.uri, current.depth + 1, ancestors, declarationLine); }
            }
        }
    }
    if (queue.length) { truncated = true; }
    if ((await ports.definitions.getView(source)).identity !== view.identity) { throw new Error('Definitions changed during the query. Refresh and retry.'); }
    return { identity: view.identity, root: source.toString(), nodes, edges, unresolved, truncated, staticAnalysis: true,
        note: 'Arguments are authored expressions. Conditions, loops and variable values require runtime evidence.' };
}
