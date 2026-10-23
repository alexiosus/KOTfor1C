import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { nestedExportDraft, nestedToExport, exportToNested, rewriteCallableCall } from '../src/scenarioCallableConversion';
import { parseExportScenarios } from '../src/exportScenarioParser';
import { collectCompilerFormatIssues } from '../src/compilerFormatDiagnostics';

const nested = ['ТипФайла: "Сценарий"', 'ДанныеСценария:', '    UID: "some-uid"', '    Имя: "Open order"',
    '    Код: "OPEN"', 'ПараметрыСценария:', '    - ПараметрыСценария1:', '        Имя: "Customer"',
    '        Значение: "Default customer"', '    - ПараметрыСценария2:', '        Имя: "Count"', '        Значение: "2"',
    'ВложенныеСценарии:', 'ТекстСценария: |', '    # language: en', '    # [Customer] is a comment',
    '    And I input "[Customer]"', '    And Delay [Count]', ''].join('\n');
const context = { sourceUri: 'file:///exports.feature', workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' as const };

test('nested export draft includes unused parameters and validates the entire signature', () => {
    const draft = nestedExportDraft(nested);
    assert.equal(draft.title, 'Open order "Customer" "Count"');
    assert.throws(() => nestedToExport(nested, 'Open "Customer"'), /Count/u);
    assert.throws(() => nestedToExport(nested, 'Open Customer "Count"'), /Customer/u);
    assert.throws(() => nestedToExport(nested, 'Open "Customer" "Count" "Other"'), /Other/u);
    assert.throws(() => nestedToExport(nested, 'Open "Customer" "Customer" "Count"'), /Duplicate/u);
    assert.throws(() => nestedToExport(nested, 'Open "Customer" "Count"\nGiven unsafe'), /single line/u);
});

test('nested to export maps only executable parameter references and accepts reordered arguments', () => {
    const result = nestedToExport(nested, 'Open "Count" for "Customer"');
    const parsed = parseExportScenarios(result.feature, context);
    assert.equal(parsed.definitions.length, 1);
    assert.deepEqual(parsed.definitions[0].parameters.map(item => item.name), ['Count', 'Customer']);
    assert.match(result.feature, /# \[Customer\] is a comment/u);
    assert.match(result.feature, /And I input "Customer"\n    And Delay "Count"/u);
    assert.deepEqual(result.parameters.map(item => item.name), ['Count', 'Customer']);
});

test('round trip retains UID, defaults and metadata while applying the new name and edited body', () => {
    const exported = nestedToExport(nested, 'Open "Count" for "Customer"');
    const reverse = exportToNested(exported.feature.replace('And Delay "Count"', 'And I wait "Count"'), 4, 'Another name', nested);
    const data = parseDocument(reverse.source).toJS();
    assert.equal(data.ДанныеСценария.UID, 'some-uid');
    assert.equal(data.ДанныеСценария.Имя, 'Another name');
    assert.equal(data.ПараметрыСценария[0].ПараметрыСценария1.Значение, 'Default customer');
    assert.match(data.ТекстСценария, /And I wait "\[Count\]"/u);
});

test('export to nested emits four-space SPPR metadata including sequence records and literal payloads', () => {
    const original = nested.replace('    Код: "OPEN"', '    Код: "OPEN"\n    Описание: |\n        First line\n          - literal payload');
    const feature = nestedToExport(original, 'Open "Customer" "Count"').feature.replace('@ExportScenarios', '@ExportScenarios @Common');
    for (const archived of [undefined, original]) {
        const result = exportToNested(feature, 4, 'Restored', archived).source;
        assert.deepEqual(collectCompilerFormatIssues(result, 'meta.yaml').filter(issue => issue.kind === 'indentation'), []);
        assert.match(result, /^    UID:/mu);
        assert.match(result, /^    - ПараметрыСценария1:/mu);
        assert.match(result, /^        Имя: ["']?Customer["']?$/mu);
        assert.match(result, /^    - ТегиСценария1:/mu);
        assert.match(result, /^        Имя: ["']?Common["']?$/mu);
        const parsed = parseDocument(result); assert.deepEqual(parsed.errors, []);
        if (archived) { assert.equal(parsed.toJS().ДанныеСценария.Описание, 'First line\n  - literal payload\n'); }
    }
});

test('export conversion extracts only selected scenario and maps arbitrary argument names to SPPR identifiers', () => {
    const text = '# language: en\n@ExportScenarios\nFeature: Shared\n\nScenario: Open "Customer name" as \'User\'\n    And I input "Customer name"\n    And I use \'User\'\n\nScenario: Other\n    And Delay 1\n';
    const result = exportToNested(text, 4, 'Nested name');
    assert.match(result.remaining, /Scenario: Other\n    And Delay 1/u);
    assert.doesNotMatch(result.remaining, /Scenario: Open/u);
    const data = parseDocument(result.source).toJS();
    assert.equal(data.ДанныеСценария.Имя, 'Nested name');
    assert.equal(data.ПараметрыСценария[0].ПараметрыСценария1.Имя, 'Customer_name');
    assert.match(data.ТекстСценария, /And I input "\[Customer_name\]"/u);
    assert.match(data.ТекстСценария, /And I use '\[User\]'/u);
});

test('unsafe SPPR constructs and outlines fail without emitting a partial conversion', () => {
    assert.throws(() => nestedToExport(nested.replace('Значение: "2"', 'Значение: "2"\n        ИсходящийПараметр: "Да"'), 'Open "Customer" "Count"'), /outgoing/iu);
    assert.throws(() => nestedToExport(nested.replace('Значение: "2"', 'Значение: "2"\n        ТипПараметра: "Таблица"'), 'Open "Customer" "Count"'), /table/iu);
    assert.throws(() => nestedToExport(nested.replace('And Delay [Count]', 'Do 3\n        And Delay [Count]\n    EndDo'), 'Open "Customer" "Count"'), /SPPR/iu);
    assert.throws(() => nestedToExport(nested.replace('"[Customer]"', '"prefix [Customer]"'), 'Open "Customer" "Count"'), /embedded/iu);
    assert.throws(() => nestedToExport(nested.replace('And Delay [Count]', 'And I use a table\n    | "[Count]" |'), 'Open "Customer" "Count"'), /table/iu);
    assert.throws(() => exportToNested('# language: en\n@ExportScenarios\nFeature: X\nScenario Outline: X <Name>\n    And Delay 1\nExamples:\n    | Name |\n    | A |\n', 3, 'X'), /outline/iu);
});

test('call rewriting preserves explicit arguments, defaults, comments and caller indentation', () => {
    const call = '    And Open order\n        Customer = "Actual"\n    # next\n    And Delay 1\n';
    const result = rewriteCallableCall(call, 0, { direction: 'export', oldTitle: 'Open order', title: 'Open "Count" for "Customer"',
        parameters: nestedExportDraft(nested).parameters });
    assert.equal(result, '    And Open "2" for "Actual"\n    # next\n    And Delay 1\n');
    assert.throws(() => rewriteCallableCall(call.replace('"Actual"', 'PreviousOutput'), 0, { direction: 'export', oldTitle: 'Open order', title: 'Open "Customer" "Count"', parameters: nestedExportDraft(nested).parameters }), /output/iu);
    const reverse = rewriteCallableCall('    And Open "A" for "Bob"\n', 0, { direction: 'nested', oldTitle: 'Open "Count" for "Customer"', title: 'Nested name',
        parameters: [{ name: 'Count', argument: 'Count', value: '' }, { name: 'Customer', argument: 'Customer', value: '' }] });
    assert.equal(reverse, '    And Nested name\n        Count = "A"\n        Customer = "Bob"\n');
});

test('caller parameter references and defaults survive conversion in both directions', () => {
    const parameters = nestedExportDraft(nested).parameters;
    const source = '    And Open order\n        Customer = [SelectedCustomer]\n';
    const exported = rewriteCallableCall(source, 0, { direction: 'export', oldTitle: 'Open order', title: 'Open "Count" for "Customer"', parameters });
    assert.equal(exported, '    And Open "2" for [SelectedCustomer]\n');
    const exportedParameters = nestedToExport(nested, 'Open "Count" for "Customer"').parameters;
    assert.equal(rewriteCallableCall(exported, 0, { direction: 'nested', oldTitle: 'Open "Count" for "Customer"', title: 'Restored', parameters: exportedParameters }),
        '    And Restored\n        Count = "2"\n        Customer = [SelectedCustomer]\n');
});

test('conversion preserves neighboring scenario tags and inherited tags without leaking them into the body', () => {
    const feature = '# language: en\n@ExportScenarios @Common\nFeature: Shared\n\n@First\nScenario: First "Name"\n    And I input "Name"\n\n@Second\nScenario: Second\n    And Delay 1\n';
    const result = exportToNested(feature, 5, 'Nested');
    assert.match(result.remaining, /@Second\nScenario: Second/u);
    assert.doesNotMatch(result.remaining, /@First/u);
    assert.doesNotMatch(parseDocument(result.source).toJS().ТекстСценария, /@Second/u);
    assert.deepEqual(parseDocument(result.source).toJS().ТегиСценария.map((record: Record<string, { Имя: string }>) => Object.values(record)[0].Имя), ['Common', 'First']);
});

test('Russian CRLF conversion and literal defaults retain their meaning', () => {
    const ru = nested.replace('# language: en', '# language: ru').replace('And I input', 'И я ввожу').replace('And Delay', 'И Пауза').replace(/\n/gu, '\r\n');
    const exported = nestedToExport(ru, 'Я открываю "Customer" "Count"');
    assert.match(exported.feature, /Сценарий: Я открываю/u);
    assert.equal(exported.feature.replace(/\r\n/gu, '').includes('\n'), false);
    const result = rewriteCallableCall('And Open\n', 0, { direction: 'export', oldTitle: 'Open', title: 'Open "Value"', parameters: [{ name: 'Value', argument: 'Value', value: '"quoted"' }] });
    assert.equal(result, 'And Open "\\"quoted\\""\n');
    assert.throws(() => nestedToExport(nested.replace('And Delay [Count]', 'And I use "Count"'), 'Open "Customer" "Count"'), /literal/u);
    assert.throws(() => rewriteCallableCall('And Open\n', 0, { direction: 'export', oldTitle: 'Open', title: 'Open "Value"', parameters: [{ name: 'Value', argument: 'Value', value: 'line1\nline2' }] }), /Multiline/u);
    assert.throws(() => rewriteCallableCall('And Open\n    Value = "Actual" # comment\n', 0, { direction: 'export', oldTitle: 'Open', title: 'Open "Value"', parameters: [{ name: 'Value', argument: 'Value', value: '' }] }), /complete quoted/u);
});
