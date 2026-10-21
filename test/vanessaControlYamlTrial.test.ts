import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDefinitionView, normalizeProjectDefinitionTemplate, type ProjectDefinition } from '../src/projectDefinition';
import { prepareVanessaYamlTrial, VanessaYamlTrialControl } from '../src/vanessaControlYamlTrial';
import type { VanessaFeatureDocument } from '../src/vanessaControlFeature';

const definitions = (kind: ProjectDefinition['kind'] = 'builtInStep', template = 'And Delay "%1 seconds"') => createProjectDefinitionView('trial', [{
    id: 'delay', kind, template, normalizedTemplate: normalizeProjectDefinitionTemplate(template), language: 'en',
    sourceLabel: 'Vanessa fixture', parameters: template.includes('%1') ? [{ name: 'seconds', index: 0, source: 'quoted' }] : []
}]);
const source = (body: string, line = 3): VanessaFeatureDocument => ({ uri: 'file:///KOT/scen.yaml', filePath: '/KOT/scen.yaml',
    text: `Имя: Safe\nТекстСценария: |\n    #language: en\n${body}\n`, line, dirty: false, version: 1 });

test('a plain YAML step becomes one exact runtime step without copying surrounding calls', () => {
    const value = source('    And Delay 1\n    And Delay 2');
    const trial = prepareVanessaYamlTrial(value, definitions());
    assert.equal(trial.featureText, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And Delay 1\n');
    assert.equal(trial.lineNumber, 4);
    assert.deepEqual(trial.sourceLines, [3]);
});

test('decimal numeric arguments remain literal numbers rather than being mistaken for attachments', () => {
    assert.match(prepareVanessaYamlTrial(source('    And Delay 1.5'), definitions()).featureText, /And Delay 1\.5\n$/u);
});

test('a missing Vanessa catalog explains the prerequisite instead of misclassifying a known step', () => {
    const view = createProjectDefinitionView('unavailable', definitions('nestedScenario').all);
    assert.throws(() => prepareVanessaYamlTrial(source('    And Delay 1'), view), /Vanessa step catalog is unavailable/u);
});

test('table and docstring payloads retain exact text and source line offsets, including CRLF', () => {
    for (const payload of ['      | A | B |\n      | 1 | 2 |', '      """text/plain\n      literal text\n      """']) {
        const value = source(`    And a payload\n${payload}\n    And Delay 2`);
        const trial = prepareVanessaYamlTrial({ ...value, text: value.text.replace(/\n/gu, '\r\n') }, definitions('builtInStep', 'And a payload'));
        assert.equal(trial.featureText, `# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And a payload\n${payload}\n`);
        assert.deepEqual(trial.sourceLines, payload.startsWith('      |') ? [3, 4, 5] : [3, 4, 5, 6]);
    }
});

test('Gherkin indentation tabs inside the YAML scalar are normalized without changing tabs in argument values', () => {
    const value = source('    \tAnd a payload\n    \t\t| A\tB |');
    const trial = prepareVanessaYamlTrial(value, definitions('builtInStep', 'And a payload'));
    assert.equal(trial.featureText, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And a payload\n    \t| A\tB |\n');
    assert.deepEqual(trial.sourceLines, [3, 4]);
});

test('Russian YAML steps use Russian headers; mismatched and unsupported language tags are rejected', () => {
    const value = source('    И Пауза 1');
    const view = definitions('builtInStep', 'И Пауза "%1 seconds"');
    const russian = { ...value, text: value.text.replace('#language: en', '#language: ru') };
    assert.match(prepareVanessaYamlTrial(russian, view).featureText, /^# language: ru\nФункционал:/u);
    assert.throws(() => prepareVanessaYamlTrial(value, view), /language/u);
    assert.throws(() => prepareVanessaYamlTrial({ ...value, text: value.text.replace('#language: en', '#language: fr') }, view), /language/u);
});

test('nested/exported/user/unknown and ambiguous invocations require a compiler build', () => {
    const value = source('    And Delay 1');
    for (const kind of ['nestedScenario', 'exportScenario', 'userStep'] as const) {
        const view = createProjectDefinitionView('with-catalog', [...definitions(kind).all,
            { ...definitions('builtInStep', 'And another built-in step').all[0], id: 'other-built-in' }]);
        assert.throws(() => prepareVanessaYamlTrial(value, view), /ordinary Vanessa step/u);
    }
    assert.throws(() => prepareVanessaYamlTrial(source('    And Unknown step'), definitions()), /ordinary Vanessa step/u);
    const base = definitions().all[0];
    assert.throws(() => prepareVanessaYamlTrial(value, createProjectDefinitionView('ambiguous', [base, { ...base, id: 'other' }])), /ordinary Vanessa step/u);
});

test('compiler substitutions, outline values, file arguments and enclosing compiler blocks cannot be tried approximately', () => {
    for (const text of ['    And Delay [Wait]', '    And Delay <Wait>', '    And Delay "document.xlsx"', '    And Delay "sub/file"',
        '    If "x" = "y" Then\n        And Delay 1\n    EndIf']) {
        assert.throws(() => prepareVanessaYamlTrial(source(text, text.includes('If ') ? 4 : 3), definitions()));
    }
    assert.throws(() => prepareVanessaYamlTrial(source('    And a payload\n      | [Wait] |'), definitions('builtInStep', 'And a payload')), /substitution/u);
});

test('file-oriented steps with extensionless paths are rejected before relocating the runtime fragment', () => {
    assert.throws(() => prepareVanessaYamlTrial(source('    And file exists "README"'), definitions('builtInStep', 'And file exists "%1 file"')), /File and attachment/u);
});

test('headers, payload rows, unclosed docstrings and folded YAML scalars are not trial steps', () => {
    for (const value of [source('    And Delay 1', 0), source('    And a payload\n      | a |', 4),
        source('    And a payload\n      """\n      unclosed'), { ...source('    And Delay 1'), text: source('    And Delay 1').text.replace(': |', ': >') }]) {
        assert.throws(() => prepareVanessaYamlTrial(value, definitions('builtInStep', 'And a payload')));
    }
});

test('trial saves the native document, checks disk and selection after preparation, and rejects queued execution', async () => {
    let current = { ...source('    And Delay 1'), dirty: true }; let release!: () => void; let executions = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const control = new VanessaYamlTrialControl({ current: () => current, save: async () => { current = { ...current, dirty: false }; return true; },
        readText: async () => current.text, getDefinitions: async () => definitions(),
        materialize: async () => { await pending; return '/runtime/trial.feature'; },
        execute: async () => { executions++; } });
    const first = control.run();
    await assert.rejects(control.run(), /busy/u);
    current = { ...current, line: 4 }; release();
    await assert.rejects(first, /source or selection changed/u); assert.equal(executions, 0);
});

test('a trial uses the existing one-step boundary with complete feature bytes and never advances the YAML cursor', async () => {
    const current = source('    And Delay 1'); const calls: unknown[] = [];
    const control = new VanessaYamlTrialControl({ current: () => current, save: async () => true,
        readText: async () => '\uFEFF' + current.text.replace(/\n/gu, '\r\n'), getDefinitions: async () => definitions(),
        materialize: async trial => { calls.push(trial.sourceLines); return '/runtime/trial.feature'; },
        execute: async (file, trial, guard) => { calls.push(file, trial.lineNumber, trial.featureText, guard()); } });
    await control.run();
    assert.deepEqual(calls, [[3], '/runtime/trial.feature', 4, '# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n    And Delay 1\n', true]);
});
