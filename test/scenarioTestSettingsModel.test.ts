import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenarioTestSettings } from '../src/scenarioTestSettingsModel';
import { findLinkedScenarioSettings } from '../src/scenarioPropertiesBindings';

test('creating test settings links the authored scenario UID and chosen infobase/users with compiler fields', () => {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: source-uid\n    Имя: Sales\n    Код: SALES\nТекстСценария: |\n    And I do something\n';
    const text = buildScenarioTestSettings(source, { uid: 'test-uid', databaseName: 'Model "Drive"', databaseId: 'drive', userProfile: 'Administrator' });
    assert.match(text, /ТипФайла: "НастройкаТеста"/);
    assert.match(text, /UID: "test-uid"/);
    assert.match(text, /UIDСценария: "source-uid"/);
    assert.match(text, /ЭталоннаяБазаИмя: "Model \\"Drive\\""/);
    assert.match(text, /ПрофильПользователя: "Administrator"/);
    const settings = { uri: 'file:///project/test.yaml', text };
    assert.deepEqual(findLinkedScenarioSettings({ uri: 'file:///project/scen.yaml', text: source }, [settings]), [settings]);
});

test('process settings keep their own UID and use UIDПроцесса, never scenario linkage', () => {
    const source = 'ТипФайла: Процесс\nДанныеПроцесса:\n    UID: process-uid\n    Имя: Business process\n    Код: 123\nШагиПроцесса:\n';
    const text = buildScenarioTestSettings(source, { uid: 'test-uid', databaseName: 'Drive', databaseId: 'drive', userProfile: 'Admin' });
    assert.match(text, /ТипФайла: "НастройкаПроцесса"/);
    assert.match(text, /UIDПроцесса: "process-uid"/);
    assert.doesNotMatch(text, /UIDСценария|СценарийНаименование/);
});

test('settings cannot be created from missing or ambiguous authored identity', () => {
    const values = { uid: 'test-uid', databaseName: 'Drive', databaseId: 'drive', userProfile: 'Admin' };
    assert.throws(() => buildScenarioTestSettings('ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Sales\n', values), /UID/i);
    assert.throws(() => buildScenarioTestSettings('ТипФайла: Сценарий\nДанныеСценария:\n    UID: first\n    UID: second\n    Имя: Sales\n', values), /ambiguous/i);
});
