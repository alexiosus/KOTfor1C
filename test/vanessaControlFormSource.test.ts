import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaFormExplorerSource } from '../src/vanessaControlFormSource';
import { VanessaFormContextChangedError, VanessaFormControlError, parseVanessaFormTree, VanessaRuntimeForms } from '../src/vanessaControlForms';
import { VanessaFormStepCache } from '../src/vanessaControlFormSteps';
const snapshot = () => parseVanessaFormTree({ content: [{ type: 'text', text: '# Анализ текущей формы\n\n## Элементы формы\nНет данных.' }] },
    { client: 'own', windowTitle: 'Own', formName: 'Own' }, new Date().toISOString());
function setup() {
    let state = { generation: 1, ready: true, supported: true }; let calls = 0;
    const ports = { snapshot: () => state, run: async <T>(work: (forms: VanessaRuntimeForms) => Promise<T>) => {
        calls++; return work({ read: async () => snapshot() } as VanessaRuntimeForms);
    } };
    const source = new VanessaFormExplorerSource(ports);
    return { source, ports, calls: () => calls, state: (value: typeof state) => { state = value; source.sessionChanged(); } };
}
test('editor completion reads an unseen form without the panel, coalesces typing and only checks identity after expiry', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const own = setup(); let trees = 0; let identities = 0;
    own.ports.run = async work => work({ read: async () => { trees++; return snapshot(); },
        refresh: async previous => { identities++; return previous; } } as VanessaRuntimeForms);
    const first = await own.source.completionSnapshot(); assert.ok(first);
    await Promise.all(Array.from({ length: 30 }, () => own.source.completionSnapshot()));
    assert.equal(trees, 1); assert.equal(identities, 0);
    context.mock.timers.tick(6_000);
    assert.equal(await own.source.completionSnapshot(), first); assert.equal(trees, 1); assert.equal(identities, 1);
});

test('disabled editor form reads retain existing panel hints and never issue a request', async () => {
    let enabled = false; let reads = 0;
    const source = new VanessaFormExplorerSource({ completionEnabled: () => enabled,
        snapshot: () => ({ generation: 1, ready: true, supported: true }),
        run: async work => { reads++; return work({ read: async () => snapshot() } as VanessaRuntimeForms); } });
    assert.equal(await source.completionSnapshot(), undefined); assert.equal(reads, 0);
    await source.refresh(); const panelForm = source.cached();
    assert.equal(await source.completionSnapshot(), panelForm); assert.equal(reads, 1);
    enabled = true; assert.equal(await source.completionSnapshot(), panelForm); assert.equal(reads, 1);
    source.dispose(); assert.equal(await source.completionSnapshot(), undefined); assert.equal(reads, 1);
});

test('completion failures back off while typing and can recover after a client connects in the same manager session', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const own = setup(); let attempts = 0; let connected = false;
    own.ports.run = async work => { attempts++; if (!connected) { throw new Error('No test client'); }
        return work({ read: async () => snapshot() } as VanessaRuntimeForms); };
    assert.equal(await own.source.completionSnapshot(), undefined);
    await Promise.all(Array.from({ length: 30 }, () => own.source.completionSnapshot())); assert.equal(attempts, 1);
    connected = true; context.mock.timers.tick(31_000);
    assert.ok(await own.source.completionSnapshot()); assert.equal(attempts, 2);
});

