import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('runtime failure decorations take precedence over normal step documentation', async () => {
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hoverProvider.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: () => ({}) });
    const provider = Object.create(module.exports.DriveHoverProvider.prototype);
    provider.provideYamlFieldHover = async () => null;
    provider.isFeatureDocument = () => true; provider.isInScenarioTextBlock = () => true;
    provider.provideVariableHover = async () => ({ contents: 'ordinary documentation' });
    const document = { fileName: '/own.feature', uri: {}, lineAt: () => ({ text: 'And own step' }) };
    provider.isRuntimeFailedLine = (_doc: unknown, line: number) => line === 3;
    assert.equal(await provider.provideHover(document, { line: 3 }, {}), null);
    assert.deepEqual(await provider.provideHover(document, { line: 2 }, {}), { contents: 'ordinary documentation' });
});
