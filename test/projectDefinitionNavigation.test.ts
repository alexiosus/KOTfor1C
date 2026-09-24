import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

interface DefinitionLocation {
    uri: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
}

interface Definition {
    id: string;
    kind: 'builtInStep' | 'userStep' | 'exportScenario' | 'nestedScenario';
    template: string;
    normalizedTemplate: string;
    parameters: readonly unknown[];
    sourceLabel: string;
    definitionLocation?: DefinitionLocation;
    implementationLocation?: DefinitionLocation;
}

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

class Selection extends Range {}

const opened: Array<{ uri: string; selection?: Range }> = [];
let quickPickIndex = 0;

const vscode = {
    Position,
    Range,
    Selection,
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    Uri: {
        parse: (value: string) => ({
            scheme: value.split(':', 1)[0],
            fsPath: value.replace(/^file:\/\//, ''),
            toString: () => value
        })
    },
    l10n: {
        t: (message: string, ...args: string[]) =>
            message.replace(/\{(\d+)\}/g, (_match: string, index: string) => args[Number(index)] ?? '')
    },
    workspace: {
        openTextDocument: async (uri: { toString(): string }) => ({ uri })
    },
    window: {
        activeTextEditor: undefined as unknown,
        showInformationMessage: () => undefined,
        showQuickPick: async (items: unknown[]) => items[quickPickIndex],
        showTextDocument: async (document: { uri: { toString(): string } }) => {
            const record: { uri: string; selection?: Range } = { uri: document.uri.toString() };
            opened.push(record);
            return {
                set selection(value: Range) {
                    record.selection = value;
                },
                revealRange: () => undefined
            };
        }
    }
};

function loadNavigationModule(): Record<string, unknown> {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(
        path.join(process.cwd(), 'src', 'projectDefinitionNavigation.ts'),
        'utf8'
    );
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        require: (specifier: string) => specifier === 'vscode' ? vscode : {},
        console
    });
    return moduleObject.exports;
}

function definition(
    id: string,
    kind: Definition['kind'],
    overrides: Partial<Definition> = {}
): Definition {
    const template = overrides.template ?? 'And project call';
    return {
        id,
        kind,
        template,
        normalizedTemplate: template.replace(/^And\s+/i, '').trim(),
        parameters: [],
        sourceLabel: overrides.sourceLabel ?? id,
        ...overrides
    };
}

function location(uri: string, line: number, start = 0, end = 20): DefinitionLocation {
    return {
        uri,
        range: {
            start: { line, character: start },
            end: { line, character: end }
        }
    };
}

function match(item: Definition, start = 4, end = 16) {
    return { definition: item, invocationRange: { start, end }, arguments: [] };
}

function document(line = 'And project call') {
    return {
        uri: vscode.Uri.parse('file:///repo/current.feature'),
        lineAt: () => ({ text: line })
    };
}

async function provide(
    resolution: object,
    line = 'And project call',
    position = new Position(0, 8)
) {
    const exports = loadNavigationModule();
    const Provider = exports.ProjectDefinitionProvider as new (resolver: object) => {
        provideDefinition: (...args: unknown[]) => Promise<unknown[]>;
    };
    const provider = new Provider({ resolve: async () => resolution });
    return provider.provideDefinition(
        document(line),
        position,
        { isCancellationRequested: false }
    );
}

test('export scenario navigation targets its scenario title', async () => {
    const item = definition('export:login', 'exportScenario', {
        definitionLocation: location('file:///repo/features/login.feature', 8, 9, 22)
    });
    const links = await provide({ kind: 'unique', match: match(item) });

    assert.equal(links.length, 1);
    assert.equal((links[0] as any).targetUri.toString(), 'file:///repo/features/login.feature');
    assert.equal((links[0] as any).targetSelectionRange.start.line, 8);
});

test('user-step navigation prefers implementation and falls back to registration', async () => {
    const implementation = definition('user:implementation', 'userStep', {
        definitionLocation: location('file:///repo/steps/module.bsl', 4),
        implementationLocation: location('file:///repo/steps/module.bsl', 40, 4, 25)
    });
    const implementationLinks = await provide({ kind: 'unique', match: match(implementation) });
    assert.equal((implementationLinks[0] as any).targetSelectionRange.start.line, 40);

    const registration = definition('user:registration', 'userStep', {
        definitionLocation: location('file:///repo/steps/module.bsl', 6, 4, 28)
    });
    const registrationLinks = await provide({ kind: 'unique', match: match(registration) });
    assert.equal((registrationLinks[0] as any).targetSelectionRange.start.line, 6);
});

