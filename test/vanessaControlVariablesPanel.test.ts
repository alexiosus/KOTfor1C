import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaVariablesPanelModel, type VanessaVariablesPanelPorts } from '../src/vanessaControlVariablesPanel';
import { VanessaRuntimeVariables } from '../src/vanessaControlVariables';

const reply = { content: [{ type: 'text', text: '# Переменные контекста\n\n## Контекст ($var$)\n- `Own` = private value\n\n## Сохраняемый контекст ($$var$$)' }] };
function setup() {
    let snapshot = { generation: 1, ready: true, read: true, write: true };
    const requests: unknown[] = [];
    const ports: VanessaVariablesPanelPorts = { snapshot: () => snapshot, run: async (work, generation) => {
        assert.equal(generation, snapshot.generation);
        return work(new VanessaRuntimeVariables({ request: async args => { requests.push(args); return reply; } }));
    } };
    return { model: new VanessaVariablesPanelModel(ports), ports, requests, snapshot: (next: typeof snapshot) => { snapshot = next; } };
}

test('panel refreshes only when visible and supported, without requiring a test client or YAML declarations', async () => {
    const own = setup(); await own.model.refresh(); assert.equal(own.requests.length, 0);
    own.model.setVisible(true); await own.model.refresh();
    assert.equal(own.model.state.rows[0].representation, 'private value');
    assert.equal(own.model.state.status, 'ready');
    own.snapshot({ generation: 1, ready: true, read: false, write: false }); own.model.sessionChanged();
    await own.model.refresh(); assert.equal(own.requests.length, 1); assert.deepEqual(own.model.state.rows, []);
    assert.equal(own.model.state.status, 'unavailable');
});

test('switching sessions clears values immediately and invalidates an open edit', async () => {
    const own = setup(); own.model.setVisible(true); await own.model.refresh();
    const edit = own.model.beginEdit('local', 'Own');
    own.snapshot({ generation: 2, ready: true, read: true, write: true }); own.model.sessionChanged();
    assert.deepEqual(own.model.state.rows, []);
    await assert.rejects(own.model.set(edit, 'new'), /changed/u); assert.equal(own.requests.length, 1);
});

test('hidden and disposed panels discard pending replies and cannot submit retained edits', async () => {
    const own = setup(); own.model.setVisible(true); await own.model.refresh();
    const edit = own.model.beginEdit('local', 'Own');
    let resolve!: (value: typeof reply) => void;
    own.ports.run = (work => work(new VanessaRuntimeVariables({ request: () => new Promise(r => { resolve = r; }) }))) as VanessaVariablesPanelPorts['run'];
    const loading = own.model.refresh();
    own.model.setVisible(false); resolve(reply); await loading;
    assert.deepEqual(own.model.state.rows, []);
    own.model.setVisible(true); await assert.rejects(own.model.set(edit, 'new'));
    own.model.dispose(); await own.model.refresh(); assert.deepEqual(own.model.state.rows, []);
});

test('read-only and busy sessions cannot change values, and refresh errors expose no raw values', async () => {
    const own = setup(); own.model.setVisible(true); await own.model.refresh();
    const edit = own.model.beginEdit('local', 'Own');
    own.snapshot({ generation: 1, ready: true, read: true, write: false }); own.model.sessionChanged();
    await assert.rejects(own.model.set(edit, 'new')); assert.equal(own.requests.length, 1);
    own.snapshot({ generation: 1, ready: false, read: true, write: true }); own.model.sessionChanged();
    await own.model.refresh(); assert.equal(own.requests.length, 1); assert.deepEqual(own.model.state.rows, []);
    own.snapshot({ generation: 1, ready: true, read: true, write: true }); own.model.sessionChanged();
    own.ports.run = async () => { throw new Error('private value'); };
    await own.model.refresh(); assert.equal(own.model.state.status, 'error');
    assert.ok(!JSON.stringify(own.model.state).includes('private value'));
});

test('a visible panel returns to refreshable idle when the same session becomes ready', async () => {
    const own = setup(); own.model.setVisible(true);
    own.snapshot({ generation: 1, ready: false, read: true, write: true }); own.model.sessionChanged();
    assert.equal(own.model.state.status, 'unavailable');
    own.snapshot({ generation: 1, ready: true, read: true, write: true }); own.model.sessionChanged();
    assert.equal(own.model.state.status, 'idle');
    await own.model.refresh(); assert.equal(own.model.state.rows.length, 1);
});
