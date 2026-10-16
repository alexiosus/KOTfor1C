import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
    MAX_SCENARIO_FILE_CHUNK_CHARACTERS,
    parseScenarioFilesMessage
} from '../src/scenarioFilesWebviewProtocol';

test('scenario files protocol rejects oversized chunks and untrusted paths', () => {
    assert.equal(parseScenarioFilesMessage({
        command: 'appendScenarioFileChunk',
        transferId: 'transfer',
        offset: 0,
        base64: 'x'.repeat(MAX_SCENARIO_FILE_CHUNK_CHARACTERS + 1)
    }), null);
    assert.equal(parseScenarioFilesMessage({
        command: 'listScenarioFiles',
        itemId: 'nested',
        relativePath: '../outside',
        requestId: 'request'
    }), null);
    assert.equal(parseScenarioFilesMessage({
        command: 'prepareScenarioFileDrop',
        dropId: 'drop',
        itemId: 'nested',
        targetRelativePath: '',
        entries: [{ clientPath: '/absolute', kind: 'file', size: 1 }]
    }), null);
});

test('scenario files protocol normalizes valid list and drop messages', () => {
    assert.deepEqual(parseScenarioFilesMessage({
        command: 'listScenarioFiles',
        itemId: ' nested ',
        relativePath: 'Fixtures\\Input',
        requestId: ' request '
    }), {
        command: 'listScenarioFiles',
        itemId: 'nested',
        relativePath: 'Fixtures/Input',
        requestId: 'request'
    });
    assert.deepEqual(parseScenarioFilesMessage({
        command: 'openCompiledScenarioFeature',
        itemId: ' main#004 '
    }), {
        command: 'openCompiledScenarioFeature',
        itemId: 'main#004'
    });
    assert.deepEqual(parseScenarioFilesMessage({
        command: 'prepareScenarioFileDrop',
        dropId: 'drop',
        itemId: 'nested',
        targetRelativePath: 'Fixtures',
        entries: [
            { clientPath: 'Folder', kind: 'directory' },
            { clientPath: 'Folder/Input.xlsx', kind: 'file', size: 42 }
        ]
    }), {
        command: 'prepareScenarioFileDrop',
        dropId: 'drop',
        itemId: 'nested',
        targetRelativePath: 'Fixtures',
        entries: [
            { clientPath: 'Folder', kind: 'directory' },
            { clientPath: 'Folder/Input.xlsx', kind: 'file', size: 42 }
        ]
    });
});

test('scenario files protocol accepts only a non-empty normalized attachment delete path', () => {
    assert.deepEqual(parseScenarioFilesMessage({
        command: 'deleteScenarioFile',
        itemId: ' nested ',
        relativePath: 'Folder\\Input.xlsx'
    }), {
        command: 'deleteScenarioFile',
        itemId: 'nested',
        relativePath: 'Folder/Input.xlsx'
    });

    for (const relativePath of ['', '..', '../outside', '/absolute', 'C:\\outside']) {
        assert.equal(parseScenarioFilesMessage({
            command: 'deleteScenarioFile',
            itemId: 'nested',
            relativePath
        }), null);
    }
    assert.equal(parseScenarioFilesMessage({
        command: 'deleteScenarioFile',
        itemId: 'x'.repeat(2_049),
        relativePath: 'Input.xlsx'
    }), null);
    assert.equal(parseScenarioFilesMessage({
        command: 'deleteScenarioFile',
        itemId: 'nested',
        relativePath: 'x'.repeat(8_193)
    }), null);
    assert.equal(parseScenarioFilesMessage({
        command: 'deleteScenarioDirectory',
        itemId: 'nested',
        relativePath: 'Folder'
    }), null);
});

function loadBrowserProtocol(): any {
    const source = fs.readFileSync(
        path.join(process.cwd(), 'media', 'scenarioFilesProtocol.js'),
        'utf8'
    );
    const context: Record<string, unknown> = {
        console,
        setTimeout,
        clearTimeout,
        Blob,
        Uint8Array,
        btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    };
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return context.KotScenarioFilesProtocol;
}

