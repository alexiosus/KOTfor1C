import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const protocolPath = path.join(process.cwd(), 'media', 'stepLibrarySidebarProtocol.js');
const protocol = require(protocolPath) as {
    createState(value?: unknown): {
        expandedIds: readonly string[];
        selectedId: string | null;
        relationshipState: unknown;
    };
    toggleExpanded(state: unknown, nodeId: string): ReturnType<typeof protocol.createState>;
    selectNode(state: unknown, nodeId: string | null): ReturnType<typeof protocol.createState>;
    moveSelection(state: unknown, visibleIds: readonly string[], delta: number): ReturnType<typeof protocol.createState>;
    withRelationshipState(state: unknown, relationshipState: unknown): ReturnType<typeof protocol.createState>;
    relationshipDecorationForNode(node: unknown, state: unknown): {
        state: 'current' | 'incoming' | 'outgoing' | 'related' | 'none';
        icon: 'eye' | 'arrow-right-to-line' | 'arrow-right-from-line' | null;
        classNames: readonly string[];
        direct: boolean;
        accessibleLabel: string;
    };
    isNodeRelationshipMatch(node: unknown, state: unknown): boolean;
    resetRelationshipPagingOnFilterChange?: (
        previousEnabled: boolean,
        nextEnabled: boolean,
        pageCache: Map<string, unknown>,
        requestCache: Set<string>
    ) => boolean;
    shouldHighlightRelationshipAncestor?: (
        nodeId: string,
        relatedAncestorIds: ReadonlySet<string>,
        state: unknown
    ) => boolean;
    nodeTooltip?: (node: unknown) => string;
    createBulkExpansionController?: (options: {
        getExpandableNodes(): readonly { readonly id: string }[];
        hasChildren(nodeId: string): boolean;
        requestChildren(node: { readonly id: string }): boolean;
        onComplete(expandedIds: readonly string[]): void;
    }) => {
        readonly active: boolean;
        start(expandedIds: readonly string[]): void;
        childrenLoaded(parentId: string): boolean;
        cancel(): void;
    };
    bulkExpansionTransition?: (
        previousExpandedIds: readonly string[],
        nextExpandedIds: readonly string[]
    ) => {
        readonly expandingIds: readonly string[];
        readonly collapsingIds: readonly string[];
    };
    displayedNodeCount?: (
        node: { readonly id: string; readonly count?: number },
        relationshipFilterEnabled: boolean,
        visibleCounts: Readonly<Record<string, number>>
    ) => number | undefined;
};

const relationships = {
    enabled: true,
    currentScenarioKeys: ['file:///current'],
    relationships: [
        { scenarioKey: 'file:///caller', incomingDistance: 1 },
        { scenarioKey: 'file:///ancestor', incomingDistance: 3 },
        { scenarioKey: 'file:///callee', outgoingDistance: 1 },
        { scenarioKey: 'file:///descendant', outgoingDistance: 2 }
    ],
    affectedMainScenarioKeys: ['file:///owner'],
    affectedPhaseNames: [],
    currentLabel: 'Current scenario'
};

test('owns immutable expansion, selection, and clamped keyboard movement', () => {
    const initial = protocol.createState({ expandedIds: ['source:nested'], selectedId: 'one' });
    const expanded = protocol.toggleExpanded(initial, 'category:one');
    const collapsed = protocol.toggleExpanded(expanded, 'source:nested');
    const selected = protocol.selectNode(collapsed, 'two');

    assert.deepEqual(initial.expandedIds, ['source:nested']);
    assert.deepEqual(expanded.expandedIds, ['source:nested', 'category:one']);
    assert.deepEqual(collapsed.expandedIds, ['category:one']);
    assert.equal(selected.selectedId, 'two');
    assert.equal(protocol.moveSelection(selected, ['one', 'two', 'three'], 1).selectedId, 'three');
    assert.equal(protocol.moveSelection(selected, ['one', 'two', 'three'], 20).selectedId, 'three');
    assert.equal(protocol.moveSelection(selected, ['one', 'two', 'three'], -20).selectedId, 'one');
    assert.equal(protocol.moveSelection(selected, [], 1).selectedId, 'two');
    assert.ok(Object.isFrozen(expanded));
    assert.ok(Object.isFrozen(expanded.expandedIds));
});

