import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    validateScenarioYamlSource,
    verifyScenarioYamlCorpus
} from '../src/scenarioYamlCorpusVerifier';

test('corpus validation exercises production sections, ranges and records', () => {
    const source = [
        'ТипФайла: Сценарий',
        'ДанныеСценария:',
        '    Имя: "Тест: #1"',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: Параметр',
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: Вложенный',
        'ТекстСценария: |',
        '    И выполняется шаг',
        ''
    ].join('\n');

    const result = validateScenarioYamlSource(source);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.sectionCount, 5);
    assert.equal(result.recordCount, 2);
});

test('corpus validation reports structural errors from ScenarioYamlDocument', () => {
    const result = validateScenarioYamlSource([
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: Тест',
        '  - structural error',
        ''
    ].join('\n'));

    assert.ok(result.errors.some(error => /YAML parser/i.test(error)));
});

test('corpus validation reports a scenario without descriptor identity', () => {
    const result = validateScenarioYamlSource([
        'ТипФайла: Сценарий',
        'ВложенныеСценарии: []',
        ''
    ].join('\n'));

    assert.ok(result.errors.some(error => /scenario name/i.test(error)));
});

test('corpus verifier walks only scen.yaml files without changing them', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scenario-yaml-corpus-'));
    const nestedDirectory = path.join(directory, 'nested');
    await mkdir(nestedDirectory);
    const scenarioPath = path.join(nestedDirectory, 'scen.yaml');
    const source = [
        'ТипФайла: Сценарий',
        'ДанныеСценария:',
        '    Имя: Sample',
        'ВложенныеСценарии: []',
        ''
    ].join('\n');
    await writeFile(scenarioPath, source, 'utf8');
    await writeFile(path.join(directory, 'ignored.yaml'), 'broken: [', 'utf8');
    t.after(async () => {
        await import('node:fs/promises').then(fs => fs.rm(directory, { recursive: true }));
    });

    const result = await verifyScenarioYamlCorpus(directory);

    assert.equal(result.fileCount, 1);
    assert.equal(result.errorCount, 0);
    assert.equal(result.warningCount, 0);
    assert.equal(await readFile(scenarioPath, 'utf8'), source);
});
