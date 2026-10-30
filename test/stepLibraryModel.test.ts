import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ProjectDefinition,
    ProjectDefinitionView
} from '../src/projectDefinition';
import {
    buildStepLibrarySnapshot,
    type StepLibrarySnapshot
} from '../src/stepLibraryModel';
import type { TestInfo } from '../src/types';

function definition(
    overrides: Partial<ProjectDefinition> & Pick<ProjectDefinition, 'id' | 'kind' | 'template'>
): ProjectDefinition {
    return {
        normalizedTemplate: overrides.template.replace(/\s+/gu, ' ').trim(),
        parameters: [],
        sourceLabel: 'Test source',
        ...overrides
    };
}

function view(definitions: readonly ProjectDefinition[]): ProjectDefinitionView {
    return {
        identity: 'view:visual-library',
        all: definitions,
        byId: new Map(definitions.map(item => [item.id, item])),
        byNormalizedTemplate: new Map()
    };
}

function scenario(overrides: Partial<TestInfo> & Pick<TestInfo, 'name'>): TestInfo {
    const serializedUri = overrides.yamlFileUri?.toString() ?? 'file:///workspace/main/scen.yaml';
    return {
        name: overrides.name,
        yamlFileUri: overrides.yamlFileUri ?? {
            scheme: 'file',
            fsPath: serializedUri.replace(/^file:\/\//u, ''),
            toString: () => serializedUri
        } as TestInfo['yamlFileUri'],
        relativePath: 'main',
        ...overrides
    };
}

function snapshotWithScenarios(
    definitions: readonly ProjectDefinition[],
    scenarios: readonly TestInfo[],
    compiledResources: ReadonlyMap<string, {
        readonly featureUri: string;
        readonly filesRootUri: string;
    }> = new Map()
): StepLibrarySnapshot {
    const build = buildStepLibrarySnapshot as unknown as (
        currentView: ProjectDefinitionView,
        currentScenarios: readonly TestInfo[],
        currentCompiledResources: ReadonlyMap<string, {
            readonly featureUri: string;
            readonly filesRootUri: string;
        }>
    ) => StepLibrarySnapshot;
    return build(view(definitions), scenarios, compiledResources);
}

function allSources(): readonly ProjectDefinition[] {
    const location = {
        uri: 'file:///workspace/library.feature',
        range: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 30 }
        }
    };
    return [
        definition({
            id: 'built:open:ru',
            familyId: 'built:open',
            kind: 'builtInStep',
            template: 'И открываю форму "%1 ИмяФормы"',
            language: 'ru',
            categoryPath: ['Интерфейс', 'Формы'],
            description: 'Открывает форму.',
            sourceLabel: 'Vanessa 1.2 (RU)'
        }),
        definition({
            id: 'built:open:en',
            familyId: 'built:open',
            kind: 'builtInStep',
            template: 'And I open "%1 FormName" form',
            language: 'en',
            categoryPath: ['UI', 'Forms'],
            description: 'Opens a form.',
            sourceLabel: 'Vanessa 1.2 (EN)'
        }),
        definition({
            id: 'user:login',
            kind: 'userStep',
            template: 'And I log in as "Administrator"',
            parameters: [{ name: 'User', index: 0, source: 'snippet' }],
            description: 'Cafe\u0301 login helper.',
            sourceLabel: 'User steps (Library)',
            definitionLocation: location
        }),
        definition({
            id: 'export:window',
            kind: 'exportScenario',
            template: '"WindowName" window is ready',
            usageExample: 'Then "Add indicator" window is ready',
            parameters: [{ name: 'WindowName', index: 0, source: 'quoted' }],
            category: 'UI.. Windows ',
            sourceLabel: 'Project exports (Libraries)',
            definitionLocation: location
        }),
        definition({
            id: 'nested:sales',
            kind: 'nestedScenario',
            template: 'Create sales order',
            category: ' Продажи . . Заказы ',
            parameters: [{
                name: 'Customer',
                index: 0,
                source: 'snippet',
                defaultValue: '"Main customer"'
            }],
            sourceLabel: 'Nested scenario (Sales/order)',
            definitionLocation: location
        })
    ];
}

