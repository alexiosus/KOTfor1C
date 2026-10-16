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
