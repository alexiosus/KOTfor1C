import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

interface ProtocolItem {
    id: string;
    kind: 'builtInStep' | 'userStep' | 'exportScenario' | 'nestedScenario' | 'mainScenario';
    sourceGroup: 'builtIn' | 'user' | 'export' | 'nested' | 'main';
    displayText: string;
    template: string;
    searchText: string;
    categoryPath: string[];
    language?: 'ru' | 'en';
    insertable?: boolean;
}

interface Protocol {
    prepareItems(items: readonly ProtocolItem[]): readonly ProtocolItem[];
    searchItems(items: readonly ProtocolItem[], query: string, options?: {
        sourceGroup?: ProtocolItem['sourceGroup'];
        categoryPath?: readonly string[];
        language?: 'ru' | 'en' | 'both';
        uncategorized?: boolean;
        offset?: number;
        limit?: number;
    }): ProtocolItem[];
    buildCategoryTree(items: readonly ProtocolItem[], labels?: {
        sources?: Partial<Record<ProtocolItem['sourceGroup'], string>>;
        uncategorized?: string;
    }): Array<{
        id: string;
        sourceGroup: ProtocolItem['sourceGroup'];
        label: string;
        path: string[];
        count: number;
        children: unknown[];
    }>;
    reconcileCategorySelection(items: readonly ProtocolItem[], selection: {
        sourceGroup?: ProtocolItem['sourceGroup'] | null;
        categoryPath?: readonly string[];
        uncategorized?: boolean;
    }): {
        sourceGroup: ProtocolItem['sourceGroup'] | null;
        categoryPath: string[];
        uncategorized: boolean;
    };
    canInsertItem(item: ProtocolItem | undefined, insertionTargetAvailable: boolean): boolean;
    tokenizeGherkinText(value: string): Array<{
        kind: 'plain' | 'keyword' | 'string' | 'parameter' | 'table';
        text: string;
    }>;
    preserveScrollPosition<T>(element: {
        scrollTop: number;
        scrollLeft: number;
    }, action: () => T): T;
}

function loadProtocol(): { protocol: Protocol; source: string } {
    const filePath = path.join(process.cwd(), 'media', 'stepLibraryProtocol.js');
    const source = fs.readFileSync(filePath, 'utf8');
    delete require.cache[require.resolve(filePath)];
    return { protocol: require(filePath) as Protocol, source };
}

function item(
    id: string,
    displayText: string,
    overrides: Partial<ProtocolItem> = {}
): ProtocolItem {
    return {
        id,
        kind: 'builtInStep',
        sourceGroup: 'builtIn',
        displayText,
        template: displayText,
        searchText: displayText.toLocaleLowerCase().normalize('NFC'),
        categoryPath: [],
        language: 'en',
        ...overrides
    };
}

test('ranks exact, prefix, token-prefix, template substring, and metadata matches', () => {
    const { protocol } = loadProtocol();
    const items = [
        item('metadata-substring', 'Different step', {
            searchText: 'different step documentation open form'
        }),
        item('template-substring', 'Reopen formal document'),
        item('token-prefix', 'Please open the main form'),
        item('template-prefix', 'Open form by name'),
        item('exact-template', 'Open form')
    ];

    const ranked = protocol.searchItems(items, 'open form');

    assert.deepEqual(ranked.map(value => value.id), [
        'exact-template',
        'template-prefix',
        'token-prefix',
        'template-substring',
        'metadata-substring'
    ]);
});

test('prepares normalized search fields once instead of rereading source text per query', () => {
    const { protocol } = loadProtocol();
    let displayReads = 0;
    let templateReads = 0;
    let searchReads = 0;
    const source = item('prepared', 'Open Form');
    Object.defineProperties(source, {
        displayText: {
            enumerable: true,
            get: () => {
                displayReads += 1;
                return 'Open Form';
            }
        },
        template: {
            enumerable: true,
            get: () => {
                templateReads += 1;
                return 'Open Form';
            }
        },
        searchText: {
            enumerable: true,
            get: () => {
                searchReads += 1;
                return 'open form documentation';
            }
        }
    });

    const prepared = protocol.prepareItems([source]);
    const readsAfterPreparation = [displayReads, templateReads, searchReads];
    let preparedDisplayReads = 0;
    Object.defineProperty(prepared[0], 'displayText', {
        enumerable: true,
        get: () => {
            preparedDisplayReads += 1;
            return 'Open Form';
        }
    });
    protocol.searchItems(prepared, 'open');
    protocol.searchItems(prepared, 'documentation');

    assert.deepEqual(
        [displayReads, templateReads, searchReads],
        readsAfterPreparation
    );
    assert.equal(preparedDisplayReads, 0);
});

