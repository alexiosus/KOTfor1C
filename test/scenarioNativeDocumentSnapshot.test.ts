import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeDocumentTextMatchesFileText } from '../src/scenarioNativeDocumentSnapshot';

test('native snapshots compare disk BOM and normalized line endings', () => {
    const disk = '\uFEFFТипФайла: Сценарий\r\nДанныеСценария:\n    Имя: Old\r';
    assert.equal(nativeDocumentTextMatchesFileText('ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Old\n', disk), true);
    assert.equal(nativeDocumentTextMatchesFileText('ТипФайла: Сценарий\r\nДанныеСценария:\r\n    Имя: Old\r\n', disk), true);
});

test('native snapshots preserve meaningful whitespace and content differences', () => {
    const disk = '\uFEFFИмя: Old\r\n    And step\r\n';
    for (const native of ['Имя: New\n    And step\n', 'Имя: Old\n   And step\n', 'Имя: Old\n    And step', 'Имя: Old\n    And step \n', '\uFEFFИмя: Old\n    And step\n']) {
        assert.equal(nativeDocumentTextMatchesFileText(native, disk), false, JSON.stringify(native));
    }
    assert.equal(nativeDocumentTextMatchesFileText('\uFEFFИмя: Old\n', '\uFEFF\uFEFFИмя: Old\r\n'), true);
});
