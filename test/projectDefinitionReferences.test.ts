import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { localFileUri, virtualFilePath } from './helpers/filePaths';
import {
    createProjectDefinitionView,
    normalizeProjectDefinitionTemplate,
    sameProjectDefinitionSource,
    type ProjectDefinition
} from '../src/projectDefinition';
import { resolveProjectInvocation } from '../src/projectDefinitionMatcher';
import * as compilerSyntax from '../src/scenarioCompilerSyntax';
import { findExportScenarioBuildCallers } from '../src/scenarioBuildDependencies';

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
        fsPath: value.startsWith('file:') ? fileURLToPath(value) : new URL(value).pathname,
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
        file: (filePath: string) => uri(localFileUri(filePath)),
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

function loadReferencesModule(nativeSources: ReadonlyMap<string, string> = new Map()): Record<string, unknown> {
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
            if (specifier === './kotInteraction') { return nativeInteraction; }
            if (specifier === './projectDefinition') { return { sameProjectDefinitionSource }; }
            if (specifier === './spprScenarioFiles.js') {
                return { resolveScenarioSourceUris: async (document: { toString(): string }) => {
                    const metadata = nativeSources.get(document.toString());
                    return metadata ? { format: 'native', metadataUri: uri(metadata) } : undefined;
                } };
            }
            if (specifier === './scenarioCompilerSyntax') { return compilerSyntax; }
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
        findReferencesForDefinitions: (...args: any[]) => Promise<ReadonlyMap<string, Array<{ uri: ReturnType<typeof uri>; range: Range }>>>;
    };
    return new Service({
        resolver: resolverFor(definitions),
        loadSearchRoots: async () => roots,
        fileSystem: {
            realpath: (value: string) => fileSystem.realpath(virtualFilePath(value)),
            readDirectory: (value: string) => fileSystem.readDirectory(virtualFilePath(value)),
            stat: (value: string) => fileSystem.stat(virtualFilePath(value)),
            readFile: (value: string) => fileSystem.readFile(virtualFilePath(value)),
            toUri: localFileUri
        },
        getOpenDocuments: () => openDocuments,
        directoryConcurrency: 2,
        readConcurrency
    });
}

const noCancellation = { isCancellationRequested: false };

test('strict reference searches reject inaccessible roots, directories and caller files', async () => {
    for (const failedMethod of ['realpath', 'readDirectory', 'readFile'] as const) {
        const exported = definition('export:open', 'exportScenario', 'open window', localFileUri("/library/export.feature"));
        const fileSystem = new VirtualFileSystem({ '/scenario/caller.feature': { text: 'Feature: A\nScenario: B\n    And open window\n' } });
        fileSystem[failedMethod] = async () => { throw new Error('Access denied'); };
        const service = createService([exported], fileSystem, [{ path: '/scenario', extensions: ['.feature'] }]);
        await assert.rejects(() => service.findReferences(exported.id, undefined, { includeDeclaration: false, failOnScanError: true }, noCancellation), /Access denied/);
        assert.equal((await service.findReferences(exported.id, undefined, { includeDeclaration: false }, noCancellation)).length, 0);
    }
});

test('strict rename searches include saved calls hidden by an unsaved edit', async () => {
    const exported = definition('export:open', 'exportScenario', 'open window', localFileUri("/library/export.feature"));
    const fileSystem = new VirtualFileSystem({ '/scenario/caller.feature': { text: 'Feature: A\nScenario: B\n    And open window\n' } });
    const document = {
        uri: uri(localFileUri("/scenario/caller.feature")), fileName: '/scenario/caller.feature', version: 2, isUntitled: false, isDirty: true,
        getText: () => 'Feature: A\nScenario: B\n    And different call\n'
    };
    const service = createService([exported], fileSystem, [{ path: '/scenario', extensions: ['.feature'] }], [document]);
    assert.equal((await service.findReferences(exported.id, undefined, { includeDeclaration: false }, noCancellation)).length, 0);
    const references = await service.findReferences(exported.id, undefined, { includeDeclaration: false, failOnScanError: true }, noCancellation);
    assert.equal(references.length, 1);
    assert.equal(references[0].uri.toString(), document.uri.toString());
});

