import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const phaseSwitcherWebviewSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcher.js'),
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
