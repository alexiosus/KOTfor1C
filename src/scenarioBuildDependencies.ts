import type * as vscode from 'vscode';
import { sameProjectDefinitionSource } from './projectDefinition';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ProjectDefinitionReferenceService } from './projectDefinitionReferences';

export interface ScenarioBuildReferenceServices {
    readonly resolver: Pick<ProjectDefinitionResolver, 'getView'>;
    readonly references: Pick<ProjectDefinitionReferenceService, 'findReferencesForDefinitions'>;
}

/** Exported bodies stay in runtime libraries, so their callers must be invalidated even if compiled text is unchanged. */
export async function findExportScenarioBuildCallers(source: vscode.Uri, services: ScenarioBuildReferenceServices): Promise<readonly vscode.Uri[]> {
    const view = await services.resolver.getView(source);
    const exports = view.all.filter(definition => definition.kind === 'exportScenario');
    const definitionsIn = (uri: string) => exports.filter(definition =>
        [definition.definitionLocation?.uri, definition.implementationLocation?.uri].some(location => sameProjectDefinitionSource(location, uri)));
    const pending = definitionsIn(source.toString()).map(definition => definition.id);
    if (!pending.length) { return []; }
    // One cached reference search covers the entire chain, including exports calling other exports.
    const references = await services.references.findReferencesForDefinitions(exports.map(definition => definition.id), source,
        { includeDeclaration: false }, { isCancellationRequested: false });
    const visited = new Set<string>();
    const callers = new Map<string, vscode.Uri>();
    for (let index = 0; index < pending.length; index++) {
        const id = pending[index];
        if (visited.has(id)) { continue; }
        visited.add(id);
        for (const reference of references.get(id) ?? []) {
            const uri = reference.uri.toString();
            if (callers.has(uri)) { continue; }
            callers.set(uri, reference.uri);
            for (const definition of definitionsIn(uri)) { pending.push(definition.id); }
        }
    }
    return [...callers.values()];
}
