import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectDefinitionFileRecord } from '../src/projectDefinition';
import {
    parseProjectDefinitionCache,
    ProjectDefinitionCache
} from '../src/projectDefinitionCache';
import {
    ProjectDefinitionIndexService,
    type ProjectDefinitionCacheStore,
    type ProjectDefinitionFileSystem,
    type ProjectDefinitionIndexConfiguration,
    type ProjectDefinitionWatcherCallbacks
} from '../src/projectDefinitionIndexService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

interface MemoryFile {
    content: string;
    mtimeMs: number;
}

class MemoryFileSystem implements ProjectDefinitionFileSystem {
    readonly files = new Map<string, MemoryFile>();
    readonly directoryReads: string[] = [];
    readonly fileReads: string[] = [];
    activeDirectoryReads = 0;
    maxDirectoryReads = 0;
    activeFileReads = 0;
    maxFileReads = 0;
    delay = false;
    blockedDirectory?: { path: string; gate: ReturnType<typeof deferred<void>> };

    setFile(filePath: string, content: string, mtimeMs = Date.now()): void {
        this.files.set(path.posix.normalize(filePath), { content, mtimeMs });
    }

    deleteFile(filePath: string): void {
        this.files.delete(path.posix.normalize(filePath));
    }

    async readDirectory(directoryPath: string) {
        const normalized = path.posix.normalize(directoryPath);
        this.directoryReads.push(normalized);
        this.activeDirectoryReads += 1;
        this.maxDirectoryReads = Math.max(this.maxDirectoryReads, this.activeDirectoryReads);
        if (this.blockedDirectory?.path === normalized) {
            await this.blockedDirectory.gate.promise;
        } else if (this.delay) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
        const entries = new Map<string, 'file' | 'directory'>();
        for (const filePath of this.files.keys()) {
            if (!filePath.startsWith(prefix)) {
                continue;
            }
            const tail = filePath.slice(prefix.length);
            const slash = tail.indexOf('/');
            entries.set(slash < 0 ? tail : tail.slice(0, slash), slash < 0 ? 'file' : 'directory');
        }
        this.activeDirectoryReads -= 1;
        return [...entries].map(([name, type]) => ({ name, type }));
    }

    async stat(filePath: string) {
        const file = this.files.get(path.posix.normalize(filePath));
        if (!file) {
            throw new Error(`ENOENT: ${filePath}`);
        }
        return { size: Buffer.byteLength(file.content), mtimeMs: file.mtimeMs };
    }

    async readFile(filePath: string) {
        const normalized = path.posix.normalize(filePath);
        const file = this.files.get(normalized);
        if (!file) {
            throw new Error(`ENOENT: ${filePath}`);
        }
        this.fileReads.push(normalized);
        this.activeFileReads += 1;
        this.maxFileReads = Math.max(this.maxFileReads, this.activeFileReads);
        if (this.delay) {
            await new Promise(resolve => setImmediate(resolve));
        }
        this.activeFileReads -= 1;
        return file.content;
    }

    async realpath(value: string): Promise<string> {
        return path.posix.normalize(value);
    }
}

class MemoryCache implements ProjectDefinitionCacheStore {
    records: readonly ProjectDefinitionFileRecord[] | null = null;
    loads = 0;
    saves = 0;

    async load(): Promise<readonly ProjectDefinitionFileRecord[] | null> {
        this.loads += 1;
        return this.records;
    }

    async save(_configurationIdentity: string, _parserVersion: string, records: readonly ProjectDefinitionFileRecord[]) {
        this.saves += 1;
        this.records = records;
    }
}

class WatchHarness {
    readonly callbacks = new Map<string, ProjectDefinitionWatcherCallbacks>();
    readonly disposed: string[] = [];

    watch = (root: string, callbacks: ProjectDefinitionWatcherCallbacks) => {
        this.callbacks.set(root, callbacks);
        return {
            dispose: () => {
                this.disposed.push(root);
                this.callbacks.delete(root);
            }
        };
    };
}

const exportFeature = (title: string) => [
    '@ExportScenarios',
    'Feature: Project exports',
    '',
    `Scenario: ${title}`,
    '    Given ready'
].join('\n');

const userStep = (title: string) => [
    'Функция ПолучитьСписокТестов(Контекст) Экспорт',
    '    ВсеТесты = Новый Массив;',
    `    Ванесса.ДобавитьШагВМассивТестов(ВсеТесты, "Step()", "Step", "${title}", "", "");`,
    '    Возврат ВсеТесты;',
    'КонецФункции'
].join('\n');

