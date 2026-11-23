import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaFeatureControl, isExecutableFeatureLine, isExecutableVanessaFragmentLine, sameSavedVanessaFeature, type VanessaFeatureDocument } from '../src/vanessaControlFeature';
const text = '# language: en\nFeature: Safe\n\nScenario: Steps\n    And Delay 1\n    And a table\n      | a |\n    And a document\n      """\n      And not a step\n      """\n    # comment\n';
const document = (): VanessaFeatureDocument => ({ uri: 'file:///C:/test.feature', filePath: 'C:\\test.feature', text, dirty: false, version: 1, line: 4 });

test('only saved feature step lines are executable; headers and payloads are never guessed', () => {
    for (const line of [4, 5, 7]) { assert.equal(isExecutableFeatureLine(document(), line), true); }
    for (const line of [0, 1, 2, 3, 6, 8, 9, 10, 11, -1, 1.1, 80]) { assert.equal(isExecutableFeatureLine(document(), line), false); }
    assert.equal(isExecutableFeatureLine({ ...document(), uri: 'untitled:Untitled-1' }, 4), false);
    assert.equal(isExecutableFeatureLine({ ...document(), uri: 'file:///scen.yaml' }, 4), false);
});

test('native SPPR fragment F11 availability excludes comments, payloads and parameter bindings', () => {
    const source = { ...document(), uri: 'file:///KOT/scen.feature', text: '#language: en\nAnd a table\n    | a |\nAnd a document\n    """\n    And not a step\n    """\n// comment\nCustomer = [Customer]\n' };
    for (const line of [1, 3]) { assert.equal(isExecutableVanessaFragmentLine({ ...source, line }), true); }
    for (const line of [0, 2, 4, 5, 6, 7, 8, 9, -1, 1.1, 80]) { assert.equal(isExecutableVanessaFragmentLine({ ...source, line }), false); }
    assert.equal(isExecutableVanessaFragmentLine({ ...source, line: 1, uri: 'untitled:scen.feature' }), false);
    assert.equal(isExecutableVanessaFragmentLine({ ...source, line: 1, uri: 'file:///KOT/own.feature' }), false);
});

test('Vanessa control-flow lines and compact tree groups are executable native feature targets', async () => {
    const sourceText = '# language: en\nFeature: Native\nScenario: Native\n    *Compact tree group\n        Try\n            And Delay 1\n        Except\n            And Delay 2\n    If condition Then\n        And Delay 3\n    ElseIf other condition Then\n        And Delay 4\n    Else\n        And Delay 5\n';
    for (const line of [3, 4, 6, 10, 12]) {
        const source = { ...document(), text: sourceText, line }; let sent = 0;
        assert.equal(isExecutableFeatureLine(source, line), true, sourceText.split('\n')[line]);
        const control = new VanessaFeatureControl({ current: () => source, exists: async () => true, save: async () => true,
            execute: async (mode, _file, number) => { assert.equal(mode, 'oneStep'); assert.equal(number, line + 1); sent++; } });
        await control.run('oneStep'); assert.equal(sent, 1);
    }
});

test('manual execution saves the native dirty feature first and uses its one-based step line', async () => {
    let current = { ...document(), dirty: true };
    const events: unknown[] = [];
    const control = new VanessaFeatureControl({ current: () => current, exists: async () => true,
        save: async () => { events.push('save'); current = { ...current, dirty: false, version: 2 }; return true; },
        execute: async (...args) => { events.push(args); } });
    await control.run('oneStep');
    assert.deepEqual(events, ['save', ['oneStep', 'C:\\test.feature', 5]]);
});

test('run from a tree group starts at its first executable descendant, never at a sibling', async () => {
    for (const nested of [false, true]) {
        const source = { ...document(), text: '# language: en\nFeature: Safe\nScenario: Safe\n    *And nested\n' +
            (nested ? '        *Inner\n' : '') + '            # comment\n            And Delay 1\n    And Delay 2\n', line: 3 };
        const sent: number[] = [];
        const control = new VanessaFeatureControl({ current: () => source, exists: async () => true, save: async () => true,
            execute: async (_mode, _path, line) => { sent.push(line); } });
        await control.run('runFromLine'); assert.deepEqual(sent, [nested ? 7 : 6]);
    }
    const source = { ...document(), text: '# language: en\nFeature: Safe\nScenario: Safe\n    *Empty\n        # comment\n    And Delay 2\n', line: 3 };
    let sent = false;
    const control = new VanessaFeatureControl({ current: () => source, exists: async () => true, save: async () => true,
        execute: async () => { sent = true; } });
    await assert.rejects(control.run('runFromLine'), /group has no executable steps/u); assert.equal(sent, false);
});

