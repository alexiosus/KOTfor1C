import {
    BuiltInStepCatalog,
    parseBuiltInStepCatalog,
    parseStepCatalogIndex,
    sha256Hex,
    StepCatalogIndex
} from './stepCatalog';

const INDEX_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const INDEX_MAX_BYTES = 1024 * 1024;
const CATALOG_MAX_BYTES = 20 * 1024 * 1024;
const VANESSA_VERSION_REGEX = /^\d+\.\d+\.\d+\.\d+$/;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

export interface StepCatalogStorage {
    read(relativePath: string): Promise<Uint8Array | null>;
    writeAtomic(relativePath: string, bytes: Uint8Array): Promise<void>;
}

export interface StepCatalogHttpResponse {
    readonly status: number;
    readonly body: Uint8Array;
    readonly etag?: string;
}

export interface StepCatalogTransport {
    get(
        url: URL,
        options: {
            readonly signal?: AbortSignal;
            readonly maxBytes: number;
            readonly etag?: string;
        }
    ): Promise<StepCatalogHttpResponse>;
}

export interface VersionedCatalogResult {
    readonly catalog: BuiltInStepCatalog;
    readonly source: 'versioned-cache' | 'versioned-download';
    readonly digest: string;
}

export interface StepCatalogCachePaths {
    readonly root: string;
    readonly index: string;
    readonly indexMeta: string;
    readonly catalog: string;
    readonly catalogMeta: string;
}

interface IndexCacheMetadata {
    readonly fetchedAt: number;
    readonly etag?: string;
}

interface CatalogCacheMetadata {
    readonly sha256: string;
    readonly sourceCommit: string;
    readonly etag?: string;
}

interface CachedIndex {
    readonly index: StepCatalogIndex;
    readonly metadata: IndexCacheMetadata | null;
}

function normalizedIndexUrl(indexUrl: string): string {
    const url = new URL(indexUrl);
    if (url.protocol !== 'https:') {
        throw new Error('Step catalog index URL must use HTTPS.');
    }
    return url.toString();
}

function parseJsonBytes(bytes: Uint8Array): unknown {
    return JSON.parse(textDecoder.decode(bytes));
}

function serializeJson(value: unknown): Uint8Array {
    return textEncoder.encode(`${JSON.stringify(value)}\n`);
}

function parseIndexMetadata(bytes: Uint8Array | null): IndexCacheMetadata | null {
    if (!bytes) {
        return null;
    }
    try {
        const value = parseJsonBytes(bytes);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }
        const record = value as Record<string, unknown>;
        if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) {
            return null;
        }
        if (record.etag !== undefined && typeof record.etag !== 'string') {
            return null;
        }
        return { fetchedAt: record.fetchedAt, etag: record.etag as string | undefined };
    } catch {
        return null;
    }
}

export function getStepCatalogCachePaths(
    indexUrl: string,
    version: string
): StepCatalogCachePaths {
    if (!VANESSA_VERSION_REGEX.test(version)) {
        throw new Error('Vanessa version must contain four numeric components.');
    }
    const namespace = sha256Hex(normalizedIndexUrl(indexUrl));
    const root = `step-catalogs/${namespace}`;
    return {
        root,
        index: `${root}/index.json`,
        indexMeta: `${root}/index-meta.json`,
        catalog: `${root}/${version}/catalog.json`,
        catalogMeta: `${root}/${version}/catalog-meta.json`
    };
}

export class VersionedStepCatalogClient {
    private readonly inFlight = new Map<string, Promise<VersionedCatalogResult | null>>();

    public constructor(
        private readonly storage: StepCatalogStorage,
        private readonly transport: StepCatalogTransport,
        private readonly now: () => number = Date.now
    ) {}

    public getExactCatalog(
        indexUrl: string,
        version: string,
        signal?: AbortSignal
    ): Promise<VersionedCatalogResult | null> {
        return this.shareRequest(indexUrl, version, false, signal);
    }

    public refreshExactCatalog(
        indexUrl: string,
        version: string,
        signal?: AbortSignal
    ): Promise<VersionedCatalogResult | null> {
        return this.shareRequest(indexUrl, version, true, signal);
    }

