import { shouldAutoMigrateScenario } from '../src/spprScenarioFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { splitLegacySpprScenario, joinNativeSpprScenario, convertSpprScenarioFiles } from '../src/spprScenarioFormat';

const metadata = '\uFEFFТипФайла: "Сценарий"\r\nДанныеСценария:\r\n    UID: "00000000-0000-0000-0000-000000000001"\r\n    Имя: "Nested"\r\n    Код: "001"\r\n    Неизвестное: " untouched "\r\nПараметрыСценария:\r\n\r\n';
const script = '\r\n#language: en\r\nAnd I call "Nested"\r\n\t| "table" | "value" |\r\n\r\n';
const legacy = metadata + 'ТекстСценария: |\r\n\r\n    #language: en\r\n    And I call "Nested"\r\n    \t| "table" | "value" |\r\n\r\n';

test('SPPR split preserves metadata bytes and raw script including CRLF, tabs and final blank lines', () => {
    assert.deepEqual(splitLegacySpprScenario(legacy), { metadata, script });
    assert.equal(splitLegacySpprScenario(joinNativeSpprScenario(metadata, script)).script, script);
    assert.equal(splitLegacySpprScenario(joinNativeSpprScenario(metadata, script)).metadata, metadata);
});

test('native script without a final newline remains byte-identical after legacy round trip', () => {
    const scriptWithoutEol = '\uFEFF#language: ru\nИ я вызываю "Вложенный"\n    | значение |';
    const result = splitLegacySpprScenario(joinNativeSpprScenario(metadata, scriptWithoutEol));
    assert.equal(result.script, scriptWithoutEol);
    assert.equal(result.metadata, metadata);
});

test('short whitespace-only lines in the embedded script are blank lines, not ambiguous step indentation', () => {
    for (const whitespace of [' ', '  ', '   ', '\t', ' \t']) {
        const source = metadata + `ТекстСценария: |\r\n    And first\r\n${whitespace}\r\n    And second\r\n`;
        assert.deepEqual(splitLegacySpprScenario(source), { metadata, script: 'And first\r\n\r\nAnd second\r\n' });
    }
});

test('ambiguous and non-SPPR block forms fail before producing conversion output', () => {
    for (const source of [legacy.replace('ТекстСценария: |', 'ТекстСценария: |-'),
        legacy.replace('ТекстСценария: |', 'ТекстСценария: >'),
        legacy + 'ДругиеДанные: "retain"\r\n',
        legacy.replace('    Имя:', '    UID: "duplicate"\r\n    Имя:'),
        legacy.replace('    And I call', '  And I call')]) {
        assert.throws(() => splitLegacySpprScenario(source));
    }
    assert.throws(() => joinNativeSpprScenario(legacy, script));
    assert.throws(() => joinNativeSpprScenario(metadata.replace('"Сценарий"', '"Процесс"'), script));
});

test('filesystem conversion preserves settings, attachments and KOT sidecar through both directions', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-sppr-format-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'files')); await fs.mkdir(path.join(root, 'test'));
    await fs.writeFile(path.join(root, 'scen.yaml'), legacy);
    await fs.writeFile(path.join(root, 'scen.yaml.kot.yml'), 'version: 2\nidentity: {kind: scenario, uid: original}\nmetadata: {category: sample}\n');
    await fs.writeFile(path.join(root, 'test', '001.yaml'), 'settings remain');
    await fs.writeFile(path.join(root, 'files', 'attachment.bin'), new Uint8Array([0, 255, 42]));
    const nativePath = await convertSpprScenarioFiles(path.join(root, 'scen.yaml'), 'native');
    assert.equal(nativePath, path.join(root, 'meta.yaml'));
    assert.equal(await fs.readFile(nativePath, 'utf8'), metadata);
    assert.equal(await fs.readFile(path.join(root, 'scen.feature'), 'utf8'), script);
    await assert.rejects(fs.stat(path.join(root, 'scen.yaml')));
    const sidecar = await fs.readFile(path.join(root, 'meta.yaml.kot.yml'), 'utf8');
    const legacyPath = await convertSpprScenarioFiles(path.join(root, 'scen.feature'), 'legacy');
    assert.deepEqual(splitLegacySpprScenario(await fs.readFile(legacyPath, 'utf8')), { metadata, script });
    assert.equal(await fs.readFile(path.join(root, 'scen.yaml.kot.yml'), 'utf8'), sidecar);
    assert.equal(await fs.readFile(path.join(root, 'test', '001.yaml'), 'utf8'), 'settings remain');
    assert.deepEqual(await fs.readFile(path.join(root, 'files', 'attachment.bin')), Buffer.from([0, 255, 42]));
});

