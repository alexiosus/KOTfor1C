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
        icon: 'arrow-right-to-line' | 'arrow-right-from-line' | null;
        direct: boolean;
        accessibleLabel: string;
    };
    isScenarioRelationshipMatch(scenarioKey: string, state: unknown): boolean;
    isScenarioRelationshipHighlighted?: (scenarioKey: string, state: unknown) => boolean;
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
    matchesScenarioSearch(
        scenario: { name?: string; phaseName?: string; attachmentPaths?: readonly string[] },
        query: string
    ): boolean;
    normalizeStatusFilter(value: unknown): 'all' | 'built' | 'running';
    matchesStatusFilter(runInfo: unknown, mode: unknown): boolean;
    visibleScenarioAggregate(
        testInfos: readonly Array<{ scenarioKey?: string; name?: string }>,
        states: Readonly<Record<string, boolean | 'checked' | 'disabled'>>,
        runArtifacts: Readonly<Record<string, unknown>>,
        mode: unknown,
        relationshipPredicate?: (testInfo: { scenarioKey?: string; name?: string }, key: string) => boolean,
        searchPredicate?: (testInfo: { scenarioKey?: string; name?: string }, key: string) => boolean
    ): {
        visibleKeys: readonly string[];
        selectedCount: number;
        totalCount: number;
    };
    formatRunProgress(value: {
        isRunning?: boolean;
        currentLine?: number;
        totalLines?: number;
        percent?: number;
        iteration?: number;
    }): {
        hasLineProgress: boolean;
        percent: number | null;
        title: string;
        counterText: string;
        badgeText: string;
    };
    compiledResourceSignature(runArtifacts: unknown): string;
    changedCompiledResourceKeys(previousArtifacts: unknown, nextArtifacts: unknown): readonly string[];
    isCurrentScenarioFileResponse(expectedRequestId: unknown, responseRequestId: unknown): boolean;
    createPhaseContextMenuActions(
        groupName: string,
        labels: { createMainScenario: string; renameGroup: string }
    ): readonly Array<{
        icon: string;
        label: string;
        message: { command: string; groupName: string };
    }>;
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

test('group context menu creates a main scenario before the rename action', () => {
    assert.deepEqual(
        protocol.createPhaseContextMenuActions('  Production 2  ', {
            createMainScenario: 'Create main scenario',
            renameGroup: 'Rename group'
        }),
        [
            {
                icon: 'codicon-add',
                label: 'Create main scenario',
                message: { command: 'createMainScenario', groupName: 'Production 2' }
            },
            {
                icon: 'codicon-rename',
                label: 'Rename group',
                message: { command: 'renameGroup', groupName: 'Production 2' }
            }
        ]
    );
});

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

test('status filters include every artifact shape and every displayed running source', () => {
    assert.equal(protocol.normalizeStatusFilter('built'), 'built');
    assert.equal(protocol.normalizeStatusFilter('running'), 'running');
    assert.equal(protocol.normalizeStatusFilter('invalid'), 'all');
    assert.equal(protocol.normalizeStatusFilter(null), 'all');

    for (const artifact of [
        { featurePath: '/build/test.feature', runStatus: 'idle' },
        { compiledFeatureUri: 'file:///build/test.feature', runStatus: 'idle' },
        { jsonPath: '/build/test.json', runStatus: 'idle' },
        { combinedJsonPath: '/build/combined.json', runStatus: 'idle' },
        { featurePath: '/build/test.feature', stale: true, runStatus: 'passed' }
    ]) {
        assert.equal(protocol.matchesStatusFilter(artifact, 'built'), true);
    }
    assert.equal(protocol.matchesStatusFilter(null, 'built'), false);
    assert.equal(protocol.matchesStatusFilter({}, 'built'), false);
    assert.equal(protocol.matchesStatusFilter(null, 'all'), true);
    assert.equal(protocol.matchesStatusFilter({ runStatus: 'running' }, 'running'), true);
    assert.equal(protocol.matchesStatusFilter({
        runStatus: 'running',
        blocksControls: false
    }, 'running'), true);
    assert.equal(protocol.matchesStatusFilter({
        runStatus: 'idle',
        featurePath: '/build/test.feature'
    }, 'running'), false);
});

