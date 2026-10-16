import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    deleteFileWithTrashFallback,
    ScenarioFilesService,
    type ScenarioFileConflictDecision,
    type ScenarioFilesDirectoryEntry,
    type ScenarioFilesHost,
    type ScenarioFilesUri,
    type ScenarioFilesWatcher
} from '../src/scenarioFilesService';
import type { StepLibraryItem } from '../src/stepLibraryModel';

interface Disposable {
    dispose(): void;
}

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}

class RecordingWatcher implements ScenarioFilesWatcher {
    readonly creates = new EventHub<ScenarioFilesUri>();
    readonly changes = new EventHub<ScenarioFilesUri>();
    readonly deletes = new EventHub<ScenarioFilesUri>();
    readonly onDidCreate = this.creates.event;
    readonly onDidChange = this.changes.event;
    readonly onDidDelete = this.deletes.event;
    disposed = false;

    dispose(): void {
        this.disposed = true;
    }
}

class RecordingHost implements ScenarioFilesHost {
    readonly readDirectoryCalls: string[] = [];
    readonly opened: string[] = [];
    readonly openedInEditor: string[] = [];
    readonly revealed: string[] = [];
    readonly deleteConfirmations: string[] = [];
    readonly deleted: string[] = [];
    confirmDeleteResult = true;
    renameTo: string | undefined = 'Renamed.csv';
    async promptRename(): Promise<string | undefined> { return this.renameTo; }
    readonly createdWatchers: Array<{ root: string; watcher: RecordingWatcher }> = [];
    conflictDecision: ScenarioFileConflictDecision = 'skip';
    readonly conflicts: string[] = [];

    parseUri(value: string): ScenarioFilesUri {
        return new URL(value);
    }

    dirname(uri: ScenarioFilesUri): ScenarioFilesUri {
        return pathToFileURL(path.dirname(fileURLToPath(uri.toString())));
    }

    joinPath(base: ScenarioFilesUri, ...segments: readonly string[]): ScenarioFilesUri {
        return pathToFileURL(path.join(fileURLToPath(base.toString()), ...segments));
    }

    async readDirectory(uri: ScenarioFilesUri): Promise<readonly ScenarioFilesDirectoryEntry[]> {
        this.readDirectoryCalls.push(uri.toString());
        const entries = await fs.readdir(fileURLToPath(uri.toString()), { withFileTypes: true });
        return entries.map(entry => ({
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'symbolicLink'
        }));
    }

    isFileNotFound(error: unknown): boolean {
        return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
    }

    async openExternal(uri: ScenarioFilesUri): Promise<boolean> {
        this.opened.push(uri.toString());
        return true;
    }

    async openInEditor(uri: ScenarioFilesUri): Promise<boolean> {
        this.openedInEditor.push(uri.toString());
        return true;
    }

    async revealInOs(uri: ScenarioFilesUri): Promise<void> {
        this.revealed.push(uri.toString());
    }

    async confirmDelete(relativePath: string): Promise<boolean> {
        this.deleteConfirmations.push(relativePath);
        return this.confirmDeleteResult;
    }

    async deleteFile(uri: ScenarioFilesUri): Promise<void> {
        this.deleted.push(uri.toString());
    }

    createWatcher(root: ScenarioFilesUri): ScenarioFilesWatcher {
        const watcher = new RecordingWatcher();
        this.createdWatchers.push({ root: root.toString(), watcher });
        return watcher;
    }

    async chooseConflict(relativePath: string): Promise<ScenarioFileConflictDecision> {
        this.conflicts.push(relativePath);
        return this.conflictDecision;
    }
}

test('attachment rename preserves the folder and content, invalidates search, and never overwrites another file', async t => {
    const f = await createScenarioFilesFixture(t, { 'Fixtures/Data.csv': 'contents', 'Fixtures/Existing.csv': 'existing' });
    assert.deepEqual(await f.service.listAttachmentPaths(f.item), ['Fixtures/Data.csv', 'Fixtures/Existing.csv']);
    assert.equal(await f.service.renameFile(f.item, 'Fixtures/Data.csv'), 'renamed');
    assert.equal(await fs.readFile(path.join(f.directory, 'files/Fixtures/Renamed.csv'), 'utf8'), 'contents');
    assert.deepEqual(await f.service.listAttachmentPaths(f.item), ['Fixtures/Existing.csv', 'Fixtures/Renamed.csv']);
    f.host.renameTo = 'Existing.csv';
    await assert.rejects(f.service.renameFile(f.item, 'Fixtures/Renamed.csv'), /exists/i);
    assert.equal(await fs.readFile(path.join(f.directory, 'files/Fixtures/Existing.csv'), 'utf8'), 'existing');
});

