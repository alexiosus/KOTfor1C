import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    WorkspaceStepCatalogConfiguration,
    WorkspaceStepCatalogCoordinator,
    WorkspaceStepCatalogDependencies,
    WorkspaceStepCatalogFolder,
    WorkspaceStepCatalogChangeEvent
} from '../src/stepCatalogService';
import {
    BuiltInStepCatalog,
    createStepDefinitionId,
    sha256Hex
} from '../src/stepCatalog';
import { VersionedCatalogResult } from '../src/stepCatalogClient';

const VERSION = '1.2.043.28';
const INDEX_URL = 'https://catalog.example.test/index.json';
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

function createCatalog(version = VERSION, suffix = ''): BuiltInStepCatalog {
    const ruPattern = `И пауза 1${suffix}`;
    const enPattern = `And 1 second pause${suffix}`;
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

function withCategoryMetadata(catalog: BuiltInStepCatalog): BuiltInStepCatalog {
    const ruPattern = 'Файлы';
    const enPattern = 'Files';
    return {
        ...catalog,
        steps: [
            {
                id: createStepDefinitionId(ruPattern, enPattern),
                ru: { pattern: ruPattern, description: 'Категория шагов' },
                en: { pattern: enPattern, description: 'Steps category' }
            },
            ...catalog.steps
        ]
    };
}

function downloadedResult(catalog: BuiltInStepCatalog): VersionedCatalogResult {
    return {
        catalog,
        source: 'versioned-download',
        digest: sha256Hex(JSON.stringify(catalog))
    };
}

function cachedResult(catalog: BuiltInStepCatalog): VersionedCatalogResult {
    return { ...downloadedResult(catalog), source: 'versioned-cache' };
}

interface CoordinatorFixtureOptions {
    readonly folders?: readonly WorkspaceStepCatalogFolder[];
    readonly configuration?: Partial<WorkspaceStepCatalogConfiguration>;
    readonly changelog?: string;
    readonly changelogMtime?: number;
    readonly getWorkspaceFolder?: (
        documentUri: string | undefined,
        folders: readonly WorkspaceStepCatalogFolder[]
    ) => WorkspaceStepCatalogFolder | undefined;
    readonly getCachedExactCatalog?: (
        indexUrl: string,
        version: string
    ) => Promise<VersionedCatalogResult | null>;
    readonly getExactCatalog?: (
        indexUrl: string,
        version: string
    ) => Promise<VersionedCatalogResult | null>;
    readonly getLatestCatalog?: (
        indexUrl: string
    ) => Promise<VersionedCatalogResult | null>;
}

function createCoordinator(options: CoordinatorFixtureOptions = {}): {
    coordinator: WorkspaceStepCatalogCoordinator;
    dependencies: WorkspaceStepCatalogDependencies;
    cachedExactCalls: Array<{ indexUrl: string; version: string }>;
    exactCalls: Array<{ indexUrl: string; version: string }>;
    latestCalls: string[];
    configurationFolderUris: Array<string | undefined>;
    setConfiguration(value: Partial<WorkspaceStepCatalogConfiguration>): void;
    setChangelog(value: string, mtime: number): void;
} {
    const folders = options.folders ?? [{ uri: 'file:///workspace', fsPath: '/workspace' }];
    let configuration: WorkspaceStepCatalogConfiguration = {
        vanessaVersion: '',
        vanessaEpfPath: 'tools/vanessa/vanessa-automation.epf',
        catalogIndexUrl: INDEX_URL,
        ...options.configuration
    };
    let changelog = options.changelog ?? `# Changelog\n## ${VERSION}\n`;
    let changelogMtime = options.changelogMtime ?? 100;
    const cachedExactCalls: Array<{ indexUrl: string; version: string }> = [];
    const exactCalls: Array<{ indexUrl: string; version: string }> = [];
    const latestCalls: string[] = [];
    const configurationFolderUris: Array<string | undefined> = [];

    const dependencies: WorkspaceStepCatalogDependencies = {
        getWorkspaceFolder(documentUri) {
            if (options.getWorkspaceFolder) {
                return options.getWorkspaceFolder(documentUri, folders);
            }
            if (!documentUri) {
                return folders[0];
            }
            return folders.find(folder => documentUri.startsWith(`${folder.uri}/`)) ?? folders[0];
        },
        getWorkspaceFolders: () => folders,
        getConfiguration: workspaceFolderUri => {
            configurationFolderUris.push(workspaceFolderUri);
            return configuration;
        },
        pathOperations: path.posix,
        statFile: async filePath => filePath.endsWith('/docs/Changelog.md')
            ? { mtime: changelogMtime, size: changelog.length }
            : null,
        readTextFile: async () => changelog,
        getCachedExactCatalog: async (indexUrl, version) => {
            cachedExactCalls.push({ indexUrl, version });
            return options.getCachedExactCatalog?.(indexUrl, version) ?? null;
        },
        getExactCatalog: async (indexUrl, version) => {
            exactCalls.push({ indexUrl, version });
            return options.getExactCatalog?.(indexUrl, version) ?? null;
        },
        refreshExactCatalog: async (indexUrl, version) => {
            exactCalls.push({ indexUrl, version });
            return options.getExactCatalog?.(indexUrl, version) ?? null;
        },
        getLatestCatalog: async indexUrl => {
            latestCalls.push(indexUrl);
            return options.getLatestCatalog?.(indexUrl) ?? null;
        },
        refreshLatestCatalog: async indexUrl => {
            latestCalls.push(indexUrl);
            return options.getLatestCatalog?.(indexUrl) ?? null;
        },
        warn: () => undefined
    };

    return {
        coordinator: new WorkspaceStepCatalogCoordinator(dependencies),
        dependencies,
        cachedExactCalls,
        exactCalls,
        latestCalls,
        configurationFolderUris,
        setConfiguration(value) {
            configuration = { ...configuration, ...value };
        },
        setChangelog(value, mtime) {
            changelog = value;
            changelogMtime = mtime;
        }
    };
}

test('refreshing an external resource updates every real workspace folder', async () => {
    const folders = [
        { uri: 'file:///first', fsPath: '/first' },
        { uri: 'file:///second', fsPath: '/second' }
    ];
    const fixture = createCoordinator({
        folders,
        configuration: { vanessaVersion: VERSION },
        getWorkspaceFolder: documentUri => folders.find(folder =>
            documentUri?.startsWith(`${folder.uri}/`)
        ),
        getExactCatalog: async () => downloadedResult(createCatalog())
    });

    await fixture.coordinator.refresh('file:///external/library.feature');

    assert.deepEqual(fixture.configurationFolderUris, ['file:///first', 'file:///second']);
});

test('concurrent first requests for one folder share the exact cached catalog resolution', async () => {
    const cached = deferred<VersionedCatalogResult | null>();
    const catalog = createCatalog();
    const fixture = createCoordinator({ getCachedExactCatalog: () => cached.promise });

    const first = fixture.coordinator.getCatalog('file:///workspace/first.yaml');
    const second = fixture.coordinator.getCatalog('file:///workspace/second.yaml');
    cached.resolve(cachedResult(catalog));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(fixture.cachedExactCalls.length, 1);
    assert.equal(firstResult.source, 'versioned-cache');
    assert.equal(secondResult.source, 'versioned-cache');
    assert.equal(firstResult.identity, secondResult.identity);
});

test('cached startup catalog is revalidated in background and replaced without manual refresh', async () => {
    const cached = createCatalog(VERSION, '-cached');
    const current = createCatalog(VERSION, '-current');
    const fixture = createCoordinator({
        getCachedExactCatalog: async () => cachedResult(cached),
        getExactCatalog: async () => downloadedResult(current)
    });
    const events: WorkspaceStepCatalogChangeEvent[] = [];
    fixture.coordinator.onDidChangeCatalog(event => events.push(event));

    const first = await fixture.coordinator.getCatalog('file:///workspace/test.yaml');
    await fixture.coordinator.whenIdle();
    const updated = await fixture.coordinator.getCatalog('file:///workspace/test.yaml');

    assert.equal(first.identity, `versioned:${sha256Hex(JSON.stringify(cached))}`);
    assert.equal(updated.identity, `versioned:${sha256Hex(JSON.stringify(current))}`);
    assert.equal(fixture.exactCalls.length, 1);
    assert.deepEqual(events.map(event => event.newIdentity), [updated.identity]);
});

test('versioned category metadata is not exposed as IntelliSense steps', async () => {
    const catalog = withCategoryMetadata(createCatalog());
    const fixture = createCoordinator({
        getCachedExactCatalog: async () => cachedResult(catalog)
    });

    const resolved = await fixture.coordinator.getCatalog('file:///workspace/test.yaml');

    assert.equal(resolved.source, 'versioned-cache');
    assert.deepEqual(resolved.steps.map(step => step.ru?.pattern), ['И пауза 1']);
});

test('unknown or malformed Vanessa version resolves the latest versioned catalog', async () => {
    const latest = createCatalog('1.2.043.29');
    const unknown = createCoordinator({
        changelog: '# No supported version\n',
        getLatestCatalog: async () => downloadedResult(latest)
    });
    const unknownResult = await unknown.coordinator.getCatalog('file:///workspace/a.yaml');
    assert.equal(unknownResult.catalogVersion, '1.2.043.29');
    assert.equal(unknownResult.source, 'versioned-download');
    assert.deepEqual(unknown.latestCalls, [INDEX_URL]);
    assert.equal(unknown.exactCalls.length, 0);

    const malformed = createCoordinator({
        configuration: { vanessaVersion: '1.2.43' },
        getLatestCatalog: async () => downloadedResult(latest)
    });
    assert.equal(
        (await malformed.coordinator.getCatalog('file:///workspace/a.yaml')).catalogVersion,
        '1.2.043.29'
    );
    assert.deepEqual(malformed.latestCalls, [INDEX_URL]);
});

test('missing versioned catalog returns an unavailable empty catalog instead of legacy HTML', async () => {
    const fixture = createCoordinator({
        changelog: '# Unknown\n',
        getLatestCatalog: async () => null
    });

    const resolved = await fixture.coordinator.getCatalog('file:///workspace/a.yaml');

    assert.equal(resolved.source, 'unavailable');
    assert.deepEqual(resolved.steps, []);
});

test('folders using the same version reuse one exact lookup', async () => {
    const { coordinator, exactCalls } = createCoordinator({
        folders: [
            { uri: 'file:///first', fsPath: '/first' },
            { uri: 'file:///second', fsPath: '/second' }
        ],
        configuration: { vanessaVersion: VERSION },
        getExactCatalog: async () => downloadedResult(createCatalog())
    });

    await Promise.all([
        coordinator.getCatalog('file:///first/a.yaml'),
        coordinator.getCatalog('file:///second/b.yaml')
    ]);
    assert.equal(exactCalls.length, 1);
});

test('a changelog mtime change invalidates the resolved folder version', async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.getCatalog('file:///workspace/a.yaml');
    fixture.setChangelog('# Changelog\n## 1.2.043.29\n', 200);
    await fixture.coordinator.getCatalog('file:///workspace/a.yaml');

    assert.deepEqual(fixture.exactCalls.map(call => call.version), [VERSION, '1.2.043.29']);
});

