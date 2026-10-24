import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenarioPropertiesSession, type ScenarioPropertiesDocument, type ScenarioPropertiesHost } from '../src/scenarioPropertiesSession';

const sourceUri = 'file:///project/scen.yaml';
const settingsUri = 'file:///project/test.yaml';
const metadataUri = `${sourceUri}.kot.yml`;
const sourceText = 'ТипФайла: Сценарий\nДанныеСценария:\n    UID: sales\n    Имя: Sales\n    Проект: Drive\nПараметрыСценария:\nТекстСценария: |\n    And I open a Sales form\n';

function harness() {
    const documents = new Map<string, ScenarioPropertiesDocument>([
        [sourceUri, { uri: sourceUri, version: 1, text: sourceText, dirty: false }],
        [settingsUri, { uri: settingsUri, version: 1, dirty: false,
            text: 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UID: test-sales\n    UIDСценария: sales\n    Имя: Test Sales\nПараметрыТеста:\nТегиТеста:\n' }]
    ]);
    const saved: string[] = [];
    const host: ScenarioPropertiesHost = {
        readDocument: async uri => { const value = documents.get(uri); if (!value) { throw new Error('Missing document'); } return { ...value }; },
        replaceDocument: async (before, text) => {
            const current = documents.get(before.uri)!;
            if (current.version !== before.version || current.text !== before.text) { return false; }
            documents.set(before.uri, { ...current, version: current.version + 1, text, dirty: true }); return true;
        },
        saveDocument: async uri => { saved.push(uri); documents.get(uri)!.dirty = false; return true; },
        listSettings: async () => [{ uri: settingsUri, text: documents.get(settingsUri)!.text }],
        loadGroups: async () => [{ id: 'sales-group', name: 'Sales group' }],
        readMetadata: async () => documents.get(metadataUri),
        ensureMetadata: async () => {
            const value = { uri: metadataUri, version: 1, dirty: false, text: 'version: 2\nidentity:\n  kind: scenario\n  uid: sales\nmetadata: {}\n' };
            documents.set(metadataUri, value); return { ...value };
        },
        runAction: async () => undefined
    };
    return { documents, saved, host, session: new ScenarioPropertiesSession(host) };
}

test('opening and copying bound files do not save or reload linked settings', async () => {
    const h = harness(); let scans = 0;
    const list = h.host.listSettings; h.host.listSettings = async source => { scans++; return list(source); };
    await h.session.open(sourceUri); assert.equal(scans, 1);
    for (const action of ['openSource', 'openText', 'openSettings', 'openMetadata', 'openReference', 'copyPath']) {
        const state = await h.session.handle({ command: 'action', action, ...(action === 'copyPath' ? { value: sourceUri } : {}) });
        assert.equal(state.loading, false); assert.equal(state.mutationError, false);
    }
    assert.deepEqual(h.saved, []); assert.equal(scans, 1);
    await h.session.handle({ command: 'action', action: 'selectSettings', value: settingsUri });
    assert.equal(scans, 1);
    const denied = await h.session.handle({ command: 'action', action: 'copyPath', value: 'file:///unbound.yaml' });
    assert.match(denied.error!, /not bound/u);
});

test('one property session resolves descriptor, selected linked settings and shared groups', async () => {
    const h = harness(); const state = await h.session.open(sourceUri);
    assert.equal(state.source?.model.title, 'Sales');
    assert.equal(state.selectedSettingsUri, settingsUri);
    assert.equal(state.settings[0].model.kind, 'test');
    assert.deepEqual(state.groups, [{ id: 'sales-group', name: 'Sales group' }]);
    assert.equal(state.metadata, null);
});

test('role conversion refreshes launchability without rebinding or leaving Properties busy', async () => {
    const h = harness(); await h.session.open(sourceUri);
    h.host.runAction = async action => {
        assert.equal(action, 'convertRole'); h.documents.delete(settingsUri);
        h.host.listSettings = async () => [];
        return { sourceUri, uriMoves: [] };
    };
    const state = await h.session.handle({ command: 'action', action: 'convertRole', value: 'nested' });
    assert.equal(state.mutationError, false); assert.equal(state.canCreateSettings, false);
    assert.equal(state.source?.uri, sourceUri); assert.deepEqual(state.settings, []);
});

test('process defaults fill only selected settings and refuse stale or foreign targets', async () => {
    const h = harness();
    h.documents.get(sourceUri)!.text = 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "sales"\n    Имя: "Sales"\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Currency"\n        Значение: "EUR"\n        ТипПараметра: "Строка"\nШагиПроцесса:\n';
    h.documents.get(settingsUri)!.text = 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n    UID: "settings-sales"\n    UIDПроцесса: "sales"\n    Имя: "Sales"\nПараметрыТеста:\n';
    await h.session.open(sourceUri);
    const message = { command: 'fillProcessDefaults', documentUri: settingsUri, documentVersion: 1, sourceVersion: 1, target: { section: 'ПараметрыТеста' } };
    const state = await h.session.handle(message);
    assert.equal(state.mutationError, false); assert.match(h.documents.get(settingsUri)!.text, /Значение: "EUR"/u);
    assert.equal(h.documents.get(settingsUri)!.dirty, true); assert.deepEqual(h.saved, []);
    const filled = h.documents.get(settingsUri)!.text;
    h.documents.get(sourceUri)!.version++;
    assert.match((await h.session.handle({ ...message, documentVersion: 2 })).error ?? '', /changed/u);
    assert.equal(h.documents.get(settingsUri)!.text, filled);
    await h.session.refresh(); h.documents.get(settingsUri)!.text = filled.replace('UIDПроцесса: "sales"', 'UIDПроцесса: "foreign"');
    const foreign = await h.session.handle({ ...message, documentVersion: 2, sourceVersion: 2 });
    assert.match(foreign.error ?? '', /belong/u);
    const wrongTarget = await h.session.handle({ ...message, documentUri: sourceUri, documentVersion: 2, sourceVersion: 2 });
    assert.match(wrongTarget.error ?? '', /process settings|selected/u);
});

test('renaming edited but unselected settings rebases the resources saved for this test', async () => {
    const h = harness(); const otherUri = 'file:///project/custom.yaml'; const nextUri = 'file:///project/renamed.yaml';
    h.documents.set(otherUri, { ...h.documents.get(settingsUri)!, uri: otherUri });
    h.host.listSettings = async () => Array.from(h.documents.values()).filter(value => value.uri !== sourceUri);
    await h.session.open(sourceUri);
    await h.session.handle({ command: 'action', action: 'selectSettings', value: settingsUri });
    await h.session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: 1,
        edit: { section: 'ДанныеТеста', field: 'ПараметрыЗапуска', value: '/OwnChange' } });
    await h.session.handle({ command: 'action', action: 'selectSettings', value: otherUri });
    h.documents.set(nextUri, { ...h.documents.get(settingsUri)!, uri: nextUri }); h.documents.delete(settingsUri);
    const state = await h.session.remapFiles([{ oldUri: settingsUri, newUri: nextUri }]);
    assert.equal(state.selectedSettingsUri, otherUri);
    assert.equal((await h.session.handle({ command: 'action', action: 'save' })).error, undefined);
    assert.ok(h.saved.includes(nextUri)); assert.ok(!h.saved.includes(settingsUri));
    assert.match(h.documents.get(nextUri)!.text, /OwnChange/); assert.equal(h.documents.get(nextUri)!.dirty, false);
});