test('attachment rename rejects traversal, folders, symlinks, stale selections, and cancellation', async t => {
    const f = await createScenarioFilesFixture(t, { 'Data.csv': 'contents', 'Folder/data.csv': 'nested' });
    for (const name of ['../escape.csv', 'folder/file.csv', 'bad\\file.csv', '.', '..', '', 'bad\0name']) {
        f.host.renameTo = name;
        await assert.rejects(f.service.renameFile(f.item, 'Data.csv'), /name|path/i);
    }
    f.host.renameTo = undefined;
    assert.equal(await f.service.renameFile(f.item, 'Data.csv'), 'cancelled');
    f.host.renameTo = 'Changed.csv';
    await assert.rejects(f.service.renameFile(f.item, 'Folder'), /file|regular/i);
    await fs.symlink(path.join(f.directory, 'files/Data.csv'), path.join(f.directory, 'files/link.csv'));
    await assert.rejects(f.service.renameFile(f.item, 'link.csv'), /symbolic/i);
    await assert.rejects(f.service.renameFile(f.item, 'Data.csv', () => false), /changed/i);
    assert.equal(await fs.readFile(path.join(f.directory, 'files/Data.csv'), 'utf8'), 'contents');
});

test('a changed source cancels attachment deletion after confirmation', async t => {
    const fixture = await createScenarioFilesFixture(t, { 'data.txt': 'Keep' }); let current = true;
    fixture.host.confirmDelete = async () => { current = false; return true; };
    await assert.rejects(fixture.service.deleteFile(fixture.item, 'data.txt', () => current), /changed|cancel/i);
    assert.deepEqual(fixture.host.deleted, []);
});

test('a changed source cancels a conflicting attachment upload before transfer allocation', async t => {
    const fixture = await createScenarioFilesFixture(t, { 'data.txt': 'Keep' }); let current = true;
    fixture.host.chooseConflict = async () => { current = false; return 'replace'; };
    await assert.rejects(fixture.service.prepareDrop(fixture.item, '', [{ clientPath: 'data.txt', kind: 'file', size: 3 }], () => current), /changed|cancel/i);
    assert.equal(await fs.readFile(path.join(fixture.directory, 'files', 'data.txt'), 'utf8'), 'Keep');
    assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'files')), ['data.txt']);
});

function nestedItem(scenarioDirectory: string, overrides: Partial<StepLibraryItem> = {}): StepLibraryItem {
    return {
        id: 'nested#authored',
        definitionId: 'nested',
        familyId: 'nested',
        kind: 'nestedScenario',
        sourceGroup: 'nested',
        template: 'Create invoice',
        displayText: 'Create invoice',
        categoryPath: [],
        parameters: [],
        sourceLabel: 'Nested scenario',
        navigable: true,
        insertable: true,
        hasScenarioFiles: true,
        capturedLocation: {
            uri: pathToFileURL(path.join(scenarioDirectory, 'scen.yaml')).toString(),
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        },
        searchText: 'create invoice',
        ...overrides
    };
}

function compiledMainItem(featurePath: string, filesRootPath: string): StepLibraryItem {
    return {
        id: 'main#compiled',
        definitionId: 'main',
        familyId: 'main',
        kind: 'mainScenario',
        sourceGroup: 'main',
        template: '004_Production',
        displayText: '004_Production',
        categoryPath: ['Production'],
        parameters: [],
        sourceLabel: 'Main scenario',
        navigable: true,
        insertable: false,
        hasScenarioFiles: true,
        searchText: '004 production',
        ...({
            compiledFeatureUri: pathToFileURL(featurePath).toString(),
            scenarioFilesRootUri: pathToFileURL(filesRootPath).toString()
        } as object)
    } as StepLibraryItem;
}