test('conflicting native files and invalid UTF-8 fail with the legacy source intact', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-sppr-conflict-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'scen.yaml');
    await fs.writeFile(source, legacy); await fs.writeFile(path.join(root, 'scen.feature'), 'unrelated');
    await assert.rejects(convertSpprScenarioFiles(source, 'native'));
    assert.equal(await fs.readFile(source, 'utf8'), legacy);
    await assert.rejects(fs.stat(path.join(root, 'meta.yaml')));
    await fs.unlink(path.join(root, 'scen.feature')); await fs.writeFile(source, Buffer.from([255]));
    await assert.rejects(convertSpprScenarioFiles(source, 'native'));
    assert.deepEqual(await fs.readFile(source), Buffer.from([255]));
});

test('failed commit guard rolls back prepared destinations and retains all original native bytes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-sppr-rollback-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'meta.yaml'), metadata); await fs.writeFile(path.join(root, 'scen.feature'), script);
    let guards = 0;
    await assert.rejects(convertSpprScenarioFiles(path.join(root, 'meta.yaml'), 'legacy', () => {
        if (++guards === 2) { throw new Error('Editor acquired unsaved changes'); }
    }), /unsaved/u);
    assert.equal(await fs.readFile(path.join(root, 'meta.yaml'), 'utf8'), metadata);
    assert.equal(await fs.readFile(path.join(root, 'scen.feature'), 'utf8'), script);
    assert.deepEqual((await fs.readdir(root)).sort(), ['meta.yaml', 'scen.feature']);
});

test('a source changed during preparation is preserved and prepared output is removed', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-sppr-concurrent-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'scen.yaml'); await fs.writeFile(source, legacy);
    let guards = 0;
    await assert.rejects(convertSpprScenarioFiles(source, 'native', async () => {
        if (++guards === 2) { await fs.writeFile(source, legacy + '    And new work\r\n'); }
    }), /Source changed/u);
    assert.equal(await fs.readFile(source, 'utf8'), legacy + '    And new work\r\n');
    assert.deepEqual(await fs.readdir(root), ['scen.yaml']);
});

test('a destination edited during preparation is kept and the original source is not removed', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-sppr-destination-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'scen.yaml'); await fs.writeFile(source, legacy);
    let guards = 0;
    await assert.rejects(convertSpprScenarioFiles(source, 'native', async () => {
        if (++guards === 2) { await fs.writeFile(path.join(root, 'scen.feature'), 'And newly edited destination\n'); }
    }), /Destination changed/u);
    assert.equal(await fs.readFile(source, 'utf8'), legacy);
    assert.equal(await fs.readFile(path.join(root, 'scen.feature'), 'utf8'), 'And newly edited destination\n');
    await assert.rejects(fs.stat(path.join(root, 'meta.yaml')));
});


test('automatic migration respects the setting and only accepts an embedded scen.yaml scenario', () => {
    assert.equal(shouldAutoMigrateScenario('C:\\tests\\scen.yaml', 'ТипФайла: Сценарий\nТекстСценария: |\n    And step\n', true), true);
    assert.equal(shouldAutoMigrateScenario('/tests/scen.yaml', 'ТипФайла: Сценарий\nТекстСценария: |\n    And step\n', false), false);
    assert.equal(shouldAutoMigrateScenario('/tests/meta.yaml', 'ТипФайла: Сценарий\n', true), false);
    assert.equal(shouldAutoMigrateScenario('/tests/scen.yaml', 'ТипФайла: Процесс\n', true), false);
});