test('action errors survive refresh and unrelated pin actions until dismissal or successful retry', async () => {
    const h = harness(); await h.session.open(sourceUri);
    h.host.runAction = async () => { throw new Error('Save the source before changing identity.'); };
    assert.match((await h.session.handle({ command: 'action', action: 'rename' })).error ?? '', /Save the source/);
    assert.match((await h.session.refresh()).error ?? '', /Save the source/);
    assert.match((await h.session.handle({ command: 'action', action: 'pin' })).error ?? '', /Save the source/);
    h.host.runAction = async () => undefined;
    assert.equal((await h.session.handle({ command: 'action', action: 'rename' })).error, undefined);
    h.host.runAction = async () => { throw new Error('Other failure'); };
    await h.session.handle({ command: 'action', action: 'rename' });
    assert.equal((await h.session.handle({ command: 'action', action: 'dismissError' })).error, undefined);
});

test('a settings file reassigned during delayed enrichment is unbound immediately and cannot be edited or saved', async () => {
    const h = harness(); const session = new ScenarioPropertiesSession(h.host, () => undefined); await session.open(sourceUri);
    await session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: 1,
        edit: { section: 'ДанныеТеста', field: 'ПараметрыЗапуска', value: '/OwnChange' } });
    const settings = h.documents.get(settingsUri)!; settings.text = settings.text.replace('UIDСценария: sales', 'UIDСценария: foreign'); settings.version++;
    let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; });
    h.host.listSettings = async () => { await delayed; return []; };
    const state = await session.refresh(true); assert.equal(state.selectedSettingsUri, null); assert.deepEqual(state.settings, []);
    const result = await session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: settings.version,
        edit: { section: 'ДанныеТеста', field: 'ПараметрыЗапуска', value: '/ForeignChange' } });
    assert.match(result.error ?? '', /not bound|belong/i); assert.doesNotMatch(h.documents.get(settingsUri)!.text, /ForeignChange/);
    assert.match((await session.handle({ command: 'action', action: 'save' })).error ?? '', /belong/i);
    assert.deepEqual(h.saved, []); release();
});