test('tokenizes Gherkin presentation text without changing its content', () => {
    const { protocol } = loadProtocol();
    const source = [
        'And I open "Sales" form',
        '    | Name | <Value> |'
    ].join('\n');

    const tokens = protocol.tokenizeGherkinText(source);

    assert.equal(tokens.map(token => token.text).join(''), source);
    assert.deepEqual(tokens.filter(token => token.kind !== 'plain'), [
        { kind: 'keyword', text: 'And' },
        { kind: 'string', text: '"Sales"' },
        { kind: 'table', text: '|' },
        { kind: 'table', text: '|' },
        { kind: 'parameter', text: '<Value>' },
        { kind: 'table', text: '|' }
    ]);
});

test('restores both scroll axes after a tree render mutates them', () => {
    const { protocol } = loadProtocol();
    const element = { scrollTop: 127, scrollLeft: 9 };

    const result = protocol.preserveScrollPosition(element, () => {
        element.scrollTop = 0;
        element.scrollLeft = 0;
        return 'rendered';
    });

    assert.equal(result, 'rendered');
    assert.deepEqual(element, { scrollTop: 127, scrollLeft: 9 });
});

test('filters by source, ancestor category, and built-in language without hiding project definitions', () => {
    const { protocol } = loadProtocol();
    const items = [
        item('built-ru', 'Открыть форму', {
            language: 'ru', categoryPath: ['UI', 'Forms']
        }),
        item('built-en', 'Open form', {
            language: 'en', categoryPath: ['UI', 'Forms', 'Managed']
        }),
        item('built-other', 'Open report', {
            language: 'en', categoryPath: []
        }),
        item('user', 'User form helper', {
            kind: 'userStep', sourceGroup: 'user', language: undefined,
            categoryPath: ['UI', 'Forms']
        })
    ];

    assert.deepEqual(
        protocol.searchItems(items, '', { sourceGroup: 'builtIn', categoryPath: ['UI'] })
            .map(value => value.id),
        ['built-en', 'built-ru']
    );
    assert.deepEqual(
        protocol.searchItems(items, '', { language: 'en' }).map(value => value.id),
        ['built-en', 'built-other', 'user']
    );
    assert.deepEqual(
        protocol.searchItems(items, '', { language: 'ru' }).map(value => value.id),
        ['user', 'built-ru']
    );
    assert.deepEqual(
        protocol.searchItems(items, '', {
            sourceGroup: 'builtIn',
            uncategorized: true
        }).map(value => value.id),
        ['built-other']
    );
});

test('builds source/category nodes with ancestor and uncategorized counts', () => {
    const { protocol } = loadProtocol();
    const tree = protocol.buildCategoryTree([
        item('forms', 'Open form', { categoryPath: ['UI', 'Forms'] }),
        item('tables', 'Open table', { categoryPath: ['UI', 'Tables'] }),
        item('uncategorized', 'Other step'),
        item('nested', 'Nested call', {
            kind: 'nestedScenario', sourceGroup: 'nested', categoryPath: ['Sales']
        })
    ], {
        sources: { builtIn: 'Vanessa', nested: 'Nested scenarios' },
        uncategorized: 'Without category'
    });
    const builtIn = tree.find(node => node.sourceGroup === 'builtIn');
    const ui = builtIn?.children.find((node: { label?: string }) => node.label === 'UI') as {
        count: number;
        children: Array<{ label: string; count: number }>;
    } | undefined;
    const uncategorized = builtIn?.children.find(
        (node: { label?: string }) => node.label === 'Without category'
    ) as { count: number; path: string[] } | undefined;

    assert.equal(builtIn?.label, 'Vanessa');
    assert.equal(builtIn?.count, 3);
    assert.equal(ui?.count, 2);
    assert.deepEqual(ui?.children.map(node => [node.label, node.count]), [
        ['Forms', 1],
        ['Tables', 1]
    ]);
    assert.deepEqual(uncategorized, {
        id: 'builtIn::#uncategorized',
        sourceGroup: 'builtIn',
        label: 'Without category',
        path: [],
        count: 1,
        children: []
    });
});

