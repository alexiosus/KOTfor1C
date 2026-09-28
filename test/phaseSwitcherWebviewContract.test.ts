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

test('Test Manager creation menu delegates exported scenarios and user steps to shared commands', () => {
    for (const entry of [
        {
            id: 'createExportScenarioFromDropdownBtn',
            label: 'createExportScenario',
            message: 'createExportScenario',
            command: 'kotTestToolkit.createExportScenario'
        },
        {
            id: 'createUserStepFromDropdownBtn',
            label: 'createUserStep',
            message: 'createUserStep',
            command: 'kotTestToolkit.createUserStep'
        }
    ]) {
        assert.match(phaseSwitcherHtmlSource, new RegExp(`id="${entry.id}"[\\s\\S]*?\\$\\{loc\\.${entry.label}\\}`));
        assert.match(phaseSwitcherWebviewSource, new RegExp(
            `${entry.id}\\.addEventListener\\('click'[\\s\\S]*?postMessage\\(\\{ command: '${entry.message}' \\}\\)`
        ));
        assert.match(phaseSwitcherProviderSource, new RegExp(
            `case '${entry.message}':[\\s\\S]*?executeCommand\\('${entry.command}'\\)`
        ));
    }
    assert.match(phaseSwitcherProviderSource, /createExportScenario:\s*this\.t\('Export scenario'\)/u);
    assert.match(phaseSwitcherProviderSource, /createUserStep:\s*this\.t\('User step'\)/u);
});

test('Test Manager toolbar opens the shared visual step library command', () => {
    assert.match(
        phaseSwitcherHtmlSource,
        /id="openStepLibraryTopBtn"[\s\S]*?\$\{loc\.openStepLibraryTopTitle\}[\s\S]*?codicon-library/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /openStepLibraryTopBtn\.addEventListener\('click'[\s\S]*?postMessage\(\{ command: 'openStepLibrary' \}\)/u
    );
    assert.match(
        phaseSwitcherProviderSource,
        /case 'openStepLibrary':[\s\S]*?executeCommand\('kotTestToolkit\.openStepLibrary'\)/u
    );
    assert.match(
        phaseSwitcherProviderSource,
        /openStepLibraryTopTitle:\s*this\.t\('Open Step Library'\)/u
    );
});

test('PhaseSwitcher consumes shared relationship state without mutating build selection', () => {
    assert.match(
        phaseSwitcherProviderSource,
        /public attachRelationshipService\(service: ScenarioRelationshipService\)/u
    );

    const projectionStart = phaseSwitcherProviderSource.indexOf(
        '    private getAffectedMainScenarioNamesForActiveEditor()'
    );
    const messageStart = phaseSwitcherProviderSource.indexOf(
        '    private sendAffectedMainScenariosToWebview(',
        projectionStart
    );
    const activeEditorStart = phaseSwitcherProviderSource.indexOf(
        '    public handleActiveEditorChanged(',
        messageStart
    );
    assert.notEqual(projectionStart, -1);
    assert.notEqual(messageStart, -1);
    assert.notEqual(activeEditorStart, -1);

    const projectionSource = phaseSwitcherProviderSource.slice(projectionStart, messageStart);
    assert.match(projectionSource, /this\._relationshipService\?\.getState\(\)/u);
    assert.doesNotMatch(projectionSource, /buildCallersByCalleeFromCache/u);

    const relationshipMessageSource = phaseSwitcherProviderSource.slice(messageStart, activeEditorStart);
    assert.match(relationshipMessageSource, /command: 'updateAffectedMainScenarios'/u);
    assert.doesNotMatch(
        relationshipMessageSource,
        /_mainScenarioSelectionStates|updateScenarioSelection|checkbox|buildScenario/u
    );
});