test('panel form reads recover from a transient collision without reload or changing the MCP generation', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 }); const own = setup();
    own.ports.run = async () => { throw new Error('busy'); }; assert.equal(await own.source.refresh(), undefined);
    own.ports.run = async work => work({ read: async () => snapshot() } as VanessaRuntimeForms);
    context.mock.timers.tick(5_001); assert.ok(await own.source.refresh());
});
test('a busy runtime defers form polling without poisoning the cache or issuing a competing command', async () => {
    let busy = true; let calls = 0;
    const source = new VanessaFormExplorerSource({ snapshot: () => ({ generation: 1, ready: true, supported: true, busy }),
        run: async work => { calls++; return work({ read: async () => snapshot() } as VanessaRuntimeForms); } });
    await source.refresh(); assert.equal(calls, 0); assert.equal(source.state.status, 'idle');
    busy = false; await source.refresh(); assert.equal(calls, 1); assert.equal(source.state.status, 'ready');
});
test('MCP source shares one in-memory refresh and provides cached editor data without file writes or extra requests', async () => {
    const own = setup(); assert.equal(own.source.cached(), undefined);
    const [a,b] = await Promise.all([own.source.refresh(), own.source.refresh()]);
    assert.equal(a, b); assert.equal(own.calls(), 1); assert.equal(own.source.cached()?.form.title, 'Own');
    await own.source.refresh(); assert.equal(own.calls(), 1);
    await own.source.refresh(true); assert.equal(own.calls(), 2);
});
test('switching session, running a step or disposing the source discards pending values and never publishes stale data', async () => {
    const own = setup(); let resolve!: (value: ReturnType<typeof snapshot>) => void;
    own.ports.run = async work => work({ read: () => new Promise(r => { resolve = r; }) } as VanessaRuntimeForms);
    const pending = own.source.refresh();
    own.state({ generation: 2, ready: true, supported: true }); resolve(snapshot());
    assert.equal(await pending, undefined); assert.equal(own.source.cached(), undefined);
    own.ports.run = async work => work({ read: async () => snapshot() } as VanessaRuntimeForms);
    await own.source.refresh(); own.state({ generation: 2, ready: false, supported: true });
    assert.equal(own.source.cached(), undefined);
    own.source.dispose(); assert.equal(await own.source.refresh(), undefined);
});
test('read failure clears stale data, is not retried automatically and exposes only a fixed message', async () => {
    const own = setup(); await own.source.refresh();
    own.ports.run = async () => { throw new Error('private source value'); };
    assert.equal(await own.source.refresh(true), undefined);
    assert.equal(own.source.state.status, 'error'); assert.equal(own.source.cached(), undefined);
    assert.ok(!JSON.stringify(own.source.state).includes('private'));
});

test('detail failures retain the proven tree and editor hints while displaying their error', async () => {
    const own = setup(); const first = await own.source.refresh();
    own.ports.run = async work => work({ element: async () => { throw new VanessaFormControlError('The Vanessa form response was not confirmed. Refresh the form.'); } } as unknown as VanessaRuntimeForms);
    const pending = own.source.element('Form.Lines');
    assert.equal(own.source.cached(), first, 'selection must not erase the tree while details are loading');
    assert.equal(await pending, undefined);
    assert.equal(own.source.cached(), first, 'an unsupported detail payload does not invalidate the separately verified form tree');
    assert.equal(own.source.state.status, 'error');
});

test('a client/window mismatch during details still discards the previous tree', async () => {
    const own = setup(); await own.source.refresh();
    own.ports.run = async work => work({ element: async () => { throw new VanessaFormContextChangedError('The Vanessa client, window or session changed. Refresh the form.'); } } as unknown as VanessaRuntimeForms);
    await own.source.element('Form.Lines'); assert.equal(own.source.cached(), undefined);
});

test('a malformed detail reply after changing the window cannot retain the old form', async () => {
    let windowTitle = 'Before';
    const forms = new VanessaRuntimeForms({ identity: async () => ({ client: 'own', windowTitle, formName: 'Own' }), request: async tool => {
        if (tool === 'get_form_analysis') { return { content: [{ type: 'text', text: '# Анализ текущей формы\n\n## Элементы формы\n```text\n- Lines [Lines] {ТестируемаяТаблицаФормы} {Видимость:Да}\n```' }] }; }
        windowTitle = 'After'; return { content: [{ type: 'text', text: 'unsupported details' }] };
    } });
    const source = new VanessaFormExplorerSource({ snapshot: () => ({ generation: 1, ready: true, supported: true }), run: async work => work(forms) });
    await source.refresh(); assert.equal(source.cached()?.form.windowTitle, 'Before');
    await source.element('Form.Lines'); assert.equal(source.cached(), undefined);
});

test('a failed MCP read is not retried by polling when session readiness recovers in the same generation', async () => {
    const own = setup(); let calls = 0;
    own.ports.run = async () => {
        calls++;
        own.state({ generation: 1, ready: false, supported: true });
        own.state({ generation: 1, ready: true, supported: true });
        throw new Error('private failure');
    };
    await own.source.refresh(); await own.source.refresh();
    assert.equal(calls, 1);
    await own.source.refresh(true); assert.equal(calls, 2);
});

test('expired MCP cache uses a lightweight form check; only an explicit refresh rebuilds the same form', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const own = setup(); let reads = 0; let checks = 0;
    own.ports.run = async work => work({ read: async () => { reads++; return snapshot(); },
        refresh: async (previous: ReturnType<typeof snapshot>) => { checks++; return previous; } } as unknown as VanessaRuntimeForms);
    const first = await own.source.refresh(); context.mock.timers.tick(6_000);
    assert.equal(await own.source.refresh(), first); assert.equal(reads, 1); assert.equal(checks, 1);
    assert.equal(own.source.cached(), first);
    await own.source.refresh(true); assert.equal(reads, 2);
});

