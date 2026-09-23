import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
    createProjectDefinitionView,
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition
} from '../src/projectDefinition';
import { resolveProjectInvocation } from '../src/projectDefinitionMatcher';

class Position {
    public constructor(public line: number, public character: number) {}
}

class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(
        startOrLine: Position | number,
        startCharacterOrEnd: Position | number,
        endLine?: number,
        endCharacter?: number
    ) {
        if (startOrLine instanceof Position && startCharacterOrEnd instanceof Position) {
            this.start = startOrLine;
            this.end = startCharacterOrEnd;
            return;
        }
        this.start = new Position(startOrLine as number, startCharacterOrEnd as number);
        this.end = new Position(endLine as number, endCharacter as number);
    }
}

function uri(value: string) {
    return {
        scheme: value.split(':', 1)[0],
        fsPath: value.replace(/^file:\/\//, ''),
        toString: () => value
    };
}

const vscode = {
    Location: class {
        public constructor(public uri: ReturnType<typeof uri>, public range: Range) {}
    },
    Position,
    Range,
    Uri: {
        file: (filePath: string) => uri(`file://${filePath}`),
        parse: uri
    },
    workspace: { textDocuments: [] as unknown[] }
};

class ConcurrencyCancelledError extends Error {}

async function runWithConcurrencyLimit<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
    options: { shouldCancel?: () => boolean } = {}
): Promise<R[]> {
    const results = Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (true) {
            if (options.shouldCancel?.()) {
                throw new ConcurrencyCancelledError();
            }
            const index = cursor++;
            if (index >= items.length) {
                return;
            }
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function collectTreeWithConcurrencyLimit<T>(
    root: string,
    _limit: number,
    worker: (directory: string) => Promise<{ children: readonly string[]; values: readonly T[] }>,
    shouldCancel: () => boolean = () => false
): Promise<T[]> {
    const queue = [root];
    const values: T[] = [];
    while (queue.length > 0) {
        if (shouldCancel()) {
            throw new ConcurrencyCancelledError();
        }
        const result = await worker(queue.shift()!);
        queue.push(...result.children);
        values.push(...result.values);
    }
    return values;
}

function loadReferencesModule(): Record<string, unknown> {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(
        path.join(process.cwd(), 'src', 'projectDefinitionReferences.ts'),
        'utf8'
    );
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => {
            if (specifier === 'vscode') {
                return vscode;
            }
            if (specifier === 'node:path') {
                return path;
            }
            if (specifier === './boundedConcurrency') {
                return {
                    collectTreeWithConcurrencyLimit,
                    ConcurrencyCancelledError,
                    runWithConcurrencyLimit
                };
            }
            return {};
        },
        console,
        setImmediate
    });
    return moduleObject.exports;
}

function definition(
    id: string,
    kind: ProjectDefinition['kind'],
    template: string,
    sourceUri: string,
    parameters: ProjectDefinition['parameters'] = []
): ProjectDefinition {
    return {
        id,
        kind,
        template,
        normalizedTemplate: normalizeProjectDefinitionTemplate(template),
        parameters,
        sourceLabel: id,
        definitionLocation: {
            uri: sourceUri,
            range: {
                start: { line: 1, character: 4 },
                end: { line: 1, character: 24 }
            }
        }
    };
}

interface VirtualFile {
    text: string;
    size?: number;
    mtimeMs?: number;
}

class VirtualFileSystem {
    public reads = 0;
    public directoryReads = 0;
    public activeReads = 0;
    public maxActiveReads = 0;
    public readonly files = new Map<string, Required<VirtualFile>>();
    public readonly aliases = new Map<string, string>();
    public onRead?: (filePath: string) => void;

    public constructor(files: Record<string, VirtualFile>) {
        for (const [filePath, value] of Object.entries(files)) {
            this.files.set(filePath, {
                text: value.text,
                size: value.size ?? value.text.length,
                mtimeMs: value.mtimeMs ?? 1
            });
        }
    }

