import assert from 'node:assert/strict';
import test from 'node:test';
import {
    extractCompilerFeatureScenarioNames,
    extractCompilerFeatureScenarioUids,
    extractCompilerFeatureProcessUids,
    extractCompilerFeatureProcessCodes,
    findCompilerSourceLocation,
    parseCompileInventory,
    parseCompilerErrorXml,
    parseCompilerJUnit,
    parseCompilerSourceMap
} from '../src/compilerArtifacts';

// Hand-derived from ЗаписатьФайлДанныеСтрок and ЗаполнитьДанныеНомеровСтрок.
const sourceMapFixture = `{
    "ДанныеСценария": [
        {"Имя":"Продажа","Код":"SALE","Основной":true,"ТекстШага":"И создается продажа","СтрокаЛин":14,"СтрокаОриг":3,"УровеньВложенности":0,"UIDСценария":"sale-uid"},
        {"Имя":"Создать товар","Код":"ITEM","Основной":false,"ТекстШага":"И создан товар","СтрокаЛин":16,"СтрокаОриг":2,"УровеньВложенности":1,"UIDСценария":"item-uid"},
        {"Имя":"Оплата","Код":"PAY","Основной":true,"ТекстШага":"И оплачен документ","СтрокаЛин":31,"СтрокаОриг":1,"УровеньВложенности":0,"UIDСценария":"pay-uid"},
        {"Имя":"Продажа","Код":"SALE","Основной":true,"ТекстШага":"И завершена продажа","СтрокаЛин":35,"СтрокаОриг":4,"УровеньВложенности":0,"UIDСценария":"sale-uid"}
    ]
}`;

test('compiler map preserves exact one-based feature and source body locations', () => {
    const map = parseCompilerSourceMap(`\uFEFF${sourceMapFixture}`);
    assert.ok(map);
    assert.equal(map.entries.length, 4);
    assert.deepEqual(findCompilerSourceLocation(map, 16), {
        scenarioUid: 'item-uid', scenarioName: 'Создать товар', scenarioCode: 'ITEM',
        isMain: false, stepText: 'И создан товар', featureLineNumber: 16,
        sourceBodyLineNumber: 2, nestingLevel: 1
    });
});

test('every main UID shares a grouped artifact while nested UIDs stay out of membership', () => {
    assert.deepEqual(parseCompilerSourceMap(sourceMapFixture)?.mainScenarioUids, ['sale-uid', 'pay-uid']);
});

