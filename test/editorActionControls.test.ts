import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { controlledCodeLenses, filterEditorActionHints } from '../src/editorActionControls';

test('editor buttons are withheld without invoking action providers until enabled', async () => {
    let enabled = false; let calls = 0;
    const provider = controlledCodeLenses({ provideCodeLenses: () => { calls++; return [{ command: { title: 'Settings', command: 'settings' } } as any]; } }, () => enabled, listener => ({ dispose() {} }));
    assert.deepEqual(await provider.provideCodeLenses({ uri: {} } as any, {} as any), []);
    assert.equal(calls, 0); enabled = true;
    assert.equal((await provider.provideCodeLenses({ uri: {} } as any, {} as any))?.length, 1);
    assert.equal(calls, 1);
});

test('disabling editor buttons retains informational inlay hints', () => {
    const hint = { label: 'Variants: 2' } as any;
    const action = { label: [{ value: 'Edit', command: { command: 'edit' } }] } as any;
    assert.deepEqual(filterEditorActionHints([hint, action], false), [hint]);
    assert.deepEqual(filterEditorActionHints([hint, action], true), [hint, action]);
});

test('format-specific editor buttons override the legacy preference independently', async () => {
    const { editorActionSetting, editorActionsAreEnabled } = await import('../src/editorActionControls');
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const properties = Object.assign({}, ...manifest.contributes.configuration.map((group: { properties: object }) => group.properties));
    const values: Record<string, { globalValue?: boolean; workspaceValue?: boolean }> = {};
    const defaultFor = (key: string): boolean => properties['kotTestToolkit.' + key].default;
    const configuration = { inspect: (key: string) => ({ defaultValue: defaultFor(key), ...values[key] }), get: (key: string) => {
        const value = values[key]; return value?.workspaceValue ?? value?.globalValue ?? defaultFor(key);
    } };
    const feature = 'file:///test.feature';
    const yaml = 'file:///scen.yaml';
    assert.equal(editorActionSetting(feature), 'editor.showFeatureActionButtons');
    assert.equal(editorActionSetting(yaml), 'editor.showYamlActionButtons');
    for (const uri of [feature, yaml]) {
        assert.equal(defaultFor(editorActionSetting(uri)), true);
        assert.equal(editorActionsAreEnabled(uri, configuration), true);
    }
    values['editor.showActionButtons'] = { globalValue: false };
    assert.equal(editorActionsAreEnabled(feature, configuration), false);
    assert.equal(editorActionsAreEnabled(yaml, configuration), false);
    values['editor.showYamlActionButtons'] = { workspaceValue: true };
    assert.equal(editorActionsAreEnabled(feature, configuration), false);
    assert.equal(editorActionsAreEnabled(yaml, configuration), true);
    values['editor.showActionButtons'] = { globalValue: true };
    values['editor.showYamlActionButtons'] = { workspaceValue: false };
    assert.equal(editorActionsAreEnabled(feature, configuration), true);
    assert.equal(editorActionsAreEnabled(yaml, configuration), false);
});