test('strict reference scans skip an uncreated search root while scanning existing sources', async () => {
    const exported = definition('export:open', 'exportScenario', 'open window', localFileUri('/library/export.feature'));
    const fileSystem = new VirtualFileSystem({ '/scenario/caller.feature': { text: 'Feature: A\nScenario: B\n    And open window\n' } });
    const realpath = fileSystem.realpath.bind(fileSystem);
    fileSystem.realpath = async file => { if (file.endsWith('not-built')) { throw Object.assign(new Error('Not built yet'), { code: 'ENOENT' }); } return realpath(file); };
    const service = createService([exported], fileSystem, [{ path: '/scenario', extensions: ['.feature'] }, { path: '/not-built', extensions: ['.feature'] }]);
    const references = await service.findReferences(exported.id, undefined, { includeDeclaration: false, failOnScanError: true }, noCancellation);
    assert.equal(references.length, 1); assert.equal(references[0].uri.toString(), localFileUri('/scenario/caller.feature'));
});

test('indexes compiler loop openings with ranges starting after their delimiters', async () => {
    for (const [template, opening, body] of [
        ['And I repeat "%1 Count" times', 'Do', 'I repeat "10" times'],
        ['И я делаю "%1 Count" раз', 'Цикл', 'я делаю "10" раз']
    ]) {
        const loop = definition('loop', 'builtInStep', template, localFileUri("/library/loops.bsl"), [
            { name: 'Count', index: 0, source: 'quoted' }
        ]);
        const fileSystem = new VirtualFileSystem({
            '/scenario/loop.yaml': { text: `ТекстСценария: |\n    ${opening} ${body}\n    EndDo\n` }
        });
        const service = createService([loop], fileSystem, [{ path: '/scenario', extensions: ['.yaml'] }]);
        const references = await service.findReferences(loop.id, undefined, { includeDeclaration: false }, noCancellation);
        assert.equal(references.length, 1, opening);
        assert.equal(references[0].range.start.line, 1);
        assert.equal(references[0].range.start.character, 4 + opening.length + 1);
        assert.equal(references[0].range.end.character, 4 + opening.length + 1 + body.length);
    }
});

test('indexes YAML and feature calls with parameterized templates and exact ranges', async () => {
    const nested = definition(
        'nested:checkout',
        'nestedScenario',
        'Checkout order',
        localFileUri("/scenario/checkout.yaml")
    );
    const user = definition(
        'user:click',
        'userStep',
        'And click "%1 button"',
        localFileUri("/library/steps.bsl"),
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
        nested.id, uri(localFileUri("/scenario/main.yaml")), { includeDeclaration: false }, noCancellation
    );
    const userReferences = await service.findReferences(
        user.id, uri(localFileUri("/library/calls.feature")), { includeDeclaration: false }, noCancellation
    );

    assert.equal(nestedReferences.length, 1);
    assert.equal(nestedReferences[0].range.start.line, 1);
    assert.equal(nestedReferences[0].range.start.character, 8);
    assert.equal(userReferences.length, 1);
    assert.equal(userReferences[0].range.start.line, 2);
    assert.equal(userReferences[0].range.start.character, 9);
});