async function createScenarioFilesFixture(
    t: TestContext,
    files: Readonly<Record<string, string>>,
    createFilesRoot = true
): Promise<{
    readonly directory: string;
    readonly item: StepLibraryItem;
    readonly host: RecordingHost;
    readonly service: ScenarioFilesService;
}> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-scenario-files-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(path.join(directory, 'scen.yaml'), 'ТипФайла: Сценарий\n');
    if (createFilesRoot) {
        await fs.mkdir(path.join(directory, 'files'), { recursive: true });
    }
    for (const [relativePath, content] of Object.entries(files)) {
        const target = path.join(directory, 'files', relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
    }
    const host = new RecordingHost();
    const service = new ScenarioFilesService(host);
    t.after(() => service.dispose());
    return { directory, item: nestedItem(directory), host, service };
}

async function createDirectorySymlinkOrSkip(
    t: TestContext,
    target: string,
    linkPath: string
): Promise<boolean> {
    try {
        await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
            && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip('directory symlinks are not permitted on this host');
            return false;
        }
        throw error;
    }
}

test('scenario files service lists one directory level with directories first', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'z.txt': 'z',
        'Alpha/a.txt': 'a',
        'beta.txt': 'b'
    });

    const nodes = await fixture.service.listChildren(fixture.item, '');

    assert.deepEqual(nodes.map(node => [node.kind, node.name]), [
        ['directory', 'Alpha'],
        ['file', 'beta.txt'],
        ['file', 'z.txt']
    ]);
    assert.equal(fixture.host.readDirectoryCalls.length, 1);
    assert.equal(fixture.host.readDirectoryCalls[0], pathToFileURL(path.join(fixture.directory, 'files')).toString());
});

test('attachment search lists safe files recursively and reuses the root cache', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'invoice.xlsx': 'invoice',
        'Fixtures/Данные.MXL': 'data',
        '.DS_Store': 'metadata',
        '.pending.kot-upload': 'upload'
    });
    const first = await fixture.service.listAttachmentPaths(fixture.item);
    assert.deepEqual(first, ['Fixtures/Данные.MXL', 'invoice.xlsx']);
    const readCount = fixture.host.readDirectoryCalls.length;

    const again = await fixture.service.listAttachmentPaths({ ...fixture.item, id: 'same-root' });
    assert.deepEqual(again, first);
    assert.equal(fixture.host.readDirectoryCalls.length, readCount);
});

test('attachment search includes authored main files before any compilation', async t => {
    const fixture = await createScenarioFilesFixture(t, { 'Входная таблица.xlsx': 'input' });
    const main = { ...fixture.item, kind: 'mainScenario' as const, sourceGroup: 'main' as const, hasScenarioFiles: undefined };
    assert.deepEqual(await fixture.service.listAttachmentPaths(main), ['Входная таблица.xlsx']);
});

test('attachment search merges authored and compiled resource files', async t => {
    const fixture = await createScenarioFilesFixture(t, { 'authored.csv': 'input', 'shared.txt': 'source' });
    const compiledRoot = path.join(fixture.directory, 'build', 'Sales', 'Файлы');
    await fs.mkdir(compiledRoot, { recursive: true });
    await fs.writeFile(path.join(compiledRoot, 'compiled.mxl'), 'output');
    await fs.writeFile(path.join(compiledRoot, 'shared.txt'), 'copy');
    const main = {
        ...fixture.item,
        ...compiledMainItem(path.join(fixture.directory, 'build', 'Sales.feature'), compiledRoot),
        capturedLocation: fixture.item.capturedLocation
    };
    assert.deepEqual(await fixture.service.listAttachmentPaths(main), ['authored.csv', 'compiled.mxl', 'shared.txt']);
});

test('attachment search updates a cached missing files root after watcher creation', async t => {
    const fixture = await createScenarioFilesFixture(t, {}, false);
    assert.deepEqual(await fixture.service.listAttachmentPaths(fixture.item), []);
    const created = path.join(fixture.directory, 'files', 'new.csv');
    await fs.mkdir(path.dirname(created), { recursive: true });
    await fs.writeFile(created, 'new');
    fixture.host.createdWatchers[0].watcher.creates.fire(pathToFileURL(created));
    assert.deepEqual(await fixture.service.listAttachmentPaths(fixture.item), ['new.csv']);
});