test('metadata reassignment is validated by the native host before immediate display, mutation and saving', async () => {
    const h = harness(); const session = new ScenarioPropertiesSession(h.host, () => undefined);
    let foreign = false;
    h.host.readMetadata = async () => { if (foreign) { throw new Error('Metadata identity does not match the source.'); } return h.documents.get(metadataUri); };
    await session.open(sourceUri);
    await session.handle({ command: 'editMetadata', documentUri: sourceUri, documentVersion: 1, field: 'description', value: 'Own change' });
    await session.refresh();
    const metadata = h.documents.get(metadataUri)!; metadata.text = metadata.text.replace('uid: sales', 'uid: foreign'); metadata.version++; foreign = true;
    const direct = await session.handle({ command: 'editMetadata', documentUri: metadataUri, documentVersion: metadata.version, field: 'description', value: 'Foreign change' });
    assert.match(direct.error ?? '', /identity/i); assert.doesNotMatch(h.documents.get(metadataUri)!.text, /Foreign change/);
    let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; }); h.host.listSettings = async () => { await delayed; return []; };
    assert.equal((await session.refresh(true)).metadata, null);
    assert.match((await session.handle({ command: 'action', action: 'save' })).error ?? '', /identity/i); assert.deepEqual(h.saved, []); release();
});

test('native catalog selection reuses the property inventory including flat sibling definitions', async () => {
    const h = harness(); await h.session.open(sourceUri);
    const sibling = { uri: 'file:///project/sibling.yaml', text: sourceText.replace('Проект: Drive', 'Проект: Sibling project') };
    h.host.listSettings = async () => [sibling]; let passed: any;
    h.host.runAction = async (_action, _source, _settings, _value, catalogs) => { passed = catalogs; };
    const state = await h.session.handle({ command: 'catalogChoice', documentUri: sourceUri, documentVersion: 1,
        target: { section: 'ДанныеСценария', field: 'Проект' }, value: 'Sibling project' });
    assert.equal(state.error, undefined); assert.deepEqual(passed.candidates.map((value: any) => value.uri), [sourceUri, sibling.uri]);
});

