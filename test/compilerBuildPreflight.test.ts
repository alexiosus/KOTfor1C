import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCompilerBuildPreflightIssues, type CompilerBuildPreflightSource } from '../src/compilerBuildPreflight';

function parameterSection(section: string, parameters: readonly { name: string; value: string; type?: string; raw?: string }[]) {
    return `${section}:\n` + parameters.map((parameter, index) => `    - ${section}${index + 1}:\n        Имя: ${JSON.stringify(parameter.name)}\n        Значение: ${parameter.raw ?? JSON.stringify(parameter.value)}\n        ТипПараметра: ${JSON.stringify(parameter.type ?? 'Строка')}\n`).join('');
}
function descriptor(kind: 'Сценарий' | 'Процесс', uid: string, values: Parameters<typeof parameterSection>[1] = []): CompilerBuildPreflightSource {
    return { uri: `file:///repo/${uid}.yaml`, text: `ТипФайла: "${kind}"\n${kind === 'Процесс' ? 'ДанныеПроцесса' : 'ДанныеСценария'}:\n    UID: "${uid}"\n    Имя: "${uid}"\n` + parameterSection('ПараметрыСценария', values) };
}
function settings(kind: 'НастройкаТеста' | 'НастройкаПроцесса', uid: string, values: Parameters<typeof parameterSection>[1] = [], suffix = ''): CompilerBuildPreflightSource {
    return { uri: `file:///repo/${uid}-settings.yaml`, text: `ТипФайла: "${kind}"\nДанныеТеста:\n    UID: "${uid}-settings"\n    ${kind === 'НастройкаПроцесса' ? 'UIDПроцесса' : 'UIDСценария'}: "${uid}"\n${suffix}` + parameterSection('ПараметрыТеста', values) };
}
const values = (count: number) => Array.from({ length: count }, (_, index) => String(index)).join(';');
const issues = (sources: readonly CompilerBuildPreflightSource[], parameters: Parameters<typeof collectCompilerBuildPreflightIssues>[0] = []) => collectCompilerBuildPreflightIssues(parameters, sources);

test('build value errors are composed even when no compiler sources were selected', () => {
    assert.ok(issues([], [{ key: 'CreateJson', value: 'perhaps' }]).some(issue => issue.parameter === 'CreateJson' && issue.severity === 'error'));
});

test('an explicitly selected process without launch settings warns instead of silently promising its own artifact', () => {
    const child = descriptor('Процесс', 'child'); const parent = descriptor('Процесс', 'parent');
    const sources = [child, parent, settings('НастройкаПроцесса', 'parent')];
    const result = collectCompilerBuildPreflightIssues([], sources, [child.uri, parent.uri]);
    assert.deepEqual(result.filter(issue => issue.code === 'missingRootProcessSettings').map(issue => ({ uri: issue.uri, severity: issue.severity })),
        [{ uri: child.uri, severity: 'warning' }]);
    assert.equal(collectCompilerBuildPreflightIssues([], sources, [parent.uri]).some(issue => issue.code === 'missingRootProcessSettings'), false);
});

test('preflight ignores unrelated YAML, native features and project metadata', () => {
    assert.deepEqual(issues([
        { uri: 'file:///repo/bases.yaml', text: 'ЭталонныеБД:\n    broken: [\n' },
        { uri: 'file:///repo/.kot/groups/smoke.yml', text: 'ТипФайла: "Сценарий"\nДанныеСценария: [' },
        { uri: 'file:///repo/scen.yaml.kot.yml', text: 'ТипФайла: "Сценарий"\nДанныеСценария: [' },
        { uri: 'file:///repo/native.feature', text: 'ТипФайла: "Сценарий"\nДанныеСценария: [' }
    ]), []);
});

test('invalid compiler YAML blocks preflight while intentional legacy escapes remain accepted', () => {
    const invalid = { uri: 'file:///repo/broken.yaml', text: 'ТипФайла: "Процесс"\nДанныеПроцесса:\n\tUID: "broken"\n' };
    assert.ok(issues([invalid]).some(issue => issue.code === 'invalidYaml' && issue.severity === 'error' && issue.uri === invalid.uri));
    const valid = descriptor('Сценарий', 'legacy', [{ name: 'Currency', value: '', raw: '"EUR\\;GBP"' }]);
    assert.equal(issues([valid, settings('НастройкаТеста', 'legacy')]).some(issue => issue.severity === 'error'), false);
});