test('source attachment messages retain scope and reject forged selectors and unsafe rename paths', () => {
    const message = { command: 'renameScenarioFile', itemId: 'main#004', resource: 'source', relativePath: 'Folder\\Data.csv' };
    assert.deepEqual(parseScenarioFilesMessage(message), { ...message, relativePath: 'Folder/Data.csv' });
    for (const patch of [{ resource: 'file:///foreign' }, { relativePath: '../foreign' }, { relativePath: '' }]) {
        assert.equal(parseScenarioFilesMessage({ ...message, ...patch }), null);
    }
});

test('compiled main trees keep authored attachments separate from generated files', () => {
    const protocol = loadBrowserProtocol();
    const nodes = protocol.projectCompiledScenarioChildren({ id: 'main#004', compiledFeatureUri: 'file:///build/main.feature',
        sourceScenarioFilesRootUri: 'file:///source/files', scenarioFilesRootUri: 'file:///build/main/Файлы' }, {}) as any[];
    assert.deepEqual(Array.from(nodes, node => [node.kind, node.name, node.resource]), [
        ['attachments', 'Source files', 'source'], ['feature', 'main.feature', undefined], ['attachments', 'Compiled files', undefined]
    ]);
});

test('scenario files browser projects a compiled feature and a separate attachments group', () => {
    const protocol = loadBrowserProtocol();
    const nodes = protocol.projectCompiledScenarioChildren?.({
        id: 'main#004',
        itemId: 'main#004',
        scenarioKey: 'file:///workspace/main/scen.yaml',
        depth: 2,
        compiledFeatureUri: 'file:///build/004_Production.feature',
        scenarioFilesRootUri: 'file:///build/004_Production/%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B'
    }, { files: 'Files' }) ?? [];

    assert.deepEqual(JSON.parse(JSON.stringify(nodes)), [
        {
            id: 'scenario-feature:main%23004',
            kind: 'feature',
            itemId: 'main#004',
            label: '004_Production.feature',
            name: '004_Production.feature',
            scenarioKey: 'file:///workspace/main/scen.yaml',
            depth: 3,
            expandable: false
        },
        {
            id: 'scenario-attachments:main%23004',
            kind: 'attachments',
            itemId: 'main#004',
            label: 'Files',
            name: 'Files',
            relativePath: '',
            depth: 3,
            expandable: true
        }
    ]);
});

test('scenario resource DOM keys distinguish a feature from its Files group at the same root path', () => {
    const protocol = loadBrowserProtocol();

    assert.equal(protocol.scenarioResourceNodeKey({
        kind: 'feature',
        itemId: 'main#004',
        relativePath: ''
    }), 'feature|main%23004|');
    assert.equal(protocol.scenarioResourceNodeKey({
        kind: 'attachments',
        itemId: 'main#004',
        relativePath: ''
    }), 'attachments|main%23004|');
});

test('scenario resource row clicks toggle containers and open files without stealing button clicks', () => {
    const protocol = loadBrowserProtocol();

    assert.equal(protocol.scenarioResourceRowAction('attachments', false), 'toggle');
    assert.equal(protocol.scenarioResourceRowAction('directory', false), 'toggle');
    assert.equal(protocol.scenarioResourceRowAction('feature', false), 'open');
    assert.equal(protocol.scenarioResourceRowAction('file', false), 'open');
    assert.equal(protocol.scenarioResourceRowAction('attachments', true), 'none');
    assert.equal(protocol.scenarioResourceRowAction('file', true), 'none');
});

test('scenario resource context actions are ordered consistently and delete only attachment files', () => {
    const protocol = loadBrowserProtocol();
    const labels = {
        openExternally: 'Open externally',
        openDefinition: 'Open definition',
        showInFileManager: 'Show in Finder / Explorer',
        delete: 'Delete'
    };
    const ids = (kind: string): string[] => JSON.parse(JSON.stringify(
        protocol.scenarioResourceContextActions(kind, labels)
    )).map((action: { id: string }) => action.id);

    assert.deepEqual(ids('file'), ['open', 'reveal', 'separator', 'rename', 'delete']);
    assert.deepEqual(ids('directory'), ['reveal']);
    assert.deepEqual(ids('attachments'), ['reveal']);
    assert.deepEqual(ids('feature'), ['open']);
    assert.deepEqual(ids('definition'), []);
});