test('missing and malformed maps leave feature navigation available', () => {
    for (const content of [undefined, null, '', '{bad', 'null', '[]', '{"other": []}', '{"ДанныеСценария":{}}']) {
        assert.equal(parseCompilerSourceMap(content), null);
    }
    assert.deepEqual(parseCompilerSourceMap('{"ДанныеСценария":[]}'), { entries: [], mainScenarioUids: [] });
    assert.equal(findCompilerSourceLocation(null, 16), null);
    const map = parseCompilerSourceMap(sourceMapFixture);
    for (const line of [0, -1, 15, 16.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(findCompilerSourceLocation(map, line), null);
    }
});

test('invalid map rows are skipped without losing valid source mappings', () => {
    const map = parseCompilerSourceMap(JSON.stringify({ ДанныеСценария: [
        null,
        { UIDСценария: 'bad', Основной: true, СтрокаЛин: 0, СтрокаОриг: 1 },
        { UIDСценария: 'bad', Основной: true, СтрокаЛин: 1.5, СтрокаОриг: 1 },
        { UIDСценария: '', Основной: true, СтрокаЛин: 2, СтрокаОриг: 1 },
        { UIDСценария: 'bad', Основной: true, СтрокаЛин: 2, СтрокаОриг: -1 },
        { UIDСценария: 'valid', Основной: true, СтрокаЛин: '6', СтрокаОриг: '2', УровеньВложенности: '0' }
    ] }));
    assert.equal(map?.entries.length, 1);
    assert.equal(findCompilerSourceLocation(map, 6)?.sourceBodyLineNumber, 2);
    assert.deepEqual(map?.mainScenarioUids, ['valid']);
});

test('legacy long field names and primary flags remain navigable', () => {
    const map = parseCompilerSourceMap(JSON.stringify({ ДанныеНомеровСтрок: [
        { UIDСценария: 'legacy', ИмяСценария: 'Legacy', КодСценария: 'L', Основной: 'Истина',
            НомерСтрокиЛинейногоСценария: 8, НомерСтрокиТекстаСценария: 5, УровеньВложенности: 0 },
        { UIDСценария: 'nested', Основной: 'Ложь', НомерСтрокиЛинейногоСценария: 9,
            НомерСтрокиТекстаСценария: 1, УровеньВложенности: 1 }
    ] }));
    assert.equal(findCompilerSourceLocation(map, 8)?.scenarioName, 'Legacy');
    assert.deepEqual(map?.mainScenarioUids, ['legacy']);
});

test('ambiguous duplicate feature locations fall back unless a deepest nested source is identifiable', () => {
    const map = parseCompilerSourceMap(JSON.stringify({ ДанныеСценария: [
        { UIDСценария: 'outer', Основной: true, СтрокаЛин: 10, СтрокаОриг: 3, УровеньВложенности: 0 },
        { UIDСценария: 'inner', Основной: false, СтрокаЛин: 10, СтрокаОриг: 1, УровеньВложенности: 1 },
        { UIDСценария: 'a', Основной: true, СтрокаЛин: 20, СтрокаОриг: 1, УровеньВложенности: 0 },
        { UIDСценария: 'b', Основной: true, СтрокаЛин: 20, СтрокаОриг: 1, УровеньВложенности: 0 }
    ] }));
    assert.equal(findCompilerSourceLocation(map, 10)?.scenarioUid, 'inner');
    assert.equal(findCompilerSourceLocation(map, 20), null);
});

const groupedFeatureFixture = [
    '\uFEFF# language: ru', 'Функционал: Продажа', '',
    '@КодСценария=SALE', '@UIDСценария=sale-uid', '@UIDНастройкиСценария=sale-setting-uid',
    '@ИмяНастройкиСценария=Основная продажа', 'Сценарий: Основная продажа',
    '    И создается продажа', '    """', '@UIDСценария=docstring-uid',
    'Сценарий: Текст внутри шага', '    """', '',
    '@КодСценария=PAY', '@UIDСценария=pay-uid', '@UIDНастройкиСценария=pay-setting-uid',
    'Сценарий: Оплата', '    И оплачен документ',
    '    | @UIDСценария=table-uid |', '# @UIDСценария=comment-uid',
    '@UIDСценария=pay-uid', 'Сценарий: Оплата'
].join('\n');

test('grouped feature UID tags identify secondary scenarios even when their str rows are absent', () => {
    assert.deepEqual(extractCompilerFeatureScenarioUids(groupedFeatureFixture), ['sale-uid', 'pay-uid']);
});

test('feature names cover Russian and English headers without docstrings or comments', () => {
    assert.deepEqual(extractCompilerFeatureScenarioNames(groupedFeatureFixture), ['Продажа', 'Основная продажа', 'Оплата']);
    assert.deepEqual(extractCompilerFeatureScenarioNames('Feature: Checkout\nScenario: Card\n# Scenario: Comment'), ['Checkout', 'Card']);
    assert.deepEqual(extractCompilerFeatureScenarioNames(null), []);
    assert.deepEqual(extractCompilerFeatureScenarioUids(undefined), []);
});

test('process markers remain distinct from scenario and process-setting markers', () => {
    const feature = [
        '@UIDПроцесса=checkout-uid', '@UIDНастройкиПроцесса=setting-uid',
        '@ПолныйКодПроцесса=CHECKOUT', '@КодНастройкиПроцесса=checkout-settings',
        'Функциональность: Checkout', '@UIDСценария=sale-uid',
        '@КодПроцесса=CHECKOUT.NESTED', '    * Подпроцесс: Nested',
        '    """', '@UIDПроцесса=docstring-uid', '@ПолныйКодПроцесса=DOCSTRING', '    """',
        '# @UIDПроцесса=comment-uid', '    | @КодПроцесса=TABLE |'
    ].join('\n');
    assert.deepEqual(extractCompilerFeatureProcessUids(feature), ['checkout-uid']);
    assert.deepEqual(extractCompilerFeatureProcessCodes(feature), ['CHECKOUT']);
    assert.deepEqual(extractCompilerFeatureScenarioUids(feature), ['sale-uid']);
    assert.deepEqual(extractCompilerFeatureProcessUids(null), []);
    assert.deepEqual(extractCompilerFeatureProcessCodes(undefined), []);
});

test('compile.txt parses actual JSON inventory without treating attempted settings as passed tests', () => {
    const inventory = parseCompileInventory('\uFEFF{"scenario_tests":["sale","pay","sale"],"process_tests":["checkout"]}');
    assert.deepEqual(inventory, { scenarioSettingsCodes: ['sale', 'pay'], processSettingsCodes: ['checkout'] });
    assert.equal(Object.hasOwn(inventory!, 'success'), false);
});

test('empty and legacy compile inventories are accepted while malformed reports are ignored', () => {
    assert.deepEqual(parseCompileInventory('{"scenario_tests":[]}'), { scenarioSettingsCodes: [], processSettingsCodes: [] });
    assert.deepEqual(parseCompileInventory('{"scenario_tests":[null,3," valid "],"process_tests":[]}'), {
        scenarioSettingsCodes: ['valid'], processSettingsCodes: []
    });
    for (const content of [undefined, null, '', 'compiled successfully', '{bad', '{}', '{"scenario_tests":2}']) {
        assert.equal(parseCompileInventory(content), null);
    }
});

// Derived from СоздатьРезультатВФорматеJunit and ЗаписатьНабор, including suite properties.
const junitFixture = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="2" failures="1" errors="0" time="0.25">
 <testsuite name="Компиляция настройки сценария sale" tests="1" failures="0" errors="0" skipped="0" time="0.1">
  <properties><property name="scenario" value="SALE"/><property name="uid_scenario" value="sale-uid"/><property name="scenario_setting" value="sale"/></properties>
  <testcase classname="Компиляция настройки сценария sale" name="Настройка запуска сценария sale" time="0.1"/>
 </testsuite>
 <testsuite name="Компиляция настройки процесса checkout" tests="1" failures="1" errors="0" skipped="0" time="0.15">
  <properties><property name="process" value="CHECKOUT"/><property name="process_setting" value="checkout"/><property name="description" value="Сценарий &quot;Оплата&quot; не найден &amp; шаг не собран"/></properties>
  <testcase classname="Компиляция настройки процесса checkout" name="Настройка запуска процесса checkout" time="0.15">
   <failure type="" message="Подробная информация: &quot;Оплата&quot; &amp; шаг">Сценарий не найден &#x416;</failure>
  </testcase>
 </testsuite>
</testsuites>`;

test('compiler JUnit preserves settings identity, compile failures and XML entities', () => {
    const report = parseCompilerJUnit(junitFixture);
    assert.ok(report);
    assert.deepEqual(report.summary, { tests: 2, failures: 1, errors: 0, skipped: 0, timeSeconds: 0.25 });
    assert.equal(report.entries[0].status, 'passed');
    assert.equal(report.entries[0].properties.uid_scenario, 'sale-uid');
    assert.equal(report.entries[1].status, 'failed');
    assert.equal(report.entries[1].properties.process_setting, 'checkout');
    assert.equal(report.entries[1].message, 'Подробная информация: "Оплата" & шаг');
    assert.equal(report.entries[1].details, 'Сценарий не найден Ж');
});

test('JUnit handles single suites, infrastructure errors, skipped tests and CDATA', () => {
    const report = parseCompilerJUnit(`<testsuite name="Compile">
     <testcase name="Startup"><error><![CDATA[Cannot open <compiler> & client]]></error></testcase>
     <testcase name="Filtered" time="bad"><skipped/></testcase>
     <testcase name="Multiple"><failure message="First">Detail 1</failure><failure message="Second">Detail 2</failure></testcase>
    </testsuite>`);
    assert.ok(report);
    assert.deepEqual(report.summary, { tests: 3, failures: 2, errors: 1, skipped: 1, timeSeconds: 0 });
    assert.equal(report.entries[0].status, 'error');
    assert.equal(report.entries[0].details, 'Cannot open <compiler> & client');
    assert.equal(report.entries[1].status, 'skipped');
    assert.equal(report.entries[2].message, 'First\nSecond');
    assert.equal(report.entries[2].details, 'Detail 1\nDetail 2');
});

test('missing, truncated and unrelated XML reports never produce successful JUnit results', () => {
    for (const content of [undefined, null, '', '<testsuites>', '<testsuites><testcase/></wrong>',
        '<html><testcase/></html>', '<testsuite><testcase name="unfinished"/>',
        '<!DOCTYPE testsuite SYSTEM "file:///private/data"><testsuite/>']) {
        assert.equal(parseCompilerJUnit(content), null);
    }
    assert.deepEqual(parseCompilerJUnit('<testsuites tests="0"/>')?.summary, {
        tests: 0, failures: 0, errors: 0, skipped: 0, timeSeconds: 0
    });
});

// 1C СериализаторXDTO writes a Structure of Property/Value pairs. Location is moved
// into ОбъектыМетаданных by ТекстОшибкиXML before serialization.
const errorXmlFixture = `<?xml version="1.0" encoding="UTF-8"?>
<Structure xmlns="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <Property name="ВерсияФормата"><Value xsi:type="xs:string">1.7</Value></Property>
 <Property name="ТипОшибки"><Value xsi:type="xs:string">Ошибка компиляции сценария</Value></Property>
 <Property name="ИсходнаяИнформация"><Value xsi:type="xs:string">Не найден &lt;шаг&gt; &amp; сценарий</Value></Property>
 <Property name="ПорядокВоспроизведения"><Value xsi:type="xs:string">Собрать настройку sale</Value></Property>
 <Property name="КодСценария"><Value xsi:type="xs:string">SALE</Value></Property>
 <Property name="КодНастройкиСценария"><Value xsi:type="xs:string">sale</Value></Property>
 <Property name="КодПроцесса"><Value xsi:nil="true"/></Property>
 <Property name="КодНастройкиПроцесса"><Value xsi:nil="true"/></Property>
 <Property name="ОбъектыМетаданных"><Value xsi:type="Array">
  <Value xsi:type="Structure"><Property name="ОбъектМетаданных"><Value xsi:type="xs:string"/></Property>
   <Property name="УточнениеРасположения"><Value xsi:type="xs:string">Шаг не собран</Value></Property>
  </Value>
 </Value></Property>
</Structure>`;

test('SPPR compiler error XML resolves nested XDTO location and original setting codes', () => {
    const report = parseCompilerErrorXml(errorXmlFixture);
    assert.ok(report);
    assert.equal(report.message, 'Шаг не собран');
    assert.equal(report.details, 'Не найден <шаг> & сценарий');
    assert.equal(report.errorType, 'Ошибка компиляции сценария');
    assert.equal(report.reproductionSteps, 'Собрать настройку sale');
    assert.equal(report.scenarioCode, 'SALE');
    assert.equal(report.scenarioSettingsCode, 'sale');
    assert.equal(report.processCode, '');
    assert.equal(report.processSettingsCode, '');
    assert.equal(report.properties.ВерсияФормата, '1.7');
});

test('namespaced XDTO elements and legacy direct fields are read without HTML casing assumptions', () => {
    const namespaced = parseCompilerErrorXml('<v8:Structure xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:Property name="ТипОшибки"><v8:Value>Ошибка</v8:Value></v8:Property><v8:Property name="ИсходнаяИнформация"><v8:Value><![CDATA[Сбой <шага>]]></v8:Value></v8:Property></v8:Structure>');
    assert.equal(namespaced?.details, 'Сбой <шага>');
    const legacy = parseCompilerErrorXml('<Ошибка><ТипОшибки>Ошибка процесса</ТипОшибки><УточнениеРасположения>Процесс &quot;Checkout&quot;</УточнениеРасположения><КодПроцесса>CHECKOUT</КодПроцесса><КодНастройкиПроцесса>checkout</КодНастройкиПроцесса></Ошибка>');
    assert.equal(legacy?.message, 'Процесс "Checkout"');
    assert.equal(legacy?.processCode, 'CHECKOUT');
    assert.equal(legacy?.processSettingsCode, 'checkout');
});

test('missing or malformed SPPR error reports are ignored', () => {
    for (const content of [undefined, null, '', '<Structure>', '<Structure><Property name="ТипОшибки"></Structure>',
        '<Structure><Property name="unrelated"><Value>Ignore</Value></Property></Structure>', '<testsuites/>']) {
        assert.equal(parseCompilerErrorXml(content), null);
    }
});

test('malformed numeric JUnit counters fall back to parsed cases while decimal durations survive', () => {
    const report = parseCompilerJUnit('<testsuite name="Compile" tests="1.5" failures="-1" errors="bad" skipped="NaN" time="0.25"><testcase name="Failed"><failure message="Broken &gt; step">Failure</failure></testcase></testsuite>');
    assert.deepEqual(report?.summary, { tests: 1, failures: 1, errors: 0, skipped: 0, timeSeconds: 0.25 });
});

test('malformed XML attributes and undefined entities cannot turn a broken report into passing cases', () => {
    for (const content of [
        '<testsuite><testcase name="a" name="b"/></testsuite>',
        '<testsuite><testcase name="a"time="0"/></testsuite>',
        '<testsuite><testcase name="a & broken"/></testsuite>',
        '<testsuite><testcase name="a &custom;"/></testsuite>',
        '<testsuite><testcase name="a &#0;"/></testsuite>'
    ]) {
        assert.equal(parseCompilerJUnit(content), null);
    }
    assert.equal(parseCompilerJUnit('<testsuite name="A &gt; B"><testcase name="&apos;case&apos;"/></testsuite>')?.entries[0].name, "'case'");
});