test('source is available without waiting for related inventory and stale enrichment is discarded', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.host.listSettings = async () => { await gate; return []; };
    const start = performance.now();
    const first = await h.session.open(sourceUri, true);
    assert.equal(first.source?.model.title, 'Sales');
    assert.equal(first.loading, true);
    assert.ok(performance.now() - start < 100);
    const nextUri = 'file:///project/other.yaml';
    h.documents.set(nextUri, { uri: nextUri, text: sourceText.replace('Sales', 'Other'), version: 1, dirty: false });
    await h.session.open(nextUri, true);
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.session.getState().source?.uri, nextUri);
    assert.equal(h.session.getState().source?.model.title, 'Other');
    assert.equal(h.session.getState().loading, false);
});

test('initial properties preserve sidecar organization without mistaking it for launch settings', async () => {
    const h = harness();
    h.documents.set(metadataUri, { uri: metadataUri, version: 1, dirty: false,
        text: 'version: 2\nidentity:\n  kind: scenario\n  uid: sales\nmetadata:\n  groupId: sales-group\n  order: 7\n' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.host.listSettings = async () => { await gate; return []; };
    try {
        const first = await h.session.open(sourceUri, true);
        assert.equal(first.loading, true);
        assert.equal(first.canCreateSettings, false);
        assert.equal(first.metadata?.values.groupId, 'sales-group');
        assert.equal(first.metadata?.values.order, 7);
        assert.deepEqual(first.groups, [{ id: 'sales-group', name: 'Sales group' }]);
    } finally { release(); }
});

test('an ungrouped main scenario is recognized from its local settings in the initial properties state', async () => {
    const h = harness();
    (h.host as ScenarioPropertiesHost & { listInitialSettings: ScenarioPropertiesHost['listSettings'] }).listInitialSettings = async () => [h.documents.get(settingsUri)!];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.host.listSettings = async () => { await gate; return []; };
    try {
        const first = await h.session.open(sourceUri, true);
        assert.equal(first.loading, true);
        assert.equal(first.canCreateSettings, true);
    } finally { release(); }
});

test('a sibling settings file linked to another UID does not expose main metadata fields on a nested scenario', async () => {
    const h = harness();
    (h.host as ScenarioPropertiesHost & { listInitialSettings: ScenarioPropertiesHost['listSettings'] }).listInitialSettings = async () => [
        { uri: settingsUri, text: h.documents.get(settingsUri)!.text.replace('UIDСценария: sales', 'UIDСценария: another') }
    ];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.host.listSettings = async () => { await gate; return []; };
    try {
        const first = await h.session.open(sourceUri, true);
        assert.equal(first.loading, true);
        assert.equal(first.canCreateSettings, false);
    } finally { release(); }
});

test('header controls carry direct identity actions, configured function choices and autofill policy', async () => {
    const h = harness(); const calls: any[] = [];
    h.host.presentation = () => ({ autoFill: { parameters: true, nested: false }, systemFunctions: [{ name: 'Sales', uid: 'fn-uid' }], suggestions: { Проект: ['Drive'] } });
    h.host.runAction = async (...args) => { calls.push(args); };
    const state = await h.session.open(sourceUri);
    assert.deepEqual(state.autoFill, { parameters: true, nested: false });
    assert.equal(state.source?.model.header.find(field => field.key === 'Имя')?.action, 'rename');
    const result = await h.session.handle({ command: 'edit', documentUri: sourceUri, documentVersion: 1, edit: { section: 'ДанныеСценария', field: 'Имя', value: 'New name' } });
    assert.equal(result.error, undefined); assert.equal(calls[0][0], 'rename'); assert.equal(calls[0][3], 'New name');
    const rejected = await h.session.handle({ command: 'addRecord', documentUri: sourceUri, documentVersion: 1, target: { section: 'ПараметрыСценария' } });
    assert.match(rejected.error ?? '', /scenario text/);
});

test('a deleted linked settings document does not block source revision refresh or leave stale bindings', async () => {
    const h = harness(); await h.session.open(sourceUri);
    h.documents.delete(settingsUri); h.host.listSettings = async () => [];
    const source = h.documents.get(sourceUri)!; h.documents.set(sourceUri, { ...source, version: 2, dirty: true });
    const refreshed = await h.session.refresh(true);
    assert.equal(refreshed.source?.version, 2); assert.equal(refreshed.settings.length, 0); assert.equal(refreshed.selectedSettingsUri, null);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.session.getState().error, undefined); assert.equal(h.session.getState().loading, false);
});

test('header edits preserve native scenario text and dirty source values stay visible in the form', async () => {
    const h = harness(); await h.session.open(sourceUri);
    const state = await h.session.handle({ command: 'edit', documentUri: sourceUri, documentVersion: 1,
        edit: { section: 'ДанныеСценария', field: 'Проект', value: 'New Drive' } });
    assert.match(h.documents.get(sourceUri)!.text, /Проект: "New Drive"/);
    assert.equal(h.documents.get(sourceUri)!.text.split('ТекстСценария: |')[1], sourceText.split('ТекстСценария: |')[1]);
    assert.equal(state.source?.model.header.find(field => field.key === 'Проект')?.value, 'New Drive');
    assert.equal(state.dirty, true);
    assert.equal(state.error, undefined);
});

test('stale and unrelated document targets are rejected without losing current edits', async () => {
    const h = harness(); await h.session.open(sourceUri);
    const current = { ...h.documents.get(sourceUri)!, version: 2, text: sourceText.replace('Drive', 'Changed elsewhere'), dirty: true };
    h.documents.set(sourceUri, current);
    let state = await h.session.handle({ command: 'edit', documentUri: sourceUri, documentVersion: 1,
        edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Stale' } });
    assert.match(state.error ?? '', /changed|stale/i);
    assert.equal(h.documents.get(sourceUri)!.text, current.text);
    state = await h.session.handle({ command: 'edit', documentUri: 'file:///other/scen.yaml', documentVersion: 1,
        edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Unrelated' } });
    assert.match(state.error ?? '', /bound|belong|target/i);
    assert.equal(h.documents.get(sourceUri)!.text, current.text);
});

test('first metadata edit bootstraps one sidecar then uses guarded document edits', async () => {
    const h = harness(); await h.session.open(sourceUri);
    let state = await h.session.handle({ command: 'editMetadata', documentUri: sourceUri, documentVersion: 1, field: 'description', value: 'Shared Sales' });
    assert.equal(state.metadata?.uri, metadataUri);
    assert.equal(state.metadata?.values.description, 'Shared Sales');
    state = await h.session.handle({ command: 'editMetadata', documentUri: metadataUri, documentVersion: state.metadata!.version, field: 'groupId', value: 'missing-group' });
    assert.match(state.error ?? '', /group/i);
    assert.equal(state.metadata?.values.groupId, undefined);
});

test('save reports a failed linked document save and leaves its changes dirty', async () => {
    const h = harness(); await h.session.open(sourceUri);
    await h.session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: 1,
        edit: { section: 'ДанныеТеста', field: 'ПараметрыЗапуска', value: '/Debug' } });
    h.host.saveDocument = async uri => { if (uri === settingsUri) { return false; } h.documents.get(uri)!.dirty = false; return true; };
    const state = await h.session.handle({ command: 'action', action: 'save' });
    assert.match(state.error ?? '', /save/i);
    assert.equal(h.documents.get(settingsUri)!.dirty, true);
    assert.equal(state.dirty, true);
});

test('an ambiguous list of linked settings is shown without choosing or editing the first one', async () => {
    const h = harness();
    const second = { ...h.documents.get(settingsUri)!, uri: 'file:///project/second-test.yaml' };
    h.documents.set(second.uri, second);
    h.host.listSettings = async () => [h.documents.get(settingsUri)!, second];
    const state = await h.session.open(sourceUri);
    assert.equal(state.settings.length, 2);
    assert.equal(state.selectedSettingsUri, null);
    const rejected = await h.session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: 1,
        edit: { section: 'ДанныеТеста', field: 'ПараметрыЗапуска', value: 'Wrong default' } });
    assert.match(rejected.error ?? '', /select|bound|target/i);
});

test('saving a newly selected test does not save dirty documents belonging to the previous test', async () => {
    const h = harness(); await h.session.open(sourceUri);
    await h.session.handle({ command: 'edit', documentUri: sourceUri, documentVersion: 1,
        edit: { section: 'ДанныеСценария', field: 'Проект', value: 'Pending project' } });
    const secondUri = 'file:///project/second.yaml';
    h.documents.set(secondUri, { uri: secondUri, version: 1, text: sourceText.replace('sales', 'second'), dirty: false });
    await h.session.open(secondUri);
    await h.session.handle({ command: 'action', action: 'save' });
    assert.deepEqual(h.saved, [secondUri]);
    assert.equal(h.documents.get(sourceUri)!.dirty, true);
});

test('unsaved source text marks the test dirty without creating run settings for nested sources', async () => {
    const h = harness(); h.host.listSettings = async () => [];
    h.documents.get(sourceUri)!.dirty = true;
    const state = await h.session.open(sourceUri);
    assert.equal(state.dirty, true);
    assert.equal(state.canCreateSettings, false);
});

test('multiple parameter values have a readonly combination preview in the same form', async () => {
    const h = harness(); const document = h.documents.get(sourceUri)!;
    h.documents.set(sourceUri, { ...document, text: sourceText.replace('ПараметрыСценария:\n', 'ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: Customer\n        Значение: "First;Second"\n        ТипПараметра: Строка\n        НесколькоЗначений: Да\n') });
    const state = await h.session.open(sourceUri);
    const preview = state.source?.model.sections.find(section => section.key === 'ПараметрыСценария')?.fields?.find(field => field.key === 'Parameter combinations');
    assert.equal(preview?.readonly, true);
    assert.match(preview?.value ?? '', /2/);
    assert.match(preview?.value ?? '', /Customer = First/);
});

test('build combination preview accounts for values overridden by selected run settings', async () => {
    const h = harness();
    const source = h.documents.get(sourceUri)!;
    h.documents.set(sourceUri, { ...source, text: source.text.replace('ПараметрыСценария:\n', 'ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: Customer\n        Значение: "First;Second"\n        ТипПараметра: Строка\n') });
    const settings = h.documents.get(settingsUri)!;
    h.documents.set(settingsUri, { ...settings, text: settings.text.replace('ПараметрыТеста:\n', 'ПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: Customer\n        Значение: "One;Two;Three"\n') });
    const state = await h.session.open(sourceUri);
    const value = state.source!.model.sections[0].fields![0].value;
    assert.equal(value.split('\n')[0], '3'); assert.match(value, /Customer = Three/);
});

test('build preview includes extra test parameters and preserves table overrides as one value', async () => {
    const h = harness(); const settings = h.documents.get(settingsUri)!;
    h.documents.set(settingsUri, { ...settings, text: settings.text.replace('ПараметрыТеста:\n', 'ПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: Extra\n        Значение: "One;Two"\n        ТипПараметра: Строка\n    - ПараметрыТеста2:\n        Имя: Table\n        Значение: "A;B"\n        ТипПараметра: Таблица\n') });
    const source = h.documents.get(sourceUri)!;
    h.documents.set(sourceUri, { ...source, text: source.text.replace('ПараметрыСценария:\n', 'ПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: Table\n        Значение: "X;Y;Z"\n        ТипПараметра: Строка\n') });
    const state = await h.session.open(sourceUri);
    assert.equal(state.source!.model.sections[0].fields![0].value.split('\n')[0], '2');
});

test('settings-only combinations are displayed even when the scenario declaration list is empty', async () => {
    const h = harness(); const settings = h.documents.get(settingsUri)!;
    h.documents.set(settingsUri, { ...settings, text: settings.text.replace('ПараметрыТеста:\n', 'ПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: Extra\n        Значение: "One;Two"\n') });
    const state = await h.session.open(sourceUri);
    assert.equal(state.source!.model.sections[0].records!.length, 0);
    assert.equal(state.source!.model.sections[0].fields![0].value.split('\n')[0], '2');
});

test('opening compiler header choices preserves missing flags and clean document state', async () => {
    const h = harness();
    const state = await h.session.open(sourceUri);
    assert.equal(state.source!.model.header.find(field => field.key === 'НеобратимоМеняетДанные')?.value, '');
    assert.equal(state.settings[0].model.header.find(field => field.key === 'Выключена')?.value, '');
    assert.equal(h.documents.get(sourceUri)!.text, sourceText);
    assert.doesNotMatch(h.documents.get(settingsUri)!.text, /Выключена/u);
    assert.equal(state.dirty, false);
});

test('scenario variant limit warning follows the selected settings and clears below the limit', async () => {
    const h = harness(); const settings = h.documents.get(settingsUri)!;
    const values = Array.from({ length: 101 }, (_, index) => String(index)).join(';');
    settings.text = settings.text.replace('ПараметрыТеста:\n', `ПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: Customer\n        Значение: "${values}"\n        ТипПараметра: "Строка"\n`);
    const state = await h.session.open(sourceUri);
    assert.deepEqual(state.variantLimitWarning, { count: '101', limit: 100 });
    assert.equal(state.source!.model.sections[0].fields![0].value.split('\n')[0], '101');
    const changed = await h.session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: settings.version,
        edit: { section: 'ПараметрыТеста', recordKey: 'Customer', field: 'Значение', value: values.split(';').slice(0, 100).join(';') } });
    assert.equal(changed.error, undefined);
    assert.equal(changed.variantLimitWarning, null);
    assert.equal(changed.source!.model.sections[0].fields![0].value.split('\n')[0], '100');
    assert.equal((await h.session.clear()).variantLimitWarning, null);
});