test('first Files click expands immediately and requests its children exactly once', () => {
    const protocol = loadBrowserProtocol();

    assert.deepEqual(JSON.parse(JSON.stringify(
        protocol.scenarioDirectoryExpansionTransition?.(false, false)
    )), {
        expanded: true,
        requestChildren: true,
        animateImmediately: true
    });
    assert.deepEqual(JSON.parse(JSON.stringify(
        protocol.scenarioDirectoryExpansionTransition?.(false, true)
    )), {
        expanded: true,
        requestChildren: false,
        animateImmediately: true
    });
    assert.deepEqual(JSON.parse(JSON.stringify(
        protocol.scenarioDirectoryExpansionTransition?.(true, true)
    )), {
        expanded: false,
        requestChildren: false,
        animateImmediately: false
    });
});

test('scenario definition rows reserve selection for explicit controls and toggle compiled resources', () => {
    const protocol = loadBrowserProtocol();

    assert.equal(protocol.scenarioDefinitionRowAction(true, false), 'toggle');
    assert.equal(protocol.scenarioDefinitionRowAction(false, false), 'focus');
    assert.equal(protocol.scenarioDefinitionRowAction(true, true), 'none');
    assert.equal(protocol.scenarioDefinitionRowAction(true, false, false), 'focus');
});

test('newly loaded resource children render collapsed before their enter animation', () => {
    const protocol = loadBrowserProtocol();

    assert.deepEqual(JSON.parse(JSON.stringify(
        protocol.scenarioResourceChildrenPresentation?.(true, true)
    )), {
        className: 'scenario-resource-children is-entering',
        maxHeight: '0px'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(
        protocol.scenarioResourceChildrenPresentation?.(true, false)
    )), {
        className: 'scenario-resource-children expanded',
        maxHeight: 'none'
    });
});

test('loaded children refresh an expanded results branch but otherwise only the selected details', () => {
    const protocol = loadBrowserProtocol();

    assert.equal(protocol.scenarioFileChildrenRenderTarget?.(true, true), 'results');
    assert.equal(protocol.scenarioFileChildrenRenderTarget?.(true, false), 'results');
    assert.equal(protocol.scenarioFileChildrenRenderTarget?.(false, true), 'details');
    assert.equal(protocol.scenarioFileChildrenRenderTarget?.(false, false), 'none');
});

test('pending expansion animations stay independent until their rendered branch consumes them', () => {
    const protocol = loadBrowserProtocol();
    const tracker = protocol.createPendingExpansionTracker();

    assert.equal(tracker.request('first'), true);
    assert.equal(tracker.request('second'), true);
    assert.equal(tracker.has('first'), true);
    assert.equal(tracker.has('second'), true);

    assert.equal(tracker.consume('first'), true);
    assert.equal(tracker.has('first'), false);
    assert.equal(tracker.has('second'), true);
    assert.equal(tracker.consume('missing'), false);

    tracker.clearWhere(id => id.startsWith('sec'));
    assert.equal(tracker.has('second'), false);
});

test('pending expansion tracker exposes every branch awaiting a rendered container', () => {
    const protocol = loadBrowserProtocol();
    const tracker = protocol.createPendingExpansionTracker();

    tracker.request('first');
    tracker.request('second');

    assert.deepEqual(Array.from(tracker.values()), ['first', 'second']);
    tracker.consume('first');
    assert.deepEqual(Array.from(tracker.values()), ['second']);
});

test('scenario files browser protocol inserts only a file base name into editor drag data', () => {
    const protocol = loadBrowserProtocol();
    const values = new Map<string, string>();
    const event = {
        dataTransfer: {
            effectAllowed: '',
            setData(type: string, value: string) {
                values.set(type, value);
            }
        }
    };

    assert.equal(protocol.setEditorDragData(event, {
        kind: 'file',
        name: 'Expected.xlsx',
        relativePath: 'Fixtures/Expected.xlsx'
    }), true);
    assert.equal(values.get('text/plain'), 'Expected.xlsx');
    assert.equal([...values.values()].some(value => value.includes('Fixtures/')), false);
});

