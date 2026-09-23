import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    collectTreeWithConcurrencyLimit,
    ConcurrencyCancelledError,
    runWithConcurrencyLimit
} from './boundedConcurrency';
import type {
    ProjectDefinition,
    ProjectDefinitionLocation,
    ProjectDefinitionMatch,
    ProjectDefinitionView
} from './projectDefinition';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';

const CALLABLE_LINE = /^\s*(?:\*\s*)?(?:К\s+тому\s+же|Допустим|Given|When|Then|And|But|Если|Когда|Тогда|Но|И|If|Дано)\s+.+/iu;
const IGNORED_DIRECTORIES = new Set(['.git', '.svn', 'node_modules']);

export interface ProjectDefinitionReferenceSearchRoot {
    readonly path: string;
    readonly extensions: readonly string[];
}

export interface ProjectDefinitionReferenceDirectoryEntry {
    readonly name: string;
    readonly type: 'file' | 'directory';
}

export interface ProjectDefinitionReferenceFileSystem {
    realpath(filePath: string): Promise<string>;
    readDirectory(directoryPath: string): Promise<readonly ProjectDefinitionReferenceDirectoryEntry[]>;
    stat(filePath: string): Promise<{ readonly size: number; readonly mtimeMs: number }>;
    readFile(filePath: string): Promise<string>;
    toUri(filePath: string): string;
}

interface OpenDocumentLike {
    readonly uri: vscode.Uri;
    readonly fileName: string;
    readonly version: number;
    readonly isUntitled: boolean;
    getText(): string;
}

export interface ProjectDefinitionReferenceServiceOptions {
    readonly resolver: ProjectDefinitionResolver;
    readonly loadSearchRoots: (
        resource?: vscode.Uri
    ) => Promise<readonly ProjectDefinitionReferenceSearchRoot[]>;
    readonly fileSystem: ProjectDefinitionReferenceFileSystem;
    readonly getOpenDocuments?: () => readonly OpenDocumentLike[];
    readonly directoryConcurrency?: number;
    readonly readConcurrency?: number;
    readonly yieldEvery?: number;
    readonly yieldControl?: () => Promise<void>;
    readonly log?: (message: string) => void;
}

export interface ProjectDefinitionReferenceOptions {
    readonly includeDeclaration: boolean;
}

interface ResolvedSearchRoot {
    readonly path: string;
    readonly extensions: ReadonlySet<string>;
}

interface ReferenceSource {
    readonly filePath: string;
    readonly uri: string;
    readonly openDocument?: OpenDocumentLike;
}

interface SerializedRange {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
}

interface CachedReferenceFile {
    readonly fingerprint: string;
    readonly byDefinitionId: ReadonlyMap<string, readonly SerializedRange[]>;
}

