import path from 'node:path';
import { localFileUri } from './helpers/filePaths';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeScenarioFileRelativePath,
    scenarioFileNodeId,
    scenarioFilesAvailable
} from '../src/scenarioFilesModel';
import * as scenarioFilesModel from '../src/scenarioFilesModel';
import type { StepLibraryItem } from '../src/stepLibraryModel';

function item(overrides: Partial<StepLibraryItem> = {}): StepLibraryItem {
    return {
        id: 'nested#authored',
        definitionId: 'nested',
        familyId: 'nested',
        kind: 'nestedScenario',
        sourceGroup: 'nested',
        template: 'Create invoice',
        displayText: 'Create invoice',
        categoryPath: [],
        parameters: [],
        sourceLabel: 'Nested scenario',
        navigable: true,
        insertable: true,
        capturedLocation: {
            uri: localFileUri("/workspace/CreateInvoice/scen.yaml"),
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        },
        searchText: 'create invoice',
        ...overrides
    };
}

test('normalizes safe resource paths and rejects traversal or absolute paths', () => {
    assert.equal(normalizeScenarioFileRelativePath('Fixtures/Input.xlsx'), 'Fixtures/Input.xlsx');
    assert.equal(normalizeScenarioFileRelativePath('./Fixtures\\Input.xlsx'), 'Fixtures/Input.xlsx');
    assert.equal(normalizeScenarioFileRelativePath(''), '');

    for (const value of [
        '../secret.txt',
        'Fixtures/../../secret.txt',
        '/tmp/file',
        'C:\\temp\\file',
        '\\\\server\\share',
        'bad\0name'
    ]) {
        assert.equal(normalizeScenarioFileRelativePath(value), null, value);
    }
});

test('builds stable resource node ids without exposing the absolute scenario path', () => {
    const id = scenarioFileNodeId('nested#authored', 'file', 'Fixtures/Input.xlsx');

    assert.equal(id, 'scenario-file:nested%23authored:file:Fixtures%2FInput.xlsx');
    assert.doesNotMatch(id, /workspace/u);
});

test('exposes files only for local nested scenario definitions', () => {
    assert.equal(scenarioFilesAvailable(item()), true);
    assert.equal(scenarioFilesAvailable(item({ kind: 'exportScenario', sourceGroup: 'export' })), false);
    assert.equal(scenarioFilesAvailable(item({ capturedLocation: undefined })), false);
    assert.equal(scenarioFilesAvailable(item({
        capturedLocation: {
            uri: 'vscode-remote://ssh-remote+host/workspace/CreateInvoice/scen.yaml',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }
    })), false);
});

test('exposes an explicit compiled attachments root for a main scenario', () => {
    const compiledMain = item({
        kind: 'mainScenario',
        sourceGroup: 'main',
        capturedLocation: undefined,
        ...({
            compiledFeatureUri: localFileUri("/workspace/build/004_Production.feature"),
            scenarioFilesRootUri: localFileUri("/workspace/build/004_Production/Файлы")
        } as object)
    } as Partial<StepLibraryItem>);

    assert.equal(scenarioFilesAvailable(compiledMain), true);
});

test('derives the compiled feature and localized attachments URIs from one artifact path', () => {
    const derive = (scenarioFilesModel as unknown as {
        compiledScenarioResourcesFromFeaturePath?: (featurePath: string) => {
            featureUri: string;
            filesRootUri: string;
        } | null;
    }).compiledScenarioResourcesFromFeaturePath;
    const resources = derive?.(path.resolve("/workspace/build/004_Production.feature"));

    assert.equal(resources?.featureUri, localFileUri("/workspace/build/004_Production.feature"));
    assert.equal(
        decodeURIComponent(resources?.filesRootUri ?? ''),
        decodeURIComponent(localFileUri("/workspace/build/004_Production/Файлы"))
    );
});
