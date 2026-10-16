import assert from 'node:assert/strict';
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
    const values: Record<string, any> = { 'editor.showActionButtons': { globalValue: true } };
    const configuration = { inspect: (key: string) => values[key], get: (key: string, fallback: boolean) => {
        const value = values[key]; return value?.workspaceFolderValue ?? value?.workspaceValue ?? value?.globalValue ?? fallback;
    } };
    assert.equal(editorActionSetting('file:///test.feature'), 'editor.showFeatureActionButtons');
    assert.equal(editorActionSetting('file:///scen.yaml'), 'editor.showYamlActionButtons');
    assert.equal(editorActionsAreEnabled('file:///test.feature', configuration), true);
    values['editor.showYamlActionButtons'] = { workspaceValue: false };
    assert.equal(editorActionsAreEnabled('file:///scen.yaml', configuration), false);
    assert.equal(editorActionsAreEnabled('file:///test.feature', configuration), true);
    values['editor.showFeatureActionButtons'] = { globalValue: false };
    assert.equal(editorActionsAreEnabled('file:///test.feature', configuration), false);
});