test('configuration invalidation suppresses a stale background result', async () => {
    const oldRemote = deferred<VersionedCatalogResult | null>();
    const newRemote = deferred<VersionedCatalogResult | null>();
    let call = 0;
    const fixture = createCoordinator({
        configuration: { vanessaVersion: VERSION },
        getExactCatalog: () => call++ === 0 ? oldRemote.promise : newRemote.promise
    });
    const events: WorkspaceStepCatalogChangeEvent[] = [];
    fixture.coordinator.onDidChangeCatalog(event => events.push(event));

    const oldRequest = fixture.coordinator.getCatalog('file:///workspace/a.yaml');
    fixture.setConfiguration({ vanessaVersion: '1.2.043.29' });
    fixture.coordinator.invalidateConfiguration('file:///workspace');
    const newRequest = fixture.coordinator.getCatalog('file:///workspace/a.yaml');

    oldRemote.resolve(downloadedResult(createCatalog(VERSION, '-old')));
    const newest = createCatalog('1.2.043.29', '-new');
    newRemote.resolve(downloadedResult(newest));
    const [, resolvedNewest] = await Promise.all([oldRequest, newRequest]);
    await fixture.coordinator.whenIdle();

    assert.equal(resolvedNewest.identity, `versioned:${sha256Hex(JSON.stringify(newest))}`);
    assert.deepEqual(events, []);
});