test('scenario files service hides transfer artifacts and operating-system metadata', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'Visible.txt': 'visible',
        '.Visible.txt.transfer.kot-upload': 'partial',
        'Visible.txt.transfer.kot-backup': 'backup',
        '.DS_Store': 'finder metadata',
        'Thumbs.db': 'explorer metadata'
    });

    const nodes = await fixture.service.listChildren(fixture.item, '');

    assert.deepEqual(nodes.map(node => node.name), ['Visible.txt']);
});

test('scenario files service reads only the requested child directory', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'Alpha/a.txt': 'a',
        'Beta/b.txt': 'b'
    });

    const nodes = await fixture.service.listChildren(fixture.item, 'Alpha');

    assert.deepEqual(nodes.map(node => [node.kind, node.name, node.relativePath]), [
        ['file', 'a.txt', 'Alpha/a.txt']
    ]);
    assert.deepEqual(fixture.host.readDirectoryCalls, [
        pathToFileURL(path.join(fixture.directory, 'files', 'Alpha')).toString()
    ]);
});

test('scenario files service treats a missing files root as empty without creating it', async t => {
    const fixture = await createScenarioFilesFixture(t, {}, false);

    assert.deepEqual(await fixture.service.listChildren(fixture.item, ''), []);
    await assert.rejects(fs.stat(path.join(fixture.directory, 'files')), { code: 'ENOENT' });
});

test('scenario files service uses the compiled attachments root for a main scenario', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compiled-scenario-files-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const featurePath = path.join(directory, '004_Production.feature');
    const filesRootPath = path.join(directory, '004_Production', 'Файлы');
    await fs.mkdir(filesRootPath, { recursive: true });
    await fs.writeFile(featurePath, 'Функционал: Production\n');
    await fs.writeFile(path.join(filesRootPath, 'Expected.mxl'), 'table');
    const host = new RecordingHost();
    const service = new ScenarioFilesService(host);
    t.after(() => service.dispose());
    const item = compiledMainItem(featurePath, filesRootPath);

    const nodes = await service.listChildren(item, '');

    assert.deepEqual(nodes.map(node => [node.kind, node.name]), [
        ['file', 'Expected.mxl']
    ]);
    assert.deepEqual(host.readDirectoryCalls, [pathToFileURL(filesRootPath).toString()]);
});

test('scenario files service opens the compiled feature in the editor', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compiled-feature-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const featurePath = path.join(directory, '004_Production.feature');
    const filesRootPath = path.join(directory, '004_Production', 'Файлы');
    await fs.writeFile(featurePath, 'Функционал: Production\n');
    const host = new RecordingHost();
    const service = new ScenarioFilesService(host);
    t.after(() => service.dispose());
    const item = compiledMainItem(featurePath, filesRootPath);

    const opened = await (service as ScenarioFilesService & {
        openCompiledFeature(candidate: StepLibraryItem): Promise<boolean>;
    }).openCompiledFeature?.(item);

    assert.equal(opened, true);
    assert.deepEqual(host.openedInEditor, [pathToFileURL(featurePath).toString()]);
});

test('scenario files service opens and reveals exact local resource URIs', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'z.txt': 'z',
        'Alpha/a.txt': 'a'
    });

    assert.equal(await fixture.service.openExternal(fixture.item, 'z.txt'), true);
    assert.equal(await fixture.service.revealInOs(fixture.item, 'Alpha'), true);
    assert.deepEqual(fixture.host.opened, [
        pathToFileURL(path.join(fixture.directory, 'files', 'z.txt')).toString()
    ]);
    assert.deepEqual(fixture.host.revealed, [
        pathToFileURL(path.join(fixture.directory, 'files', 'Alpha')).toString()
    ]);
});

test('scenario files service confirms and trash-deletes only an existing regular attachment file', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'Folder/Input.xlsx': 'input'
    });

    assert.equal(
        await fixture.service.deleteFile(fixture.item, 'Folder\\Input.xlsx'),
        'deleted'
    );
    assert.deepEqual(fixture.host.deleteConfirmations, ['Folder/Input.xlsx']);
    assert.deepEqual(fixture.host.deleted, [
        pathToFileURL(path.join(fixture.directory, 'files', 'Folder', 'Input.xlsx')).toString()
    ]);
});