test('builds stable serializable rows for all callable sources', () => {
    const snapshot = buildStepLibrarySnapshot(view(allSources()));

    assert.equal(snapshot.viewIdentity, 'view:visual-library');
    assert.deepEqual(snapshot.counts, { builtIn: 2, user: 1, export: 1, nested: 1, main: 0, process: 0 });
    assert.equal(snapshot.items.length, 5);
    assert.equal(JSON.parse(JSON.stringify(snapshot)).viewIdentity, snapshot.viewIdentity);
    assert.equal(JSON.stringify(snapshot).includes('snippetText'), false);
});

test('includes nested scenario codes in presentation and search data', () => {
    const nested = Object.assign(
        definition({
            id: 'nested:code',
            kind: 'nestedScenario',
            template: 'Fill GL account',
            sourceLabel: 'Nested scenario (Accounting)',
            definitionLocation: allSources()[4].definitionLocation
        }),
        { scenarioCode: '000015128' }
    );

    const item = buildStepLibrarySnapshot(view([nested])).items[0] as {
        scenarioCode?: string;
        searchText: string;
    };

    assert.equal(item.scenarioCode, '000015128');
    assert.match(item.searchText, /000015128/u);
});

test('marks only local nested definitions as scenario file roots', () => {
    const location = allSources()[4].definitionLocation;
    assert.ok(location);
    const localNested = definition({
        id: 'nested:local-files',
        kind: 'nestedScenario',
        template: 'Local nested scenario',
        sourceLabel: 'Nested scenario',
        definitionLocation: location
    });
    const remoteNested = definition({
        id: 'nested:remote-files',
        kind: 'nestedScenario',
        template: 'Remote nested scenario',
        sourceLabel: 'Nested scenario',
        definitionLocation: {
            ...location,
            uri: 'vscode-remote://ssh-remote+host/workspace/scen.yaml'
        }
    });
    const exported = definition({
        id: 'export:local-files',
        kind: 'exportScenario',
        template: 'Export scenario',
        sourceLabel: 'Export scenario',
        definitionLocation: location
    });

    const items = buildStepLibrarySnapshot(view([localNested, remoteNested, exported])).items;

    assert.equal(items.find(item => item.definitionId === localNested.id)?.hasScenarioFiles, true);
    assert.equal(items.find(item => item.definitionId === remoteNested.id)?.hasScenarioFiles, undefined);
    assert.equal(items.find(item => item.definitionId === exported.id)?.hasScenarioFiles, undefined);
});

test('adds non-callable main scenarios as a separate searchable source grouped by Test Manager tab', () => {
    const snapshot = snapshotWithScenarios([], [scenario({
        name: 'Monthly close',
        scenarioCode: '000020026',
        scenarioDescription: 'Builds the monthly close feature.',
        tabName: 'Accounting',
        relativePath: 'Accounting/MonthlyClose'
    })]);

    assert.deepEqual(snapshot.counts, {
        builtIn: 0,
        user: 0,
        export: 0,
        nested: 0,
        main: 1,
        process: 0
    });
    assert.equal(snapshot.items.length, 1);
    assert.deepEqual(snapshot.items[0], {
        id: 'mainScenario#file:///workspace/main/scen.yaml',
        definitionId: 'mainScenario:file:///workspace/main/scen.yaml',
        familyId: 'mainScenario:file:///workspace/main/scen.yaml',
        kind: 'mainScenario',
        sourceGroup: 'main',
        hasScenarioFiles: true,
        sourceScenarioFilesRootUri: 'file:///workspace/main/files',
        scenarioFilesRootUri: 'file:///workspace/main/files',
        template: 'Monthly close',
        displayText: 'Monthly close',
        description: 'Builds the monthly close feature.',
        scenarioCode: '000020026',
        categoryPath: ['Accounting'],
        parameters: [],
        sourceLabel: 'Main scenario (Accounting/MonthlyClose)',
        navigable: true,
        insertable: false,
        capturedLocation: {
            uri: 'file:///workspace/main/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            }
        },
        scenarioKey: 'file:///workspace/main/scen.yaml',
        searchText: 'monthly close builds the monthly close feature. 000020026 accounting main scenario (accounting/monthlyclose) accounting/monthlyclose'
    });
});