function normalizeExtension(value: string): string {
    const normalized = value.trim().toLocaleLowerCase();
    return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function pathKey(value: string): string {
    const normalized = path.normalize(value);
    return path.sep === '\\' ? normalized.toLocaleLowerCase() : normalized;
}

function isSameOrNestedPath(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toRange(range: SerializedRange): vscode.Range {
    return new vscode.Range(
        new vscode.Position(range.start.line, range.start.character),
        new vscode.Position(range.end.line, range.end.character)
    );
}

function serializeMatchRange(line: number, match: ProjectDefinitionMatch): SerializedRange {
    return {
        start: { line, character: match.invocationRange.start },
        end: { line, character: match.invocationRange.end }
    };
}

function locationRange(location: ProjectDefinitionLocation): vscode.Range {
    return new vscode.Range(
        new vscode.Position(location.range.start.line, location.range.start.character),
        new vscode.Position(location.range.end.line, location.range.end.character)
    );
}

function referenceKey(location: vscode.Location): string {
    return [
        location.uri.toString(),
        location.range.start.line,
        location.range.start.character,
        location.range.end.line,
        location.range.end.character
    ].join(':');
}

function compareLocations(left: vscode.Location, right: vscode.Location): number {
    return left.uri.toString().localeCompare(right.uri.toString(), undefined, { sensitivity: 'base' })
        || left.range.start.line - right.range.start.line
        || left.range.start.character - right.range.start.character
        || left.range.end.line - right.range.end.line
        || left.range.end.character - right.range.end.character;
}

export class ProjectDefinitionReferenceService {
    readonly #options: ProjectDefinitionReferenceServiceOptions;
    readonly #cache = new Map<string, CachedReferenceFile>();

    constructor(options: ProjectDefinitionReferenceServiceOptions) {
        this.#options = options;
    }

    async findReferences(
        definitionId: string,
        resource: vscode.Uri | undefined,
        options: ProjectDefinitionReferenceOptions,
        token: Pick<vscode.CancellationToken, 'isCancellationRequested'>
    ): Promise<vscode.Location[]> {
        if (token.isCancellationRequested) {
            return [];
        }

        try {
            const [view, roots] = await Promise.all([
                this.#options.resolver.getView(resource),
                this.#resolveSearchRoots(resource, token)
            ]);
            if (token.isCancellationRequested) {
                return [];
            }
            if (!view.byId.has(definitionId)) {
                return [];
            }
            const sources = await this.#enumerateSources(roots, token);
            if (token.isCancellationRequested) {
                return [];
            }
            this.#mergeOpenDocuments(sources, roots);

            const sourceList = Array.from(sources.values());
            const records = await runWithConcurrencyLimit(
                sourceList,
                this.#options.readConcurrency ?? 4,
                source => this.#readReferenceFile(source, view, token),
                {
                    shouldCancel: () => token.isCancellationRequested,
                    yieldEvery: this.#options.yieldEvery ?? 24,
                    yieldControl: this.#options.yieldControl
                }
            );
            if (token.isCancellationRequested) {
                return [];
            }

            const activeUris = new Set(sources.keys());
            for (const cachedUri of this.#cache.keys()) {
                if (!activeUris.has(cachedUri)) {
                    this.#cache.delete(cachedUri);
                }
            }

            const references: vscode.Location[] = [];
            for (let index = 0; index < records.length; index++) {
                const ranges = records[index]?.byDefinitionId.get(definitionId) ?? [];
                const source = sourceList[index];
                for (const range of ranges) {
                    references.push(new vscode.Location(vscode.Uri.parse(source.uri), toRange(range)));
                }
            }

            if (options.includeDeclaration) {
                const definition = view.byId.get(definitionId);
                const declaration = definition?.definitionLocation ?? definition?.implementationLocation;
                if (declaration) {
                    references.push(new vscode.Location(
                        vscode.Uri.parse(declaration.uri),
                        locationRange(declaration)
                    ));
                }
            }

            const unique = new Map<string, vscode.Location>();
            for (const location of references) {
                unique.set(referenceKey(location), location);
            }
            return Array.from(unique.values()).sort(compareLocations);
        } catch (error) {
            if (error instanceof ConcurrencyCancelledError || token.isCancellationRequested) {
                return [];
            }
            this.#options.log?.(`Project definition reference scan failed: ${String(error)}`);
            return [];
        }
    }

    async #resolveSearchRoots(
        resource: vscode.Uri | undefined,
        token: Pick<vscode.CancellationToken, 'isCancellationRequested'>
    ): Promise<ResolvedSearchRoot[]> {
        const configured = await this.#options.loadSearchRoots(resource);
        const merged = new Map<string, { path: string; extensions: Set<string> }>();
        for (const item of configured) {
            if (token.isCancellationRequested) {
                throw new ConcurrencyCancelledError();
            }
            try {
                const resolvedPath = await this.#options.fileSystem.realpath(item.path);
                const key = pathKey(resolvedPath);
                const current = merged.get(key) ?? { path: resolvedPath, extensions: new Set<string>() };
                item.extensions.forEach(extension => current.extensions.add(normalizeExtension(extension)));
                merged.set(key, current);
            } catch (error) {
                this.#options.log?.(`Cannot resolve reference search root ${item.path}: ${String(error)}`);
            }
        }
        return Array.from(merged.values()).map(item => ({
            path: item.path,
            extensions: item.extensions
        }));
    }

    async #enumerateSources(
        roots: readonly ResolvedSearchRoot[],
        token: Pick<vscode.CancellationToken, 'isCancellationRequested'>
    ): Promise<Map<string, ReferenceSource>> {
        const sources = new Map<string, ReferenceSource>();
        for (const root of roots) {
            if (token.isCancellationRequested) {
                throw new ConcurrencyCancelledError();
            }
            const files = await collectTreeWithConcurrencyLimit(
                root.path,
                this.#options.directoryConcurrency ?? 4,
                async directoryPath => {
                    try {
                        const entries = await this.#options.fileSystem.readDirectory(directoryPath);
                        const children: string[] = [];
                        const values: string[] = [];
                        for (const entry of entries) {
                            const childPath = path.join(directoryPath, entry.name);
                            if (entry.type === 'directory') {
                                if (!IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) {
                                    children.push(childPath);
                                }
                            } else if (root.extensions.has(path.extname(entry.name).toLocaleLowerCase())) {
                                values.push(childPath);
                            }
                        }
                        return { children, values };
                    } catch (error) {
                        this.#options.log?.(`Cannot enumerate reference directory ${directoryPath}: ${String(error)}`);
                        return { children: [], values: [] };
                    }
                },
                () => token.isCancellationRequested
            );
            for (const filePath of files) {
                const uri = this.#options.fileSystem.toUri(filePath);
                sources.set(uri, { filePath, uri });
            }
        }
        return sources;
    }

    #mergeOpenDocuments(
        sources: Map<string, ReferenceSource>,
        roots: readonly ResolvedSearchRoot[]
    ): void {
        for (const document of this.#options.getOpenDocuments?.() ?? []) {
            if (document.isUntitled || document.uri.scheme !== 'file') {
                continue;
            }
            const extension = path.extname(document.fileName).toLocaleLowerCase();
            const included = roots.some(root =>
                root.extensions.has(extension) && isSameOrNestedPath(document.fileName, root.path)
            );
            if (!included) {
                continue;
            }
            const uri = document.uri.toString();
            sources.set(uri, {
                filePath: document.fileName,
                uri,
                openDocument: document
            });
        }
    }

    async #readReferenceFile(
        source: ReferenceSource,
        view: ProjectDefinitionView,
        token: Pick<vscode.CancellationToken, 'isCancellationRequested'>
    ): Promise<CachedReferenceFile | null> {
        if (token.isCancellationRequested) {
            throw new ConcurrencyCancelledError();
        }

        let fingerprint: string;
        let text: string;
        if (source.openDocument) {
            fingerprint = `${view.identity}\0open:${source.openDocument.version}`;
            const cached = this.#cache.get(source.uri);
            if (cached?.fingerprint === fingerprint) {
                return cached;
            }
            text = source.openDocument.getText();
        } else {
            try {
                const stat = await this.#options.fileSystem.stat(source.filePath);
                fingerprint = `${view.identity}\0disk:${stat.size}:${stat.mtimeMs}`;
                const cached = this.#cache.get(source.uri);
                if (cached?.fingerprint === fingerprint) {
                    return cached;
                }
                text = await this.#options.fileSystem.readFile(source.filePath);
            } catch (error) {
                this.#options.log?.(`Cannot read reference source ${source.filePath}: ${String(error)}`);
                this.#cache.delete(source.uri);
                return null;
            }
        }

        if (token.isCancellationRequested) {
            throw new ConcurrencyCancelledError();
        }
        const byDefinitionId = new Map<string, SerializedRange[]>();
        const lines = text.split(/\r?\n/u);
        for (let line = 0; line < lines.length; line++) {
            if (token.isCancellationRequested) {
                throw new ConcurrencyCancelledError();
            }
            const invocation = lines[line];
            if (!CALLABLE_LINE.test(invocation)) {
                continue;
            }
            const resolution = await this.#options.resolver.resolve(
                vscode.Uri.parse(source.uri),
                invocation,
                view
            );
            if (resolution.kind === 'missing') {
                continue;
            }
            const matches = resolution.kind === 'unique' ? [resolution.match] : resolution.matches;
            for (const match of matches) {
                const ranges = byDefinitionId.get(match.definition.id) ?? [];
                ranges.push(serializeMatchRange(line, match));
                byDefinitionId.set(match.definition.id, ranges);
            }
        }

        const record: CachedReferenceFile = {
            fingerprint,
            byDefinitionId
        };
        this.#cache.set(source.uri, record);
        return record;
    }
}

