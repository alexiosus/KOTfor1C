import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeCompilerBuildOutputs, planCompilerBuildJobs } from '../src/compilerBuildRuntime';
import { normalizeCompilerProcessFeatureLanguage } from '../src/compilerProcessFeatureLanguage';

const source = [
    '\uFEFF#language: en', '@tree', '#report.feature=Drive', 'Функциональность: English process',
    '@КодНастройкиПроцесса=2345323', '@ПолныйКодПроцесса=2345323', 'Сценарий: English process',
    '* Подпроцесс: Shipping', '\tИ я подключаю TestClient "User" логин "login" пароль "pass"',
    '\tИ я закрыл все окна клиентского приложения', '\t#language: en', '\tAnd I click "Сценарий: literal" button',
    '* Сценарий: Invoice', '\tИ Я закрыл все окна клиентского приложения', '\tThen the result is',
    '\t| Russian text |', '\t| Функциональность: literal |', '\t"""', 'Сценарий: docstring',
    '#language: ru', 'И я закрыл все окна клиентского приложения', '\t"""', ''
].join('\r\n');

async function mergedFeature(text: string, verify: (output: string, root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-process-en-'));
    try {
        const jobs = planCompilerBuildJobs([], path.join(root, 'runtime'), path.join(root, 'out'));
        const worker = path.join(jobs[0].outputPath, 'EtalonDrive');
        await fs.mkdir(path.join(worker, '2345323', 'Файлы'), { recursive: true });
        await fs.writeFile(path.join(worker, '2345323.feature'), text);
        await fs.writeFile(path.join(worker, '2345323.str'), '{"СтрокаЛин":15}');
        await fs.writeFile(path.join(worker, '2345323', 'Файлы', 'attached.feature'), text);
        await fs.writeFile(path.join(worker, '2345323', 'Файлы', 'data.json'), '{ "name" : "customer", "value" : 1 }\n');
        await mergeCompilerBuildOutputs(jobs, path.join(root, 'out'));
        await verify(await fs.readFile(path.join(root, 'out', 'EtalonDrive', '2345323.feature'), 'utf8'), root);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('compiled English processes normalize headers and generated steps without shifting source maps or literal content', async () => {
    await mergedFeature(source, async (output, root) => {
        assert.match(output, /\r\nFeature: English process\r\n/u);
        assert.match(output, /\r\nScenario: English process\r\n/u);
        assert.match(output, /\* Subprocess: Shipping\r\n/u);
        assert.match(output, /\* Scenario: Invoice\r\n/u);
        assert.match(output, /\tAnd I connect "User" TestClient using "login" login and "pass" password\r\n/u);
        assert.match(output, /\tAnd I close all client application windows\r\n/u);
        assert.ok(output.startsWith('\uFEFF#language: en\r\n'));
        assert.equal(output.split('\r\n').length, source.split('\r\n').length);
        assert.equal(output.replace(/\r\n/gu, '').includes('\n'), false);
        assert.ok(output.includes('And I click "Сценарий: literal" button'));
        assert.ok(output.includes('| Функциональность: literal |'));
        assert.ok(output.includes('"""\r\nСценарий: docstring\r\n#language: ru\r\nИ я закрыл все окна клиентского приложения\r\n\t"""'));
        assert.equal(await fs.readFile(path.join(root, 'out', 'EtalonDrive', '2345323.str'), 'utf8'), '{"СтрокаЛин":15}');
        assert.equal(await fs.readFile(path.join(root, 'out', 'EtalonDrive', '2345323', 'Файлы', 'attached.feature'), 'utf8'), source);
        assert.equal(await fs.readFile(path.join(root, 'out', 'EtalonDrive', '2345323', 'Файлы', 'data.json'), 'utf8'), '{ "name" : "customer", "value" : 1 }\n');
    });
});

test('Russian processes and ordinary features retain their original compiler output', async () => {
    for (const unchanged of [source.replace('#language: en', '#language: ru'), source.replace(/@(?:КодНастройкиПроцесса|ПолныйКодПроцесса)=2345323\r\n/gu, '')]) {
        await mergedFeature(unchanged, async output => { assert.equal(output, unchanged); });
    }
});

test('normalization retains quoted arguments exactly and can be applied repeatedly', () => {
    const input = '#language: en\nФункциональность: Process\n@ПолныйКодПроцесса=001\nСценарий: Process\n'
        + '\tИ я подключаю TestClient "User \\"One\\"" логин "user\\\\name" пароль "pass$`\\"\\\\"\n'
        + '\t```text\nФункциональность: code\n#language: ru\n\t```\n';
    const normalized = normalizeCompilerProcessFeatureLanguage(input);
    assert.ok(normalized.includes('And I connect "User \\"One\\"" TestClient using "user\\\\name" login and "pass$`\\"\\\\" password'));
    assert.ok(normalized.includes('```text\nФункциональность: code\n#language: ru\n\t```'));
    assert.equal(normalizeCompilerProcessFeatureLanguage(normalized), normalized);
    assert.equal(normalized.split('\n').length, input.split('\n').length);
});