    public async realpath(filePath: string): Promise<string> {
        return this.aliases.get(filePath) ?? filePath;
    }

    public async readDirectory(directoryPath: string) {
        this.directoryReads += 1;
        const names = new Map<string, 'file' | 'directory'>();
        const prefix = `${directoryPath.replace(/\/$/, '')}/`;
        for (const filePath of this.files.keys()) {
            if (!filePath.startsWith(prefix)) {
                continue;
            }
            const relative = filePath.slice(prefix.length);
            const slash = relative.indexOf('/');
            names.set(slash < 0 ? relative : relative.slice(0, slash), slash < 0 ? 'file' : 'directory');
        }
        return Array.from(names, ([name, type]) => ({ name, type }));
    }

    public async stat(filePath: string) {
        const value = this.files.get(filePath);
        if (!value) {
            throw new Error(`Missing ${filePath}`);
        }
        return { size: value.size, mtimeMs: value.mtimeMs };
    }

    public async readFile(filePath: string): Promise<string> {
        const value = this.files.get(filePath);
        if (!value) {
            throw new Error(`Missing ${filePath}`);
        }
        this.reads += 1;
        this.activeReads += 1;
        this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
        this.onRead?.(filePath);
        await new Promise<void>(resolve => setImmediate(resolve));
        this.activeReads -= 1;
        return value.text;
    }
}

function resolverFor(definitions: readonly ProjectDefinition[]) {
    const view = createProjectDefinitionView('references', definitions);
    return {
        getView: async () => view,
        resolve: async (_resource: unknown, invocation: string, currentView = view) =>
            resolveProjectInvocation(currentView, invocation)
    };
}

function createService(
    definitions: readonly ProjectDefinition[],
    fileSystem: VirtualFileSystem,
    roots: readonly { path: string; extensions: readonly string[] }[],
    openDocuments: readonly unknown[] = [],
    readConcurrency = 2
) {
    const exports = loadReferencesModule();
    const Service = exports.ProjectDefinitionReferenceService as new (options: object) => {
        findReferences: (...args: any[]) => Promise<Array<{ uri: ReturnType<typeof uri>; range: Range }>>;
    };
    return new Service({
        resolver: resolverFor(definitions),
        loadSearchRoots: async () => roots,
        fileSystem: {
            realpath: (value: string) => fileSystem.realpath(value),
            readDirectory: (value: string) => fileSystem.readDirectory(value),
            stat: (value: string) => fileSystem.stat(value),
            readFile: (value: string) => fileSystem.readFile(value),
            toUri: (value: string) => `file://${value}`
        },
        getOpenDocuments: () => openDocuments,
        directoryConcurrency: 2,
        readConcurrency
    });
}

const noCancellation = { isCancellationRequested: false };

test('indexes YAML and feature calls with parameterized templates and exact ranges', async () => {
    const nested = definition(
        'nested:checkout',
        'nestedScenario',
        'Checkout order',
        'file:///scenario/checkout.yaml'
    );
    const user = definition(
        'user:click',
        'userStep',
        'And click "%1 button"',
        'file:///library/steps.bsl',
        [{ name: 'button', index: 0, source: 'quoted' }]
    );
    const fileSystem = new VirtualFileSystem({
        '/scenario/main.yaml': { text: 'ТекстСценария: |\n    And Checkout order\n' },
        '/library/calls.feature': { text: 'Feature: Calls\nScenario: Click\n    When click "Save"\n' }
    });
    const service = createService(
        [nested, user],
        fileSystem,
        [
            { path: '/scenario', extensions: ['.yaml', '.yml'] },
            { path: '/library', extensions: ['.feature'] }
        ]
    );

    const nestedReferences = await service.findReferences(
        nested.id, uri('file:///scenario/main.yaml'), { includeDeclaration: false }, noCancellation
    );
    const userReferences = await service.findReferences(
        user.id, uri('file:///library/calls.feature'), { includeDeclaration: false }, noCancellation
    );

    assert.equal(nestedReferences.length, 1);
    assert.equal(nestedReferences[0].range.start.line, 1);
    assert.equal(nestedReferences[0].range.start.character, 8);
    assert.equal(userReferences.length, 1);
    assert.equal(userReferences[0].range.start.line, 2);
    assert.equal(userReferences[0].range.start.character, 9);
});

