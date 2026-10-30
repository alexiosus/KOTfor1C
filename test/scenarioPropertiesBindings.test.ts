import assert from 'node:assert/strict';
import test from 'node:test';
import { findLinkedScenarioSettings, selectScenarioSettings } from '../src/scenarioPropertiesBindings';

const scenario = { uri: 'file:///project/scen.yaml', text: 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: Sales-Uid\n    Имя: Sales\n' };
const candidate = (uri: string, uid: string, kind = 'НастройкаТеста') => ({ uri,
    text: `ТипФайла: ${kind}\nДанныеТеста:\n    ${kind === 'НастройкаПроцесса' ? 'UIDПроцесса' : 'UIDСценария'}: ${uid}\n    СценарийНаименование: Sales\n` });

test('settings bind by exact compiler UID and kind instead of nearby filename or equal name', () => {
    const matching = candidate('file:///project/profiles/second.yaml', 'sales-uid');
    assert.deepEqual(findLinkedScenarioSettings(scenario, [
        candidate('file:///project/test.yaml', 'different'),
        candidate('file:///project/process.yaml', 'sales-uid', 'НастройкаПроцесса'), matching
    ]), [matching]);
});

test('process settings bind to their process and incomplete source identity binds nothing', () => {
    const process = { uri: 'file:///project/process.yaml', text: 'ТипФайла: Процесс\nДанныеПроцесса:\n    UID: process-uid\n    Имя: Sales\n' };
    const matching = candidate('file:///project/setting.yaml', 'PROCESS-UID', 'НастройкаПроцесса');
    assert.deepEqual(findLinkedScenarioSettings(process, [matching, candidate('file:///project/test.yaml', 'process-uid')]), [matching]);
    assert.deepEqual(findLinkedScenarioSettings({ ...scenario, text: scenario.text.replace('    UID: Sales-Uid\n', '') }, [candidate('file:///project/test.yaml', 'sales-uid')]), []);
});

test('legacy process headers still bind process settings when the file type is absent', () => {
    const process = { uri: 'file:///project/process.yaml', text: 'ДанныеПроцесса:\n    UID: process-uid\n    Имя: Sales\n' };
    const matching = candidate('file:///project/setting.yml', 'PROCESS-UID', 'НастройкаПроцесса');
    assert.deepEqual(findLinkedScenarioSettings(process, [matching, candidate('file:///project/test.yaml', 'process-uid')]), [matching]);
});

test('duplicate settings linkage is rejected rather than used to edit an arbitrary definition', () => {
    const duplicate = { uri: 'file:///project/bad.yaml', text: 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: sales-uid\n    UIDСценария: different\n' };
    assert.throws(() => findLinkedScenarioSettings(scenario, [duplicate]), /ambiguous/i);
});

test('several settings require explicit selection and selection is retained only while it exists', () => {
    const settings = [candidate('file:///project/one.yaml', 'sales-uid'), candidate('file:///project/two.yaml', 'sales-uid')];
    assert.equal(selectScenarioSettings(settings), undefined);
    assert.equal(selectScenarioSettings(settings, settings[1].uri), settings[1].uri);
    assert.equal(selectScenarioSettings(settings, 'file:///removed.yaml'), undefined);
    assert.equal(selectScenarioSettings([settings[0]]), settings[0].uri);
});