test('visible scenario aggregate intersects status relationship and search filters without mutation', () => {
    const testInfos = [
        { scenarioKey: 'a', name: 'Alpha' },
        { scenarioKey: 'b', name: 'Beta' },
        { scenarioKey: 'c', name: 'Gamma' },
        { scenarioKey: 'd', name: 'Delta' },
        { scenarioKey: '', name: 'Invalid' }
    ];
    const states = { a: true, b: false, c: 'checked', d: 'disabled' } as const;
    const runArtifacts = {
        a: { featurePath: '/a.feature', runStatus: 'idle', stale: true },
        b: { jsonPath: '/b.json', runStatus: 'idle' },
        c: { runStatus: 'running', blocksControls: false },
        d: { combinedJsonPath: '/d.json', runStatus: 'idle' }
    };
    const artifactsBefore = JSON.stringify(runArtifacts);
    const infosBefore = JSON.stringify(testInfos);

    assert.deepEqual(protocol.visibleScenarioAggregate(
        testInfos,
        states,
        runArtifacts,
        'built',
        (_info, key) => key !== 'b',
        info => info.name !== 'Gamma'
    ), {
        visibleKeys: ['a', 'd'],
        selectedCount: 1,
        totalCount: 1
    });
    assert.deepEqual(protocol.visibleScenarioAggregate(
        testInfos,
        states,
        runArtifacts,
        'running',
        () => true,
        () => true
    ), {
        visibleKeys: ['c'],
        selectedCount: 1,
        totalCount: 1
    });
    assert.equal(JSON.stringify(runArtifacts), artifactsBefore);
    assert.equal(JSON.stringify(testInfos), infosBefore);
});

test('keeps current editor identity independent from focused row state', () => {
    const parsed = protocol.parseRelationshipState({
        ...relationshipState,
        focusedScenarioKey: 'focused'
    });

    assert.equal(protocol.relationshipDecorationForScenario('open', parsed).state, 'current');
    assert.equal(protocol.relationshipDecorationForScenario('focused', parsed).state, 'none');
});