test('shows authored main-scenario attachments before assembly and retains compiled resources after assembly', () => {
    const main = scenario({
        name: 'Compiled production',
        tabName: 'Production',
        relativePath: 'Production/004_Production'
    });
    const scenarioKey = main.yamlFileUri.toString();

    const withoutBuild = snapshotWithScenarios([], [main]).items[0];
    const withBuild = snapshotWithScenarios([], [main], new Map([
        [scenarioKey, {
            featureUri: 'file:///workspace/build/004_Production.feature',
            filesRootUri: 'file:///workspace/build/004_Production/%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B'
        }]
    ])).items[0];

    assert.equal(withoutBuild?.hasScenarioFiles, true);
    assert.equal(withoutBuild?.compiledFeatureUri, undefined);
    const sourceFiles = new URL('./files', main.yamlFileUri.toString()).toString();
    assert.equal(withoutBuild?.scenarioFilesRootUri, sourceFiles);
    assert.equal(withBuild?.sourceScenarioFilesRootUri, sourceFiles);
    assert.equal(withBuild?.hasScenarioFiles, true);
    assert.equal(withBuild?.compiledFeatureUri, 'file:///workspace/build/004_Production.feature');
    assert.equal(
        withBuild?.scenarioFilesRootUri,
        'file:///workspace/build/004_Production/%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B'
    );
});

test('binds nested definitions to the nearest scenario runtime key in the same file', () => {
    const uri = scenario({ name: 'placeholder' }).yamlFileUri;
    const nested = definition({
        id: 'nested:related',
        kind: 'nestedScenario',
        template: 'Prepare environment',
        sourceLabel: 'Nested scenario',
        definitionLocation: {
            uri: uri.toString(),
            range: {
                start: { line: 18, character: 0 },
                end: { line: 18, character: 20 }
            }
        }
    });
    const snapshot = snapshotWithScenarios([nested], [
        scenario({ name: 'Earlier scenario', yamlFileUri: uri, scenarioCodeLine: 3 }),
        scenario({ name: 'Prepare environment', yamlFileUri: uri, scenarioCodeLine: 17 })
    ]);

    assert.equal(snapshot.items[0]?.scenarioKey, uri.toString());
});

test('preserves the project definition identity used by export relationships', () => {
    const exported = definition({
        id: 'export:shared-login',
        kind: 'exportScenario',
        template: 'And use shared login',
        sourceLabel: 'Project exports',
        definitionLocation: {
            uri: 'file:///workspace/library.feature',
            range: {
                start: { line: 4, character: 0 },
                end: { line: 4, character: 20 }
            }
        }
    });

    const snapshot = buildStepLibrarySnapshot(view([exported]));

    assert.equal(snapshot.items[0]?.definitionId, 'export:shared-login');
});

test('pairs built-in translations and keeps localized multiline display data', () => {
    const definitions = allSources().map(item => item.id === 'built:open:en'
        ? { ...item, template: `${item.template}\n    | Column |` }
        : item);
    const snapshot = buildStepLibrarySnapshot(view(definitions));
    const english = snapshot.items.find(item => item.definitionId === 'built:open:en');
    const russian = snapshot.items.find(item => item.definitionId === 'built:open:ru');

    assert.equal(english?.id, 'built:open:en#en');
    assert.equal(english?.familyId, 'built:open');
    assert.equal(english?.displayText, 'And I open "" form\n    | Column |');
    assert.equal(english?.alternateDisplayText, 'И открываю форму ""');
    assert.equal(russian?.alternateDisplayText, 'And I open "" form\n    | Column |');
    assert.deepEqual(english?.categoryPath, ['UI', 'Forms']);
    assert.equal(english?.navigable, false);
    assert.equal(english?.capturedLocation, undefined);
});

