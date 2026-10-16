import path from 'node:path';
import * as vscode from 'vscode';
import { projectLibraryEnvironment } from './projectLibraryIntegration';
import { resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { ProjectPropertyCatalogStore, type ProjectSystemFunction } from './projectPropertyCatalogStore';

/** Resolve the same project owner used by groups and adjacent metadata. */
export function projectSystemFunctionStore(target: vscode.Uri, beforeWrite?: () => void | Promise<void>): ProjectPropertyCatalogStore {
    if (target.scheme !== 'file') { throw new Error('System functions require a source in a project.'); }
    const environment = projectLibraryEnvironment();
    const root = resolveProjectLibraryRoot(target.fsPath, environment.workspaceRoots, environment.scanRoots);
    const file = path.join(root, '.kot', 'property-catalogs.yml');
    return new ProjectPropertyCatalogStore(root, { beforeWrite: async () => {
        await beforeWrite?.();
        if (vscode.workspace.textDocuments.some(document => !document.isClosed && document.isDirty && document.uri.scheme === 'file'
            && path.resolve(document.uri.fsPath) === file)) { throw new Error('Save the modified project catalog before changing system functions.'); }
    } });
}

export async function loadProjectSystemFunctions(target: vscode.Uri, legacy: readonly ProjectSystemFunction[]): Promise<ProjectSystemFunction[]> {
    return projectSystemFunctionStore(target).ensureSystemFunctions(legacy);
}