test('unsupported descriptor kinds are rejected without warning about unrelated general YAML', () => {
    const source = descriptor('Сценарий', 'unsupported');
    source.text = source.text.replace('"Сценарий"', '"СценарийШаблон"');
    assert.ok(issues([source]).some(issue => issue.code === 'unsupportedKind' && issue.severity === 'error'));
    assert.deepEqual(issues([{ uri: 'file:///repo/config.yaml', text: 'ТипФайла: "Configuration"\nSettings: "value"\n' }]), []);
});

test('format warnings summarize counts and affected lines once per selected URI', () => {
    const source = { uri: 'file:///repo/format.yml', text: 'ТипФайла: Сценарий\nДанныеСценария:\n  UID: alpha\n  Имя: Alpha # retained\n' };
    const result = issues([source, { ...source }]);
    const format = result.filter(issue => issue.code === 'compilerFormat');
    assert.equal(format.length, 1);
    assert.equal(format[0].severity, 'warning');
    assert.equal(format[0].uri, source.uri);
    assert.ok(Number(format[0].messageArgs?.[0]) >= 5);
    assert.deepEqual(format[0].messageArgs?.slice(1), [3, '1, 3, 4']);
});

test('scenario limit uses selected settings overrides and merges only missing defaults', () => {
    const scenario = descriptor('Сценарий', 'main', [{ name: 'A', value: values(7) }, { name: 'B', value: values(15) }]);
    const selected = settings('НастройкаТеста', 'main');
    const limit = issues([scenario, selected]).find(issue => issue.code === 'variantLimit');
    assert.equal(limit?.uri, selected.uri);
    assert.equal(limit?.severity, 'error');
    assert.deepEqual(limit?.messageArgs, ['105', 100]);
    assert.equal(issues([scenario, settings('НастройкаТеста', 'main', [{ name: 'B', value: '' }])]).some(issue => issue.code === 'variantLimit'), false);
    assert.equal(issues([scenario, settings('НастройкаТеста', 'main', [{ name: 'A', value: values(10) }, { name: 'B', value: values(10) }])]).some(issue => issue.code === 'variantLimit'), false);
});

test('unselected nested definitions do not trigger root limit or process defaults warnings', () => {
    const nested = descriptor('Сценарий', 'nested', [{ name: 'Huge', value: values(101) }]);
    const process = descriptor('Процесс', 'subprocess', [{ name: 'Huge', value: values(101) }]);
    assert.equal(issues([nested, process]).some(issue => ['variantLimit', 'processMissingDefaults', 'processMultipleValues'].includes(issue.code)), false);
});

test('process limit counts settings values without adding process defaults and preserves empty overrides', () => {
    const process = descriptor('Процесс', 'process', [{ name: 'Declared', value: values(101) }]);
    const selected = settings('НастройкаПроцесса', 'process', [{ name: 'Declared', value: '' }]);
    assert.deepEqual(issues([process, selected]), []);
    const many = settings('НастройкаПроцесса', 'process', [{ name: 'Declared', value: values(101) }]);
    assert.deepEqual(issues([process, many]).find(issue => issue.code === 'variantLimit')?.messageArgs, ['101', 100]);
});

test('root process defaults absent from selected settings warn individually without filling explicit blanks', () => {
    const process = descriptor('Процесс', 'flow', [{ name: 'Currency', value: 'USD' }, { name: 'Country', value: 'US' }]);
    const selected = settings('НастройкаПроцесса', 'flow', [{ name: 'Currency', value: '' }]);
    const missing = issues([process, selected]).filter(issue => issue.code === 'processMissingDefaults');
    assert.deepEqual(missing.map(issue => [issue.uri, issue.parameter]), [[selected.uri, 'Country']]);
});

test('process route warns about ExceptionTags, ignored disabled settings and unexpanded scalar lists only', () => {
    const process = descriptor('Процесс', 'flow');
    const selected = settings('НастройкаПроцесса', 'flow', [
        { name: 'Currency', value: 'EUR;GBP' }, { name: 'Escaped', value: '', raw: '"EUR\\;GBP"' },
        { name: 'Table', value: 'EUR;GBP', type: 'Таблица' }
    ], '    Выключена: "Да"\n');
    const result = issues([process, selected], [{ key: 'ExceptionTags', value: '@skip' }]);
    assert.ok(result.some(issue => issue.code === 'processExceptionTags' && issue.parameter === 'ExceptionTags' && issue.uri === selected.uri));
    assert.ok(result.some(issue => issue.code === 'processDisabledIgnored' && issue.uri === selected.uri));
    assert.deepEqual(result.filter(issue => issue.code === 'processMultipleValues').map(issue => issue.parameter), ['Currency']);
    assert.equal(result.some(issue => issue.code === 'variantLimit'), false);
});

