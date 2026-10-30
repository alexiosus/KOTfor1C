import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseVanessaParameterSources } from '../src/vanessaParameterParser';
import { applyAdditionalVanessaParameters, getVanessaParameterAliases } from '../src/vanessaLaunchJson';
import { createVanessaParameterFieldDefinitions, loadVanessaParameterCatalogSnapshot } from '../src/vanessaParameterCatalog';
import { VANESSA_PARAMETER_CATALOG } from '../src/vanessaParameterCatalog.generated';

test('catalog parser extracts root and nested settings, aliases and literal defaults without executing BSL', () => {
    const object = `Функция СтруктураОбщихНастроек() Экспорт
Настройки = Новый Структура;
Настройки.Вставить("Enabled", Истина);
Группа = Новый Структура;
Группа.Вставить("Пауза", 10);
Группа.Вставить("Текст", "a""b");
Группа.Вставить("Массив", Новый Массив);
Группа.Вставить("NoDefault");
Настройки.Вставить("Выполнение", Группа);
// Настройки.Вставить("Commented", Ложь);
Возврат Настройки;
КонецФункции
Настройки.Вставить("Unrelated", Ложь);`;
    const form = `Функция ТаблицаИменаКлючейОбщихНастроек()
ТаблицаИменНоваяСтрока("Выполнение", "Execution", ТаблицаИмен, НижнийРегистр);
ТаблицаИменНоваяСтрока("Пауза", "Delay", ТаблицаИмен, НижнийРегистр);
КонецФункции`;
    const values = parseVanessaParameterSources(object, form);
    assert.equal(values.find(row => row.key === 'Enabled')?.value, 'true');
    assert.equal(values.find(row => row.key === 'Enabled')?.valueKind, 'boolean');
    assert.deepEqual(values.find(row => row.key === 'Выполнение.Пауза')?.aliases, ['Execution.Delay']);
    assert.equal(values.find(row => row.key === 'Выполнение.Пауза')?.value, '10');
    assert.equal(values.find(row => row.key === 'Выполнение.Пауза')?.valueKind, 'number');
    assert.equal(values.find(row => row.key === 'Выполнение.Текст')?.value, 'a"b');
    assert.equal(values.find(row => row.key === 'Выполнение.Текст')?.valueKind, 'string');
    assert.equal(values.find(row => row.key === 'Выполнение.Массив')?.value, '[]');
    assert.equal(values.find(row => row.key === 'Выполнение.Массив')?.valueKind, 'array');
    assert.equal(values.find(row => row.key === 'Выполнение')?.valueKind, 'object');
    assert.equal(values.find(row => row.key === 'Выполнение.NoDefault')?.value, '');
    assert.equal(values.find(row => row.key === 'Выполнение.NoDefault')?.valueKind, 'unknown');
    assert.equal(values.some(row => /Commented|Unrelated/u.test(row.key)), false);
});

test('generated alias catalog recognizes helper setting and respects an explicit false in launch JSON', () => {
    assert.ok(getVanessaParameterAliases('ShowHelperOnFirstLaunch').includes('ПоказыватьПомощникПриПервомЗапуске'));
    const result = applyAdditionalVanessaParameters({ useaddin: false }, [
        { key: 'ИспользоватьКомпонентуVanessaExt', value: 'true', overrideExisting: false }
    ]);
    assert.deepEqual(result.value, { useaddin: false });
});

test('source aliases and older launch aliases form one connected identity', () => {
    assert.ok(getVanessaParameterAliases('vanessarun').includes('ExecuteScenarios'));
    const result = applyAdditionalVanessaParameters({ ExecuteScenarios: false }, [
        { key: 'vanessarun', value: 'true', overrideExisting: true }
    ]);
    assert.deepEqual(result.value, { ExecuteScenarios: true });
});

test('field metadata covers stored aliases, nested values and primitive kinds without inferring from user values', () => {
    const definitions = createVanessaParameterFieldDefinitions(VANESSA_PARAMETER_CATALOG);
    assert.equal(definitions.find(item => item.keys.includes('ShowHelperOnFirstLaunch'))?.valueKind, 'boolean');
    assert.equal(definitions.find(item => item.keys.includes('vanessarun'))?.valueKind, 'boolean');
    assert.equal(definitions.find(item => item.keys.includes('КаталогФич'))?.valueKind, 'string');
    assert.equal(definitions.find(item => item.keys.includes('КлиентТестирования.ДанныеКлиентовТестирования'))?.valueKind, 'array');
    assert.equal(definitions.find(item => item.keys.includes('ОтчетAllure'))?.valueKind, 'object');
});