test('scenario file deletion falls back to permanent removal when trash is unavailable', async () => {
    const attempts: Array<{ uri: string; useTrash: boolean }> = [];
    const uri = new URL('file:///shared/Scenario/files/Input.xlsx');

    await deleteFileWithTrashFallback(uri, async (target, options) => {
        attempts.push({ uri: target.toString(), useTrash: options.useTrash });
        if (options.useTrash) {
            throw new Error('Trash is unavailable for this shared filesystem');
        }
    });

    assert.deepEqual(attempts, [
        { uri: uri.toString(), useTrash: true },
        { uri: uri.toString(), useTrash: false }
    ]);
});

test('scenario files service leaves the file intact when deletion is cancelled', async t => {
    const fixture = await createScenarioFilesFixture(t, { 'Input.xlsx': 'input' });
    fixture.host.confirmDeleteResult = false;

    assert.equal(await fixture.service.deleteFile(fixture.item, 'Input.xlsx'), 'cancelled');
    assert.deepEqual(fixture.host.deleteConfirmations, ['Input.xlsx']);
    assert.deepEqual(fixture.host.deleted, []);
    assert.equal(await fs.readFile(path.join(fixture.directory, 'files', 'Input.xlsx'), 'utf8'), 'input');
});

test('scenario files service rejects missing directories and symbolic-link leaves before confirmation', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'Folder/Input.xlsx': 'input'
    });
    const outside = path.join(fixture.directory, 'outside.txt');
    await fs.writeFile(outside, 'outside');
    const linkPath = path.join(fixture.directory, 'files', 'linked.txt');
    try {
        await fs.symlink(outside, linkPath, 'file');
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
            && (error.code === 'EPERM' || error.code === 'EACCES')) {
            t.skip('file symlinks are not permitted on this host');
            return;
        }
        throw error;
    }

    await assert.rejects(fixture.service.deleteFile(fixture.item, 'missing.txt'), /exist|missing/u);
    await assert.rejects(fixture.service.deleteFile(fixture.item, 'Folder'), /regular.*file|directory/iu);
    await assert.rejects(fixture.service.deleteFile(fixture.item, 'linked.txt'), /symbolic link/u);
    assert.deepEqual(fixture.host.deleteConfirmations, []);
    assert.deepEqual(fixture.host.deleted, []);
});

test('scenario files service rejects a delete path that escapes through a directory symlink', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-scenario-delete-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, 'Secret.txt'), 'secret');
    if (!await createDirectorySymlinkOrSkip(
        t,
        outside,
        path.join(fixture.directory, 'files', 'Escape')
    )) {
        return;
    }

    await assert.rejects(
        fixture.service.deleteFile(fixture.item, 'Escape/Secret.txt'),
        /symbolic link|escapes/u
    );
    assert.deepEqual(fixture.host.deleteConfirmations, []);
    assert.deepEqual(fixture.host.deleted, []);
});

test('scenario files service deletes a compiled-main attachment from its explicit root', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compiled-delete-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const featurePath = path.join(directory, '004_Production.feature');
    const filesRootPath = path.join(directory, '004_Production', 'Файлы');
    await fs.mkdir(filesRootPath, { recursive: true });
    await fs.writeFile(featurePath, 'Функционал: Production\n');
    await fs.writeFile(path.join(filesRootPath, 'Expected.mxl'), 'table');
    const host = new RecordingHost();
    const service = new ScenarioFilesService(host);
    t.after(() => service.dispose());

    assert.equal(
        await service.deleteFile(compiledMainItem(featurePath, filesRootPath), 'Expected.mxl'),
        'deleted'
    );
    assert.deepEqual(host.deleted, [pathToFileURL(path.join(filesRootPath, 'Expected.mxl')).toString()]);
});

test('scenario files service rejects non-nested and non-local items without filesystem calls', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const userItem = nestedItem(fixture.directory, {
        kind: 'userStep',
        sourceGroup: 'user',
        hasScenarioFiles: undefined
    });
    const remoteItem = nestedItem(fixture.directory, {
        capturedLocation: {
            uri: 'https://example.test/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }
    });

    await assert.rejects(fixture.service.listChildren(userItem, ''), /nested scenario/u);
    await assert.rejects(fixture.service.listChildren(remoteItem, ''), /local/u);
    assert.deepEqual(fixture.host.readDirectoryCalls, []);
});

