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
const LEGACY_HTML = `
<table><tr class="R1">
<td>И пауза 1</td><td>Пауза</td><td>And 1 second pause</td><td>Pause</td>
</tr></table>`;

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

function downloadedResult(catalog: BuiltInStepCatalog): VersionedCatalogResult {
    return {
        catalog,
        source: 'versioned-download',
        digest: sha256Hex(JSON.stringify(catalog))
    };
}

interface CoordinatorFixtureOptions {
    readonly folders?: readonly WorkspaceStepCatalogFolder[];
    readonly configuration?: Partial<WorkspaceStepCatalogConfiguration>;
    readonly bundledHtml?: string;
    readonly customHtml?: string;
    readonly changelog?: string;
    readonly changelogMtime?: number;
    readonly getExactCatalog?: (
        indexUrl: string,
        version: string
    ) => Promise<VersionedCatalogResult | null>;
}

function createCoordinator(options: CoordinatorFixtureOptions = {}): {
    coordinator: WorkspaceStepCatalogCoordinator;
    dependencies: WorkspaceStepCatalogDependencies;
    exactCalls: Array<{ indexUrl: string; version: string }>;
    setConfiguration(value: Partial<WorkspaceStepCatalogConfiguration>): void;
    setChangelog(value: string, mtime: number): void;
} {
    const folders = options.folders ?? [{ uri: 'file:///workspace', fsPath: '/workspace' }];
    let configuration: WorkspaceStepCatalogConfiguration = {
        vanessaVersion: '',
        vanessaEpfPath: 'tools/vanessa/vanessa-automation.epf',
        catalogIndexUrl: INDEX_URL,
        externalUrl: '',
        ...options.configuration
    };
    let changelog = options.changelog ?? `# Changelog\n## ${VERSION}\n`;
    let changelogMtime = options.changelogMtime ?? 100;
    const exactCalls: Array<{ indexUrl: string; version: string }> = [];

    const dependencies: WorkspaceStepCatalogDependencies = {
        getWorkspaceFolder(documentUri) {
            if (!documentUri) {
                return folders[0];
            }
            return folders.find(folder => documentUri.startsWith(`${folder.uri}/`)) ?? folders[0];
        },
        getWorkspaceFolders: () => folders,
        getConfiguration: () => configuration,
        pathOperations: path.posix,
        statFile: async filePath => filePath.endsWith('/docs/Changelog.md')
            ? { mtime: changelogMtime, size: changelog.length }
            : null,
        readTextFile: async () => changelog,
        readBundledHtml: async () => options.bundledHtml ?? LEGACY_HTML,
        readCustomHtml: async () => options.customHtml ?? LEGACY_HTML,
        getCachedExactCatalog: async () => null,
        getExactCatalog: async (indexUrl, version) => {
            exactCalls.push({ indexUrl, version });
            return options.getExactCatalog?.(indexUrl, version) ?? null;
        },
        refreshExactCatalog: async (indexUrl, version) => {
            exactCalls.push({ indexUrl, version });
            return options.getExactCatalog?.(indexUrl, version) ?? null;
        },
        warn: () => undefined
    };

    return {
        coordinator: new WorkspaceStepCatalogCoordinator(dependencies),
        dependencies,
        exactCalls,
        setConfiguration(value) {
            configuration = { ...configuration, ...value };
        },
        setChangelog(value, mtime) {
            changelog = value;
            changelogMtime = mtime;
        }
    };
}

test('first offline request returns bundled catalog without waiting for remote completion', async () => {
    const remote = deferred<VersionedCatalogResult | null>();
    const { coordinator } = createCoordinator({ getExactCatalog: () => remote.promise });

    const resolved = await Promise.race([
        coordinator.getCatalog('file:///workspace/test.yaml'),
        new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('fallback waited for remote catalog')),
            50
        ))
    ]);
    assert.equal(resolved.source, 'bundled-html');
    assert.equal(resolved.steps.length, 1);
});

test('background exact catalog emits one change after fallback was returned', async () => {
    const remote = deferred<VersionedCatalogResult | null>();
    const { coordinator } = createCoordinator({ getExactCatalog: () => remote.promise });
    const events: WorkspaceStepCatalogChangeEvent[] = [];
    coordinator.onDidChangeCatalog(event => events.push(event));

    await coordinator.getCatalog('file:///workspace/test.yaml');
    const catalog = createCatalog();
    remote.resolve(downloadedResult(catalog));
    await coordinator.whenIdle();

    assert.deepEqual(events.map(event => event.newIdentity), [
        `versioned:${sha256Hex(JSON.stringify(catalog))}`
    ]);
});

test('unknown or malformed configured version uses fallback without a catalog request', async () => {
    const unknown = createCoordinator({ changelog: '# No supported version\n' });
    assert.equal((await unknown.coordinator.getCatalog('file:///workspace/a.yaml')).source, 'bundled-html');
    assert.equal(unknown.exactCalls.length, 0);

    const malformed = createCoordinator({
        configuration: { vanessaVersion: '1.2.43' },
        changelog: `## ${VERSION}\n`
    });
    assert.equal((await malformed.coordinator.getCatalog('file:///workspace/a.yaml')).source, 'bundled-html');
    assert.equal(malformed.exactCalls.length, 0);
});

test('invalid custom HTML falls through to the bundled catalog', async () => {
    const { coordinator } = createCoordinator({
        configuration: { vanessaVersion: '', externalUrl: 'https://custom.example/steps.htm' },
        customHtml: '<html>not a steps table</html>',
        changelog: '# Unknown\n'
    });

    const resolved = await coordinator.getCatalog('file:///workspace/a.yaml');
    assert.equal(resolved.source, 'bundled-html');
    assert.equal(resolved.steps[0].ru?.pattern, 'И пауза 1');
});

test('folders using the same version reuse one background exact lookup', async () => {
    const remote = deferred<VersionedCatalogResult | null>();
    const { coordinator, exactCalls } = createCoordinator({
        folders: [
            { uri: 'file:///first', fsPath: '/first' },
            { uri: 'file:///second', fsPath: '/second' }
        ],
        configuration: { vanessaVersion: VERSION },
        getExactCatalog: () => remote.promise
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

    await fixture.coordinator.getCatalog('file:///workspace/a.yaml');
    fixture.setConfiguration({ vanessaVersion: '1.2.043.29' });
    fixture.coordinator.invalidateConfiguration('file:///workspace');
    await fixture.coordinator.getCatalog('file:///workspace/a.yaml');

    oldRemote.resolve(downloadedResult(createCatalog(VERSION, '-old')));
    const newest = createCatalog('1.2.043.29', '-new');
    newRemote.resolve(downloadedResult(newest));
    await fixture.coordinator.whenIdle();

    assert.deepEqual(events.map(event => event.newIdentity), [
        `versioned:${sha256Hex(JSON.stringify(newest))}`
    ]);
});
