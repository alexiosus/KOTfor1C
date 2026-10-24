import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKotWorkspaceRequest, workspaceActions } from '../src/kotWorkspaceProtocol';

test('webview cannot choose an arbitrary command or an unregistered project folder', () => {
    const folders = ['file:///second'];
    assert.throws(() => parseKotWorkspaceRequest({ id: '1', type: 'action', action: 'workbench.action.terminal.new' }, folders));
    assert.throws(() => parseKotWorkspaceRequest({ id: '2', type: 'scan', folder: 'file:///first' }, folders));
    const request = parseKotWorkspaceRequest({ id: '3', type: 'action', action: 'library', folder: 'file:///second' }, folders);
    assert.equal(workspaceActions[request.action!], 'kotTestToolkit.openStepLibrary');
});

test('settings-only opening and explicit setup use distinct, validated entry routes', () => {
    assert.equal(parseKotWorkspaceRequest({ id: '1', type: 'openNative' }, []).type, 'openNative');
    assert.equal(parseKotWorkspaceRequest({ id: '2', type: 'ready' }, []).type, 'ready');
    for (const message of [null, [], { id: 2, type: 'ready' }, { id: '3', type: 'runShell' }, { id: '4', type: 'settings', scope: 'other' }]) {
        assert.throws(() => parseKotWorkspaceRequest(message, []));
    }
});

test('a restored page with a closed folder can boot while operations still reject that folder', () => {
    assert.equal(parseKotWorkspaceRequest({ id: '1', type: 'ready', folder: 'file:///closed' }, ['file:///project']).folder, undefined);
    assert.throws(() => parseKotWorkspaceRequest({ id: '2', type: 'loadProgress', folder: 'file:///closed' }, ['file:///project']));
});
