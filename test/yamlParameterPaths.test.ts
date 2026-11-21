import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as paths from '../src/yamlParameterPaths';
import { createVanessaParameterFieldDefinitions } from '../src/vanessaParameterCatalog';
import { VANESSA_PARAMETER_CATALOG } from '../src/vanessaParameterCatalog.generated';

test('compiler pickers preserve portable project paths, parents and cross-drive paths', () => {
    const folder = paths.getBuildParameterPathField('FeatureFolder')!;
    assert.equal(paths.formatPickedParameterPath('C:\\repo\\build\\features', 'C:\\repo', folder), 'build/features');
    assert.equal(paths.formatPickedParameterPath('C:\\shared', 'C:\\repo', folder), '../shared');
    assert.equal(paths.formatPickedParameterPath('C:\\repo', 'C:\\repo', folder), '.');
    assert.equal(paths.formatPickedParameterPath('D:\\tools', 'C:\\repo', folder), 'D:\\tools');
    assert.equal(paths.formatPickedParameterPath('/repo/data', '/repo', folder), 'data');
    assert.equal(paths.formatPickedParameterPath('/repo', '/Repo', folder), '../repo');
    assert.equal(paths.getBuildParameterPathField('ModelDBSettings')?.kind, 'file');
    assert.equal(paths.getBuildParameterPathField('CompileFile')?.save, true);
    assert.equal(paths.getBuildParameterPathField('LaunchDBFolder', 'File="C:\\base";'), undefined);
    assert.equal(paths.getBuildParameterPathField('RepoPath'), undefined, 'a repository URL is not a local path');
});

test('VA path metadata works with aliases and excludes flags and cloud identifiers', () => {
    const definitions = createVanessaParameterFieldDefinitions(VANESSA_PARAMETER_CATALOG);
    for (const key of ['allurepath', 'librarycatalogs', 'PathToadb', 'textlogname']) {
        const field = definitions.find(item => item.keys.includes(key))?.pathField;
        assert.ok(field, key);
        assert.deepEqual(paths.getParameterPathField('additional', key, ''), field);
        assert.equal(paths.formatPickedParameterPath('C:\\data', 'C:\\repo', field!), 'C:\\data');
    }
    assert.equal(paths.getParameterPathField('additional', 'useaddin', 'true'), undefined);
    assert.equal(paths.getParameterPathField('additional', 'ЗаписьВидео.ЗаписьВидеоYandexTTSИдентификаторКаталога', ''), undefined);
    assert.equal(paths.getParameterPathField('additional', '/ОтчетAllure/КаталогВыгрузкиAllure', '')?.kind, 'folder');
    assert.equal(paths.getParameterPathField('globalVars', 'Data', '')?.kind, 'choice');
});

test('choosing multiple library paths retains existing entries and refuses malformed arrays', () => {
    assert.equal(paths.mergePickedParameterPaths('lib/one|lib/two', ['lib/two', 'lib/three'], { kind: 'folder', multiple: 'pipe' }), 'lib/one|lib/two|lib/three');
    assert.deepEqual(JSON.parse(paths.mergePickedParameterPaths('["$Library$"]', ['C:\\lib'], { kind: 'folder', multiple: 'json' })), ['$Library$', 'C:\\lib']);
    assert.throws(() => paths.mergePickedParameterPaths('[1]', ['C:\\lib'], { kind: 'folder', multiple: 'json' }));
    assert.throws(() => paths.mergePickedParameterPaths('broken', [], { kind: 'folder', multiple: 'json' }));
});

test('path dialogs use the right field type and keep cancellation without changing a value', async () => {
    const ts = require('typescript') as typeof import('typescript'); const module = { exports: {} as any };
    const dialogs: any[] = []; let selection: any = [{ fsPath: 'C:\\repo\\features' }];
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/yamlParametersManager.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => {
            if (name === './kotInteraction') { return nativeInteraction; }
        if (name === 'vscode') { return { Uri: { file: (fsPath: string) => ({ fsPath }) }, window: {
            showQuickPick: async (items: any[]) => items[1],
            showOpenDialog: async (options: any) => { dialogs.push(options); return selection; },
            showSaveDialog: async (options: any) => { dialogs.push(options); return selection?.[0]; }
        } }; }
        if (name === './yamlParameterPaths') { return paths; }
        if (['path', 'fs', 'node:crypto'].includes(name)) { return require(name); }
        return {};
    } });
    const manager = Object.create(module.exports.YamlParametersManager.prototype);
    manager.getWorkspaceRootPath = () => 'C:\\repo'; manager.t = (text: string) => text;
    const pick = (section: string, key: string, value = '') => manager.pickParameterPath({ section, key, value });
    assert.equal(await pick('build', 'FeatureFolder'), 'features');
    assert.equal(dialogs.at(-1).canSelectFolders, true); assert.equal(dialogs.at(-1).canSelectFiles, false);
    assert.equal(await pick('build', 'ModelDBSettings'), 'features');
    assert.equal(dialogs.at(-1).canSelectFiles, true);
    assert.equal(await pick('globalVars', 'MyPath'), 'C:\\repo\\features');
    assert.equal(dialogs.at(-1).canSelectFolders, true);
    selection = undefined;
    assert.equal(await pick('build', 'CompileFile'), undefined);
    assert.equal(dialogs.at(-1).saveLabel, 'Select');
    const count = dialogs.length;
    await assert.rejects(pick('additional', 'librarycatalogs', 'broken'));
    assert.equal(dialogs.length, count);
});

test('picker replies cannot overwrite a changed field or a different profile', () => {
    const script = fs.readFileSync('media/yamlParameters.js', 'utf8');
    const start = script.indexOf('    const pendingPathRequests'); const end = script.indexOf('    function buildRowHtml', start);
    const messages: any[] = []; let events = 0;
    const field = { value: 'old', isConnected: true, readOnly: false, dispatchEvent() { events++; } };
    const key = { value: 'FeatureFolder' };
    const row = { querySelector: (selector: string) => selector === '.param-key' ? key : field, closest: () => ({ id: 'buildParametersTableBody' }) };
    const button = { disabled: false, closest: () => row };
    const actions = vm.runInNewContext(`let activeProfileId = 'one'; ${script.slice(start, end)}\n({requestParameterPath, acceptParameterPath, switchProfile: () => { activeProfileId = 'two'; }})`, {
        vscode: { postMessage: (message: any) => messages.push(message) }, Event: class {}
    });
    actions.requestParameterPath(button); field.value = 'edited';
    actions.acceptParameterPath({ requestId: messages.at(-1).requestId, value: 'chosen' });
    assert.equal(field.value, 'edited'); assert.equal(events, 0); assert.equal(button.disabled, false);
    actions.requestParameterPath(button);
    actions.acceptParameterPath({ requestId: messages.at(-1).requestId, value: 'chosen' });
    assert.equal(field.value, 'chosen'); assert.equal(events, 1);
    actions.requestParameterPath(button); actions.switchProfile();
    actions.acceptParameterPath({ requestId: messages.at(-1).requestId, value: 'wrong profile' });
    assert.equal(field.value, 'chosen'); assert.equal(events, 1);
});