function configuration(
    profileId: string,
    root = `/workspace/${profileId}`,
    identity = `configuration-${profileId}`
): ProjectDefinitionIndexConfiguration {
    return {
        identity,
        workspaceFolderPath: '/workspace',
        workspaceFolderUri: 'file:///workspace',
        profileId,
        libraryRootPaths: [root],
        warnings: []
    };
}

function createService(
    fileSystem: MemoryFileSystem,
    options: {
        cache?: MemoryCache;
        watches?: WatchHarness;
        concurrency?: number;
    } = {}
) {
    return new ProjectDefinitionIndexService({
        parserVersion: 'parser-v1',
        fileSystem,
        cache: options.cache ?? new MemoryCache(),
        watch: options.watches?.watch,
        directoryConcurrency: options.concurrency ?? 2,
        readConcurrency: options.concurrency ?? 2,
        yieldEvery: 2
    });
}

test('reuses exact cached records and reads only changed files', async () => {
    const fileSystem = new MemoryFileSystem();
    const featurePath = '/workspace/active/export.feature';
    const bslPath = '/workspace/active/UserSteps.bsl';
    fileSystem.setFile(featurePath, exportFeature('Cached export'), 10);
    fileSystem.setFile(bslPath, userStep('И живой шаг'), 20);
    const cache = new MemoryCache();
    const first = createService(fileSystem, { cache });
    first.startProfile(configuration('active'));
    await first.waitForIdle();
    const cachedFeature = first.getSnapshot()?.files.get('file:///workspace/active/export.feature');
    assert.ok(cachedFeature);
    first.dispose();

    cache.records = [cachedFeature];
    fileSystem.fileReads.length = 0;
    const second = createService(fileSystem, { cache });
    second.startProfile(configuration('active'));
    await second.waitForIdle();

    assert.deepEqual(fileSystem.fileReads, [bslPath]);
    assert.deepEqual(second.getSnapshot()?.definitions.map(item => item.template), [
        'Cached export',
        'И живой шаг'
    ]);
    assert.equal(cache.saves >= 2, true);
});

test('watcher create, change, and delete update only the affected source file', async () => {
    const fileSystem = new MemoryFileSystem();
    const watches = new WatchHarness();
    const root = '/workspace/active';
    const firstPath = `${root}/one.feature`;
    const secondPath = `${root}/two.feature`;
    fileSystem.setFile(firstPath, exportFeature('First'), 1);
    const service = createService(fileSystem, { watches });
    service.startProfile(configuration('active', root));
    await service.waitForIdle();
    const callbacks = watches.callbacks.get(root);
    assert.ok(callbacks);

    fileSystem.setFile(firstPath, exportFeature('Changed'), 2);
    callbacks.change(firstPath);
    await service.waitForIdle();
    assert.deepEqual(service.getSnapshot()?.definitions.map(item => item.template), ['Changed']);

    fileSystem.setFile(secondPath, exportFeature('Created'), 3);
    callbacks.create(secondPath);
    await service.waitForIdle();
    assert.deepEqual(service.getSnapshot()?.definitions.map(item => item.template), ['Changed', 'Created']);

    fileSystem.deleteFile(firstPath);
    callbacks.delete(firstPath);
    await service.waitForIdle();
    assert.deepEqual(service.getSnapshot()?.definitions.map(item => item.template), ['Created']);
    assert.equal(fileSystem.fileReads.filter(item => item === secondPath).length, 1);
});

test('profile changes dispose old watchers and suppress stale completed scans', async () => {
    const fileSystem = new MemoryFileSystem();
    const watches = new WatchHarness();
    const gate = deferred<void>();
    fileSystem.blockedDirectory = { path: '/workspace/profile-a', gate };
    fileSystem.setFile('/workspace/profile-a/a.feature', exportFeature('Old profile'), 1);
    fileSystem.setFile('/workspace/profile-b/b.feature', exportFeature('New profile'), 1);
    const service = createService(fileSystem, { watches });

    service.startProfile(configuration('profile-a'));
    service.startProfile(configuration('profile-b'));
    gate.resolve();
    await service.waitForIdle();

    assert.equal(service.getSnapshot()?.profileId, 'profile-b');
    assert.deepEqual(service.getSnapshot()?.definitions.map(item => item.template), ['New profile']);
    assert.equal(watches.disposed.includes('/workspace/profile-a'), true);
});

