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