test('settings match the correct UID field and reject missing or ambiguous root definitions', () => {
    const processSettings = settings('НастройкаПроцесса', 'same');
    const scenario = descriptor('Сценарий', 'same');
    assert.ok(issues([scenario, processSettings]).some(issue => issue.code === 'missingSettingsSource' && issue.uri === processSettings.uri));
    const duplicate = descriptor('Процесс', 'same');
    assert.ok(issues([duplicate, { ...duplicate, uri: 'file:///repo/copied.yaml' }, processSettings]).some(issue => issue.code === 'ambiguousSettingsSource' && issue.uri === processSettings.uri));
    const wrongLink = { ...processSettings, text: processSettings.text.replace('UIDПроцесса:', 'UIDСценария:') };
    assert.ok(issues([duplicate, wrongLink]).some(issue => issue.code === 'missingSettingsSource'));
});

test('scenario settings disabled by the supplied compiler do not contribute variants', () => {
    const scenario = descriptor('Сценарий', 'main', [{ name: 'Huge', value: values(101) }]);
    assert.equal(issues([scenario, settings('НастройкаТеста', 'main', [], '    Выключена: "Да"\n')]).some(issue => issue.code === 'variantLimit'), false);
});

test('preflight leaves source text and build parameters untouched', () => {
    const source = descriptor('Процесс', 'immutable', [{ name: 'Currency', value: 'USD' }]);
    const selected = settings('НастройкаПроцесса', 'immutable', [{ name: 'Currency', value: 'EUR;GBP' }]);
    const parameters = [{ key: 'ExceptionTags', value: 'tag' }];
    const sources = [source, selected];
    const before = JSON.stringify([parameters, sources]);
    issues(sources, parameters);
    assert.equal(JSON.stringify([parameters, sources]), before);
});

function withHeader(source: CompilerBuildPreflightSource, section: string, fields: readonly [string, string][]): CompilerBuildPreflightSource {
    return { ...source, text: source.text.replace(`${section}:\n`, `${section}:\n${fields.map(([key, value]) => `    ${key}: ${JSON.stringify(value)}\n`).join('')}`) };
}
function withTags(source: CompilerBuildPreflightSource, section: string, tags: readonly string[]): CompilerBuildPreflightSource {
    return { ...source, text: source.text + `${section}:\n${tags.map((tag, index) => `    - ${section}${index + 1}:\n        Имя: ${JSON.stringify(tag)}\n`).join('')}` };
}

test('scenario settings and scenario selectors use OR unless ScenarioFilterHasPriority is true', () => {
    const root = withHeader(descriptor('Сценарий', 'root', [{ name: 'Many', value: values(101) }]), 'ДанныеСценария', [['Код', 'scenario-code']]);
    const selected = withHeader(settings('НастройкаТеста', 'root'), 'ДанныеТеста', [['Код', 'selected-code']]);
    const filters = [{ key: 'ScenarioSettingsFilter', value: 'selected-code' }, { key: 'ScenarioFilter', value: 'other' }];
    assert.ok(issues([root, selected], filters).some(issue => issue.code === 'variantLimit'));
    assert.equal(issues([root, selected], [...filters, { key: 'ScenarioFilterHasPriority', value: 'True' }]).some(issue => issue.code === 'variantLimit'), false);
    assert.ok(issues([root, selected], [{ key: 'UIDScenarioSettingsFilter', value: 'root-settings' }]).some(issue => issue.code === 'variantLimit'));
    assert.equal(issues([root, selected], [{ key: 'ScenarioSettingsFilter', value: 'other' }]).some(issue => issue.code === 'variantLimit'), false);
});

test('process settings keep OR selection without ScenarioFilter priority and ProcessFilter uses full code', () => {
    const root = withHeader(descriptor('Процесс', 'flow'), 'ДанныеПроцесса', [['Код', 'short'], ['ПолныйКод', 'flow-full']]);
    const selected = withHeader(settings('НастройкаПроцесса', 'flow', [{ name: 'Many', value: values(101) }]), 'ДанныеТеста', [['Код', 'selected-code']]);
    assert.ok(issues([root, selected], [{ key: 'ProcessSettingsFilter', value: 'selected-code' }, { key: 'ScenarioFilter', value: 'other' }, { key: 'ScenarioFilterHasPriority', value: 'True' }]).some(issue => issue.code === 'variantLimit'));
    assert.equal(issues([root, selected], [{ key: 'ProcessFilter', value: 'short' }]).some(issue => issue.code === 'variantLimit'), false);
    assert.ok(issues([root, selected], [{ key: 'ProcessFilter', value: 'flow-full' }]).some(issue => issue.code === 'variantLimit'));
});