test('aligns Gherkin tables in every visual representation without changing the insertion template', () => {
    const template = [
        'And I inspect the table:',
        '| Name |Long value|',
        '| Longer name|x|'
    ].join('\n');
    const builtIn = definition({
        id: 'built:table:en',
        familyId: 'built:table',
        kind: 'builtInStep',
        template,
        language: 'en'
    });

    const item = buildStepLibrarySnapshot(view([builtIn])).items[0] as
        StepLibrarySnapshot['items'][number] & { templateDisplayText?: string };

    const aligned = [
        'And I inspect the table:',
        '    | Name        | Long value |',
        '    | Longer name | x          |'
    ].join('\n');
    assert.equal(item.displayText, aligned);
    assert.equal(item.templateDisplayText, aligned);
    assert.equal(item.template, template);
});

test('splits authored categories, exposes compact parameters, and uses export examples', () => {
    const snapshot = buildStepLibrarySnapshot(view(allSources()));
    const user = snapshot.items.find(item => item.kind === 'userStep');
    const exported = snapshot.items.find(item => item.kind === 'exportScenario');
    const nested = snapshot.items.find(item => item.kind === 'nestedScenario');

    assert.deepEqual(user?.categoryPath, []);
    assert.deepEqual(exported?.categoryPath, ['UI', 'Windows']);
    assert.equal(exported?.displayText, 'Then "Add indicator" window is ready');
    assert.deepEqual(nested?.categoryPath, ['Продажи', 'Заказы']);
    assert.deepEqual(nested?.parameters, [{
        name: 'Customer',
        defaultValue: '"Main customer"'
    }]);
    assert.equal(nested?.navigable, true);
    assert.deepEqual(nested?.capturedLocation, allSources()[4].definitionLocation);
});

test('precomputes normalized search text and orders rows deterministically', () => {
    const definitions = allSources();
    const forward = buildStepLibrarySnapshot(view(definitions));
    const reversed = buildStepLibrarySnapshot(view([...definitions].reverse()));
    const user = forward.items.find(item => item.kind === 'userStep');

    assert.match(user?.searchText ?? '', /café login helper/u);
    assert.match(user?.searchText ?? '', /administrator/u);
    assert.match(user?.searchText ?? '', /user steps \(library\)/u);
    assert.deepEqual(
        forward.items.map(item => item.id),
        reversed.items.map(item => item.id)
    );
});

test('process details expose immutable ordered steps and change snapshot identity on reorder', () => {
    const process = scenario({ name: 'Process', kind: 'process', uid: 'process-uid', processCode: 'P.1',
        processSteps: [
            { uid: 'first', type: 'scenario', scenarioUid: 'scenario', scenarioName: 'Invoice' },
            { uid: 'second', type: 'process', processUid: 'child', processName: 'Nested process' }
        ] });
    const initial = snapshotWithScenarios([], [process]);
    const selected = initial.items[0] as any;
    assert.equal(selected.processUri, 'file:///workspace/main/scen.yaml');
    assert.equal(selected.processUid, 'process-uid');
    assert.equal(selected.scenarioCode, 'P.1');
    assert.deepEqual(selected.processSteps.map((step: any) => step.uid), ['first', 'second']);
    assert.equal(Object.isFrozen(selected.processSteps[0]), true);
    const reordered = snapshotWithScenarios([], [{ ...process, processSteps: [...process.processSteps!].reverse() }]);
    assert.notEqual(initial.viewIdentity, reordered.viewIdentity);
    assert.notEqual(selected.processStepsSignature, (reordered.items[0] as any).processStepsSignature);
    assert.match(selected.searchText, /nested process/u);
});
