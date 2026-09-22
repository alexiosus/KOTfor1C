import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getStepCatalogCachePaths,
    StepCatalogHttpResponse,
    StepCatalogStorage,
    StepCatalogTransport,
    VersionedStepCatalogClient
} from '../src/stepCatalogClient';
import {
    BuiltInStepCatalog,
    createStepDefinitionId,
    sha256Hex,
    StepCatalogIndexEntry
} from '../src/stepCatalog';

const INDEX_URL = 'https://catalog.example.test/index.json';
const VERSION = '1.2.043.28';
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const encoder = new TextEncoder();

function createCatalog(version = VERSION): BuiltInStepCatalog {
    const ruPattern = 'И пауза 1';
    const enPattern = 'And 1 second pause';
    return {
        schemaVersion: 1,
        vanessaVersion: version,
        generatedAt: '2026-09-22T00:00:00.000Z',
        source: {
            repository: 'Pr-Mex/vanessa-automation',
            ref: version,
            commit: SOURCE_COMMIT
        },
        steps: [{
            id: createStepDefinitionId(ruPattern, enPattern),
            ru: { pattern: ruPattern, description: 'Пауза' },
            en: { pattern: enPattern, description: 'Pause' }
        }]
    };
}

function jsonBytes(value: unknown): Uint8Array {
    return encoder.encode(`${JSON.stringify(value)}\n`);
}

function catalogEntry(catalogBytes: Uint8Array, stepCount = 1): StepCatalogIndexEntry {
    return {
        path: `${VERSION}/catalog.json`,
        sha256: sha256Hex(catalogBytes),
        stepCount,
        sourceCommit: SOURCE_COMMIT
    };
}

function indexResponse(
    catalogs: Readonly<Record<string, StepCatalogIndexEntry>>
): StepCatalogHttpResponse {
    return {
        status: 200,
        body: jsonBytes({
            schemaVersion: 1,
            generatedAt: '2026-09-22T00:00:00.000Z',
            catalogs
        }),
        etag: '"index-1"'
    };
}

function catalogResponse(catalog: BuiltInStepCatalog): StepCatalogHttpResponse {
    return { status: 200, body: jsonBytes(catalog), etag: '"catalog-1"' };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

class MemoryStorage implements StepCatalogStorage {
    public readonly files = new Map<string, Uint8Array>();

    public constructor(initial: Readonly<Record<string, Uint8Array>> = {}) {
        Object.entries(initial).forEach(([key, value]) => this.files.set(key, value));
    }

    public async read(relativePath: string): Promise<Uint8Array | null> {
        return this.files.get(relativePath) ?? null;
    }

    public async writeAtomic(relativePath: string, bytes: Uint8Array): Promise<void> {
        this.files.set(relativePath, bytes);
    }
}

class FakeTransport implements StepCatalogTransport {
    public calls = 0;

    public constructor(
        private readonly responses: readonly Array<Promise<StepCatalogHttpResponse>>
    ) {}

    public get(): Promise<StepCatalogHttpResponse> {
        const response = this.responses[this.calls++];
        return response ?? Promise.reject(new Error('offline'));
    }
}

class SizeEnforcingTransport implements StepCatalogTransport {
    public calls = 0;

    public constructor(private readonly bodies: readonly Uint8Array[]) {}

    public async get(
        _url: URL,
        options: { readonly maxBytes: number }
    ): Promise<StepCatalogHttpResponse> {
        const body = this.bodies[this.calls++];
        if (!body) {
            throw new Error('offline');
        }
        if (body.byteLength > options.maxBytes) {
            throw new Error('maximum size exceeded');
        }
        return { status: 200, body };
    }
}

test('shares one in-flight promise for concurrent exact-version requests', async () => {
    const catalog = createCatalog();
    const catalogBytes = jsonBytes(catalog);
    const pendingIndex = deferred<StepCatalogHttpResponse>();
    const transport = new FakeTransport([
        pendingIndex.promise,
        Promise.resolve({ status: 200, body: catalogBytes })
    ]);
    const client = new VersionedStepCatalogClient(new MemoryStorage(), transport, () => 1_000);

    const first = client.getExactCatalog(INDEX_URL, VERSION);
    const second = client.getExactCatalog(INDEX_URL, VERSION);
    assert.equal(first, second);

    pendingIndex.resolve(indexResponse({ [VERSION]: catalogEntry(catalogBytes) }));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult?.source, 'versioned-download');
    assert.equal(secondResult?.digest, sha256Hex(catalogBytes));
    assert.equal(transport.calls, 2);
});

test('does not fall forward when the exact version is absent', async () => {
    const newerCatalog = createCatalog('1.2.043.29');
    const newerBytes = jsonBytes(newerCatalog);
    const transport = new FakeTransport([
        Promise.resolve(indexResponse({
            '1.2.043.29': {
                ...catalogEntry(newerBytes),
                path: '1.2.043.29/catalog.json'
            }
        }))
    ]);
    const client = new VersionedStepCatalogClient(new MemoryStorage(), transport, () => 1_000);

    assert.equal(await client.getExactCatalog(INDEX_URL, VERSION), null);
    assert.equal(transport.calls, 1);
});