test('cancelled save, changed file/tab and missing path never send a command', async () => {
    for (const mode of ['cancel', 'changed', 'switched', 'missing'] as const) {
        let current = { ...document(), dirty: true }; let sent = 0;
        const control = new VanessaFeatureControl({ current: () => current, exists: async () => mode !== 'missing',
            save: async () => { current = { ...current, dirty: false, text: mode === 'changed' ? text + '# new' : text,
                uri: mode === 'switched' ? 'file:///C:/other.feature' : current.uri }; return mode !== 'cancel'; },
            execute: async () => { sent++; } });
        await assert.rejects(control.run('runFromLine'));
        assert.equal(sent, 0, mode);
    }
});

test('repeated F11 while save or execution is pending cannot queue an extra step', async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); let sent = 0;
    const control = new VanessaFeatureControl({ current: document, exists: async () => true, save: async () => true,
        execute: async () => { sent++; await pending; } });
    const first = control.run('oneStep');
    await assert.rejects(control.run('oneStep'), /busy/i);
    release(); await first; assert.equal(sent, 1);
});

test('run from line rejects Background because Vanessa requires an independent scenario', async () => {
    const source = { ...document(), text: '# language: en\nFeature: Safe\nBackground:\n    And Delay 1\nScenario: Safe\n    And Delay 2\n', line: 3 };
    let sent = 0;
    const control = new VanessaFeatureControl({ current: () => source, exists: async () => true, save: async () => true, execute: async () => { sent++; } });
    await assert.rejects(control.run('runFromLine'), /Background/);
    assert.equal(sent, 0);
    await control.run('oneStep');
    assert.equal(sent, 1);
});

test('run scenario from the start selects within the current scenario from its heading or body', async () => {
    const feature = '# language: en\nFeature: Safe\nBackground:\n    And Delay 0\nScenario: First\n    And Delay 1\n' +
        'Scenario: Second\n    *Group\n        And Call an export\n    And Delay 2\nScenario: Third\n    And Delay 3\n';
    let cursor = 3;
    const sent: unknown[] = [];
    const control = new VanessaFeatureControl({ current: () => ({ ...document(), text: feature, line: cursor }),
        exists: async () => true, save: async () => true, execute: async (...args) => { sent.push(args); } });
    await assert.rejects(control.run('runScenario'), /inside a scenario/u);
    for (const line of [6, 7, 9]) { cursor = line; await control.run('runScenario'); }
    assert.deepEqual(sent, Array.from({ length: 3 }, () => ['runScenario', document().filePath, 9, [9, 10]]));
});

test('F11 advances only to a runtime-selected executable line while the source and selection stay unchanged', async () => {
    for (const mode of ['same', 'moved', 'switched', 'edited', 'invalid'] as const) {
        let source = document(); const selected: number[] = [];
        const control = new VanessaFeatureControl({ current: () => source, exists: async () => true, save: async () => true,
            selectLine: line => { selected.push(line); }, execute: async () => {
                if (mode === 'moved') { source = { ...source, line: 5 }; }
                if (mode === 'switched') { source = { ...source, uri: 'file:///C:/other.feature' }; }
                if (mode === 'edited') { source = { ...source, text: source.text + '# edit', dirty: true }; }
                return mode === 'invalid' ? 7 : 8;
            } });
        await control.run('oneStep');
        assert.deepEqual(selected, mode === 'same' ? [7] : [], mode);
    }
});

test('automatic F11 selection does not traverse a backwards loop edge in the affected runtime', async () => {
    const source = { ...document(), line: 7 }; const selected: number[] = [];
    const control = new VanessaFeatureControl({ current: () => source, exists: async () => true, save: async () => true,
        execute: async () => 5, selectLine: line => { selected.push(line); } });
    await control.run('oneStep');
    assert.deepEqual(selected, []);
});

test('reopened document versions cannot make breakpoint markers valid for different saved contents', () => {
    const saved = document();
    assert.equal(sameSavedVanessaFeature(saved, { ...saved, version: 1, text: text + '# external change' }), false);
    assert.equal(sameSavedVanessaFeature(saved, { ...saved, version: 1, dirty: true }), false);
    assert.equal(sameSavedVanessaFeature(saved, { ...saved, version: 8 }), true);
    assert.equal(sameSavedVanessaFeature(saved, { ...saved, uri: 'file:///other.feature' }), false);
});

test('a saved editor differing from the file on disk cannot execute a manual step', async () => {
    let sent = 0;
    const control = new VanessaFeatureControl({ current: document, exists: async () => true, save: async () => true,
        readText: async () => text + '# changed externally', execute: async () => { sent++; } });
    await assert.rejects(control.run('oneStep'), /saved feature changed/u); assert.equal(sent, 0);
});

test('disk verification accepts VS Code BOM and EOL normalization without losing source checks', async () => {
    let sent = 0;
    const control = new VanessaFeatureControl({ current: document, exists: async () => true, save: async () => true,
        readText: async () => '\uFEFF' + text.replace(/\n/gu, '\r\n'), execute: async () => { sent++; } });
    await control.run('oneStep'); assert.equal(sent, 1);
});