test('keeps reference buckets separated by stable definition id', async () => {
    const first = definition('user:first', 'userStep', 'And choose "%1 value" first', localFileUri("/lib/a.bsl"), [
        { name: 'value', index: 0, source: 'quoted' }
    ]);
    const second = definition('user:second', 'userStep', 'And choose "%1 value" second', localFileUri("/lib/b.bsl"), [
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

test('collects references for several definitions in one source scan', async () => {
    const first = definition('export:first', 'exportScenario', 'And use first export', localFileUri("/lib/exports.feature"));
    const second = definition('export:second', 'exportScenario', 'And use second export', localFileUri("/lib/exports.feature"));
    const fileSystem = new VirtualFileSystem({
        '/scenario/main.yaml': {
            text: 'ТекстСценария: |\n    And use first export\n    And use second export\n'
        }
    });
    const service = createService(
        [first, second],
        fileSystem,
        [{ path: '/scenario', extensions: ['.yaml'] }]
    );

    const references = await service.findReferencesForDefinitions(
        [first.id, second.id],
        uri(localFileUri("/scenario/main.yaml")),
        { includeDeclaration: false },
        noCancellation
    );

    assert.equal(references.get(first.id)?.length, 1);
    assert.equal(references.get(second.id)?.length, 1);
    assert.equal(fileSystem.directoryReads, 1);
    assert.equal(fileSystem.reads, 1);
});

test('build invalidation finds export callers in native scripts and legacy YAML through runtime library calls', async () => {
    const leaf = definition('export:leaf', 'exportScenario', 'And leaf step', localFileUri("/library/leaf.feature"));
    const middle = definition('export:middle', 'exportScenario', 'And middle step', localFileUri("/library/middle.feature"));
    const fileSystem = new VirtualFileSystem({
        '/library/middle.feature': { text: 'Feature: library\nScenario: middle step\n    And leaf step\n' },
        '/tests/native/scen.feature': { text: 'And middle step\n' },
        '/tests/legacy/scen.yaml': { text: 'ТекстСценария: |\n    And middle step\n' },
        '/tests/unrelated/scen.feature': { text: 'And Delay 1\n' }
    });
    const definitions = [leaf, middle];
    const references = createService(definitions, fileSystem, [
        { path: '/library', extensions: ['.feature'] }, { path: '/tests', extensions: ['.yaml', '.feature'] }
    ]);
    const services = { resolver: resolverFor(definitions), references } as any;
    const callers = await findExportScenarioBuildCallers(uri(localFileUri("/library/leaf.feature")) as any, services);
    assert.deepEqual(new Set(callers.map(item => item.toString())), new Set([
        localFileUri("/library/middle.feature"), localFileUri("/tests/native/scen.feature"), localFileUri("/tests/legacy/scen.yaml")
    ]));
    assert.equal(fileSystem.reads, 4);
    await findExportScenarioBuildCallers(uri(localFileUri("/library/leaf.feature")) as any, services);
    assert.equal(fileSystem.reads, 4, 'unchanged caller contents should be reused');
});

test('honors declaration inclusion independently of usages', async () => {
    const nested = definition('nested:only', 'nestedScenario', 'Only scenario', localFileUri("/scenario/only.yaml"));
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
    assert.ok(withDeclaration.some(item => item.uri.toString() === localFileUri("/scenario/only.yaml")));
});

test('open unsaved documents override disk content', async () => {
    const first = definition('nested:disk', 'nestedScenario', 'Disk call', localFileUri("/defs/disk.yaml"));
    const second = definition('nested:open', 'nestedScenario', 'Open call', localFileUri("/defs/open.yaml"));
    const fileSystem = new VirtualFileSystem({
        '/scenario/main.yaml': { text: 'ТекстСценария: |\n    And Disk call\n' }
    });
    const openDocument = {
        uri: uri(localFileUri("/scenario/main.yaml")),
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
    const nested = definition('nested:cache', 'nestedScenario', 'Cached call', localFileUri("/defs/cache.yaml"));
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

test('returns workspace-facing URIs while reading files through a canonical root alias', async () => {
    const nested = definition(
        'nested:workspace-uri',
        'nestedScenario',
        'Workspace call',
        localFileUri("/workspace/definition.yaml")
    );
    const fileSystem = new VirtualFileSystem({
        '/physical/main.yaml': { text: 'And Workspace call\n' }
    });
    fileSystem.aliases.set('/workspace', '/physical');
    const service = createService(
        [nested],
        fileSystem,
        [{ path: '/workspace', extensions: ['.yaml'] }]
    );

    const references = await service.findReferences(
        nested.id,
        uri(localFileUri("/workspace/definition.yaml")),
        { includeDeclaration: false },
        noCancellation
    );

    assert.equal(references.length, 1);
    assert.equal(references[0].uri.toString(), localFileUri("/workspace/main.yaml"));
});

test('bounds concurrent reads and cancels without publishing partial results', async () => {
    const nested = definition('nested:many', 'nestedScenario', 'Many call', localFileUri("/defs/many.yaml"));
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
    const user = definition('user:declaration', 'userStep', 'And declared step', localFileUri("/lib/steps.bsl"));
    const resolver = resolverFor([user]);
    const calls: Array<{ id: string; includeDeclaration: boolean }> = [];
    const service = {
        findReferences: async (id: string, _resource: unknown, options: { includeDeclaration: boolean }) => {
            calls.push({ id, includeDeclaration: options.includeDeclaration });
            return [new (vscode.Location as any)(uri(localFileUri("/usage.feature")), new Range(3, 4, 3, 17))];
        }
    };
    const exports = loadReferencesModule();
    const Provider = exports.ProjectDefinitionReferenceProvider as new (
        service: object,
        resolver: object
    ) => { provideReferences: (...args: any[]) => Promise<unknown[]> };
    const provider = new Provider(service, resolver);
    const document = {
        uri: uri(localFileUri("/lib/steps.bsl")),
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

test('current-scenario resolution uses the open document instead of the cursor line', async () => {
    const nested = definition(
        localFileUri("/scenario/current.yaml"),
        'nestedScenario',
        'Current scenario',
        localFileUri("/scenario/current.yaml")
    );
    const calledFromCurrentLine = definition(
        localFileUri("/scenario/called.yaml"),
        'nestedScenario',
        'Called scenario',
        localFileUri("/scenario/called.yaml")
    );
    const exports = loadReferencesModule();
    const resolveForDocument = exports.resolveProjectDefinitionIdsForDocument as (
        document: object,
        resolver: object,
        token: object
    ) => Promise<string[]>;
    const document = {
        uri: uri(localFileUri("/scenario/current.yaml")),
        lineAt: () => ({ text: 'And Called scenario' })
    };

    const ids = await resolveForDocument(
        document,
        resolverFor([nested, calledFromCurrentLine]),
        noCancellation
    );

    assert.deepEqual(Array.from(ids), [nested.id]);
});

test('activation stays lazy and registers Shift+F12 for YAML, feature, and BSL files', () => {
    const extension = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.match(extension, /new ProjectDefinitionReferenceService\(/);
    assert.match(extension, /registerReferenceProvider\(/);
    assert.match(extension, /pattern: '\*\*\/\*\.bsl', scheme: 'file'/);
    assert.doesNotMatch(extension, /await\s+projectDefinitionReferenceService\.(?:scan|findReferences)\(/);
});

test('current-scenario references normalize Windows URI spelling for metadata and implementations', async () => {
    const nested = definition('own', 'nestedScenario', 'Own', 'file:///C:/Git/Tests/scen.yaml');
    const other = definition('other', 'nestedScenario', 'Other', 'file:///C:/Git/Tests/other/scen.yaml');
    const exports = loadReferencesModule();
    const resolve = exports.resolveProjectDefinitionIdsForDocument as (...args: any[]) => Promise<string[]>;
    const resolver = resolverFor([nested, other]);
    const document = { uri: uri('file:///c%3A/git/tests/scen.yaml'), lineAt: () => ({ text: 'And Other' }) };
    assert.deepEqual(Array.from(await resolve(document, resolver, noCancellation)), [nested.id]);
    const atPosition = exports.resolveProjectDefinitionIdsAtPosition as (...args: any[]) => Promise<string[]>;
    assert.deepEqual(Array.from(await atPosition(document, new Position(1, 4), resolver, noCancellation)), [nested.id]);
    const step = { ...nested, id: 'implementation', kind: 'userStep' as const, definitionLocation: undefined,
        implementationLocation: { ...nested.definitionLocation!, uri: 'file:///C:/Git/Steps/module.bsl' } };
    assert.deepEqual(Array.from(await resolve({ uri: uri('file:///c%3A/git/steps/module.bsl') }, resolverFor([step]), noCancellation)), [step.id]);
});

test('native current-scenario references resolve paired metadata without selecting the call under the cursor', async () => {
    const script = localFileUri('/scenario/own/scen.feature'); const metadata = localFileUri('/scenario/own/meta.yaml');
    const own = definition('own', 'nestedScenario', 'Own', metadata);
    const other = definition('other', 'nestedScenario', 'Other', localFileUri('/scenario/other/meta.yaml'));
    const exports = loadReferencesModule(new Map([[script, metadata]])); const resolver = resolverFor([own, other]);
    const resolve = exports.resolveProjectDefinitionIdsForDocument as (...args: any[]) => Promise<string[]>;
    const atPosition = exports.resolveProjectDefinitionIdsAtPosition as (...args: any[]) => Promise<string[]>;
    const document = { uri: uri(script), lineAt: () => ({ text: 'And Other' }) };
    assert.deepEqual(Array.from(await resolve(document, resolver, noCancellation)), [own.id]);
    assert.deepEqual(Array.from(await atPosition(document, new Position(5, 4), resolver, noCancellation)), [other.id]);
    assert.deepEqual(Array.from(await atPosition({ uri: uri(script), lineAt: () => ({ text: '' }) }, new Position(6, 0), resolver, noCancellation)), [own.id]);
    assert.deepEqual(Array.from(await resolve(document, resolver, { isCancellationRequested: true })), []);
});

test('a standalone scen.feature is not associated with unvalidated neighbouring metadata', async () => {
    const script = localFileUri('/scenario/own/scen.feature');
    const own = definition('own', 'nestedScenario', 'Own', localFileUri('/scenario/own/meta.yaml'));
    const exports = loadReferencesModule();
    const resolve = exports.resolveProjectDefinitionIdsForDocument as (...args: any[]) => Promise<string[]>;
    assert.deepEqual(Array.from(await resolve({ uri: uri(script) }, resolverFor([own]), noCancellation)), []);
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const menu = manifest.contributes.menus['kotTestToolkit.editorContext'].find((item: any) => item.command === 'kotTestToolkit.editorMenu.findCurrentFileReferences');
    assert.match(menu.when, /resourceExtname == \.feature/u);
});
