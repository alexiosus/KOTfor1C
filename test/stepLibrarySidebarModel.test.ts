import assert from 'node:assert/strict';
import test from 'node:test';
import {
    StepLibrarySidebarIndex,
    type StepLibrarySidebarNode
} from '../src/stepLibrarySidebarModel';
import type {
    StepLibraryItem,
    StepLibrarySnapshot,
    StepLibrarySourceGroup
} from '../src/stepLibraryModel';

function item(overrides: Partial<StepLibraryItem> & Pick<StepLibraryItem, 'id' | 'sourceGroup' | 'displayText'>): StepLibraryItem {
    const definitionId = overrides.definitionId ?? overrides.id;
    return Object.freeze({
        id: overrides.id,
        definitionId,
        familyId: overrides.familyId ?? definitionId,
        kind: overrides.kind ?? (overrides.sourceGroup === 'main' ? 'mainScenario' : 'builtInStep'),
        sourceGroup: overrides.sourceGroup,
        template: overrides.template ?? overrides.displayText,
        displayText: overrides.displayText,
        categoryPath: Object.freeze([...(overrides.categoryPath ?? [])]),
        parameters: Object.freeze([...(overrides.parameters ?? [])]),
        sourceLabel: overrides.sourceLabel ?? 'Test source',
        navigable: overrides.navigable ?? false,
        insertable: overrides.insertable ?? true,
        searchText: overrides.searchText ?? [
            overrides.displayText,
            overrides.alternateDisplayText,
            overrides.template,
            overrides.description,
            overrides.scenarioCode,
            ...(overrides.categoryPath ?? []),
            ...(overrides.parameters ?? []).flatMap(parameter => [parameter.name, parameter.defaultValue])
        ].filter(Boolean).join(' ').normalize('NFC').toLowerCase(),
        ...overrides
    });
}

function snapshot(items: readonly StepLibraryItem[]): StepLibrarySnapshot {
    const groups: StepLibrarySourceGroup[] = ['builtIn', 'user', 'export', 'nested', 'main'];
    return Object.freeze({
        viewIdentity: 'sidebar:test',
        items: Object.freeze([...items]),
        counts: Object.freeze(Object.fromEntries(groups.map(group => [
            group,
            items.filter(candidate => candidate.sourceGroup === group).length
        ])) as Record<StepLibrarySourceGroup, number>)
    });
}

function childByLabel(index: StepLibrarySidebarIndex, parentId: string, label: string): StepLibrarySidebarNode {
    const node = index.children(parentId).nodes.find(candidate => candidate.label === label);
    assert.ok(node, `Expected child ${label} below ${parentId}`);
    return node;
}

test('main groups expose a trusted member identity for rename without making source roots renameable', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({ id: 'main-smoke', sourceGroup: 'main', displayText: 'Smoke test', categoryPath: ['Smoke'] }),
        item({ id: 'export', sourceGroup: 'export', displayText: 'Export', categoryPath: ['Smoke'] })
    ]), 'en');
    const group = childByLabel(index, 'source:main', 'Smoke');
    assert.equal((group as any).renameGroupItemId, 'main-smoke');
    assert.equal((childByLabel(index, 'source:export', 'Smoke') as any).renameGroupItemId, undefined);
    assert.equal((index.roots().find(node => node.sourceGroup === 'main') as any).renameGroupItemId, undefined);
});

test('projects favorites plus six stable source roots and only immediate category branches', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({ id: 'forms', sourceGroup: 'builtIn', displayText: 'Open form', categoryPath: ['UI', 'Forms'] }),
        item({ id: 'tables', sourceGroup: 'builtIn', displayText: 'Check table', categoryPath: ['UI', 'Tables'] }),
        item({ id: 'direct-ui', sourceGroup: 'builtIn', displayText: 'Use interface', categoryPath: ['UI'] }),
        item({ id: 'loose', sourceGroup: 'builtIn', displayText: 'Loose step' }),
        item({ id: 'user', sourceGroup: 'user', displayText: 'User step' }),
        item({ id: 'export', sourceGroup: 'export', displayText: 'Export scenario' }),
        item({ id: 'nested', sourceGroup: 'nested', displayText: 'Nested scenario' }),
        item({ id: 'main', sourceGroup: 'main', displayText: 'Main scenario' })
    ]), 'en');

    assert.deepEqual(index.roots().map(root => [root.id, root.label, root.count, root.kind]), [
        ['favorites', 'Favorites', 0, 'source'],
        ['source:builtIn', 'Vanessa built-in steps', 4, 'source'],
        ['source:user', 'User steps', 1, 'source'],
        ['source:export', 'Exported scenarios', 1, 'source'],
        ['source:nested', 'Nested scenarios', 1, 'source'],
        ['source:main', 'Main scenarios', 1, 'source'],
        ['source:process', 'Processes', 0, 'source']
    ]);

    const builtInChildren = index.children('source:builtIn').nodes;
    assert.deepEqual(builtInChildren.map(node => [node.kind, node.label]), [
        ['category', 'UI'],
        ['category', 'Uncategorized']
    ]);
    const ui = builtInChildren[0];
    assert.deepEqual(index.children(ui.id).nodes.map(node => [node.kind, node.label]), [
        ['category', 'Forms'],
        ['category', 'Tables'],
        ['definition', 'Use interface']
    ]);
    assert.deepEqual(index.children(builtInChildren[1].id).nodes.map(node => node.label), ['Loose step']);
    assert.equal(childByLabel(index, ui.id, 'Forms').depth, 2);
});

