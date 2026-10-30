import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import os from 'node:os';
import * as launch from '../src/vanessaLaunchJson';
const { applyAdditionalVanessaParameters } = launch;

function manager() {
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/yamlParametersManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, console, require: (name: string) => {
        if (name === './vanessaLaunchJson.js') { return launch; }
        if (['fs', 'path'].includes(name)) { return require(name); }
        return {};
    } });
    return Object.create(module.exports.YamlParametersManager.prototype);
}

test('VAParams import retains false, zero, empty and JSON-looking strings, null and nested arrays through launch serialization', () => {
    const api = manager();
    const source = {
        useaddin: false, featurepath: '', ПоказыватьПомощникПриПервомЗапуске: false,
        ВыполнениеСценариев: { КоличествоПопытокВыполненияСценария: 0 },
        filtertags: ['Smoke', 'Slow'], EmptyArray: [], EmptyObject: {},
        CustomText: 'false', CustomCode: '0012', CustomNumberText: '0', CustomJsonText: '{}', CustomNull: null,
        'Custom.WithDot': true, CustomObject: { 'path/with~escape': 'value' }
    };
    const imported = api.parseAdditionalParametersFromJsonData(source);
    assert.ok(imported.some((row: any) => row.key === 'filtertags' && row.value === '["Smoke","Slow"]'), 'array stays one editable JSON field');
    const restored = JSON.parse(JSON.stringify(imported));
    assert.deepEqual(applyAdditionalVanessaParameters({}, restored).value, source);
    assert.deepEqual(applyAdditionalVanessaParameters({}, api.normalizeAdditionalVanessaParameters(restored)).value, source);
});

test('row-based imports retain native false and zero values instead of turning them into empty fields', () => {
    const api = manager();
    const rows = api.parseAdditionalParametersFromJsonData({ additionalVanessaParameters: [
        { key: 'useaddin', value: false }, { key: 'Count', value: 0 }, { key: 'Rows', value: ['one'] }
    ] });
    assert.equal(rows[0].value, 'false'); assert.equal(rows[1].value, '0'); assert.equal(rows[2].value, '["one"]');
    assert.deepEqual(applyAdditionalVanessaParameters({}, rows).value, { useaddin: false, Count: 0, Rows: ['one'] });
});

test('typed numeric and boolean editors serialize valid native input syntax to JSON primitives', () => {
    assert.deepEqual(applyAdditionalVanessaParameters({}, [
        { key: 'Number', value: '.5', valueKind: 'number', overrideExisting: false },
        { key: 'Flag', value: 'TRUE', valueKind: 'boolean', overrideExisting: false }
    ]).value, { Number: 0.5, Flag: true });
});

test('saving and reimporting additional parameters preserves their JSON types and nested structure', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-va-import-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const api = manager(); const source = { useaddin: false, Custom: { Code: '0', Value: null }, filtertags: ['Smoke'] };
    const target = path.join(root, 'additional.json');
    await api.createAdditionalVanessaParametersFile(target, api.parseAdditionalParametersFromJsonData(source));
    const exported = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(exported, source);
    assert.deepEqual(applyAdditionalVanessaParameters({}, api.parseAdditionalParametersFromJsonData(exported)).value, source);
});
