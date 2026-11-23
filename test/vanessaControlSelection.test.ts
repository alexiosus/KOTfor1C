import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareVanessaSelection } from '../src/vanessaControlSelection';
import { createProjectDefinitionView, normalizeProjectDefinitionTemplate } from '../src/projectDefinition';
import type { VanessaFeatureDocument } from '../src/vanessaControlFeature';

const definitions = createProjectDefinitionView('selection', [{ id: 'delay', kind: 'builtInStep', template: 'And Delay "%1 seconds"',
    normalizedTemplate: normalizeProjectDefinitionTemplate('And Delay "%1 seconds"'), language: 'en', sourceLabel: 'Vanessa fixture',
    parameters: [{ name: 'seconds', index: 0, source: 'quoted' }] }]);
const source: VanessaFeatureDocument = { uri: 'file:///KOT/own.feature', filePath: '/KOT/own.feature', version: 1, dirty: false, line: 4,
    text: '# language: en\nFeature: Own\nScenario: Own\n    And Delay "1"\n    And Delay "2"\n    And Delay "3"\n' };

test('selection creates a bounded feature containing only selected ordinary steps in authored order', () => {
    const selected = prepareVanessaSelection(source, 4, 5, definitions);
    assert.equal(selected.featureText, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And Delay 0\n    And Delay "2"\n    And Delay "3"\n');
    assert.deepEqual(selected.sourceLines, [4, 4, 5]);
});

test('YAML selection can run before compilation and refuses compiler or feature structure', () => {
    const yaml = { ...source, uri: 'file:///KOT/scen.yaml', filePath: '/KOT/scen.yaml', text: 'ТипФайла: "Сценарий"\nТекстСценария: |\n    # language: en\n    And Delay "1"\n    And Delay "2"\n' };
    assert.deepEqual(prepareVanessaSelection(yaml, 3, 4, definitions).sourceLines, [3, 4]);
    assert.throws(() => prepareVanessaSelection(source, 1, 4, definitions));
    assert.throws(() => prepareVanessaSelection(yaml, 0, 4, definitions));
    assert.throws(() => prepareVanessaSelection(source, 4, 3, definitions));
});

test('compiler-generated feature selection preserves tabs and does not need the step catalog', () => {
    const compiled = { ...source, text: '# language: en\nFeature: Own\nScenario: Own\n\t\t\t\tAnd Delay "1"\n\t\t\t\tAnd Delay "2"\n' };
    const trial = prepareVanessaSelection(compiled, 3, 4);
    assert.equal(trial.featureText, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n\t\t\t\tAnd Delay 0\n\t\t\t\tAnd Delay "1"\n\t\t\t\tAnd Delay "2"\n');
    assert.deepEqual(trial.sourceLines, [3, 3, 4]);
});

test('compiled selection enters before a subscenario call and preserves groups, comments and conditions', () => {
    const feature = { ...source, text: [
        '#language: en', '@tree', 'Feature: Compiled', 'Background:', '\tAnd preparation', 'Scenario: Own',
        '\tAnd I refill TestClient connections table', '\t*And I initialize main variables', '\t\t// Keep this comment',
        '\t\tIf "Flag" variable is equal to "Yes" Then', '\t\t\t\tAnd an expanded step', '\tAnd later', ''
    ].join('\r\n') };
    const block = prepareVanessaSelection(feature, 6, 10);
    assert.equal(block.lineNumber, 5);
    const runtimeLines = block.featureText.split('\n');
    assert.equal(runtimeLines[block.lineNumber - 1], '\tAnd Delay 0');
    assert.equal(runtimeLines[block.lineNumber], '\tAnd I refill TestClient connections table');
    assert.equal(runtimeLines.slice(5, -1).join('\r\n'), feature.text.split('\r\n').slice(6, 11).join('\r\n'));
    assert.match(block.featureText, /^# language: en\n@tree\n/u);
    assert.deepEqual(block.sourceLines, [6, 6, 7, 8, 9, 10]);

    for (const start of [7, 9]) {
        const nested = prepareVanessaSelection(feature, start, 10);
        assert.equal(nested.lineNumber, 5);
        const indent = start === 7 ? '\t' : '\t\t';
        assert.equal(nested.featureText.split('\n')[4], `${indent}And Delay 0`);
        assert.equal(nested.featureText.split('\n').slice(5, -1).join('\r\n'), feature.text.split('\r\n').slice(start, 11).join('\r\n'));
        assert.equal(nested.sourceLines.at(-1), 10);
    }
});

test('complete feature selection includes a full step payload and stays inside its original scenario', () => {
    const feature = { ...source, text: ['Feature: Own', 'Scenario: First', '    And a table', '        | First |', '        | Second |',
        '    And a multiline value', '        """', '        Scenario: plain string', '        """', 'Scenario: Second', '    And later'].join('\n') };
    assert.deepEqual(prepareVanessaSelection(feature, 2, 8).sourceLines, [2, 2, 3, 4, 5, 6, 7, 8]);
    for (const [start, end] of [[2, 3], [3, 5], [5, 7], [7, 8]]) {
        assert.throws(() => prepareVanessaSelection(feature, start, end));
    }
    assert.throws(() => prepareVanessaSelection(feature, 5, 10), /inside the scenario text/u);
    assert.throws(() => prepareVanessaSelection({ ...feature, text: feature.text.replace('First |', '<Value> |') }, 2, 4), /substitution/u);
});