test('counts only visible relationship items in every ancestor group', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({ id: 'related-favorite', sourceGroup: 'nested', displayText: 'Related favorite', categoryPath: ['Orders', 'Create'] }),
        item({ id: 'related-other', sourceGroup: 'nested', displayText: 'Related other', categoryPath: ['Orders', 'Validate'] }),
        item({ id: 'unrelated', sourceGroup: 'nested', displayText: 'Unrelated', categoryPath: ['Orders', 'Create'] }),
        item({ id: 'export', sourceGroup: 'export', displayText: 'Export scenario' })
    ]), 'en', new Set(['related-favorite']));
    const counts = (index as any).countsForItems(new Set([
        'related-favorite',
        'related-other'
    ]));
    const orders = childByLabel(index, 'source:nested', 'Orders');
    const create = childByLabel(index, orders.id, 'Create');
    const validate = childByLabel(index, orders.id, 'Validate');

    assert.deepEqual({ ...counts }, {
        favorites: 1,
        'source:nested': 2,
        [orders.id]: 2,
        [create.id]: 1,
        [validate.id]: 1
    });
});

test('pages only direct definitions in stable order and appends a continuation node', () => {
    const definitions = Array.from({ length: 205 }, (_, index) => item({
        id: `item-${String(index).padStart(3, '0')}`,
        sourceGroup: 'user',
        displayText: `Step ${String(index).padStart(3, '0')}`,
        categoryPath: ['Bulk']
    }));
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot(definitions.reverse()), 'en');
    const category = childByLabel(model, 'source:user', 'Bulk');

    const first = model.children(category.id);
    assert.equal(first.nodes.filter(node => node.kind === 'definition').length, 100);
    assert.equal(first.nodes.at(-1)?.kind, 'more');
    assert.equal(first.nextOffset, 100);
    assert.deepEqual(first.nodes.slice(0, 2).map(node => node.label), ['Step 000', 'Step 001']);

    const second = model.children(category.id, first.nextOffset ?? 0);
    assert.equal(second.nodes.filter(node => node.kind === 'definition').length, 100);
    assert.equal(second.nextOffset, 200);
    assert.equal(second.nodes[0].label, 'Step 100');

    const last = model.children(category.id, second.nextOffset ?? 0);
    assert.equal(last.nodes.length, 5);
    assert.equal(last.nextOffset, null);
    assert.equal(last.nodes.at(-1)?.label, 'Step 204');
});

test('filters direct definitions before paging and computing the continuation node', () => {
    const definitions = Array.from({ length: 205 }, (_, index) => item({
        id: `item-${String(index).padStart(3, '0')}`,
        sourceGroup: 'user',
        displayText: `Step ${String(index).padStart(3, '0')}`,
        categoryPath: ['Bulk']
    }));
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot(definitions), 'en');
    const category = childByLabel(model, 'source:user', 'Bulk');
    const modelWithFilteredChildren = model as unknown as {
        children(
            parentId: string,
            offset: number,
            limit: number,
            visibleItemIds: ReadonlySet<string>
        ): ReturnType<StepLibrarySidebarIndex['children']>;
    };

    const page = modelWithFilteredChildren.children(
        category.id,
        0,
        100,
        new Set(['item-150', 'item-204'])
    );

    assert.deepEqual(page.nodes.map(node => [node.kind, node.itemId]), [
        ['definition', 'item-150'],
        ['definition', 'item-204']
    ]);
    assert.equal(page.nextOffset, null);
});