test('nested scenario code selection selects the parent setting without testing nested defaults as independent roots', () => {
    const child = withHeader(descriptor('Сценарий', 'child', [{ name: 'NestedOnly', value: values(101) }]), 'ДанныеСценария', [['Код', 'child-code']]);
    const parent = withHeader(descriptor('Сценарий', 'parent'), 'ДанныеСценария', [['Код', 'parent-code']]);
    const linked = { ...parent, text: parent.text + 'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        UIDВложенныйСценарий: "child"\n' };
    assert.equal(issues([linked, child, settings('НастройкаТеста', 'parent')], [{ key: 'ScenarioFilter', value: 'child-code' }]).some(issue => issue.code === 'variantLimit'), false);
});

test('tag and model database gates apply after selector OR, with ExceptionTags only excluding scenarios', () => {
    const scenario = withTags(descriptor('Сценарий', 'main', [{ name: 'Many', value: values(101) }]), 'ТегиСценария', ['Smoke', 'Skip']);
    const selected = withHeader(settings('НастройкаТеста', 'main'), 'ДанныеТеста', [['Код', 'run'], ['ИдентификаторБазы', 'DB1']]);
    assert.equal(issues([scenario, selected], [{ key: 'ScenarioSettingsFilter', value: 'run' }, { key: 'FilterTags', value: 'other' }]).some(issue => issue.code === 'variantLimit'), false);
    assert.equal(issues([scenario, selected], [{ key: 'ExceptionTags', value: 'skip' }]).some(issue => issue.code === 'variantLimit'), false);
    assert.equal(issues([scenario, selected], [{ key: 'ModelDBid', value: 'db2' }]).some(issue => issue.code === 'variantLimit'), false);
    assert.ok(issues([scenario, selected], [{ key: 'ModelDBid', value: 'db2; db1' }, { key: 'FilterTags', value: 'smoke' }]).some(issue => issue.code === 'variantLimit'));
    const process = withTags(descriptor('Процесс', 'flow'), 'ТегиПроцесса', ['Skip']);
    const processSettings = settings('НастройкаПроцесса', 'flow', [{ name: 'Many', value: values(101) }]);
    assert.ok(issues([process, processSettings], [{ key: 'ExceptionTags', value: 'skip' }]).some(issue => issue.code === 'variantLimit'));
});

test('ExceptScenario excludes the root code with unconditional priority, and tag tokens are not trimmed', () => {
    const root = withTags(withHeader(descriptor('Сценарий', 'main', [{ name: 'Many', value: values(101) }]), 'ДанныеСценария', [['Код', 'root-code']]), 'ТегиСценария', ['Smoke']);
    const selected = withHeader(settings('НастройкаТеста', 'main'), 'ДанныеТеста', [['Код', 'run']]);
    assert.equal(issues([root, selected], [{ key: 'ScenarioSettingsFilter', value: 'run' }, { key: 'ExceptScenario', value: 'root-code' }]).some(issue => issue.code === 'variantLimit'), false);
    assert.equal(issues([root, selected], [{ key: 'FilterTags', value: 'other; Smoke' }]).some(issue => issue.code === 'variantLimit'), false);
});

test('unadapted nested-process definition filters warn without assuming successful compiler traversal', () => {
    const child = withHeader(descriptor('Процесс', 'child'), 'ДанныеПроцесса', [['ПолныйКод', 'child-full']]);
    const parent = { ...descriptor('Процесс', 'parent'), text: descriptor('Процесс', 'parent').text
        + 'ШагиПроцесса:\n    - ШагиПроцесса1:\n        ТипШага: "1"\n        ВложенныйПроцессUID: "child"\n' };
    const selected = withHeader(settings('НастройкаПроцесса', 'parent', [{ name: 'Many', value: values(101) }]), 'ДанныеТеста', [['Код', 'parent-settings']]);
    const unadapted = issues([parent, child, selected], [{ key: 'ProcessFilter', value: 'child-full' }]);
    assert.ok(unadapted.some(issue => issue.code === 'processFilterTraversalUnavailable' && issue.severity === 'warning'));
    assert.equal(unadapted.some(issue => issue.code === 'variantLimit'), false);
    const adapted = issues([parent, child, selected], [{ key: 'ProcessSettingsFilter', value: 'parent-settings' }]);
    assert.ok(adapted.some(issue => issue.code === 'variantLimit'));
    assert.equal(adapted.some(issue => issue.code === 'processFilterTraversalUnavailable'), false);
    const numericType = { ...parent, text: parent.text.replace('ТипШага: "1"', 'ТипШага: "01"') };
    assert.ok(issues([numericType, child, selected], [{ key: 'ProcessFilter', value: 'child-full' }])
        .some(issue => issue.code === 'processFilterTraversalUnavailable'));
});
