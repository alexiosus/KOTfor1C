import assert from 'node:assert/strict';
import test from 'node:test';
import { FeaturePropertiesController } from '../src/featurePropertiesController';
function harness() {
    let document = { uri: 'file:///test.feature', text: 'Feature: Test\nScenario: One\n', version: 1, dirty: false };
    let favorite = false; const actions: string[] = [];
    const controller = new FeaturePropertiesController({
        readDocument: async uri => { assert.equal(uri, document.uri); return { ...document }; },
        replaceDocument: async (before, text) => { if (before.version !== document.version) { return false; } document = { ...document, text, version: document.version + 1, dirty: true }; return true; },
        saveDocument: async () => { document.dirty = false; return true; },
        decorate: async () => ({ favorite, canFavorite: true }),
        action: async action => { actions.push(action); if (action === 'favorite') { favorite = !favorite; } }
    });
    const request = (extra: any) => controller.handle({ command: 'featureAction', uri: document.uri, version: document.version, ...(extra.action === 'edit' ? { baseValue: extra.field === 'tags' ? controller.state?.model.tags.join(' ') : controller.state?.model[extra.field as 'title' | 'description'] } : {}), ...extra });
    return { controller, request, actions, document: () => document };
}
test('feature controller edits native source and refreshes dirty, saved, pin and favorite state', async () => {
    const h = harness(); await h.controller.open(h.document().uri);
    await h.request({ action: 'edit', field: 'title', value: 'Updated' });
    assert.equal(h.controller.state?.model.title, 'Updated'); assert.equal(h.controller.state?.dirty, true);
    await h.request({ action: 'save' }); assert.equal(h.controller.state?.dirty, false);
    await h.request({ action: 'favorite' }); assert.equal(h.controller.state?.favorite, true);
    await h.request({ action: 'pin' }); assert.equal(h.controller.pinned, true);
});
test('stale actions cannot edit another source, and errors survive automatic refresh', async () => {
    const h = harness(); await h.controller.open(h.document().uri);
    await assert.rejects(h.controller.handle({ command: 'featureAction', uri: 'file:///old.feature', version: 1, action: 'edit', field: 'title', value: 'Bad' }), /changed/iu);
    await h.controller.refresh(); assert.match(h.controller.state?.error ?? '', /changed/iu);
    assert.equal(h.document().text, 'Feature: Test\nScenario: One\n'); assert.deepEqual(h.actions, []);
    await h.request({ action: 'dismissError' }); assert.equal(h.controller.state?.error, undefined);
});
test('structural and scenario actions must match the current parsed feature', async () => {
    const h = harness(); await h.controller.open(h.document().uri);
    await assert.rejects(h.request({ action: 'structure', value: 'background', line: 99 }), /available/iu);
    await h.request({ action: 'structure', value: 'background', line: 0 });
    assert.deepEqual(h.actions, ['structure']);
    await assert.rejects(h.request({ action: 'openScenario', line: 99 }), /available/iu);
    await h.request({ action: 'openScenario', line: 1 });
    assert.equal(h.actions.at(-1), 'openScenario');
});

test('external field edits are never overwritten by an older draft carrying a newer document version', async () => {
    const h = harness(); await h.controller.open(h.document().uri);
    h.document().text = 'Feature: External\nScenario: One\n'; h.document().version++; await h.controller.refresh();
    await assert.rejects(h.request({ action: 'edit', field: 'title', value: 'Local', baseValue: 'Test' }), /field changed/iu);
    assert.equal(h.document().text, 'Feature: External\nScenario: One\n');
});

test('a pinned feature can be unpinned even when the source disappears', async () => {
    let missing = false;
    const controller = new FeaturePropertiesController({ readDocument: async () => { if (missing) { throw new Error('Missing file'); } return { uri: 'file:///deleted.feature', version: 1, text: 'Feature: Deleted\nScenario: Ready\n' }; },
        replaceDocument: async () => true, saveDocument: async () => true, decorate: async () => ({}), action: async () => undefined });
    await controller.open('file:///deleted.feature');
    const pin = () => controller.handle({ command: 'featureAction', uri: 'file:///deleted.feature', version: 1, action: 'pin' });
    await pin(); assert.equal(controller.pinned, true); missing = true; await pin(); assert.equal(controller.pinned, false);
});