test('nested scenario navigation targets its YAML definition', async () => {
    const item = definition('nested:checkout', 'nestedScenario', {
        template: 'Checkout order',
        definitionLocation: location('file:///repo/tests/checkout.yaml', 3, 5, 19)
    });
    const links = await provide({ kind: 'unique', match: match(item, 4, 18) }, 'And Checkout order');

    assert.equal((links[0] as any).targetUri.toString(), 'file:///repo/tests/checkout.yaml');
    assert.equal((links[0] as any).originSelectionRange.start.character, 4);
    assert.equal((links[0] as any).originSelectionRange.end.character, 18);
});

test('built-in definitions without source locations do not navigate', async () => {
    const item = definition('built:click', 'builtInStep');
    const links = await provide({ kind: 'unique', match: match(item) });
    assert.equal(links.length, 0);
});

test('ambiguous calls return one LocationLink per navigable definition', async () => {
    const first = definition('local:a', 'userStep', {
        definitionLocation: location('file:///repo/steps/a.bsl', 5)
    });
    const second = definition('local:b', 'exportScenario', {
        definitionLocation: location('file:///repo/features/b.feature', 7)
    });
    const links = await provide({ kind: 'ambiguous', matches: [match(first), match(second)] });

    assert.equal(links.length, 2);
    assert.deepEqual(
        Array.from(links, link => (link as any).targetUri.toString()).sort(),
        ['file:///repo/features/b.feature', 'file:///repo/steps/a.bsl']
    );
});

test('picker opens the source selected by stable definition id', async () => {
    opened.length = 0;
    quickPickIndex = 1;
    const first = definition('nested:a', 'nestedScenario', {
        definitionLocation: location('file:///repo/tests/a.yaml', 2)
    });
    const second = definition('nested:b', 'nestedScenario', {
        definitionLocation: location('file:///repo/tests/b.yaml', 9, 4, 16)
    });
    const view = {
        identity: 'view',
        all: [first, second],
        byId: new Map([[first.id, first], [second.id, second]]),
        byNormalizedTemplate: new Map()
    };
    const resolver = { getView: async () => view };
    const exports = loadNavigationModule();
    const pickProjectDefinition = exports.pickProjectDefinition as (
        definitions: Definition[],
        resource: unknown,
        resolver: object,
        title?: string
    ) => Promise<boolean>;

    const result = await pickProjectDefinition(
        [first, second],
        vscode.Uri.parse('file:///repo/current.yaml'),
        resolver,
        'Choose definition'
    );

    assert.equal(result, true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].uri, 'file:///repo/tests/b.yaml');
    assert.equal(opened[0].selection?.start.line, 9);
});

test('context scenario navigation opens an exported scenario definition', async () => {
    opened.length = 0;
    const item = definition('export:ready', 'exportScenario', {
        template: 'Then "WindowName" window is opened and ready for input',
        definitionLocation: location('file:///repo/features/WaitWindowReadyForInput.feature', 5, 10, 60)
    });
    const view = {
        identity: 'view',
        all: [item],
        byId: new Map([[item.id, item]]),
        byNormalizedTemplate: new Map()
    };
    const resolver = {
        resolve: async () => ({ kind: 'unique', match: match(item) }),
        getView: async () => view
    };
    const exports = loadNavigationModule();
    const openScenarioDefinitionForInvocation = exports.openScenarioDefinitionForInvocation as
        | ((invocation: string, resource: unknown, resolver: object) => Promise<boolean>)
        | undefined;

    assert.equal(typeof openScenarioDefinitionForInvocation, 'function');
    const result = await openScenarioDefinitionForInvocation?.(
        'Then "Add indicator" window is opened and ready for input',
        vscode.Uri.parse('file:///repo/current.yaml'),
        resolver
    );

    assert.equal(result, true);
    assert.equal(opened[0]?.uri, 'file:///repo/features/WaitWindowReadyForInput.feature');
    assert.equal(opened[0]?.selection?.start.line, 5);
});

test('legacy open-by-name handler delegates to scenario definition navigation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'commandHandlers.ts'), 'utf8');
    const start = source.indexOf('export async function openScenarioByNameHandler(');
    const end = source.indexOf('\n}\n', start) + 2;
    const handler = source.slice(start, end);

    assert.match(handler, /ProjectDefinitionResolver/);
    assert.match(handler, /openScenarioDefinitionForInvocation/);
    assert.doesNotMatch(handler, /findFileByName|ensureFreshScenarioCatalog/);
});

test('activation registers navigation for file-backed YAML and feature documents', () => {
    const extension = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const manifest = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as { contributes: { commands: Array<{ command: string }> } };

    assert.match(
        extension,
        /registerDefinitionProvider\(\s*completionAndHoverSelector,\s*new ProjectDefinitionProvider\(projectDefinitionResolver\)/
    );
    assert.match(extension, /pattern: '\*\*\/\*\.yaml', scheme: 'file'/);
    assert.match(extension, /pattern: '\*\*\/\*\.feature', scheme: 'file'/);
    assert.ok(
        manifest.contributes.commands.some(command =>
            command.command === 'kotTestToolkit.openProjectDefinition'
        )
    );
});