test('projects mixed favorite definitions in one bounded root', () => {
    const definitions = Array.from({ length: 105 }, (_, index) => item({
        id: `favorite-${String(index).padStart(3, '0')}`,
        sourceGroup: index % 2 === 0 ? 'nested' : 'export',
        displayText: `Favorite ${String(index).padStart(3, '0')}`
    }));
    const favoriteIds = new Set(definitions.map(definition => definition.id));
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot(definitions), 'en', favoriteIds);

    assert.equal(model.roots()[0].count, 105);
    const first = model.children('favorites');
    assert.equal(first.nodes.filter(node => node.kind === 'definition').length, 100);
    assert.equal(first.nodes.at(-1)?.kind, 'more');
    assert.equal(first.nextOffset, 100);
    assert.ok(first.nodes.filter(node => node.kind === 'definition').every(node => node.favorite));
});

test('returns an empty bounded projection for empty or unknown branches', () => {
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot([]), 'ru');

    assert.deepEqual(model.roots().map(node => node.count), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(model.children('source:builtIn'), {
        parentId: 'source:builtIn',
        nodes: [],
        nextOffset: null
    });
    assert.deepEqual(model.children('unknown'), {
        parentId: 'unknown',
        nodes: [],
        nextOffset: null
    });
    assert.deepEqual(model.search('anything'), []);
});

test('ranks display matches before searchable metadata and searches code, category, and parameters', () => {
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({ id: 'exact', sourceGroup: 'nested', displayText: 'Close period', scenarioCode: '000001' }),
        item({ id: 'prefix', sourceGroup: 'nested', displayText: 'Close period safely' }),
        item({ id: 'token', sourceGroup: 'nested', displayText: 'Monthly close period' }),
        item({ id: 'template', sourceGroup: 'nested', displayText: 'Accounting helper', template: 'Close period from template' }),
        item({ id: 'metadata', sourceGroup: 'nested', displayText: 'Accounting helper two', description: 'Close period from description' }),
        item({
            id: 'search-fields',
            sourceGroup: 'nested',
            displayText: 'Special helper',
            scenarioCode: '009912',
            categoryPath: ['Tests Environment'],
            parameters: [{ name: 'InfobaseName', defaultValue: 'Demo' }]
        }),
        ...Array.from({ length: 130 }, (_, index) => item({
            id: `bulk-${index}`,
            sourceGroup: 'nested',
            displayText: `Bulk match ${index}`
        }))
    ]), 'en');

    assert.deepEqual(model.search('close period').slice(0, 5).map(node => node.itemId), [
        'exact', 'prefix', 'token', 'template', 'metadata'
    ]);
    assert.equal(model.search('bulk', 500).length, 100);
    assert.equal(model.search('009912')[0]?.itemId, 'search-fields');
    assert.equal(model.search('tests environment')[0]?.itemId, 'search-fields');
    assert.equal(model.search('infobasename demo')[0]?.itemId, 'search-fields');
});

test('keeps aligned multiline Gherkin text intact in definition nodes', () => {
    const displayText = [
        'And I compare table:',
        '    | Name        | Value |',
        '    | Longer name | 42    |'
    ].join('\n');
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({ id: 'table', sourceGroup: 'builtIn', displayText, categoryPath: ['UI', 'Tables'] })
    ]), 'en');
    const ui = childByLabel(model, 'source:builtIn', 'UI');
    const tables = childByLabel(model, ui.id, 'Tables');

    assert.equal(model.children(tables.id).nodes[0]?.label, displayText);
});

test('definition nodes carry safe action and drag capabilities from their server-owned item', () => {
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({
            id: 'nested',
            sourceGroup: 'nested',
            displayText: 'I prepare data',
            template: 'I prepare data',
            categoryPath: ['Tests'],
            parameters: [
                { name: 'Infobase', defaultValue: '"Demo"' },
                { name: 'User' }
            ],
            insertable: true,
            navigable: true
        }),
        item({
            id: 'main',
            sourceGroup: 'main',
            displayText: 'Main scenario',
            categoryPath: ['Tests'],
            insertable: false,
            navigable: true
        })
    ]), 'en');
    const nestedCategory = childByLabel(model, 'source:nested', 'Tests');
    const nested = model.children(nestedCategory.id).nodes[0];
    const mainCategory = childByLabel(model, 'source:main', 'Tests');
    const main = model.children(mainCategory.id).nodes[0];

    assert.deepEqual(
        { insertable: nested.insertable, navigable: nested.navigable, dragText: nested.dragText },
        {
            insertable: true,
            navigable: true,
            dragText: [
                'And I prepare data',
                '    Infobase = "Demo"',
                '    User     = "User"'
            ].join('\n')
        }
    );
    assert.deepEqual(
        { insertable: main.insertable, navigable: main.navigable, dragText: main.dragText },
        { insertable: false, navigable: true, dragText: undefined }
    );
});