test('explicit Refresh during a background form check still performs a full read, coalescing repeated clicks', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const own = setup(); const first = await own.source.refresh(); let finish!: () => void; let reads = 0;
    own.ports.run = async work => work({ read: async () => { reads++; return snapshot(); },
        refresh: async () => { await new Promise<void>(resolve => { finish = resolve; }); return first; } } as unknown as VanessaRuntimeForms);
    context.mock.timers.tick(6_000); const check = own.source.refresh();
    const forced = own.source.refresh(true); const repeated = own.source.refresh(true); finish();
    await Promise.all([check, forced, repeated]); assert.equal(reads, 1);
});

test('editor hints retain the last loaded form while the Form Explorer tab is hidden; polling freshness stays bounded', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const own = setup(); const first = await own.source.refresh(); context.mock.timers.tick(60_000);
    assert.equal(own.source.cached(), first, 'editor hints must not disappear five seconds after switching away from the form tab');
    own.state({ generation: 2, ready: true, supported: true }); assert.equal(own.source.cached(), undefined);
});

test('shared MCP snapshots receive static metadata once per new tree and discard stale enrichment', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const own = setup(); let enriched = 0;
    own.ports.enrich = async value => { enriched++; return { ...value, notes: ['Own static metadata'] }; };
    own.ports.run = async work => work({ read: async () => snapshot(), refresh: async (previous: ReturnType<typeof snapshot>) => previous } as unknown as VanessaRuntimeForms);
    const first = await own.source.refresh(); assert.deepEqual(first?.notes, ['Own static metadata']); assert.equal(enriched, 1);
    context.mock.timers.tick(6_000); assert.equal(await own.source.refresh(), first); assert.equal(enriched, 1);
    own.ports.enrich = async value => { own.state({ generation: 2, ready: true, supported: true }); return value; };
    assert.equal(await own.source.refresh(true), undefined); assert.equal(own.source.cached(), undefined);
});
test('explicit window selection publishes its refreshed tree to the shared form cache', async () => {
    const own = setup(); const windows = { client: 'own', titles: ['Other'] };
    own.ports.run = async work => work({ windows: async () => windows, activateWindow: async () => ({ ...snapshot(), notes: ['Selected own window'] }) } as unknown as VanessaRuntimeForms);
    assert.equal(await own.source.windows(), windows);
    assert.deepEqual((await own.source.activateWindow(windows, 'Other'))?.notes, ['Selected own window']);
    assert.deepEqual(own.source.cached()?.notes, ['Selected own window']);
});

test('native inspection reserves the shared source and publishes selected details to editor hints', async () => {
    const own = setup(); const first = (await own.source.refresh())!; const next = { ...first, notes: ['Inspected current field'] };
    let finish!: () => void;
    own.ports.run = async work => work({ steps: async () => { await new Promise<void>(resolve => { finish = resolve; }); return { snapshot: next, text: 'And current', cached: false }; } } as unknown as VanessaRuntimeForms);
    assert.equal(own.source.inspectionReady, true);
    const reading = own.source.steps(first, 'Form.Name', new VanessaFormStepCache(), 'en', () => true);
    assert.equal(own.source.inspectionReady, false); assert.equal(own.source.cached(), first);
    assert.equal(await own.source.steps(first, 'Form.Other', new VanessaFormStepCache(), 'en', () => true), undefined);
    finish(); assert.equal((await reading)?.text, 'And current');
    assert.equal(own.source.cached(), next); assert.equal(own.source.inspectionReady, true);
});
test('superseded native inspection releases its reservation without erasing the known form', async () => {
    const own = setup(); const first = (await own.source.refresh())!; let current = true; let finish!: () => void;
    own.ports.run = async work => work({ steps: async () => { await new Promise<void>(resolve => { finish = resolve; }); throw new VanessaFormContextChangedError('Superseded'); } } as unknown as VanessaRuntimeForms);
    const reading = own.source.steps(first, 'Form.Name', new VanessaFormStepCache(), 'en', () => current);
    current = false; finish(); assert.equal(await reading, undefined);
    assert.equal(own.source.state.status, 'ready'); assert.equal(own.source.cached(), first); assert.equal(own.source.inspectionReady, true);
});