test('keeps reference buckets separated by stable definition id', async () => {
    const first = definition('user:first', 'userStep', 'And choose "%1 value" first', 'file:///lib/a.bsl', [
        { name: 'value', index: 0, source: 'quoted' }
    ]);
    const second = definition('user:second', 'userStep', 'And choose "%1 value" second', 'file:///lib/b.bsl', [
        { name: 'value', index: 0, source: 'quoted' }
    ]);
    const fileSystem = new VirtualFileSystem({
        '/features/usage.feature': {
            text: 'Feature: Stable ids\nScenario: Calls\n    And choose "A" first\n'
        }
    });
    const service = createService(
        [first, second],
        fileSystem,
        [{ path: '/features', extensions: ['.feature'] }]
    );

    assert.equal((await service.findReferences(first.id, undefined, { includeDeclaration: false }, noCancellation)).length, 1);
    assert.equal((await service.findReferences(second.id, undefined, { includeDeclaration: false }, noCancellation)).length, 0);
});

test('honors declaration inclusion independently of usages', async () => {
    const nested = definition('nested:only', 'nestedScenario', 'Only scenario', 'file:///scenario/only.yaml');
    const fileSystem = new VirtualFileSystem({
        '/scenario/main.yaml': { text: 'ТекстСценария: |\n    And Only scenario\n' }
    });
    const service = createService(
        [nested], fileSystem, [{ path: '/scenario', extensions: ['.yaml'] }]
    );

    const without = await service.findReferences(nested.id, undefined, { includeDeclaration: false }, noCancellation);
    const withDeclaration = await service.findReferences(nested.id, undefined, { includeDeclaration: true }, noCancellation);

    assert.equal(without.length, 1);
    assert.equal(withDeclaration.length, 2);
    assert.ok(withDeclaration.some(item => item.uri.toString() === 'file:///scenario/only.yaml'));
});

test('open unsaved documents override disk content', async () => {
    const first = definition('nested:disk', 'nestedScenario', 'Disk call', 'file:///defs/disk.yaml');
    const second = definition('nested:open', 'nestedScenario', 'Open call', 'file:///defs/open.yaml');
    const fileSystem = new VirtualFileSystem({
        '/scenario/main.yaml': { text: 'ТекстСценария: |\n    And Disk call\n' }
    });
    const openDocument = {
        uri: uri('file:///scenario/main.yaml'),
        fileName: '/scenario/main.yaml',
        version: 7,
        isUntitled: false,
        getText: () => 'ТекстСценария: |\n    And Open call\n'
    };
    const service = createService(
        [first, second], fileSystem, [{ path: '/scenario', extensions: ['.yaml'] }], [openDocument]
    );

    assert.equal((await service.findReferences(first.id, undefined, { includeDeclaration: false }, noCancellation)).length, 0);
    assert.equal((await service.findReferences(second.id, undefined, { includeDeclaration: false }, noCancellation)).length, 1);
    assert.equal(fileSystem.reads, 0);
});