test('bulk expansion completes once after every recursively discovered branch is loaded', () => {
    assert.equal(typeof protocol.createBulkExpansionController, 'function');
    const loaded = new Set<string>();
    const knownNodes: { id: string }[] = [{ id: 'source:builtIn' }];
    const requests: string[] = [];
    const completions: readonly string[][] = [];
    const controller = protocol.createBulkExpansionController!({
        getExpandableNodes: () => knownNodes,
        hasChildren: nodeId => loaded.has(nodeId),
        requestChildren: node => {
            requests.push(node.id);
            return true;
        },
        onComplete: expandedIds => completions.push(expandedIds)
    });

    controller.start([]);
    assert.deepEqual(requests, ['source:builtIn']);
    assert.equal(completions.length, 0);

    loaded.add('source:builtIn');
    knownNodes.push({ id: 'category:language' }, { id: 'category:forms' });
    assert.equal(controller.childrenLoaded('source:builtIn'), true);
    assert.deepEqual(requests, ['source:builtIn', 'category:language', 'category:forms']);
    assert.equal(completions.length, 0);

    loaded.add('category:language');
    assert.equal(controller.childrenLoaded('category:language'), true);
    assert.equal(completions.length, 0);

    loaded.add('category:forms');
    assert.equal(controller.childrenLoaded('category:forms'), true);
    assert.deepEqual(completions, [[
        'source:builtIn',
        'category:language',
        'category:forms'
    ]]);
    assert.equal(controller.active, false);
    assert.equal(controller.childrenLoaded('category:forms'), false);
    assert.equal(completions.length, 1);
});

test('cancelling bulk expansion prevents pending responses from completing it', () => {
    assert.equal(typeof protocol.createBulkExpansionController, 'function');
    const loaded = new Set<string>();
    const completions: readonly string[][] = [];
    const controller = protocol.createBulkExpansionController!({
        getExpandableNodes: () => [{ id: 'source:builtIn' }],
        hasChildren: nodeId => loaded.has(nodeId),
        requestChildren: () => true,
        onComplete: expandedIds => completions.push(expandedIds)
    });

    controller.start([]);
    controller.cancel();
    loaded.add('source:builtIn');

    assert.equal(controller.childrenLoaded('source:builtIn'), false);
    assert.equal(controller.active, false);
    assert.deepEqual(completions, []);
});

test('bulk expansion transition identifies branches that must animate', () => {
    assert.equal(typeof protocol.bulkExpansionTransition, 'function');
    assert.deepEqual(protocol.bulkExpansionTransition?.(
        ['source:nested', 'category:old'],
        ['source:nested', 'category:new', 'definition:compiled']
    ), {
        expandingIds: ['category:new', 'definition:compiled'],
        collapsingIds: ['category:old']
    });
});

test('relationship-filtered tree rows display their actual visible count', () => {
    assert.equal(typeof protocol.displayedNodeCount, 'function');
    const node = { id: 'source:main', count: 56 };

    assert.equal(protocol.displayedNodeCount?.(node, false, { 'source:main': 2 }), 56);
    assert.equal(protocol.displayedNodeCount?.(node, true, { 'source:main': 2 }), 2);
    assert.equal(protocol.displayedNodeCount?.({ id: 'more', count: 4 }, true, {}), 4);
});

test('updates relationship state without changing expansion or selection', () => {
    const initial = protocol.createState({
        expandedIds: ['source:nested', 'category:tests'],
        selectedId: 'definition:one'
    });
    const updated = protocol.withRelationshipState(initial, relationships);

    assert.strictEqual(updated.expandedIds, initial.expandedIds);
    assert.equal(updated.selectedId, initial.selectedId);
    assert.notStrictEqual(updated.relationshipState, initial.relationshipState);
});

test('definition tooltips expose scenario descriptions across every scenario source', () => {
    for (const sourceGroup of ['export', 'nested', 'main']) {
        assert.equal(protocol.nodeTooltip?.({
            kind: 'definition',
            sourceGroup,
            label: `${sourceGroup} scenario`,
            description: `${sourceGroup} description`
        }), `${sourceGroup} description`);
    }
    assert.equal(protocol.nodeTooltip?.({
        kind: 'definition',
        sourceGroup: 'nested',
        label: 'Scenario without description'
    }), 'Scenario without description');
});

test('decorates current, caller, callee, and transitive scenario nodes distinctly', () => {
    const state = protocol.withRelationshipState(protocol.createState(), relationships);
    const node = (scenarioKey: string) => ({ kind: 'definition', scenarioKey });

    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///current'), state), {
        state: 'current',
        icon: null,
        classNames: ['is-related'],
        direct: true,
        accessibleLabel: 'Currently open scenario'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///caller'), state), {
        state: 'incoming',
        icon: null,
        classNames: ['is-related', 'is-incoming'],
        direct: true,
        accessibleLabel: 'Calls the open scenario directly'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///callee'), state), {
        state: 'outgoing',
        icon: null,
        classNames: ['is-related', 'is-outgoing'],
        direct: true,
        accessibleLabel: 'Called by the open scenario directly'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///ancestor'), state), {
        state: 'incoming',
        icon: null,
        classNames: ['is-related', 'is-incoming', 'is-transitive'],
        direct: false,
        accessibleLabel: 'Calls the open scenario through 3 scenarios'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///descendant'), state), {
        state: 'outgoing',
        icon: null,
        classNames: ['is-related', 'is-outgoing', 'is-transitive'],
        direct: false,
        accessibleLabel: 'Called by the open scenario through 2 scenarios'
    });
    assert.equal(protocol.relationshipDecorationForNode({ kind: 'category' }, state).state, 'none');
});

