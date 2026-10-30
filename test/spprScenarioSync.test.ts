import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeSpprScenarioSynchronizer } from '../src/spprScenarioSync';

test('native saves synchronize both metadata blocks and save only metadata that was initially clean', async () => {
    for (const isDirty of [false, true]) {
        const calls: string[] = [];
        const metadata = { uri: { toString: () => 'file:///own/meta.yaml' }, isDirty, save: async () => { calls.push('save'); return true; } };
        const sync = new NativeSpprScenarioSynchronizer({ resolve: async () => metadata, read: async () => 'joined current script',
            enabled: () => ({ nested: true, parameters: true }), needsNested: () => true, needsParameters: () => true,
            fillNested: async () => { calls.push('nested'); return true; }, fillParameters: async () => { calls.push('parameters'); return true; },
            changed: () => { calls.push('changed'); } });
        assert.equal(await sync.onSave(metadata), true);
        assert.deepEqual(calls, ['nested', 'parameters', 'changed', ...(isDirty ? [] : ['save'])]);
    }
});

test('a recursive metadata save does not deadlock and a pending script save is rechecked', async () => {
    let changed = false; let saves = 0; let reads = 0;
    const doc = { uri: { toString: () => 'file:///own/meta.yaml' }, isDirty: false, save: async () => { saves++; await sync.onSave(doc); return true; } };
    const sync = new NativeSpprScenarioSynchronizer({ resolve: async () => doc, read: async () => { reads++; return changed ? 'synchronized' : 'pending'; },
        enabled: () => ({ nested: true, parameters: false }), needsNested: source => source === 'pending', needsParameters: () => false,
        fillNested: async () => { await sync.onSave(doc); changed = true; return true; }, fillParameters: async () => false, changed: () => {} });
    await sync.onSave(doc); assert.equal(saves, 1); assert.ok(reads >= 2);
});