test('bounds directory and source reads and never reads binary EPFs', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.delay = true;
    for (let index = 0; index < 8; index++) {
        fileSystem.setFile(`/workspace/active/lib-${index}/step-${index}.feature`, exportFeature(`Step ${index}`), index + 1);
    }
    fileSystem.setFile('/workspace/active/step_definitions/OnlyBinary.epf', 'binary', 20);
    fileSystem.setFile('/workspace/active/step_definitions/HasSource.epf', 'binary', 20);
    fileSystem.setFile(
        '/workspace/active/step_definitions-src/HasSource/Module.bsl',
        userStep('И исходный шаг'),
        21
    );
    const service = createService(fileSystem, { concurrency: 2 });
    service.startProfile(configuration('active'));
    await service.waitForIdle();

    assert.equal(fileSystem.maxDirectoryReads <= 2, true);
    assert.equal(fileSystem.maxFileReads <= 2, true);
    assert.equal(fileSystem.fileReads.some(item => item.endsWith('.epf')), false);
    const binaryWarnings = service.getSnapshot()?.warnings.filter(item => /binary-only/i.test(item.message));
    assert.equal(binaryWarnings?.length, 1);
    assert.match(binaryWarnings?.[0].message ?? '', /1 binary-only/i);
});

test('dispose cancels work, disposes watchers, and prevents later publication', async () => {
    const fileSystem = new MemoryFileSystem();
    const watches = new WatchHarness();
    const gate = deferred<void>();
    fileSystem.blockedDirectory = { path: '/workspace/active', gate };
    fileSystem.setFile('/workspace/active/a.feature', exportFeature('Late'), 1);
    const service = createService(fileSystem, { watches });
    let changes = 0;
    service.onDidChangeSnapshot(() => { changes += 1; });
    service.startProfile(configuration('active'));
    service.dispose();
    gate.resolve();
    await service.waitForIdle();

    assert.equal(service.getSnapshot(), null);
    assert.equal(changes, 0);
    assert.equal(watches.disposed.includes('/workspace/active'), true);
});

test('start schedules configuration loading without waiting for it', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.setFile('/workspace/active/a.feature', exportFeature('Started'), 1);
    const loading = deferred<readonly ProjectDefinitionIndexConfiguration[]>();
    const service = new ProjectDefinitionIndexService({
        parserVersion: 'parser-v1',
        fileSystem,
        cache: new MemoryCache(),
        loadConfigurations: () => loading.promise
    });

    assert.equal(service.start(), undefined);
    assert.equal(service.getSnapshot(), null);
    loading.resolve([configuration('active')]);
    await service.waitForIdle();
    assert.deepEqual(service.getSnapshot()?.definitions.map(item => item.template), ['Started']);
});

test('ensureReady observes caller cancellation without publishing a partial snapshot', async () => {
    const fileSystem = new MemoryFileSystem();
    const gate = deferred<void>();
    fileSystem.blockedDirectory = { path: '/workspace/active', gate };
    fileSystem.setFile('/workspace/active/a.feature', exportFeature('Eventually ready'), 1);
    const service = createService(fileSystem);
    const listeners = new Set<() => void>();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        }
    };
    service.startProfile(configuration('active'));
    const ready = service.ensureReady(undefined, token);
    token.isCancellationRequested = true;
    for (const listener of [...listeners]) {
        listener();
    }

    await assert.rejects(ready, /cancelled/i);
    assert.equal(service.getSnapshot(), null);
    gate.resolve();
    await service.waitForIdle();
    assert.deepEqual(service.getSnapshot()?.definitions.map(item => item.template), ['Eventually ready']);
});

test('persistent cache round-trips valid records and rejects incompatible or malformed data', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-definition-cache-'));
    try {
        const cache = new ProjectDefinitionCache(directory);
        const fileRecord: ProjectDefinitionFileRecord = {
            uri: 'file:///workspace/a.feature',
            size: 10,
            mtimeMs: 20,
            parserVersion: 'parser-v1',
            definitions: [],
            warnings: []
        };
        await cache.save('configuration-a', 'parser-v1', [fileRecord]);

        assert.equal((await cache.load('configuration-a', 'parser-v1'))?.length, 1);
        assert.equal(await cache.load('configuration-b', 'parser-v1'), null);
        assert.equal(await cache.load('configuration-a', 'parser-v2'), null);
        assert.equal(parseProjectDefinitionCache('{bad json', 'configuration-a', 'parser-v1'), null);
        assert.equal(parseProjectDefinitionCache(JSON.stringify({ schemaVersion: 1 }), 'configuration-a', 'parser-v1'), null);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
