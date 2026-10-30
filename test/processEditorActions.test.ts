import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProcessStepsEditorAction } from '../src/processEditorActions';

test('the add-steps button targets the structural YAML section and the exact process file', () => {
    const action = buildProcessStepsEditorAction('ДанныеПроцесса:\r\n  UID: "parent"\r\n  Имя: "Parent"\r\n\r\nШагиПроцесса:\r\n', 'file:///custom/process.yaml', value => value);
    assert.deepEqual(action, { line: 4, title: 'Add process steps', command: 'kotTestToolkit.addProcessSteps', documentUri: 'file:///custom/process.yaml' });
});

test('scenarios and settings do not receive the process action', () => {
    for (const source of ['ДанныеСценария:\n  UID: "scenario"\nШагиПроцесса:\n', 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "parent"\n']) {
        assert.equal(buildProcessStepsEditorAction(source, 'file:///test.yaml', value => value), undefined);
    }
});

test('the action ignores a fake section inside scalar text and duplicate process identities', () => {
    const source = 'ДанныеПроцесса:\n  UID: "parent"\nОписание: |\n  ШагиПроцесса:\nШагиПроцесса:\n';
    assert.equal(buildProcessStepsEditorAction(source, 'file:///process.yaml', value => value)?.line, 4);
    assert.equal(buildProcessStepsEditorAction('ДанныеПроцесса:\n  UID: a\n  UID: b\nШагиПроцесса:\n', 'file:///process.yaml', value => value), undefined);
});