test('definition nodes expose the catalog runtime key used by relationship projections', () => {
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot([
        item({
            id: 'nested-related',
            sourceGroup: 'nested',
            displayText: 'Prepare environment',
            scenarioKey: 'file:///workspace/scenarios/environment/scen.yaml'
        })
    ]), 'en');
    const uncategorized = childByLabel(model, 'source:nested', 'Uncategorized');

    assert.equal(
        model.children(uncategorized.id).nodes[0]?.scenarioKey,
        'file:///workspace/scenarios/environment/scen.yaml'
    );
});

test('definition nodes expose project definition ids used by export relationships', () => {
    const currentSnapshot = snapshot([item({
        id: 'export:shared#authored',
        definitionId: 'export:shared',
        kind: 'exportScenario',
        sourceGroup: 'export',
        displayText: 'Shared export'
    })]);
    const index = StepLibrarySidebarIndex.fromSnapshot(currentSnapshot, 'en');

    const source = index.roots().find(node => node.id === 'source:export')!;
    const category = index.children(source.id).nodes[0];
    const definitionNode = index.children(category.id).nodes[0];

    assert.equal(definitionNode.definitionId, 'export:shared');
});

test('nested definitions with local files advertise an expandable resource child', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot([item({
        id: 'nested-local',
        kind: 'nestedScenario',
        sourceGroup: 'nested',
        displayText: 'Create invoice',
        hasScenarioFiles: true,
        capturedLocation: {
            uri: 'file:///workspace/CreateInvoice/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }
    })]), 'en');

    const nested = index.search('Create invoice')[0];

    assert.equal(nested.expandable, true);
    assert.equal(nested.hasScenarioFiles, true);
});

test('compiled main definitions expose their feature and attachments metadata to the sidebar', () => {
    const index = StepLibrarySidebarIndex.fromSnapshot(snapshot([item({
        id: 'main-compiled',
        kind: 'mainScenario',
        sourceGroup: 'main',
        displayText: '004_Production',
        hasScenarioFiles: true,
        compiledFeatureUri: 'file:///build/004_Production.feature',
        scenarioFilesRootUri: 'file:///build/004_Production/%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B'
    })]), 'en');

    const main = index.search('004_Production')[0];

    assert.equal(main.expandable, true);
    assert.equal(main.compiledFeatureUri, 'file:///build/004_Production.feature');
    assert.equal(
        main.scenarioFilesRootUri,
        'file:///build/004_Production/%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B'
    );
});

test('deduplicates a translated built-in family using the preferred language branch', () => {
    const russian = item({
        id: 'open-ru',
        definitionId: 'open-ru',
        familyId: 'open',
        sourceGroup: 'builtIn',
        displayText: 'И я открываю форму',
        alternateDisplayText: 'And I open the form',
        language: 'ru',
        categoryPath: ['Интерфейс', 'Формы'],
        searchText: 'и я открываю форму and i open the form интерфейс формы ui forms'
    });
    const english = item({
        id: 'open-en',
        definitionId: 'open-en',
        familyId: 'open',
        sourceGroup: 'builtIn',
        displayText: 'And I open the form',
        alternateDisplayText: 'И я открываю форму',
        description: 'Opens the requested application form.',
        language: 'en',
        categoryPath: ['UI', 'Forms'],
        searchText: 'and i open the form и я открываю форму ui forms интерфейс формы'
    });
    const model = StepLibrarySidebarIndex.fromSnapshot(snapshot([russian, english]), 'en');
    const ui = childByLabel(model, 'source:builtIn', 'UI');
    const forms = childByLabel(model, ui.id, 'Forms');
    const definition = model.children(forms.id).nodes[0];

    assert.equal(model.roots().find(node => node.id === 'source:builtIn')?.count, 1);
    assert.equal(definition.label, 'And I open the form');
    assert.equal(definition.alternateLabel, 'И я открываю форму');
    assert.equal(definition.description, 'Opens the requested application form.');
    assert.equal(model.getItem(definition.itemId ?? '')?.language, 'en');
    assert.equal(model.search('открываю')[0]?.itemId, 'open-en');
    assert.equal(indexCategoryLabels(model).includes('Интерфейс'), false);
});

function indexCategoryLabels(index: StepLibrarySidebarIndex): string[] {
    const labels: string[] = [];
    const pending = index.roots().map(node => node.id);
    while (pending.length > 0) {
        const parentId = pending.shift()!;
        for (const node of index.children(parentId).nodes) {
            if (node.kind === 'category') {
                labels.push(node.label);
                pending.push(node.id);
            }
        }
    }
    return labels;
}
