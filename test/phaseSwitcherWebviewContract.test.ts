import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const phaseSwitcherWebviewSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcher.js'),
    'utf8'
);
const phaseSwitcherHtmlSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcher.html'),
    'utf8'
);
const phaseSwitcherProviderSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'src', 'phaseSwitcher.ts'),
    'utf8'
);
const extensionSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'src', 'extension.ts'),
    'utf8'
);
const packageManifest = JSON.parse(require('node:fs').readFileSync(
    path.join(process.cwd(), 'package.json'),
    'utf8'
));

const protocol = require(path.join(process.cwd(), 'media', 'phaseSwitcherProtocol.js')) as {
    getScenarioKey(testInfo: unknown): string;
    createScenarioCommand(
        command: string,
        testInfo: unknown,
        extra?: Record<string, unknown>
    ): Record<string, unknown>;
};

test('scenario protocol creates exact URI-backed command payloads', () => {
    const testInfo = {
        scenarioKey: 'file:///a/scen.yaml',
        name: 'Duplicate',
        yamlFileUriString: 'file:///a/scen.yaml'
    };

    assert.equal(protocol.getScenarioKey(testInfo), 'file:///a/scen.yaml');
    assert.deepEqual(protocol.createScenarioCommand('runScenarioInVanessa', testInfo), {
        command: 'runScenarioInVanessa',
        key: 'file:///a/scen.yaml',
        name: 'Duplicate',
        uri: 'file:///a/scen.yaml'
    });
    assert.deepEqual(protocol.createScenarioCommand('openScenarioJsonArtifactInEditor', testInfo, {
        variant: 'combined'
    }), {
        command: 'openScenarioJsonArtifactInEditor',
        key: 'file:///a/scen.yaml',
        name: 'Duplicate',
        uri: 'file:///a/scen.yaml',
        variant: 'combined'
    });
});

test('scenario protocol rejects incomplete runtime identities', () => {
    assert.throws(
        () => protocol.createScenarioCommand('openScenario', {
            name: 'Missing key',
            yamlFileUriString: 'file:///a/scen.yaml'
        }),
        /runtime key/i
    );
});

test('run-state refresh preserves URI-backed checkbox identity', () => {
    const syncFunctionStart = phaseSwitcherWebviewSource.indexOf('    function syncScenarioLeadingControl(');
    const nextFunctionStart = phaseSwitcherWebviewSource.indexOf(
        '    function syncScenarioProgress(',
        syncFunctionStart
    );
    assert.notEqual(syncFunctionStart, -1);
    assert.notEqual(nextFunctionStart, -1);

    const syncFunctionSource = phaseSwitcherWebviewSource.slice(syncFunctionStart, nextFunctionStart);
    assert.match(syncFunctionSource, /existingCheckbox\.name = viewState\.scenarioKey;/);
    assert.doesNotMatch(syncFunctionSource, /existingCheckbox\.name = viewState\.name;/);
});

test('demo run state is overlaid by exact scenario URI key', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /const scenarioKey = scenarioProtocol\.getScenarioKey\(info\)/
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /demoOverlay\[scenarioKey\] = buildDemoRunArtifact\(name, stateKey\)/
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /const scenarioKey = message\.key;[\s\S]*?\{ \[scenarioKey\]: artifact \}/
    );
});

test('Test Manager creation actions use the native view title menu', () => {
    assert.doesNotMatch(phaseSwitcherHtmlSource, /createExportScenarioFromDropdownBtn|createUserStepFromDropdownBtn/u);
    const actions = packageManifest.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
    const phaseCommands = actions
        .filter(action => action.when === 'view == kotTestToolkit.phaseSwitcherView')
        .map(action => action.command);
    assert.ok(phaseCommands.includes('kotTestToolkit.showCreateScenarioMenu'));
    const commandContributions = packageManifest.contributes.commands as Array<{
        command: string;
        category?: string;
    }>;
    for (const command of phaseCommands) {
        assert.equal(
            commandContributions.find(candidate => candidate.command === command)?.category,
            undefined,
            `${command} must not be prefixed with the extension category in the Test Manager menu`
        );
    }
});

test('phase aggregate checkbox is synchronized after the header controls are attached', () => {
    const headerStart = phaseSwitcherWebviewSource.indexOf(
        "            const phaseHeaderDiv = document.createElement('div');"
    );
    const listStart = phaseSwitcherWebviewSource.indexOf(
        "            const testsListDiv = document.createElement('div');",
        headerStart
    );
    assert.notEqual(headerStart, -1);
    assert.notEqual(listStart, -1);

    const headerSource = phaseSwitcherWebviewSource.slice(headerStart, listStart);
    const attachCheckbox = headerSource.indexOf('phaseHeaderDiv.appendChild(phaseCheckbox);');
    const synchronizeAggregate = headerSource.indexOf(
        'updatePhaseCountButton(countButton, phaseName, enabledCount, totalInPhase);'
    );
    assert.ok(attachCheckbox >= 0);
    assert.ok(synchronizeAggregate > attachCheckbox);
});

test('Step Library full-page action is contributed to its native view title', () => {
    assert.doesNotMatch(phaseSwitcherHtmlSource, /id="openStepLibraryTopBtn"/u);
    assert.match(extensionSource, /registerCommand\(\s*'kotTestToolkit\.openStepLibrary'/u);
    const actions = packageManifest.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
    assert.ok(actions.some(action =>
        action.command === 'kotTestToolkit.openStepLibrary'
        && action.when === 'view == kotTestToolkit.stepLibrarySidebarView'
    ));
});

test('PhaseSwitcher consumes shared relationship state without mutating build selection', () => {
    assert.match(
        phaseSwitcherProviderSource,
        /public attachRelationshipService\(service: ScenarioRelationshipService\)/u
    );

    const messageStart = phaseSwitcherProviderSource.indexOf(
        '    private sendRelationshipStateToWebview('
    );
    const activeEditorStart = phaseSwitcherProviderSource.indexOf(
        '    public handleActiveEditorChanged(',
        messageStart
    );
    assert.notEqual(messageStart, -1);
    assert.notEqual(activeEditorStart, -1);

    const relationshipMessageSource = phaseSwitcherProviderSource.slice(messageStart, activeEditorStart);
    assert.match(relationshipMessageSource, /this\._relationshipService\?\.getState\(\)/u);
    assert.doesNotMatch(relationshipMessageSource, /buildCallersByCalleeFromCache/u);
    assert.match(relationshipMessageSource, /command: 'updateRelationshipState'/u);
    for (const property of [
        'currentScenarioKeys',
        'relationships',
        'affectedMainScenarioKeys',
        'affectedPhaseNames',
        'currentLabel',
        'enabled'
    ]) {
        assert.match(relationshipMessageSource, new RegExp(`\\b${property}\\b`, 'u'));
    }
    assert.doesNotMatch(
        relationshipMessageSource,
        /_mainScenarioSelectionStates|updateScenarioSelection|checkbox|buildScenario/u
    );
    assert.match(
        phaseSwitcherProviderSource,
        /case 'setRelationshipHighlightEnabled':[\s\S]*?typeof message\.enabled !== 'boolean'[\s\S]*?await this\._relationshipService\.setEnabled\(message\.enabled\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /relationshipState = scenarioProtocol\.parseRelationshipState\(message\.relationshipState\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /case 'updateRelationshipState':[\s\S]*?scenarioProtocol\.parseRelationshipState\(message\)/u
    );
});
