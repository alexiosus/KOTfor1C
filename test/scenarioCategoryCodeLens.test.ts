import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as categoryModule from '../src/scenarioCategory';
import * as descriptorModule from '../src/scenarioDescriptor';
import * as yamlMutations from '../src/scenarioYamlMutations';
import * as phaseMetadata from '../src/phaseSwitcherMetadata';
import {
    isScenarioCategoryCommandTarget,
    validateScenarioCategoryValue
} from '../src/scenarioCategory';

test('accepts only complete scenario category command targets', () => {
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: 'file:///scenario.yaml',
        documentVersion: 7
    }), true);
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: '',
        documentVersion: 7
    }), false);
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: 'file:///scenario.yaml',
        documentVersion: 1.5
    }), false);
    assert.equal(isScenarioCategoryCommandTarget({
        documentUri: 'file:///scenario.yaml',
        documentVersion: 7,
        uri: 'file:///attacker.yaml'
    }), true);
});

function commandHarness(shared = true) {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Nested\n    Код: Nested\n    UID: nested\nТекстСценария: |\n    And ready\n';
    const document = { version: 3, uri: { toString: () => 'file:///repo/nested.yaml' }, getText: () => source,
        positionAt: (offset: number) => ({ line: 0, character: offset }) };
    let main = false;
    let mutateDuringPrompt = false;
    const patches: unknown[] = [];
    const edits: unknown[] = [];
    const commands: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const initialValues: string[] = [];
    const host = {
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        Uri: { parse: () => document.uri },
        Range: class {}, CodeLens: class { constructor(public range: unknown, public command: unknown) {} },
        WorkspaceEdit: class { replace(...args: unknown[]) { edits.push(args); } },
        workspace: { openTextDocument: async () => document, applyEdit: async () => true },
        commands: { executeCommand: async (command: string) => { commands.push(command); } },
        window: {
            showInputBox: async (options: { value: string }) => {
                initialValues.push(options.value);
                if (mutateDuringPrompt) { document.version++; }
                return 'New category';
            },
            showWarningMessage: (message: string) => { warnings.push(message); },
            showErrorMessage: (message: string) => { errors.push(message); }
        }
    };
    const dependencies: Record<string, unknown> = {
        vscode: host, './localization': { getTranslator: async () => (message: string) => message },
        './scenarioCategory': categoryModule, './scenarioDescriptor': descriptorModule, './scenarioYamlMutations': yamlMutations,
        './phaseSwitcherMetadata': phaseMetadata,
        './projectLibraryIntegration': {
            projectedProjectScenario: () => ({ tabName: main ? 'Shared group' : undefined, scenarioCategory: 'Shared category' }),
            persistProjectMetadata: async (_document: unknown, patch: unknown) => { if (shared) { patches.push(patch); } return shared; }
        }
    };
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/scenarioCategoryCodeLens.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name], console });
    return { api: module.exports, document, patches, edits, commands, warnings, errors, initialValues,
        main: () => { main = true; }, mutateDuringPrompt: () => { mutateDuringPrompt = true; } };
}

test('category command writes the shared object without adding KOT metadata to the scenario', async () => {
    const h = commandHarness();
    await h.api.setScenarioCategoryCommand({ documentUri: h.document.uri.toString(), documentVersion: 3 }, {
        resolver: { getView: async () => ({ all: [] }) }
    });
    assert.deepEqual(h.patches.map(value => JSON.parse(JSON.stringify(value))), [{ category: 'New category' }]);
    assert.deepEqual(h.edits, []);
    assert.deepEqual(h.initialValues, ['Shared category']);
    assert.deepEqual(h.commands, ['kotTestToolkit.refreshPhaseSwitcher']);
    assert.deepEqual(h.errors, []);
});

test('category action rejects projected main scenarios and rechecks source version after prompting', async () => {
    const main = commandHarness();
    main.main();
    const lenses = await new main.api.ScenarioCategoryCodeLensProvider({}).provideCodeLenses(main.document, { isCancellationRequested: false });
    assert.equal(lenses.length, 0);
    await main.api.setScenarioCategoryCommand({ documentUri: main.document.uri.toString(), documentVersion: 3 }, {
        resolver: { getView: async () => ({ all: [] }) }
    });
    assert.deepEqual(main.patches, []);
    const changed = commandHarness();
    changed.mutateDuringPrompt();
    await changed.api.setScenarioCategoryCommand({ documentUri: changed.document.uri.toString(), documentVersion: 3 }, {
        resolver: { getView: async () => ({ all: [] }) }
    });
    assert.deepEqual(changed.patches, []);
    assert.equal(changed.warnings.length, 1);
});

test('category command retains the legacy source edit only when project storage is unavailable', async () => {
    const h = commandHarness(false);
    await h.api.setScenarioCategoryCommand({ documentUri: h.document.uri.toString(), documentVersion: 3 }, {
        resolver: { getView: async () => ({ all: [] }) }
    });
    assert.deepEqual(h.patches, []);
    assert.equal(h.edits.length, 1);
    assert.deepEqual(h.commands, []);
});

test('validates non-empty single-line categories', () => {
    const t = (message: string) => `T:${message}`;

    assert.equal(validateScenarioCategoryValue('Sales.Orders', t), undefined);
    assert.equal(
        validateScenarioCategoryValue('   ', t),
        'T:Scenario category must not be empty.'
    );
    assert.equal(
        validateScenarioCategoryValue('Sales\nOrders', t),
        'T:Scenario category must fit on a single line.'
    );
});
