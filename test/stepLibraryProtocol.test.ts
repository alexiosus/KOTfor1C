import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

interface ProtocolItem {
    id: string;
    kind: 'builtInStep' | 'userStep' | 'exportScenario' | 'nestedScenario';
    sourceGroup: 'builtIn' | 'user' | 'export' | 'nested';
    displayText: string;
    template: string;
    searchText: string;
    categoryPath: string[];
    language?: 'ru' | 'en';
}

interface Protocol {
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
        id: 'builtIn::uncategorized',
        sourceGroup: 'builtIn',
        label: 'Without category',
        path: [],
        count: 1,
        children: []
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