test('returns a valid exact cache without contacting the network', async () => {
    const catalog = createCatalog();
    const catalogBytes = jsonBytes(catalog);
    const paths = getStepCatalogCachePaths(INDEX_URL, VERSION);
    const storage = new MemoryStorage({ [paths.catalog]: catalogBytes });
    const transport = new FakeTransport([]);
    const client = new VersionedStepCatalogClient(storage, transport, () => 1_000);

    const result = await client.getExactCatalog(INDEX_URL, VERSION);
    assert.equal(result?.source, 'versioned-cache');
    assert.equal(result?.digest, sha256Hex(catalogBytes));
    assert.equal(transport.calls, 0);
});

test('invalid downloaded hash preserves a valid exact cache during refresh', async () => {
    const catalog = createCatalog();
    const cachedBytes = jsonBytes(catalog);
    const paths = getStepCatalogCachePaths(INDEX_URL, VERSION);
    const storage = new MemoryStorage({ [paths.catalog]: cachedBytes });
    const invalidEntry = { ...catalogEntry(cachedBytes), sha256: '0'.repeat(64) };
    const transport = new FakeTransport([
        Promise.resolve(indexResponse({ [VERSION]: invalidEntry })),
        Promise.resolve(catalogResponse(catalog))
    ]);
    const client = new VersionedStepCatalogClient(storage, transport, () => 1_000);

    const result = await client.refreshExactCatalog(INDEX_URL, VERSION);
    assert.equal(result?.source, 'versioned-cache');
    assert.deepEqual(await storage.read(paths.catalog), cachedBytes);
});

test('rejects a downloaded catalog whose declared version or count does not match', async () => {
    const wrongVersion = createCatalog('1.2.043.29');
    const wrongBytes = jsonBytes(wrongVersion);
    const transport = new FakeTransport([
        Promise.resolve(indexResponse({ [VERSION]: catalogEntry(wrongBytes, 2) })),
        Promise.resolve({ status: 200, body: wrongBytes })
    ]);
    const client = new VersionedStepCatalogClient(new MemoryStorage(), transport, () => 1_000);

    assert.equal(await client.getExactCatalog(INDEX_URL, VERSION), null);
});

test('returns null on first-run offline or invalid index JSON', async () => {
    const offlineClient = new VersionedStepCatalogClient(
        new MemoryStorage(),
        new FakeTransport([Promise.reject(new Error('offline'))]),
        () => 1_000
    );
    assert.equal(await offlineClient.getExactCatalog(INDEX_URL, VERSION), null);

    const invalidClient = new VersionedStepCatalogClient(
        new MemoryStorage(),
        new FakeTransport([Promise.resolve({ status: 200, body: encoder.encode('{') })]),
        () => 1_000
    );
    assert.equal(await invalidClient.getExactCatalog(INDEX_URL, VERSION), null);
});

test('rejects oversized index and catalog responses', async () => {
    const oversizedIndexTransport = new SizeEnforcingTransport([
        new Uint8Array(1024 * 1024 + 1)
    ]);
    const oversizedIndexClient = new VersionedStepCatalogClient(
        new MemoryStorage(),
        oversizedIndexTransport,
        () => 1_000
    );
    assert.equal(await oversizedIndexClient.getExactCatalog(INDEX_URL, VERSION), null);
    assert.equal(oversizedIndexTransport.calls, 1);

    const catalog = createCatalog();
    const validCatalogBytes = jsonBytes(catalog);
    const indexBytes = indexResponse({ [VERSION]: catalogEntry(validCatalogBytes) }).body;
    const oversizedCatalogTransport = new SizeEnforcingTransport([
        indexBytes,
        new Uint8Array(20 * 1024 * 1024 + 1)
    ]);
    const oversizedCatalogClient = new VersionedStepCatalogClient(
        new MemoryStorage(),
        oversizedCatalogTransport,
        () => 1_000
    );
    assert.equal(await oversizedCatalogClient.getExactCatalog(INDEX_URL, VERSION), null);
    assert.equal(oversizedCatalogTransport.calls, 2);
});

test('rejects an unsafe path in a downloaded index', async () => {
    const catalog = createCatalog();
    const catalogBytes = jsonBytes(catalog);
    const unsafeEntry = { ...catalogEntry(catalogBytes), path: '../catalog.json' };
    const client = new VersionedStepCatalogClient(
        new MemoryStorage(),
        new FakeTransport([Promise.resolve(indexResponse({ [VERSION]: unsafeEntry }))]),
        () => 1_000
    );

    assert.equal(await client.getExactCatalog(INDEX_URL, VERSION), null);
});

test('uses separate cache namespaces for different index URLs', () => {
    const first = getStepCatalogCachePaths('https://one.example/index.json', VERSION);
    const second = getStepCatalogCachePaths('https://two.example/index.json', VERSION);
    assert.notEqual(first.catalog, second.catalog);
    assert.match(first.catalog, new RegExp(`${VERSION}/catalog\\.json$`));
});
