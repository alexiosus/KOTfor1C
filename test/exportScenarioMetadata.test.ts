import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildExportScenarioMetadataActions,
    canonicalizeExportScenarioDocumentUri,
    collectAvailableExportScenarioCategories,
    collectExportScenarioCategories,
    EXPORT_SCENARIO_METADATA_COMMAND,
    getExportScenarioMetadataInputDefault
} from '../src/exportScenarioMetadata';

function source(text: string) {
    return {
        text,
        version: 12,
        sourceUri: 'file:///workspace/libraries/exports.feature',
        workspaceFolderUri: 'file:///workspace',
        profileId: 'active',
        libraryRootUri: 'file:///workspace/libraries',
        sourceLabel: 'Project exports',
        defaultLanguage: 'en' as const
    };
}

test('offers CodeLens actions only for missing metadata on exported scenarios', () => {
    const feature = [
        '# language: en',
        'Feature: Shared calls',
        '',
        '@ExportScenarios',
        '@steptype: Windows',
        'Scenario: Exported call',
        '    Given ready',
        '',
        'Scenario: Local helper',
        '    Given ready'
    ].join('\n');

    const actions = buildExportScenarioMetadataActions(source(feature), message => `T:${message}`);

    assert.deepEqual(actions.map(action => ({
        title: action.title,
        command: action.command,
        line: action.range.start.line,
        kind: action.target.kind,
        version: action.target.documentVersion,
        uri: action.target.documentUri
    })), [
        {
            title: 'T:+ Description',
            command: EXPORT_SCENARIO_METADATA_COMMAND,
            line: 5,
            kind: 'description',
            version: 12,
            uri: 'file:///workspace/libraries/exports.feature'
        },
        {
            title: 'T:+ Usage example',
            command: EXPORT_SCENARIO_METADATA_COMMAND,
            line: 5,
            kind: 'usageExample',
            version: 12,
            uri: 'file:///workspace/libraries/exports.feature'
        }
    ]);
});

test('collects sorted unique export-scenario categories case-insensitively', () => {
    const categories = collectExportScenarioCategories([
        { kind: 'exportScenario', category: ' Windows.Readiness ' },
        { kind: 'userStep', category: 'User steps' },
        { kind: 'exportScenario', category: 'windows.readiness' },
        { kind: 'exportScenario', category: 'Forms' },
        { kind: 'exportScenario' }
    ]);

    assert.deepEqual(categories, ['Forms', 'Windows.Readiness']);
});

test('uses live current-document categories instead of stale indexed categories reached through an alias', async () => {
    const editorUri = 'file:///alias/exports.feature';
    const physicalUri = 'file:///physical/exports.feature';
    const currentUri = await canonicalizeExportScenarioDocumentUri(
        '/alias/exports.feature',
        editorUri,
        async () => '/physical/exports.feature'
    );
    const indexed = [
        {
            kind: 'exportScenario' as const,
            category: 'Legacy',
            definitionLocation: { uri: physicalUri }
        },
        {
            kind: 'exportScenario' as const,
            category: 'Forms',
            definitionLocation: { uri: 'file:///workspace/other.feature' }
        }
    ];

    assert.deepEqual(collectAvailableExportScenarioCategories(
        indexed,
        [{ kind: 'exportScenario', category: 'Windows.Readiness' }],
        currentUri
    ), ['Forms', 'Windows.Readiness']);
    assert.deepEqual(collectAvailableExportScenarioCategories(indexed, [], currentUri), ['Forms']);
});

test('keeps the editor URI when resolving its physical path fails', async () => {
    const editorUri = 'file:///missing/exports.feature';
    assert.equal(await canonicalizeExportScenarioDocumentUri(
        '/missing/exports.feature',
        editorUri,
        async () => { throw new Error('missing'); }
    ), editorUri);
});

test('prefills only usage examples with the feature-language call keyword', () => {
    assert.equal(getExportScenarioMetadataInputDefault('usageExample', 'Open card', 'en'), 'And Open card');
    assert.equal(getExportScenarioMetadataInputDefault('usageExample', 'Открыть карточку', 'ru'), 'И Открыть карточку');
    assert.equal(getExportScenarioMetadataInputDefault('description', 'Open card', 'en'), '');
    assert.equal(getExportScenarioMetadataInputDefault('category', 'Open card', 'en'), '');
});