test('highlights the open scenario with its relationship graph but not when highlighting is disabled', () => {
    assert.equal(typeof protocol.isScenarioRelationshipHighlighted, 'function');
    const isHighlighted = protocol.isScenarioRelationshipHighlighted!;

    assert.equal(isHighlighted('open', relationshipState), true);
    assert.equal(isHighlighted('callee', relationshipState), true);
    assert.equal(isHighlighted('unrelated', relationshipState), false);
    assert.equal(isHighlighted('open', { ...relationshipState, enabled: false }), false);
    assert.equal(protocol.isScenarioRelationshipMatch('open', { ...relationshipState, enabled: false }), true);
    assert.equal(protocol.isScenarioRelationshipMatch('caller', { ...relationshipState, enabled: false }), true);
    assert.equal(protocol.isScenarioRelationshipMatch('unrelated', { ...relationshipState, enabled: false }), false);
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
        icon: null,
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

test('scenario search filters by scenario or group name like the Library search', () => {
    assert.equal(protocol.matchesScenarioSearch({ name: 'Create sales order', phaseName: 'CRM / Sales' }, 'sales'), true);
    assert.equal(protocol.matchesScenarioSearch({ name: 'Create sales order', phaseName: 'CRM / Sales' }, 'CRM'), true);
    assert.equal(protocol.matchesScenarioSearch({ name: 'Create sales order', phaseName: 'CRM / Sales' }, 'cash'), false);
    assert.equal(protocol.matchesScenarioSearch({ name: 'Create sales order', phaseName: 'CRM / Sales' }, '  '), true);
});

test('scenario search matches attachment names and nested paths case insensitively', () => {
    const scenario = { name: 'Create sales order', phaseName: 'CRM', attachmentPaths: ['Fixtures/Данные.MXL', 'Input.xlsx'] };
    assert.equal(protocol.matchesScenarioSearch(scenario, 'данные.mxl'), true);
    assert.equal(protocol.matchesScenarioSearch(scenario, 'fixtures/'), true);
    assert.equal(protocol.matchesScenarioSearch(scenario, 'INPUT.XLSX'), true);
    assert.equal(protocol.matchesScenarioSearch(scenario, 'unrelated.csv'), false);
});

test('run progress keeps the feature position and exposes repeated loop visits', () => {
    assert.deepEqual(protocol.formatRunProgress({
        isRunning: true,
        currentLine: 300,
        totalLines: 2500,
        percent: 12,
        iteration: 3
    }), {
        hasLineProgress: true,
        percent: 12,
        title: '300/2500 (12%) · ×3',
        counterText: '300/2500 · ×3',
        badgeText: '12% · ×3'
    });
    assert.deepEqual(protocol.formatRunProgress({
        isRunning: true,
        currentLine: 301,
        totalLines: 2500,
        percent: 12,
        iteration: 1
    }), {
        hasLineProgress: true,
        percent: 12,
        title: '301/2500 (12%)',
        counterText: '301/2500',
        badgeText: '12%'
    });
});

test('compiled resource signature ignores live status but changes with the resource tree', () => {
    const initial = {
        'file:///workspace/tests/Production/test.yaml': {
            compiledFeatureUri: 'file:///workspace/build/004_Production.feature',
            scenarioFilesRootUri: 'file:///workspace/build/004_Production/Файлы',
            runStatus: 'idle',
            progressPercent: 0
        }
    };
    const running = {
        'file:///workspace/tests/Production/test.yaml': {
            ...initial['file:///workspace/tests/Production/test.yaml'],
            runStatus: 'running',
            progressPercent: 41
        }
    };
    const rebuilt = {
        'file:///workspace/tests/Production/test.yaml': {
            ...running['file:///workspace/tests/Production/test.yaml'],
            compiledFeatureUri: 'file:///workspace/build-next/004_Production.feature',
            scenarioFilesRootUri: 'file:///workspace/build-next/004_Production/Файлы'
        }
    };

    assert.equal(
        protocol.compiledResourceSignature(initial),
        protocol.compiledResourceSignature(running)
    );
    assert.notEqual(
        protocol.compiledResourceSignature(initial),
        protocol.compiledResourceSignature(rebuilt)
    );
    assert.equal(protocol.compiledResourceSignature(null), '');
});

test('resource cache invalidation targets only scenarios whose compiled locations changed', () => {
    const previous = {
        stable: {
            compiledFeatureUri: 'file:///build/stable.feature',
            scenarioFilesRootUri: 'file:///build/stable/Файлы',
            runStatus: 'idle'
        },
        rebuilt: {
            compiledFeatureUri: 'file:///build-old/rebuilt.feature',
            scenarioFilesRootUri: 'file:///build-old/rebuilt/Файлы'
        },
        removed: {
            compiledFeatureUri: 'file:///build/removed.feature',
            scenarioFilesRootUri: 'file:///build/removed/Файлы'
        }
    };
    const next = {
        stable: {
            ...previous.stable,
            runStatus: 'running',
            progressPercent: 20
        },
        rebuilt: {
            compiledFeatureUri: 'file:///build-new/rebuilt.feature',
            scenarioFilesRootUri: 'file:///build-new/rebuilt/Файлы'
        },
        added: {
            compiledFeatureUri: 'file:///build/added.feature',
            scenarioFilesRootUri: 'file:///build/added/Файлы'
        }
    };

    assert.deepEqual(
        protocol.changedCompiledResourceKeys(previous, next),
        ['added', 'rebuilt', 'removed']
    );
});

test('a file-tree response is accepted only for the latest request', () => {
    assert.equal(protocol.isCurrentScenarioFileResponse('request-2', 'request-1'), false);
    assert.equal(protocol.isCurrentScenarioFileResponse('request-2', 'request-2'), true);
    assert.equal(protocol.isCurrentScenarioFileResponse(undefined, 'request-2'), false);
});
