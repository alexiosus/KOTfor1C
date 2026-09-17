import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

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
