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

test('decorates current, caller, callee, and transitive scenario nodes distinctly', () => {
    const state = protocol.withRelationshipState(protocol.createState(), relationships);
    const node = (scenarioKey: string) => ({ kind: 'definition', scenarioKey });

    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///current'), state), {
        state: 'current',
        icon: 'eye',
        classNames: ['is-current'],
        direct: true,
        accessibleLabel: 'Currently open scenario'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///caller'), state), {
        state: 'incoming',
        icon: 'arrow-right-to-line',
        classNames: ['is-related', 'is-incoming'],
        direct: true,
        accessibleLabel: 'Calls the open scenario directly'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///callee'), state), {
        state: 'outgoing',
        icon: 'arrow-right-from-line',
        classNames: ['is-related', 'is-outgoing'],
        direct: true,
        accessibleLabel: 'Called by the open scenario directly'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///ancestor'), state), {
        state: 'incoming',
        icon: 'arrow-right-to-line',
        classNames: ['is-related', 'is-incoming', 'is-transitive'],
        direct: false,
        accessibleLabel: 'Calls the open scenario through 3 scenarios'
    });
    assert.deepEqual(protocol.relationshipDecorationForNode(node('file:///descendant'), state), {
        state: 'outgoing',
        icon: 'arrow-right-from-line',
        classNames: ['is-related', 'is-outgoing', 'is-transitive'],
        direct: false,
        accessibleLabel: 'Called by the open scenario through 2 scenarios'
    });
    assert.equal(protocol.relationshipDecorationForNode({ kind: 'category' }, state).state, 'none');
});

test('keeps current identity visible when relationship highlighting is disabled', () => {
    const state = protocol.withRelationshipState(protocol.createState(), {
        ...relationships,
        enabled: false
    });

    assert.equal(protocol.relationshipDecorationForNode({ scenarioKey: 'file:///current' }, state).state, 'current');
    assert.equal(protocol.relationshipDecorationForNode({ scenarioKey: 'file:///caller' }, state).state, 'none');
});

test('client protocol contains no catalog search or snapshot filtering implementation', () => {
    const source = readFileSync(protocolPath, 'utf8');

    assert.doesNotMatch(source, /buildCategoryTree|normalizedSearch|searchItems|filterSnapshot/u);
});