test('variant limit warning is absent when no scenario combinations are displayed', async () => {
    const h = harness(); h.host.listSettings = async () => [];
    const state = await h.session.open(sourceUri);
    assert.equal(state.variantLimitWarning, null);
    h.documents.set(sourceUri, { uri: sourceUri, version: 2, dirty: false,
        text: 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    UID: "flow"\n    Имя: "Flow"\nПараметрыСценария:\nШагиПроцесса:\n' });
    assert.equal((await h.session.open(sourceUri)).variantLimitWarning, null);
});

test('selecting a different linked settings file recalculates the scenario variant limit warning', async () => {
    const h = harness(); const limited = h.documents.get(settingsUri)!; const otherUri = 'file:///project/limited.yaml';
    const values = Array.from({ length: 101 }, (_, index) => String(index)).join(';');
    h.documents.set(otherUri, { ...limited, uri: otherUri,
        text: limited.text.replace('UID: test-sales', 'UID: larger-test').replace('ПараметрыТеста:\n',
            `ПараметрыТеста:\n    - ПараметрыТеста1:\n        Имя: Customer\n        Значение: "${values}"\n        ТипПараметра: "Строка"\n`) });
    h.host.listSettings = async () => [h.documents.get(settingsUri)!, h.documents.get(otherUri)!];
    assert.equal((await h.session.open(sourceUri)).variantLimitWarning, null);
    const large = await h.session.handle({ command: 'action', action: 'selectSettings', value: otherUri });
    assert.deepEqual(large.variantLimitWarning, { count: '101', limit: 100 });
    assert.equal((await h.session.handle({ command: 'action', action: 'selectSettings', value: settingsUri })).variantLimitWarning, null);
});

test('nested metadata group changes cannot accidentally turn a nested source into a main scenario', async () => {
    const h = harness(); h.host.listSettings = async () => [];
    await h.session.open(sourceUri);
    const state = await h.session.handle({ command: 'editMetadata', documentUri: sourceUri, documentVersion: 1, field: 'groupId', value: 'sales-group' });
    assert.match(state.error ?? '', /main|nested|group/i);
    assert.equal(h.documents.has(metadataUri), false);
});

test('metadata migrated by the project store is present in the first property state', async () => {
    const h = harness();
    h.host.loadGroups = async () => {
        h.documents.set(metadataUri, { uri: metadataUri, version: 1, dirty: false,
            text: 'version: 2\nidentity:\n  kind: scenario\n  uid: sales\nmetadata:\n  description: Migrated description\n' });
        return [];
    };
    const state = await h.session.open(sourceUri);
    assert.equal(state.metadata?.values.description, 'Migrated description');
});

test('changing Group and Category preserves each other and the ungrouped main marker', async () => {
    const h = harness(); const doc = h.documents.get(sourceUri)!;
    doc.text += 'KOTМетаданные:\n    PhaseSwitcher:\n        Tab: Sales\n';
    h.documents.set(metadataUri, { uri: metadataUri, version: 1, dirty: false,
        text: 'version: 2\nidentity: {kind: scenario, uid: sales}\nmetadata:\n  groupId: sales-group\n  category: Retail\n  order: 2\n  description: Notes\n' });
    await h.session.open(sourceUri);
    let state = await h.session.handle({ command: 'editMetadata', documentUri: metadataUri, documentVersion: 1, field: 'category', value: 'Other' });
    assert.equal(state.metadata?.values.groupId, 'sales-group'); assert.equal(state.metadata?.values.order, 2);
    state = await h.session.handle({ command: 'editMetadata', documentUri: metadataUri, documentVersion: 2, field: 'groupId', value: '' });
    assert.equal(state.metadata?.values.category, 'Other'); assert.equal(state.metadata?.values.groupId, '');
    assert.equal(state.metadata?.values.description, 'Notes'); assert.equal(state.canCreateSettings, true);
});

test('a code rename result remaps bound source, selected settings, metadata and unsaved resources before refresh', async () => {
    const h = harness(); h.host.readMetadata = async source => h.documents.get(source.uri + '.kot.yml');
    await h.session.open(sourceUri); await h.session.handle({ command: 'action', action: 'pin' });
    await h.session.handle({ command: 'editMetadata', documentUri: sourceUri, documentVersion: 1, field: 'description', value: 'Draft' });
    await h.session.handle({ command: 'edit', documentUri: settingsUri, documentVersion: 1, edit: { section: 'ДанныеТеста', field: 'ПараметрыЗапуска', value: '/Run' } });
    h.host.runAction = async action => {
        assert.equal(action, 'changeCode');
        const previous = Array.from(h.documents.values()); h.documents.clear();
        for (const document of previous) {
            const uri = document.uri === settingsUri ? 'file:///new/renamed.yaml' : document.uri.replace('file:///project/', 'file:///new/');
            h.documents.set(uri, { ...document, uri });
        }
        return { sourceUri: 'file:///new/scen.yaml', uriMoves: [
            { oldUri: settingsUri, newUri: 'file:///project/renamed.yaml' }, { oldUri: 'file:///project', newUri: 'file:///new' }
        ] };
    };
    h.host.listSettings = async () => [{ uri: 'file:///new/renamed.yaml', text: h.documents.get('file:///new/renamed.yaml')!.text }];
    const state = await h.session.handle({ command: 'edit', documentUri: sourceUri, documentVersion: 1,
        edit: { section: 'ДанныеСценария', field: 'Код', value: 'NEW' } });
    assert.equal(state.error, undefined); assert.equal(state.source?.uri, 'file:///new/scen.yaml'); assert.equal(state.pinned, true);
    assert.equal(state.selectedSettingsUri, 'file:///new/renamed.yaml'); assert.equal(state.metadata?.uri, 'file:///new/scen.yaml.kot.yml');
    await h.session.handle({ command: 'action', action: 'save' });
    assert.deepEqual(new Set(h.saved), new Set([sourceUri, settingsUri, metadataUri, 'file:///new/scen.yaml', 'file:///new/renamed.yaml', 'file:///new/scen.yaml.kot.yml']));
});