test('deduplicates aliased roots and invalidates only a changed file', async () => {
    const nested = definition('nested:cache', 'nestedScenario', 'Cached call', 'file:///defs/cache.yaml');
    const fileSystem = new VirtualFileSystem({
        '/root/a.yaml': { text: 'And Cached call\n', mtimeMs: 1 },
        '/root/b.yaml': { text: 'And Cached call\n', mtimeMs: 1 }
    });
    fileSystem.aliases.set('/alias', '/root');
    const service = createService(
        [nested],
        fileSystem,
        [
            { path: '/root', extensions: ['.yaml'] },
            { path: '/alias', extensions: ['.yaml'] }
        ]
    );

    await service.findReferences(nested.id, undefined, { includeDeclaration: false }, noCancellation);
    assert.equal(fileSystem.directoryReads, 1);
    assert.equal(fileSystem.reads, 2);

    await service.findReferences(nested.id, undefined, { includeDeclaration: false }, noCancellation);
    assert.equal(fileSystem.reads, 2);

    fileSystem.files.get('/root/b.yaml')!.mtimeMs = 2;
    await service.findReferences(nested.id, undefined, { includeDeclaration: false }, noCancellation);
    assert.equal(fileSystem.reads, 3);
});

test('bounds concurrent reads and cancels without publishing partial results', async () => {
    const nested = definition('nested:many', 'nestedScenario', 'Many call', 'file:///defs/many.yaml');
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
        `/scenario/${index}.yaml`,
        { text: 'And Many call\n' }
    ]));
    const fileSystem = new VirtualFileSystem(files);
    const service = createService(
        [nested], fileSystem, [{ path: '/scenario', extensions: ['.yaml'] }], [], 2
    );

    const references = await service.findReferences(
        nested.id, undefined, { includeDeclaration: false }, noCancellation
    );
    assert.equal(references.length, 8);
    assert.ok(fileSystem.maxActiveReads > 1);
    assert.ok(fileSystem.maxActiveReads <= 2);

    const cancelledFileSystem = new VirtualFileSystem(files);
    const cancellation = { isCancellationRequested: false };
    cancelledFileSystem.onRead = () => {
        cancellation.isCancellationRequested = true;
    };
    const cancelledService = createService(
        [nested], cancelledFileSystem, [{ path: '/scenario', extensions: ['.yaml'] }], [], 2
    );
    const cancelled = await cancelledService.findReferences(
        nested.id, undefined, { includeDeclaration: false }, cancellation
    );
    assert.equal(cancelled.length, 0);
    assert.ok(cancelledFileSystem.reads <= 2);
});

test('reference provider resolves a stable id from a BSL declaration range', async () => {
    const user = definition('user:declaration', 'userStep', 'And declared step', 'file:///lib/steps.bsl');
    const resolver = resolverFor([user]);
    const calls: Array<{ id: string; includeDeclaration: boolean }> = [];
    const service = {
        findReferences: async (id: string, _resource: unknown, options: { includeDeclaration: boolean }) => {
            calls.push({ id, includeDeclaration: options.includeDeclaration });
            return [new (vscode.Location as any)(uri('file:///usage.feature'), new Range(3, 4, 3, 17))];
        }
    };
    const exports = loadReferencesModule();
    const Provider = exports.ProjectDefinitionReferenceProvider as new (
        service: object,
        resolver: object
    ) => { provideReferences: (...args: any[]) => Promise<unknown[]> };
    const provider = new Provider(service, resolver);
    const document = {
        uri: uri('file:///lib/steps.bsl'),
        lineAt: () => ({ text: '    Дано("And declared step")' })
    };

    const references = await provider.provideReferences(
        document,
        new Position(1, 10),
        { includeDeclaration: true },
        noCancellation
    );

    assert.equal(references.length, 1);
    assert.deepEqual(calls, [{ id: user.id, includeDeclaration: true }]);
});

test('activation stays lazy and registers Shift+F12 for YAML, feature, and BSL files', () => {
    const extension = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.match(extension, /new ProjectDefinitionReferenceService\(/);
    assert.match(extension, /registerReferenceProvider\(/);
    assert.match(extension, /pattern: '\*\*\/\*\.bsl', scheme: 'file'/);
    assert.doesNotMatch(extension, /await\s+projectDefinitionReferenceService\.(?:scan|findReferences)\(/);
});