test('keeps authored uncategorized category distinct from the synthetic bucket', () => {
    const { protocol } = loadProtocol();
    const tree = protocol.buildCategoryTree([
        item('authored', 'Named category', { categoryPath: ['uncategorized'] }),
        item('synthetic', 'No category')
    ]);
    const childIds = tree[0].children as Array<{ id: string }>;

    assert.deepEqual(childIds.map(child => child.id).sort(), [
        'builtIn::#uncategorized',
        'builtIn::uncategorized'
    ]);
});

test('reconciles a removed source or category to the closest surviving selection', () => {
    const { protocol } = loadProtocol();
    const items = [
        item('forms', 'Open form', { categoryPath: ['UI', 'Forms'] }),
        item('tables', 'Open table', { categoryPath: ['UI', 'Tables'] }),
        item('nested', 'Create order', {
            kind: 'nestedScenario', sourceGroup: 'nested', categoryPath: ['Sales']
        })
    ];

    assert.deepEqual(protocol.reconcileCategorySelection(items, {
        sourceGroup: 'builtIn',
        categoryPath: ['UI', 'Removed'],
        uncategorized: false
    }), {
        sourceGroup: 'builtIn',
        categoryPath: ['UI'],
        uncategorized: false
    });
    assert.deepEqual(protocol.reconcileCategorySelection(items, {
        sourceGroup: 'user',
        categoryPath: ['Missing'],
        uncategorized: false
    }), {
        sourceGroup: null,
        categoryPath: [],
        uncategorized: false
    });
});

test('reconciles localized category selection against only the active language', () => {
    const { protocol } = loadProtocol();
    const items = protocol.prepareItems([
        item('english', 'Open form', {
            language: 'en', categoryPath: ['UI', 'Forms']
        }),
        item('russian', 'Открыть форму', {
            language: 'ru', categoryPath: ['Интерфейс', 'Формы']
        })
    ]);
    const russianItems = protocol.searchItems(items, '', {
        language: 'ru', limit: Number.MAX_SAFE_INTEGER
    });

    assert.deepEqual(protocol.reconcileCategorySelection(russianItems, {
        sourceGroup: 'builtIn',
        categoryPath: ['UI'],
        uncategorized: false
    }), {
        sourceGroup: 'builtIn',
        categoryPath: [],
        uncategorized: false
    });
});

test('uses stable alphabetical ties and returns a bounded result window', () => {
    const { protocol } = loadProtocol();
    const items = [
        item('z', 'Zulu helper'),
        item('b', 'Beta helper'),
        item('a', 'Alpha helper')
    ];

    assert.deepEqual(
        protocol.searchItems(items, '', { offset: 1, limit: 1 }).map(value => value.id),
        ['b']
    );
});

test('allows insertion only for callable library items with an active editor target', () => {
    const { protocol } = loadProtocol();
    const callable = item('callable', 'Open form', { insertable: true });
    const mainScenario = item('main', 'Monthly close', {
        kind: 'mainScenario',
        sourceGroup: 'main',
        insertable: false
    });

    assert.equal(protocol.canInsertItem(callable, true), true);
    assert.equal(protocol.canInsertItem(callable, false), false);
    assert.equal(protocol.canInsertItem(mainScenario, true), false);
    assert.equal(protocol.canInsertItem(undefined, true), false);
});

test('exports under Node, attaches to globalThis, and contains no edit-distance implementation', () => {
    const { protocol, source } = loadProtocol();
    assert.equal(typeof protocol.searchItems, 'function');
    assert.doesNotMatch(source, /levenshtein|editDistance|new\s+Array\([^)]*\)\s*\.fill/iu);

    const context = vm.createContext({ globalThis: {} });
    vm.runInContext(source, context);
    assert.equal(
        typeof (context.globalThis as { StepLibraryProtocol?: Protocol }).StepLibraryProtocol?.searchItems,
        'function'
    );
});