test('local Vanessa sources determine version and compatibility; changing the source is reflected without a stale catalog', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-va-version-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const source = path.join(root, 'VanessaAutomation');
    await fs.mkdir(path.join(source, 'Ext'), { recursive: true });
    await fs.mkdir(path.join(source, 'Forms/УправляемаяФорма/Ext/Form'), { recursive: true });
    const objectFile = path.join(source, 'Ext/ObjectModule.bsl');
    const object = (version: string, includeHelper: boolean) => `Функция СтруктураОбщихНастроек() Экспорт
Настройки = Новый Структура;
Настройки.Вставить("ИспользоватьКомпонентуVanessaExt", Ложь);
${includeHelper ? 'Настройки.Вставить("ПоказыватьПомощникПриПервомЗапуске", Истина);' : ''}
Возврат Настройки;
КонецФункции
Функция ПолучитьВерсиюОбработки() Экспорт
Версия = "${version}";
КонецФункции`;
    await fs.writeFile(objectFile, object('1.2.001', false));
    await fs.writeFile(path.join(source, 'Forms/УправляемаяФорма/Ext/Form/Module.bsl'), 'Функция ИменаКлючейОбщихНастроек()\nТаблицаИменНоваяСтрока("ИспользоватьКомпонентуVanessaExt", "useaddin", ТаблицаИмен, НижнийРегистр);\nКонецФункции');
    const old = await loadVanessaParameterCatalogSnapshot(root);
    assert.equal(old.authoritative, true); assert.equal(old.version, '1.2.001');
    const fields = createVanessaParameterFieldDefinitions(old.definitions, old.authoritative);
    assert.equal(fields.find(field => field.keys.includes('useaddin'))?.availability, 'supported');
    assert.equal(fields.find(field => field.keys.includes('ShowHelperOnFirstLaunch'))?.availability, 'unsupported');
    assert.equal(fields.some(field => field.keys.includes('MyCustomParameter')), false);
    await fs.writeFile(objectFile, object('1.2.043', true));
    const updated = await loadVanessaParameterCatalogSnapshot(root);
    assert.equal(updated.version, '1.2.043');
    assert.equal(createVanessaParameterFieldDefinitions(updated.definitions, updated.authoritative).find(field => field.keys.includes('ShowHelperOnFirstLaunch'))?.availability, 'supported');
    const binaryOnly = await loadVanessaParameterCatalogSnapshot(path.join(root, 'no-sources'));
    assert.equal(binaryOnly.authoritative, false);
    assert.equal(createVanessaParameterFieldDefinitions(binaryOnly.definitions, false).find(field => field.keys.includes('ShowHelperOnFirstLaunch'))?.availability, 'unverified');
});

test('release distributions use their local parameter documentation when BSL modules are absent', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-va-docs-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    await fs.mkdir(path.join(root, 'docs/JsonParams'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs/Changelog.md'), '# History\n## 1.2.043.45\n');
    const docsFile = path.join(root, 'docs/JsonParams/JsonParamsRU.md');
    await fs.writeFile(docsFile, `# Parameters
      * **ИспользоватьКомпонентуVanessaExt {useaddin}**:
         Description from this installed release.
      * **НовыйПараметр {NewSetting}**:
         A parameter absent from the bundled catalog.
`);
    const snapshot = await loadVanessaParameterCatalogSnapshot(path.join(root, 'vanessa-automation.epf'));
    assert.equal(snapshot.authoritative, false, 'documentation is not proof of binary compatibility');
    assert.equal(snapshot.source, 'documentation');
    assert.equal(snapshot.version, '1.2.043.45');
    const addin = snapshot.definitions.find(row => row.key === 'ИспользоватьКомпонентуVanessaExt');
    assert.equal(addin?.description, 'Description from this installed release.');
    assert.equal(addin?.valueKind, 'boolean');
    assert.deepEqual(addin?.aliases, ['useaddin']);
    assert.equal(snapshot.definitions.find(row => row.key === 'НовыйПараметр')?.valueKind, 'unknown');
    assert.equal(snapshot.definitions.some(row => row.key === 'ПоказыватьПомощникПриПервомЗапуске'), false, 'picker follows the selected release docs');
    const storedHelper = createVanessaParameterFieldDefinitions(snapshot.definitions, snapshot.authoritative).find(row => row.keys.includes('ShowHelperOnFirstLaunch'));
    assert.equal(storedHelper?.valueKind, 'boolean', 'existing rows retain built-in type hints even when not documented in the release');
    assert.equal(storedHelper?.availability, 'unverified', 'absence from release docs does not prove lack of support');
    if (process.platform !== 'win32') {
        const foreignPath = `C:\\shared\\${path.basename(root)}\\vanessa-automation.epf`;
        const mapped = await loadVanessaParameterCatalogSnapshot(foreignPath, root);
        assert.equal(mapped.source, 'documentation', 'Windows build paths inside the shared workspace resolve on the current host');
    }
    await fs.writeFile(docsFile, '* **ДругойПараметр {OtherSetting}**:\n  Changed release.\n');
    const changed = await loadVanessaParameterCatalogSnapshot(root);
    assert.equal(changed.definitions.some(row => row.key === 'НовыйПараметр'), false);
    assert.equal(changed.definitions[0].key, 'ДругойПараметр');
});

test('parameter name options contain equivalent spellings without exposing unrelated leaf keys', () => {
    const fields = createVanessaParameterFieldDefinitions(VANESSA_PARAMETER_CATALOG);
    assert.deepEqual(fields.find(row => row.keys.includes('useaddin'))?.keyOptions, ['ИспользоватьКомпонентуVanessaExt', 'useaddin']);
    const nested = fields.find(row => row.keys.includes('КлиентТестирования.ДанныеКлиентовТестирования'))!;
    assert.ok(nested.keyOptions.includes('КлиентТестирования.ДанныеКлиентовТестирования'));
    assert.equal(nested.keyOptions.includes('КлиентТестирования'), false);
});
