import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExportScenarios } from '../src/exportScenarioParser';
import { createProjectDefinitionView } from '../src/projectDefinition';
import { prepareVanessaResultSources } from '../src/vanessaControlStepSources';
import { mapVanessaStepResults } from '../src/vanessaControlStepResults';

const uri = 'file:///KOT/library.feature';
const exports_ = (body: string) => '# language: en\n@ExportScenarios\nFeature: Library\n' + body;
const view = (text: string) => createProjectDefinitionView('exports', parseExportScenarios(text, {
    sourceUri: uri, workspaceFolderUri: 'file:///KOT', profileId: '', libraryRootUri: 'file:///KOT', sourceLabel: 'Library', defaultLanguage: 'en'
}).definitions);
const feature = (steps: string) => '# language: en\nFeature: Test\nScenario: Test\n' + steps;

test('saved export arguments map native child results back to the call and invalidate after a library edit', async () => {
    let saved = exports_('Scenario: I remember workshop message "Message"\n  And I save "Message" in "WorkshopMessage" variable\n');
    const source = feature('  And I remember workshop message "Native source is ready"\n');
    let reads = 0;
    const result = await prepareVanessaResultSources(source, view(saved), async () => { reads++; return saved; });
    assert.deepEqual(result?.steps, [{ lineNumber: 4, text: 'And I save "Native source is ready" in "WorkshopMessage" variable' }]);
    assert.equal(reads, 1);
    assert.equal(await result?.isCurrent(), true);
    saved = saved.replace('WorkshopMessage', 'OtherVariable');
    assert.equal(await result?.isCurrent(), false);
});

test('nested exports aggregate every child and preserve repeated call occurrences', async () => {
    const saved = exports_('Scenario: remember "Message"\n  And store "Message"\n  And verify "Message"\n' +
        'Scenario: store "Value"\n  And save "Value"\n');
    const source = feature('  And remember "A"\n  And remember "A"\n');
    const result = await prepareVanessaResultSources(source, view(saved), async () => saved);
    assert.deepEqual(result?.steps, [
        { lineNumber: 4, text: 'And save "A"' }, { lineNumber: 4, text: 'And verify "A"' },
        { lineNumber: 5, text: 'And save "A"' }, { lineNumber: 5, text: 'And verify "A"' }
    ]);
    const reply = { content: [{ type: 'text', text: '# Результаты тестов\n\n## Шаги (4)\n' +
        ['And save "A"', 'And verify "A"', 'And save "A"', 'And verify "A"'].map((step, index) => `${index + 1}. ${step} → **Success**`).join('\n') }] };
    assert.deepEqual(mapVanessaStepResults(reply, source, 1, undefined, result?.steps), [
        { lineNumber: 4, status: 'passed' }, { lineNumber: 5, status: 'passed' }
    ]);
});

test('docstring contents are not executable export steps', async () => {
    const saved = exports_('Scenario: remember "Message"\n  And save "Message"\n    """\n    And imaginary step\n    """\n');
    const result = await prepareVanessaResultSources(feature('  And remember "A"\n'), view(saved), async () => saved);
    assert.deepEqual(result?.steps, [{ lineNumber: 4, text: 'And save "A"' }]);
});

test('cyclic, dynamic, stale or ambiguous export bodies cannot prove a passed call', async () => {
    for (const body of [
        'Scenario: remember "Message"\n  And remember "Message"\n',
        'Scenario: remember "Message"\n  If "condition" Then\n    And save "Message"\n  EndIf\n',
        'Scenario: remember "Message"\n  And save "Message"\nScenario: remember "Message"\n  And other\n'
    ]) {
        const saved = exports_(body);
        assert.equal(await prepareVanessaResultSources(feature('  And remember "A"\n'), view(saved), async () => saved), undefined);
    }
    const saved = exports_('Scenario: remember "Message"\n  And save "Message"\n');
    assert.equal(await prepareVanessaResultSources(feature('  And remember "A"\n'), view(saved), async () => saved.replace('Scenario: remember', 'Scenario: renamed')), undefined);
});