test('hides every scenario relationship decoration when highlighting is disabled', () => {
    const state = protocol.withRelationshipState(protocol.createState(), {
        ...relationships,
        enabled: false
    });

    assert.equal(protocol.relationshipDecorationForNode({ scenarioKey: 'file:///current' }, state).state, 'none');
    assert.equal(protocol.relationshipDecorationForNode({ scenarioKey: 'file:///caller' }, state).state, 'none');
    assert.equal(protocol.isNodeRelationshipMatch({ scenarioKey: 'file:///current' }, state), true);
    assert.equal(protocol.isNodeRelationshipMatch({ scenarioKey: 'file:///caller' }, state), true);
});

test('highlights relationship ancestors only while Highlight is enabled', () => {
    assert.equal(typeof protocol.shouldHighlightRelationshipAncestor, 'function');
    const shouldHighlight = protocol.shouldHighlightRelationshipAncestor!;
    const ancestors = new Set(['source:main', 'category:main:Accounting']);
    const enabled = protocol.withRelationshipState(protocol.createState(), relationships);
    const disabled = protocol.withRelationshipState(protocol.createState(), {
        ...relationships,
        enabled: false
    });

    assert.equal(shouldHighlight('source:main', ancestors, enabled), true);
    assert.equal(shouldHighlight('category:main:Accounting', ancestors, disabled), false);
    assert.equal(shouldHighlight('source:export', ancestors, enabled), false);
});

test('decorates and filters export definitions by stable definition id', () => {
    const state = protocol.withRelationshipState(protocol.createState(), {
        ...relationships,
        currentDefinitionIds: ['export:current'],
        definitionRelationships: [
            { definitionId: 'export:called', outgoingDistance: 1 }
        ]
    });

    assert.equal(protocol.relationshipDecorationForNode({ definitionId: 'export:current' }, state).state, 'current');
    assert.deepEqual(protocol.relationshipDecorationForNode({ definitionId: 'export:called' }, state), {
        state: 'outgoing',
        icon: null,
        classNames: ['is-related', 'is-outgoing'],
        direct: true,
        accessibleLabel: 'Called by the open scenario directly'
    });
    assert.equal(protocol.isNodeRelationshipMatch({ definitionId: 'export:called' }, state), true);
    assert.equal(protocol.isNodeRelationshipMatch({ definitionId: 'export:unrelated' }, state), false);
});

test('uses an export definition relationship when the row also has an unrelated scenario key', () => {
    const state = protocol.withRelationshipState(protocol.createState(), {
        ...relationships,
        currentDefinitionIds: [],
        definitionRelationships: [
            { definitionId: 'export:called', outgoingDistance: 1 }
        ]
    });
    const exportRow = {
        kind: 'definition',
        scenarioKey: 'file:///generated/export/scen.yaml',
        definitionId: 'export:called'
    };

    assert.deepEqual(protocol.relationshipDecorationForNode(exportRow, state), {
        state: 'outgoing',
        icon: null,
        classNames: ['is-related', 'is-outgoing'],
        direct: true,
        accessibleLabel: 'Called by the open scenario directly'
    });
    assert.equal(protocol.isNodeRelationshipMatch(exportRow, state), true);
});

test('clears cached pages and requests only when relationship filtering changes', () => {
    assert.equal(typeof protocol.resetRelationshipPagingOnFilterChange, 'function');
    const resetPaging = protocol.resetRelationshipPagingOnFilterChange!;
    const pageCache = new Map<string, unknown>([['category', ['old page']]]);
    const requestCache = new Set(['category\0' + '0']);

    assert.equal(resetPaging(false, false, pageCache, requestCache), false);
    assert.equal(pageCache.size, 1);
    assert.equal(requestCache.size, 1);

    assert.equal(resetPaging(false, true, pageCache, requestCache), true);
    assert.equal(pageCache.size, 0);
    assert.equal(requestCache.size, 0);
});

test('client protocol contains no catalog search or snapshot filtering implementation', () => {
    const source = readFileSync(protocolPath, 'utf8');

    assert.doesNotMatch(source, /buildCategoryTree|normalizedSearch|searchItems|filterSnapshot/u);
});
