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
    scenarios: readonly TestInfo[]
): StepLibrarySnapshot {
    const build = buildStepLibrarySnapshot as unknown as (
        currentView: ProjectDefinitionView,
        currentScenarios: readonly TestInfo[]
    ) => StepLibrarySnapshot;
    return build(view(definitions), scenarios);
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
    assert.deepEqual(snapshot.counts, { builtIn: 2, user: 1, export: 1, nested: 1, main: 0 });
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
        main: 1
    });
    assert.equal(snapshot.items.length, 1);
    assert.deepEqual(snapshot.items[0], {
        id: 'mainScenario#file:///workspace/main/scen.yaml',
        definitionId: 'mainScenario:file:///workspace/main/scen.yaml',
        familyId: 'mainScenario:file:///workspace/main/scen.yaml',
        kind: 'mainScenario',
        sourceGroup: 'main',
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
        searchText: 'monthly close builds the monthly close feature. 000020026 accounting main scenario (accounting/monthlyclose) accounting/monthlyclose'
    });
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