test('scenario files service shares a watcher until the final subscriber is disposed', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    let firstInvalidations = 0;
    let secondInvalidations = 0;
    const globalInvalidations: Array<{ readonly changedUris: readonly string[] }> = [];
    fixture.service.onDidInvalidate(event => globalInvalidations.push(event));

    const first = fixture.service.watch(fixture.item, () => firstInvalidations += 1);
    const second = fixture.service.watch(fixture.item, () => secondInvalidations += 1);
    assert.equal(fixture.host.createdWatchers.length, 1);

    const watched = fixture.host.createdWatchers[0];
    watched.watcher.changes.fire(pathToFileURL(path.join(fixture.directory, 'files', 'a.txt')));
    watched.watcher.creates.fire(pathToFileURL(path.join(fixture.directory, 'files', 'b.txt')));
    watched.watcher.deletes.fire(pathToFileURL(path.join(fixture.directory, 'files', 'c.txt')));
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(firstInvalidations, 1);
    assert.equal(secondInvalidations, 1);
    assert.deepEqual(
        [...globalInvalidations[0].changedUris].sort(),
        ['a.txt', 'b.txt', 'c.txt'].map(name =>
            pathToFileURL(path.join(fixture.directory, 'files', name)).toString()
        ).sort()
    );

    first.dispose();
    assert.equal(watched.watcher.disposed, false);
    second.dispose();
    assert.equal(watched.watcher.disposed, true);
});

test('scenario files service writes ordered chunks and publishes only on completion', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const plan = await fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'Expected.xlsx', kind: 'file', size: 6 }
    ]);
    const transfer = plan.files[0];
    assert.ok(transfer);

    assert.equal(await fixture.service.appendTransferChunk(
        transfer.transferId,
        0,
        Buffer.from('abc').toString('base64')
    ), 3);
    await assert.rejects(fs.stat(path.join(fixture.directory, 'files', 'Expected.xlsx')), {
        code: 'ENOENT'
    });
    assert.equal(await fixture.service.appendTransferChunk(
        transfer.transferId,
        3,
        Buffer.from('def').toString('base64')
    ), 6);

    await fixture.service.completeTransfer(transfer.transferId);

    assert.equal(
        await fs.readFile(path.join(fixture.directory, 'files', 'Expected.xlsx'), 'utf8'),
        'abcdef'
    );
    assert.deepEqual(
        (await fs.readdir(path.join(fixture.directory, 'files'))).filter(name => name.includes('.kot-upload')),
        []
    );
});

test('scenario files service opens upload files lazily when their first chunk arrives', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const plan = await fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'First.bin', kind: 'file', size: 1 },
        { clientPath: 'Second.bin', kind: 'file', size: 1 }
    ]);

    assert.equal(plan.files.length, 2);
    assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'files')), []);
});

test('scenario files service rejects a symbolic-link files root', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-scenario-files-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.rm(path.join(fixture.directory, 'files'), { recursive: true, force: true });
    if (!await createDirectorySymlinkOrSkip(
        t,
        outside,
        path.join(fixture.directory, 'files')
    )) {
        return;
    }

    await assert.rejects(fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'Outside.bin', kind: 'file', size: 1 }
    ]), /symbolic link/u);
    assert.deepEqual(await fs.readdir(outside), []);
});

test('scenario files service refuses direct access through an escaping child symlink', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-scenario-files-secret-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, 'Secret.txt'), 'secret');
    if (!await createDirectorySymlinkOrSkip(
        t,
        outside,
        path.join(fixture.directory, 'files', 'Escape')
    )) {
        return;
    }

    await assert.rejects(
        fixture.service.listChildren(fixture.item, 'Escape'),
        /symbolic link|escapes/u
    );
    assert.equal(
        await fixture.service.openExternal(fixture.item, 'Escape/Secret.txt'),
        false
    );
    assert.deepEqual(fixture.host.opened, []);
});

