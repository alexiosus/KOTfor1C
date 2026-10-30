import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StepLibraryItem } from './stepLibraryModel';

export type ScenarioFileNodeKind = 'directory' | 'file';
export type ScenarioFileResource = 'source' | 'compiled';

/** Resource selectors never accept a path from the webview; roots come from the trusted snapshot. */
export function scenarioFilesItemForResource(item: StepLibraryItem | undefined, resource?: ScenarioFileResource): StepLibraryItem | undefined {
    if (!item || resource !== 'source') { return item; }
    return item.sourceScenarioFilesRootUri
        ? { ...item, scenarioFilesRootUri: item.sourceScenarioFilesRootUri }
        : item.kind === 'nestedScenario' ? item : undefined;
}

export function scopeScenarioFileNodes(nodes: readonly ScenarioFileNode[], resource?: ScenarioFileResource): readonly ScenarioFileNode[] {
    return resource ? nodes.map(node => ({ ...node, id: `${node.id}:${resource}`, resource })) : nodes;
}

export interface ScenarioFileNode {
    readonly id: string;
    readonly kind: ScenarioFileNodeKind;
    readonly itemId: string;
    readonly name: string;
    readonly relativePath: string;
    readonly depth: number;
    readonly expandable: boolean;
    readonly resource?: ScenarioFileResource;
}

export interface ScenarioFileManifestEntry {
    readonly clientPath: string;
    readonly kind: 'directory' | 'file';
    readonly size?: number;
}

export interface CompiledScenarioResourceUris {
    readonly featureUri: string;
    readonly filesRootUri: string;
}

export function compiledScenarioResourcesFromFeaturePath(
    featurePath: string
): CompiledScenarioResourceUris | null {
    const normalizedPath = featurePath.trim();
    if (!normalizedPath || path.extname(normalizedPath).toLocaleLowerCase() !== '.feature') {
        return null;
    }
    const scenarioName = path.basename(normalizedPath, path.extname(normalizedPath));
    if (!scenarioName) {
        return null;
    }
    return Object.freeze({
        featureUri: pathToFileURL(normalizedPath).toString(),
        filesRootUri: pathToFileURL(path.join(
            path.dirname(normalizedPath),
            scenarioName,
            'Файлы'
        )).toString()
    });
}

export function normalizeScenarioFileRelativePath(value: string): string | null {
    if (value.includes('\0')) {
        return null;
    }
    const slashPath = value.replace(/\\/gu, '/');
    if (slashPath === '') {
        return '';
    }
    if (
        slashPath.startsWith('/')
        || slashPath.startsWith('//')
        || /^[A-Za-z]:/u.test(slashPath)
    ) {
        return null;
    }
    const normalized: string[] = [];
    for (const segment of slashPath.split('/')) {
        if (segment === '.') {
            continue;
        }
        if (!segment || segment === '..') {
            return null;
        }
        normalized.push(segment);
    }
    return normalized.join('/');
}

export function scenarioFileNodeId(
    itemId: string,
    kind: ScenarioFileNodeKind,
    relativePath: string
): string {
    return `scenario-file:${encodeURIComponent(itemId)}:${kind}:${encodeURIComponent(relativePath)}`;
}

export function scenarioFilesAvailable(
    item: Pick<
        StepLibraryItem,
        'id' | 'kind' | 'sourceGroup' | 'capturedLocation' | 'scenarioFilesRootUri'
    >
): boolean {
    if (
        item.id.length > 0
        && (item.kind === 'mainScenario' || item.kind === 'process')
        && (item.sourceGroup === 'main' || item.sourceGroup === 'process')
        && /^file:/iu.test(item.scenarioFilesRootUri ?? '')
    ) {
        return true;
    }
    return item.id.length > 0
        && item.kind === 'nestedScenario'
        && item.sourceGroup === 'nested'
        && /^file:/iu.test(item.capturedLocation?.uri ?? '');
}
