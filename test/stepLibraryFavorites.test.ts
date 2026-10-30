import assert from 'node:assert/strict';
import test from 'node:test';
import { StepLibraryFavoritesService } from '../src/stepLibraryFavorites';
import type { StepLibraryItem, StepLibrarySnapshot } from '../src/stepLibraryModel';

class MemoryState {
    public readonly values = new Map<string, unknown>();
    public get<T>(key: string, fallback: T): T {
        return (this.values.has(key) ? this.values.get(key) : fallback) as T;
    }
    public update(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
        return Promise.resolve();
    }
}

function item(overrides: Partial<StepLibraryItem> & Pick<StepLibraryItem, 'id' | 'sourceGroup'>): StepLibraryItem {
    return {
        id: overrides.id,
        definitionId: overrides.id,
        familyId: overrides.id,
        kind: overrides.sourceGroup === 'main' ? 'mainScenario' : 'nestedScenario',
        sourceGroup: overrides.sourceGroup,
        template: overrides.id,
        displayText: overrides.id,
        categoryPath: [],
        parameters: [],
        sourceLabel: 'Test',
        navigable: true,
        insertable: overrides.sourceGroup !== 'main',
        searchText: overrides.id,
        ...overrides
    };
}

function snapshot(items: readonly StepLibraryItem[]): StepLibrarySnapshot {
    return {
        viewIdentity: 'favorites',
        items,
        counts: { builtIn: 0, user: 0, export: 0, nested: 0, main: 0 }
    };
}

test('preserves legacy favorite main scenarios and toggles callable definitions independently', async () => {
    const state = new MemoryState();
    state.values.set('phaseSwitcher.favoriteScenarios', [{
        uri: 'file:///workspace/main/scen.yaml',
        name: 'Main'
    }]);
    const main = item({
        id: 'main',
        sourceGroup: 'main',
        capturedLocation: {
            uri: 'file:///workspace/main/scen.yaml',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        }
    });
    const nested = item({ id: 'nested', sourceGroup: 'nested' });
    const service = new StepLibraryFavoritesService(state);

    assert.deepEqual([...service.favoriteItemIds(snapshot([main, nested]))], ['main']);
    assert.equal(await service.toggle(nested), true);
    assert.deepEqual([...service.favoriteItemIds(snapshot([main, nested]))].sort(), ['main', 'nested']);
    assert.equal(await service.toggle(main), false);
    assert.deepEqual([...service.favoriteItemIds(snapshot([main, nested]))], ['nested']);
});

test('scenario favorites survive both role conversions and can be cleared from either presentation', async () => {
    const state = new MemoryState(); const service = new StepLibraryFavoritesService(state); const uri = 'file:///workspace/scen.yaml';
    const capturedLocation = { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    const main = item({ id: `mainScenario#${uri}`, sourceGroup: 'main', capturedLocation });
    const nested = item({ id: `${uri}#authored`, sourceGroup: 'nested', capturedLocation });
    await service.toggle(main); assert.equal(service.isFavorite(nested), true);
    await service.toggle(nested); assert.equal(service.isFavorite(main), false);
    state.values.set('stepLibrary.favoriteItemIds', [nested.id]);
    assert.equal(service.isFavorite(main), true);
    assert.equal(service.favoriteItemIds(snapshot([main])).has(main.id), true);
    await service.toggle(main); assert.equal(service.isFavorite(nested), false);
});

test('Properties reads exactly the same favorite state as Library for main and standalone tests', async () => {
    const service = new StepLibraryFavoritesService(new MemoryState());
    for (const value of [item({ id: 'mainScenario#file:///test.yaml', sourceGroup: 'main', capturedLocation: { uri: 'file:///test.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }), item({ id: 'standaloneFeature#file:///test.feature', sourceGroup: 'standalone' })]) {
        assert.equal(service.isFavorite(value), false); await service.toggle(value);
        assert.equal(service.isFavorite(value), true); assert.equal(service.favoriteItemIds(snapshot([value])).has(value.id), true);
        await service.toggle(value); assert.equal(service.isFavorite(value), false);
    }
});