test('scenario files service preserves replace save-copy and skip collision semantics', async t => {
    const cases = [
        { decision: 'replace', destination: 'Expected.xlsx', transfers: 1 },
        { decision: 'copy', destination: 'Expected (1).xlsx', transfers: 1 },
        { decision: 'skip', destination: undefined, transfers: 0 }
    ] as const;

    for (const expected of cases) {
        const fixture = await createScenarioFilesFixture(t, { 'Expected.xlsx': 'old' });
        fixture.host.conflictDecision = expected.decision;

        const plan = await fixture.service.prepareDrop(fixture.item, '', [
            { clientPath: 'Expected.xlsx', kind: 'file', size: 3 }
        ]);

        assert.equal(plan.files[0]?.destinationRelativePath, expected.destination);
        assert.equal(plan.files.length, expected.transfers);
        assert.deepEqual(plan.skipped, expected.decision === 'skip' ? ['Expected.xlsx'] : []);
        assert.deepEqual(fixture.host.conflicts, ['Expected.xlsx']);
    }
});

test('scenario files service merges existing directories while planning recursive files', async t => {
    const fixture = await createScenarioFilesFixture(t, {
        'Fixtures/existing.txt': 'keep'
    });

    const plan = await fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'Fixtures', kind: 'directory' },
        { clientPath: 'Fixtures/Input.xlsx', kind: 'file', size: 3 }
    ]);

    assert.equal(plan.files[0]?.destinationRelativePath, 'Fixtures/Input.xlsx');
    assert.equal(
        await fs.readFile(path.join(fixture.directory, 'files', 'Fixtures', 'existing.txt'), 'utf8'),
        'keep'
    );
});

test('scenario files service rejects traversal and absolute manifests before writing', async t => {
    const invalidPaths = ['../outside', '/absolute', 'C:\\outside', '\\\\server\\share'];
    for (const invalidPath of invalidPaths) {
        const fixture = await createScenarioFilesFixture(t, {});
        await assert.rejects(fixture.service.prepareDrop(fixture.item, '', [
            { clientPath: invalidPath, kind: 'file', size: 1 }
        ]), /Invalid scenario files path/u);
        assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'files')), []);
    }
});

test('scenario files service removes a transfer after wrong offset or size overflow', async t => {
    const offsetFixture = await createScenarioFilesFixture(t, {});
    const offsetTransfer = (await offsetFixture.service.prepareDrop(offsetFixture.item, '', [
        { clientPath: 'offset.bin', kind: 'file', size: 4 }
    ])).files[0];
    assert.ok(offsetTransfer);
    await offsetFixture.service.appendTransferChunk(
        offsetTransfer.transferId,
        0,
        Buffer.from('abc').toString('base64')
    );
    await assert.rejects(offsetFixture.service.appendTransferChunk(
        offsetTransfer.transferId,
        2,
        Buffer.from('d').toString('base64')
    ), /offset/u);

    const overflowFixture = await createScenarioFilesFixture(t, {});
    const overflowTransfer = (await overflowFixture.service.prepareDrop(overflowFixture.item, '', [
        { clientPath: 'overflow.bin', kind: 'file', size: 3 }
    ])).files[0];
    assert.ok(overflowTransfer);
    await assert.rejects(overflowFixture.service.appendTransferChunk(
        overflowTransfer.transferId,
        0,
        Buffer.from('four').toString('base64')
    ), /declared size/u);

    await new Promise(resolve => setTimeout(resolve, 20));
    for (const fixture of [offsetFixture, overflowFixture]) {
        assert.deepEqual(
            (await fs.readdir(path.join(fixture.directory, 'files'))).filter(name => name.includes('.kot-upload')),
            []
        );
    }
});

test('scenario files service cancels incomplete transfers without publishing files', async t => {
    const fixture = await createScenarioFilesFixture(t, {});
    const cancelled = (await fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'cancelled.bin', kind: 'file', size: 3 }
    ])).files[0];
    assert.ok(cancelled);
    await fixture.service.cancelTransfer(cancelled.transferId);

    const incomplete = (await fixture.service.prepareDrop(fixture.item, '', [
        { clientPath: 'incomplete.bin', kind: 'file', size: 3 }
    ])).files[0];
    assert.ok(incomplete);
    await fixture.service.appendTransferChunk(
        incomplete.transferId,
        0,
        Buffer.from('ab').toString('base64')
    );
    await assert.rejects(
        fixture.service.completeTransfer(incomplete.transferId),
        /incomplete/u
    );

    assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'files')), []);
});