function positionWithinRange(position: vscode.Position, range: ProjectDefinitionLocation['range']): boolean {
    const afterStart = position.line > range.start.line
        || (position.line === range.start.line && position.character >= range.start.character);
    const beforeEnd = position.line < range.end.line
        || (position.line === range.end.line && position.character <= range.end.character);
    return afterStart && beforeEnd;
}

function definitionContainsPosition(
    definition: ProjectDefinition,
    documentUri: string,
    position: vscode.Position
): boolean {
    return [definition.definitionLocation, definition.implementationLocation].some(location =>
        location?.uri === documentUri && positionWithinRange(position, location.range)
    );
}

export async function resolveProjectDefinitionIdsAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    resolver: ProjectDefinitionResolver,
    token: Pick<vscode.CancellationToken, 'isCancellationRequested'>
): Promise<string[]> {
    if (token.isCancellationRequested) {
        return [];
    }
    const view = await resolver.getView(document.uri);
    if (token.isCancellationRequested) {
        return [];
    }
    const documentUri = document.uri.toString();
    const declarations = view.all.filter(definition =>
        definitionContainsPosition(definition, documentUri, position)
    );
    if (declarations.length > 0) {
        return declarations.map(definition => definition.id);
    }

    const resolution = await resolver.resolve(document.uri, document.lineAt(position.line).text, view);
    if (token.isCancellationRequested) {
        return [];
    }
    if (resolution.kind === 'unique') {
        return [resolution.match.definition.id];
    }
    if (resolution.kind === 'ambiguous') {
        return resolution.matches.map(match => match.definition.id);
    }

    const sameFile = view.all.filter(definition =>
        definition.definitionLocation?.uri === documentUri
        || definition.implementationLocation?.uri === documentUri
    );
    return sameFile.length === 1 ? [sameFile[0].id] : [];
}

export class ProjectDefinitionReferenceProvider implements vscode.ReferenceProvider {
    constructor(
        private readonly service: ProjectDefinitionReferenceService,
        private readonly resolver: ProjectDefinitionResolver
    ) {}

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const definitionIds = await resolveProjectDefinitionIdsAtPosition(
            document,
            position,
            this.resolver,
            token
        );
        const locations: vscode.Location[] = [];
        for (const definitionId of definitionIds) {
            if (token.isCancellationRequested) {
                return [];
            }
            locations.push(...await this.service.findReferences(
                definitionId,
                document.uri,
                { includeDeclaration: context.includeDeclaration },
                token
            ));
        }
        const unique = new Map<string, vscode.Location>();
        locations.forEach(location => unique.set(referenceKey(location), location));
        return Array.from(unique.values()).sort(compareLocations);
    }
}