test('scenario files browser protocol projects resource rows directly below a scenario', () => {
    const protocol = loadBrowserProtocol();

    const projected = protocol.projectDirectChildren(2, [{
        id: 'scenario-file:nested:file:demo-items.csv',
        kind: 'file',
        itemId: 'nested',
        name: 'demo-items.csv',
        relativePath: 'demo-items.csv',
        depth: 1,
        expandable: false
    }]);

    assert.deepEqual(JSON.parse(JSON.stringify(projected)), [{
        id: 'scenario-file:nested:file:demo-items.csv',
        kind: 'file',
        itemId: 'nested',
        name: 'demo-items.csv',
        label: 'demo-items.csv',
        relativePath: 'demo-items.csv',
        depth: 3,
        expandable: false
    }]);
});

test('scenario files browser protocol collects a recursive DOM directory manifest', async () => {
    const protocol = loadBrowserProtocol();
    const file = { name: 'Input.xlsx', size: 17 };
    const fileEntry = {
        isFile: true,
        isDirectory: false,
        name: 'Input.xlsx',
        file(callback: (value: unknown) => void) { callback(file); }
    };
    let readCount = 0;
    const directoryEntry = {
        isFile: false,
        isDirectory: true,
        name: 'Fixtures',
        createReader: () => ({
            readEntries(callback: (entries: unknown[]) => void) {
                callback(readCount++ === 0 ? [fileEntry] : []);
            }
        })
    };

    const result = await protocol.collectDropEntries({
        items: [{ webkitGetAsEntry: () => directoryEntry }],
        files: []
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result.entries)), [
        { clientPath: 'Fixtures', kind: 'directory' },
        { clientPath: 'Fixtures/Input.xlsx', kind: 'file', size: 17 }
    ]);
    assert.equal(result.filesByPath.get('Fixtures/Input.xlsx'), file);
});

test('scenario files browser protocol uploads planned files sequentially', async () => {
    const protocol = loadBrowserProtocol();
    const messages: any[] = [];
    const controller = protocol.createTransferController((message: unknown) => {
        messages.push(message);
    });
    const file = (name: string, value: string) => ({
        name,
        size: Buffer.byteLength(value),
        slice: () => ({
            arrayBuffer: async () => Uint8Array.from(Buffer.from(value)).buffer
        })
    });

    const dropId = await controller.beginDrop({
        items: [],
        files: [file('First.bin', 'a'), file('Second.bin', 'b')]
    }, { itemId: 'nested', relativePath: '' });
    controller.handleMessage({
        command: 'scenarioFileDropPrepared',
        dropId,
        files: [
            { clientPath: 'First.bin', transferId: 'first' },
            { clientPath: 'Second.bin', transferId: 'second' }
        ]
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(
        messages.filter(message => message.command === 'appendScenarioFileChunk')
            .map(message => message.transferId),
        ['first']
    );
});

test('scenario files browser protocol releases dropped files after planning fails', async () => {
    const protocol = loadBrowserProtocol();
    const messages: any[] = [];
    const controller = protocol.createTransferController((message: unknown) => {
        messages.push(message);
    });
    const file = {
        name: 'Input.xlsx',
        size: 1,
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) })
    };
    const dropId = await controller.beginDrop({ items: [], files: [file] }, {
        itemId: 'nested', relativePath: ''
    });

    controller.handleMessage({ command: 'scenarioFileTransferFailed', dropId });

    assert.equal(controller.handleMessage({
        command: 'scenarioFileDropPrepared',
        dropId,
        files: [{ clientPath: 'Input.xlsx', transferId: 'late' }]
    }), false);
    assert.equal(messages.some(message => message.transferId === 'late'), false);
});

test('scenario files browser protocol rejects a drop before retaining an oversized manifest', async () => {
    const protocol = loadBrowserProtocol();
    const messages: unknown[] = [];
    const controller = protocol.createTransferController(message => messages.push(message));
    const files = Array.from({ length: 5_001 }, (_, index) => ({
        name: `file-${index}.txt`,
        size: 1
    }));

    await assert.rejects(
        controller.beginDrop({ items: [], files }, { itemId: 'nested', relativePath: '' }),
        /too many files/iu
    );
    assert.deepEqual(messages, []);
});
