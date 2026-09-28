import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const protocol = require(path.join(process.cwd(), 'media', 'phaseSwitcherProtocol.js')) as {
    parseRelationshipState(value: unknown): {
        enabled: boolean;
        currentScenarioKeys: readonly string[];
        relationships: readonly Array<{
            scenarioKey: string;
            incomingDistance?: number;
            outgoingDistance?: number;
        }>;
        affectedMainScenarioKeys: readonly string[];
        affectedPhaseNames: readonly string[];
        currentLabel: string | null;
    };
    relationshipDecorationForScenario(scenarioKey: string, state: unknown): {
        state: 'current' | 'incoming' | 'outgoing' | 'related' | 'none';
        icon: 'eye' | 'arrow-right-to-line' | 'arrow-right-from-line' | null;
        direct: boolean;
        accessibleLabel: string;
    };
    aggregatePhaseRelationship(scenarioKeys: readonly string[], state: unknown): {
        state: 'related' | 'none';
        icon: 'git-branch' | null;
        count: number;
        direct: boolean;
        accessibleLabel: string;
    };
    selectionAggregateForKeys(
        selectedKeys: readonly string[],
        visibleKeys: readonly string[]
    ): 'checked' | 'unchecked' | 'indeterminate';
    nextVisibleSelection(
        currentKeys: readonly string[],
        visibleKeys: readonly string[],
        mode: 'select' | 'clear' | 'toggle'
    ): readonly string[];
};

const relationshipState = {
    enabled: true,
    currentScenarioKeys: ['open'],
    relationships: [
        { scenarioKey: 'caller', incomingDistance: 1 },
        { scenarioKey: 'ancestor', incomingDistance: 3 },
        { scenarioKey: 'callee', outgoingDistance: 1 },
        { scenarioKey: 'descendant', outgoingDistance: 2 },
        { scenarioKey: 'cycle', incomingDistance: 2, outgoingDistance: 1 }
    ],
    affectedMainScenarioKeys: ['main-owner'],
    affectedPhaseNames: ['Accounting'],
    currentLabel: 'Open scenario'
};

test('normalizes relationship payloads into immutable stable-key state', () => {
    const parsed = protocol.parseRelationshipState({
        ...relationshipState,
        currentScenarioKeys: [' open ', '', 'open'],
        relationships: [
            { scenarioKey: ' caller ', incomingDistance: 2 },
            { scenarioKey: 'caller', incomingDistance: 1, outgoingDistance: -4 },
            { scenarioKey: '', outgoingDistance: 1 }
        ],
        affectedMainScenarioKeys: [' main-owner ', 'main-owner'],
        affectedPhaseNames: [' Accounting ', 'Accounting'],
        currentLabel: ' Open scenario '
    });

    assert.deepEqual(parsed, {
        enabled: true,
        currentScenarioKeys: ['open'],
        relationships: [{ scenarioKey: 'caller', incomingDistance: 1 }],
        affectedMainScenarioKeys: ['main-owner'],
        affectedPhaseNames: ['Accounting'],
        currentLabel: 'Open scenario'
    });
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.relationships));
});

test('aggregates checked, unchecked, and indeterminate visible build selections', () => {
    assert.equal(protocol.selectionAggregateForKeys(['a', 'b'], ['a', 'b']), 'checked');
    assert.equal(protocol.selectionAggregateForKeys(['hidden'], ['a', 'b']), 'unchecked');
    assert.equal(protocol.selectionAggregateForKeys(['a'], ['a', 'b']), 'indeterminate');
    assert.equal(protocol.selectionAggregateForKeys(['a'], []), 'unchecked');
});

test('Select visible preserves hidden tests and only changes the filtered result', () => {
    assert.deepEqual(
        protocol.nextVisibleSelection(['hidden', 'visible-a'], ['visible-a', 'visible-b'], 'select'),
        ['hidden', 'visible-a', 'visible-b']
    );
    assert.deepEqual(
        protocol.nextVisibleSelection(['hidden', 'visible-a'], ['visible-a', 'visible-b'], 'clear'),
        ['hidden']
    );
    assert.deepEqual(
        protocol.nextVisibleSelection(['main-a'], ['favorite-b'], 'toggle'),
        ['main-a', 'favorite-b']
    );
    assert.deepEqual(
        protocol.nextVisibleSelection(['main-a', 'favorite-b'], ['favorite-b'], 'toggle'),
        ['main-a']
    );
});

test('keeps current editor identity independent from focused row state', () => {
    const parsed = protocol.parseRelationshipState({
        ...relationshipState,
        focusedScenarioKey: 'focused'
    });

    assert.equal(protocol.relationshipDecorationForScenario('open', parsed).state, 'current');
    assert.equal(protocol.relationshipDecorationForScenario('focused', parsed).state, 'none');
});

test('current blue state takes precedence over relationship purple state', () => {
    const parsed = protocol.parseRelationshipState({
        ...relationshipState,
        relationships: [
            ...relationshipState.relationships,
            { scenarioKey: 'open', incomingDistance: 1 }
        ]
    });

    assert.deepEqual(protocol.relationshipDecorationForScenario('open', parsed), {
        state: 'current',
        icon: 'eye',
        direct: true,
        accessibleLabel: 'Currently open scenario'
    });
});

test('uses distinct caller and callee icons with direct and transitive accessible text', () => {
    const parsed = protocol.parseRelationshipState(relationshipState);

    assert.deepEqual(protocol.relationshipDecorationForScenario('caller', parsed), {
        state: 'incoming',
        icon: 'arrow-right-to-line',
        direct: true,
        accessibleLabel: 'Calls the open scenario directly'
    });
    assert.deepEqual(protocol.relationshipDecorationForScenario('callee', parsed), {
        state: 'outgoing',
        icon: 'arrow-right-from-line',
        direct: true,
        accessibleLabel: 'Called by the open scenario directly'
    });
    assert.deepEqual(protocol.relationshipDecorationForScenario('ancestor', parsed), {
        state: 'incoming',
        icon: 'arrow-right-to-line',
        direct: false,
        accessibleLabel: 'Calls the open scenario through 3 scenarios'
    });
    assert.deepEqual(protocol.relationshipDecorationForScenario('cycle', parsed), {
        state: 'incoming',
        icon: 'arrow-right-to-line',
        direct: false,
        accessibleLabel: 'Calls the open scenario through 2 scenarios; Called by the open scenario directly'
    });
});

test('retains current identity but removes purple relations when highlighting is disabled', () => {
    const parsed = protocol.parseRelationshipState({ ...relationshipState, enabled: false });

    assert.equal(protocol.relationshipDecorationForScenario('open', parsed).state, 'current');
    assert.equal(protocol.relationshipDecorationForScenario('caller', parsed).state, 'none');
    assert.equal(protocol.relationshipDecorationForScenario('main-owner', parsed).state, 'none');
});

test('aggregates related phase children without pretending the phase is current', () => {
    const parsed = protocol.parseRelationshipState(relationshipState);

    assert.deepEqual(protocol.aggregatePhaseRelationship(
        ['open', 'caller', 'unrelated'],
        parsed
    ), {
        state: 'related',
        icon: 'git-branch',
        count: 2,
        direct: true,
        accessibleLabel: '2 related scenarios in this phase'
    });
    assert.deepEqual(protocol.aggregatePhaseRelationship(
        ['unrelated'],
        parsed
    ), {
        state: 'none',
        icon: null,
        count: 0,
        direct: false,
        accessibleLabel: ''
    });
});