    private shareRequest(
        indexUrl: string,
        version: string,
        refresh: boolean,
        signal?: AbortSignal
    ): Promise<VersionedCatalogResult | null> {
        let normalizedUrl: string;
        try {
            normalizedUrl = normalizedIndexUrl(indexUrl);
            getStepCatalogCachePaths(normalizedUrl, version);
        } catch {
            return Promise.resolve(null);
        }

        const key = `${normalizedUrl}\0${version}\0${refresh ? 'refresh' : 'normal'}`;
        const existing = this.inFlight.get(key);
        if (existing) {
            return existing;
        }

        const request = this.resolveExactCatalog(normalizedUrl, version, refresh, signal);
        let tracked!: Promise<VersionedCatalogResult | null>;
        tracked = request.finally(() => {
            if (this.inFlight.get(key) === tracked) {
                this.inFlight.delete(key);
            }
        });
        this.inFlight.set(key, tracked);
        return tracked;
    }

    private async resolveExactCatalog(
        indexUrl: string,
        version: string,
        refresh: boolean,
        signal?: AbortSignal
    ): Promise<VersionedCatalogResult | null> {
        const paths = getStepCatalogCachePaths(indexUrl, version);
        const cachedCatalog = await this.loadCachedCatalog(paths.catalog, version);
        if (cachedCatalog && !refresh) {
            return cachedCatalog;
        }

        try {
            const index = await this.resolveIndex(indexUrl, paths, refresh, signal);
            if (!index) {
                return cachedCatalog;
            }
            const entry = index.catalogs[version];
            if (!entry) {
                return cachedCatalog;
            }

            const response = await this.transport.get(new URL(entry.path, indexUrl), {
                signal,
                maxBytes: CATALOG_MAX_BYTES
            });
            if (response.status !== 200) {
                return cachedCatalog;
            }

            const digest = sha256Hex(response.body);
            if (digest !== entry.sha256) {
                return cachedCatalog;
            }
            const catalog = parseBuiltInStepCatalog(parseJsonBytes(response.body), version);
            if (
                catalog.steps.length !== entry.stepCount
                || catalog.source.commit !== entry.sourceCommit
            ) {
                return cachedCatalog;
            }

            const metadata: CatalogCacheMetadata = {
                sha256: digest,
                sourceCommit: entry.sourceCommit,
                etag: response.etag
            };
            await this.storage.writeAtomic(paths.catalog, response.body);
            await this.storage.writeAtomic(paths.catalogMeta, serializeJson(metadata));
            return { catalog, source: 'versioned-download', digest };
        } catch {
            return cachedCatalog;
        }
    }

    private async loadCachedCatalog(
        catalogPath: string,
        version: string
    ): Promise<VersionedCatalogResult | null> {
        try {
            const bytes = await this.storage.read(catalogPath);
            if (!bytes) {
                return null;
            }
            const catalog = parseBuiltInStepCatalog(parseJsonBytes(bytes), version);
            return {
                catalog,
                source: 'versioned-cache',
                digest: sha256Hex(bytes)
            };
        } catch {
            return null;
        }
    }

    private async loadCachedIndex(paths: StepCatalogCachePaths): Promise<CachedIndex | null> {
        try {
            const [indexBytes, metadataBytes] = await Promise.all([
                this.storage.read(paths.index),
                this.storage.read(paths.indexMeta)
            ]);
            if (!indexBytes) {
                return null;
            }
            return {
                index: parseStepCatalogIndex(parseJsonBytes(indexBytes)),
                metadata: parseIndexMetadata(metadataBytes)
            };
        } catch {
            return null;
        }
    }

    private async resolveIndex(
        indexUrl: string,
        paths: StepCatalogCachePaths,
        refresh: boolean,
        signal?: AbortSignal
    ): Promise<StepCatalogIndex | null> {
        const cached = await this.loadCachedIndex(paths);
        if (
            !refresh
            && cached?.metadata
            && this.now() - cached.metadata.fetchedAt <= INDEX_CACHE_MAX_AGE_MS
        ) {
            return cached.index;
        }

        try {
            const response = await this.transport.get(new URL(indexUrl), {
                signal,
                maxBytes: INDEX_MAX_BYTES,
                etag: cached?.metadata?.etag
            });
            if (response.status === 304 && cached) {
                await this.storage.writeAtomic(paths.indexMeta, serializeJson({
                    fetchedAt: this.now(),
                    etag: response.etag ?? cached.metadata?.etag
                } satisfies IndexCacheMetadata));
                return cached.index;
            }
            if (response.status !== 200) {
                return cached?.index ?? null;
            }

            const index = parseStepCatalogIndex(parseJsonBytes(response.body));
            await this.storage.writeAtomic(paths.index, response.body);
            await this.storage.writeAtomic(paths.indexMeta, serializeJson({
                fetchedAt: this.now(),
                etag: response.etag
            } satisfies IndexCacheMetadata));
            return index;
        } catch {
            return cached?.index ?? null;
        }
    }
}
