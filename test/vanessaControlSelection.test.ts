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
    assert.equal(selected.featureText, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And Delay "2"\n    And Delay "3"\n');
    assert.deepEqual(selected.sourceLines, [4, 5]);
});

test('YAML selection can run before compilation and refuses compiler or feature structure', () => {
    const yaml = { ...source, uri: 'file:///KOT/scen.yaml', filePath: '/KOT/scen.yaml', text: 'ТипФайла: "Сценарий"\nТекстСценария: |\n    # language: en\n    And Delay "1"\n    And Delay "2"\n' };
    assert.deepEqual(prepareVanessaSelection(yaml, 3, 4, definitions).sourceLines, [3, 4]);
    assert.throws(() => prepareVanessaSelection(source, 1, 4, definitions));
    assert.throws(() => prepareVanessaSelection(yaml, 0, 4, definitions));
    assert.throws(() => prepareVanessaSelection(source, 4, 3, definitions));
});

test('compiler-generated feature tabs are normalized only in indentation before running a selection', () => {
    const compiled = { ...source, text: '# language: en\nFeature: Own\nScenario: Own\n\t\t\t\tAnd Delay "1"\n\t\t\t\tAnd Delay "2"\n' };
    const trial = prepareVanessaSelection(compiled, 3, 4, definitions);
    assert.equal(trial.featureText, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And Delay "1"\n    And Delay "2"\n');
    assert.deepEqual(trial.sourceLines, [3, 4]);
});
