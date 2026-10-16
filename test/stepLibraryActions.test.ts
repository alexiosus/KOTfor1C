import assert from 'node:assert/strict';
import test from 'node:test';
import {
    StepLibraryActionService,
    buildStepLibraryDropSnippet,
    type StepLibraryActionHost
} from '../src/stepLibraryActions';
import type { ProjectDefinition, ProjectDefinitionView } from '../src/projectDefinition';
import type { StepLibraryItem } from '../src/stepLibraryModel';
import { buildStepLibrarySnapshot, getProcessStepsSignature } from '../src/stepLibraryModel';
import { parseScenarioDescriptor } from '../src/scenarioDescriptor';

interface Disposable {
    dispose(): void;
}

class EventHub<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}

function uri(value: string): any {
    return { toString: () => value, fsPath: value.replace(/^file:\/\//u, '') };
}

function definition(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
    return {
        id: 'user:ready',
        kind: 'userStep',
        template: 'And ready',
        normalizedTemplate: 'And ready',
        parameters: [],
        sourceLabel: 'User steps',
        language: 'en',
        ...overrides
    };
}

function item(overrides: Partial<StepLibraryItem> = {}): StepLibraryItem {
    return {
        id: 'user:ready#en',
        definitionId: 'user:ready',
        familyId: 'user:ready',
        kind: 'userStep',
        sourceGroup: 'user',
        template: 'And ready',
        displayText: 'And ready',
        language: 'en',
        categoryPath: [],
        parameters: [],
        sourceLabel: 'User steps',
        navigable: true,
        insertable: true,
        searchText: 'and ready',
        ...overrides
    };
}

function projectView(current: ProjectDefinition): ProjectDefinitionView {
    return {
        identity: `view:${current.template}`,
        all: [current],
        byId: new Map([[current.id, current]]),
        byNormalizedTemplate: new Map()
    };
}

function createEditor(lines = ['Feature: Demo', 'Scenario: Demo', '    ']): any {
    const document: any = {
        uri: uri('file:///workspace/test.feature'),
        languageId: 'gherkin',
        fileName: '/workspace/test.feature',
        version: 1,
        text: lines.join('\n'),
        getText: () => document.text,
        lineAt: (line: number) => ({ text: document.text.split('\n')[line] })
    };
    const position = { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
    const editor: any = {
        document,
        selections: [{ anchor: position, active: position }],
        inserted: [] as Array<{ value: string; selections: readonly unknown[] }>,
        async insertSnippet(snippet: { value: string }, selections: readonly unknown[]) {
            editor.inserted.push({ value: snippet.value, selections });
            return true;
        }
    };
    return editor;
}

function harness(activeEditor: any, currentDefinition = definition(), processStepHost?: any) {
    const activeEditorEvents = new EventHub<any>();
    const selectionEvents = new EventHub<any>();
    const documentEvents = new EventHub<any>();
    const clipboardWrites: string[] = [];
    const openCalls: unknown[][] = [];
    const propertiesCalls: string[] = [];
    const renamed: StepLibraryItem[] = [];
    const renamedGroups: StepLibraryItem[] = [];
    const deleted: StepLibraryItem[] = [];
    let editor = activeEditor;
    let resolverView = projectView(currentDefinition);
    const host: StepLibraryActionHost = {
        getActiveTextEditor: () => editor,
        onDidChangeActiveTextEditor: activeEditorEvents.event as never,
        onDidChangeTextEditorSelection: selectionEvents.event as never,
        onDidChangeTextDocument: documentEvents.event as never,
        createPosition: (line, character) => ({ line, character }) as never,
        createSelection: (anchor, active) => ({ anchor, active }) as never,
        createSnippetString: value => ({ value }) as never,
        writeClipboardText: async value => { clipboardWrites.push(value); }
    };
    const service = new StepLibraryActionService({
        resolver: { getView: async () => resolverView },
        host,
        ...(processStepHost ? { processStepHost } : {}),
        renameDefinition: async value => { renamed.push(value); return true; },
        renameMainGroup: async value => { renamedGroups.push(value); return true; },
        deleteDefinition: async value => { deleted.push(value); return true; },
        openDefinition: async (...args: unknown[]) => {
            openCalls.push(args);
            return true;
        },
        openScenarioProperties: async value => { propertiesCalls.push(value); }
    });
    return {
        service,
        activeEditorEvents,
        selectionEvents,
        documentEvents,
        clipboardWrites,
        openCalls,
        propertiesCalls,
        renamed,
        renamedGroups,
        deleted,
        setEditor(value: any) { editor = value; },
        setView(value: ProjectDefinitionView) { resolverView = value; }
    };
}

test('Properties opens the selected YAML source and rejects feature, catalog, and stale definition targets', async () => {
    const capturedLocation = { uri: 'file:///workspace/selected.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    for (const kind of ['mainScenario', 'process', 'nestedScenario', 'exportScenario'] as const) {
        const current = definition({ kind, definitionLocation: capturedLocation });
        const h = harness(undefined, current);
        assert.equal(await h.service.openScenarioProperties(item({ kind, definitionId: current.id, capturedLocation })), true);
        assert.deepEqual(h.propertiesCalls, [capturedLocation.uri]);
        if (kind === 'nestedScenario' || kind === 'exportScenario') {
            h.setView(projectView({ ...current, definitionLocation: { ...capturedLocation, uri: 'file:///workspace/other.yaml' } }));
            assert.equal(await h.service.openScenarioProperties(item({ kind, definitionId: current.id, capturedLocation })), false);
        }
    }
    const h = harness(undefined);
    for (const kind of ['standaloneFeature', 'builtInStep', 'userStep'] as const) {
        assert.equal(await h.service.openScenarioProperties(item({ kind, capturedLocation })), false);
    }
    assert.deepEqual(h.propertiesCalls, []);
});

test('Library deletes editable local definitions and rejects read-only catalogs or stale locations', async () => {
    for (const kind of ['mainScenario', 'nestedScenario', 'exportScenario', 'standaloneFeature', 'builtInStep', 'userStep'] as const) {
        const capturedLocation = { uri: 'file:///workspace/definition.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
        const h = harness(undefined, definition({ kind: kind === 'mainScenario' || kind === 'standaloneFeature' ? 'nestedScenario' : kind, definitionLocation: capturedLocation }));
        assert.equal(typeof (h.service as any).delete, 'function');
        const supported = kind !== 'builtInStep' && kind !== 'userStep';
        assert.equal(await (h.service as any).delete(item({ kind, capturedLocation })), supported);
        assert.equal(h.deleted.length, supported ? 1 : 0);
    }
    const h = harness(undefined, definition({ kind: 'nestedScenario', definitionLocation: {
        uri: 'file:///different.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    } }));
    assert.equal(await (h.service as any).delete(item({ kind: 'nestedScenario', capturedLocation: {
        uri: 'file:///old.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    } })), false);
    assert.equal(h.deleted.length, 0);
});

const processSource = [
    'ТипФайла: "Процесс"', 'ДанныеПроцесса:', '    UID: "parent"', '    Имя: "Process"', '    ПолныйКод: "P"', 'ШагиПроцесса:',
    '    - ШагиПроцесса1:', '        UID: "step-a"', '        СценарийНаименование: "First"', '        СценарийUID: "first"',
    '        ПолныйКод: "P.1"', '        ПараметрыШага:', '            - ПараметрыШага1:', '                Имя: "Date"', '                ЗначениеПроизвольное: "Today"', '        ТипШага: "0"',
    '    # The second step retains its comment', '    - ШагиПроцесса2:', '        UID: "step-b"', '        ВложенныйПроцессНаименование: "Second"',
    '        ВложенныйПроцессUID: "second"', '        ПолныйКод: "P.2"', '        ТипШага: "1"', 'ТегиПроцесса:', ''
].join('\n');

function processActionHarness(source = processSource) {
    const descriptor = parseScenarioDescriptor(processSource);
    const snapshot = buildStepLibrarySnapshot({ identity: 'process-actions', all: [], byId: new Map(), byNormalizedTemplate: new Map() }, [{
        name: 'Process', kind: 'process', uid: 'parent', relativePath: 'process.yaml', yamlFileUri: uri('file:///process.yaml'),
        processSteps: [...descriptor.processSteps!]
    }]);
    const selected = snapshot.items[0];
    let text = source;
    let saves = 0;
    const additions: unknown[] = [];
    const document = { uri: uri('file:///process.yaml'), version: 3, getText: () => text, save: async () => { saves += 1; return true; } };
    let replaceResult = true;
    let duringOpen: (() => void) | undefined;
    const h = harness(undefined, definition(), {
        addSteps: async (actual: unknown, expectedVersion: number, expectedSource: string) => {
            assert.equal(actual, document); assert.equal(expectedVersion, document.version); assert.equal(expectedSource, text);
            additions.push(actual); return true;
        },
        openDocument: async (value: string) => { assert.equal(value, 'file:///process.yaml'); duringOpen?.(); return document; },
        replaceDocument: async (actual: unknown, replacement: string, expectedVersion: number, expectedSource: string) => {
            assert.equal(actual, document);
            assert.equal(expectedVersion, document.version);
            assert.equal(expectedSource, text);
            if (!replaceResult) { return false; }
            text = replacement; document.version += 1; return true;
        }
    });
    const request = { processUri: 'file:///process.yaml', processUid: 'parent', stepUid: 'step-b', direction: 'up', stepsSignature: selected.processStepsSignature };
    return { ...h, selected, request, document, additions, get text() { return text; }, get saves() { return saves; },
        replaceDenied: () => { replaceResult = false; }, changeDuringOpen: (value: string) => { duringOpen = () => { text = value; document.version += 1; }; } };
}

test('process drag reorders by stable UIDs and preserves bound parameter blocks', async () => {
    const h = processActionHarness();
    assert.equal(typeof (h.service as any).reorderProcessStep, 'function');
    assert.equal(await (h.service as any).reorderProcessStep(h.selected, { ...h.request, stepUid: 'step-a', beforeStepUid: null }), true);
    assert.deepEqual(parseScenarioDescriptor(h.text).processSteps?.map(step => step.uid), ['step-b', 'step-a']);
    assert.match(h.text, /ЗначениеПроизвольное: "Today"/u);
    assert.match(h.text, /UID: "step-b"[\s\S]*ПолныйКод: "P\.1"/u);
    assert.equal(h.saves, 1);
});

test('process step deletion renumbers retained steps and Add targets the guarded process document', async () => {
    const h = processActionHarness();
    assert.equal(typeof (h.service as any).removeProcessStep, 'function');
    assert.equal(await (h.service as any).removeProcessStep(h.selected, { ...h.request, stepUid: 'step-a' }), true);
    assert.deepEqual(parseScenarioDescriptor(h.text).processSteps?.map(step => step.uid), ['step-b']);
    assert.match(h.text, /ШагиПроцесса1:[\s\S]*ПолныйКод: "P\.1"/u);
    const add = processActionHarness();
    assert.equal(typeof (add.service as any).addProcessSteps, 'function');
    assert.equal(await (add.service as any).addProcessSteps(add.selected, add.request), true);
    assert.deepEqual(add.additions, [add.document]);
    const remaining = parseScenarioDescriptor(h.text).processSteps!;
    const updatedItem = { ...h.selected, processSteps: remaining, processStepsSignature: getProcessStepsSignature('parent', remaining) };
    assert.equal(await (h.service as any).removeProcessStep(updatedItem, { ...h.request, stepsSignature: updatedItem.processStepsSignature, stepUid: 'step-b' }), true);
    assert.deepEqual(parseScenarioDescriptor(h.text).processSteps, []);
});

test('process drag/remove/add reject stale sources and foreign target identities', async () => {
    for (const method of ['reorderProcessStep', 'removeProcessStep', 'addProcessSteps']) {
        for (const patch of [{ processUri: 'file:///other.yaml' }, { processUid: 'other' }, { stepsSignature: 'stale' }]) {
            const h = processActionHarness();
            assert.equal(typeof (h.service as any)[method], 'function');
            assert.equal(await (h.service as any)[method](h.selected, { ...h.request, beforeStepUid: 'step-a', ...patch }), false);
            assert.equal(h.saves, 0); assert.equal(h.additions.length, 0);
        }
        const h = processActionHarness(); h.changeDuringOpen(processSource.replace('UID: "parent"', 'UID: "other"'));
        assert.equal(await (h.service as any)[method](h.selected, { ...h.request, beforeStepUid: 'step-a' }), false);
        assert.equal(h.saves, 0); assert.equal(h.additions.length, 0);
    }
});

test('process step deletion keeps a step used by another parameter binding', async () => {
    for (const field of ['ШагПроцессаЗначениеПоСсылкеUID', 'ШагПроцессаЗначениеПоСсылке']) {
        const source = processSource.replace('ЗначениеПроизвольное: "Today"', `${field}: "step-b"`);
        const h = processActionHarness(source);
        await assert.rejects(() => (h.service as any).removeProcessStep(h.selected, h.request), /supplies parameters/iu);
        assert.equal(h.text, source); assert.equal(h.saves, 0);
    }
});

test('process step edits reject duplicate parameter sections instead of bypassing links', async () => {
    const source = processSource.replace('ТипШага: "1"', 'ПараметрыШага:\n            - ПараметрыШага1:\n                ШагПроцессаЗначениеПоСсылкеUID: "step-a"\n        ПараметрыШага:\n        ТипШага: "1"');
    const h = processActionHarness(source);
    await assert.rejects(() => (h.service as any).removeProcessStep(h.selected, { ...h.request, stepUid: 'step-a' }), /duplicate field|ambiguous/iu);
    assert.equal(h.text, source); assert.equal(h.saves, 0);
});

test('process moves target the selected URI and preserve UID, parameters and comments when saving', async () => {
    const h = processActionHarness();
    assert.equal(typeof (h.service as any).moveProcessStep, 'function');
    assert.equal(await (h.service as any).moveProcessStep(h.selected, h.request), true);
    assert.deepEqual(parseScenarioDescriptor(h.text).processSteps?.map(step => step.uid), ['step-b', 'step-a']);
    assert.match(h.text, /UID: "step-b"[\s\S]*ПолныйКод: "P\.1"/u);
    assert.match(h.text, /UID: "step-a"[\s\S]*ПолныйКод: "P\.2"/u);
    assert.match(h.text, /The second step retains its comment/u);
    assert.match(h.text, /ЗначениеПроизвольное: "Today"/u);
    assert.equal(h.saves, 1);
    h.service.dispose();
});

test('process moves reject stale ordering, changed identity, forged targets and duplicate step UIDs', async () => {
    for (const source of [processSource.replace('UID: "parent"', 'UID: "other"'),
        processSource.replace('UID: "step-a"', 'UID: "step-b"'), processSource.replace('СценарийUID: "first"', 'СценарийUID: "changed"')]) {
        const h = processActionHarness();
        h.changeDuringOpen(source);
        assert.equal(typeof (h.service as any).moveProcessStep, 'function');
        assert.equal(await (h.service as any).moveProcessStep(h.selected, h.request), false);
        assert.equal(h.text, source);
        assert.equal(h.saves, 0);
        h.service.dispose();
    }
    for (const patch of [{ processUri: 'file:///forged.yaml' }, { processUid: 'forged' }, { stepUid: 'missing' }, { stepsSignature: 'stale' }, { direction: 'down' }]) {
        const h = processActionHarness();
        assert.equal(await (h.service as any).moveProcessStep(h.selected, { ...h.request, ...patch }), false);
        assert.equal(h.text, processSource);
        assert.equal(h.saves, 0);
        h.service.dispose();
    }
});

test('denied process workspace edits leave the source unsaved', async () => {
    const h = processActionHarness(); h.replaceDenied();
    assert.equal(typeof (h.service as any).moveProcessStep, 'function');
    assert.equal(await (h.service as any).moveProcessStep(h.selected, h.request), false);
    assert.equal(h.text, processSource);
    assert.equal(h.saves, 0);
    h.service.dispose();
});

test('library rename uses the selected scenario identity independently of the active editor', async () => {
    const location = { uri: 'file:///repo/selected/scen.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    for (const kind of ['mainScenario', 'nestedScenario', 'exportScenario'] as const) {
        const current = definition({ id: 'selected', kind: kind === 'mainScenario' ? 'nestedScenario' : kind, definitionLocation: location });
        const h = harness(undefined, current);
        const selected = item({ definitionId: 'selected', kind, sourceGroup: kind === 'mainScenario' ? 'main' : kind === 'nestedScenario' ? 'nested' : 'export', capturedLocation: location });
        assert.equal(await h.service.rename(selected), true);
        assert.deepEqual(h.renamed, [selected]);
        h.service.dispose();
    }
});

test('library rename excludes built-in/user steps, missing declarations and stale local identities', async () => {
    const h = harness(undefined);
    assert.equal(await h.service.rename(item()), false);
    assert.equal(await h.service.rename(item({ kind: 'builtInStep', sourceGroup: 'builtIn' })), false);
    assert.equal(await h.service.rename(item({ kind: 'nestedScenario', sourceGroup: 'nested' })), false);
    assert.equal(await h.service.rename(item({ kind: 'exportScenario', sourceGroup: 'export', definitionId: 'missing',
        capturedLocation: { uri: 'file:///repo/export.feature', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } })), false);
    assert.equal(h.renamed.length, 0);
    h.service.dispose();
});

test('library group rename targets a main scenario group and excludes other item kinds', async () => {
    const h = harness(undefined);
    const selected = item({ kind: 'mainScenario', sourceGroup: 'main', categoryPath: ['Smoke'],
        capturedLocation: { uri: 'file:///scen.yaml', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } });
    assert.equal(await (h.service as any).renameMainGroup(selected), true);
    assert.deepEqual(h.renamedGroups, [selected]);
    assert.equal(await (h.service as any).renameMainGroup(item()), false);
    assert.equal(await (h.service as any).renameMainGroup({ ...selected, categoryPath: [] }), false);
    h.service.dispose();
});

test('captures an eligible editor and inserts the current resolver definition', async () => {
    const editor = createEditor();
    const state = harness(editor, definition({ template: 'And current text' }));
    assert.equal(state.service.getInsertionTargetState().available, true);

    const inserted = await state.service.insert(item({ template: 'And stale text' }), editor.document.uri);
    assert.equal(inserted, true);
    assert.equal(editor.inserted[0]?.value, 'And current text');
    state.service.dispose();
});

test('library insertion uses compiler loop syntax in YAML and native syntax in feature editors', async () => {
    const loop = definition({
        kind: 'builtInStep', template: 'And I repeat "%1 Count" times'
    });
    for (const format of ['yaml', 'feature'] as const) {
        const editor = format === 'yaml'
            ? createEditor(['ТипФайла: "Сценарий"', 'ТекстСценария: |', '    #language: en', '    '])
            : createEditor();
        if (format === 'yaml') {
            editor.document.uri = uri('file:///workspace/scen.yaml');
            editor.document.fileName = '/workspace/scen.yaml';
            editor.document.languageId = 'yaml';
        }
        const state = harness(editor, loop);
        assert.equal(await state.service.insert(item({ kind: 'builtInStep' })), true);
        assert.equal(editor.inserted[0]?.value, format === 'yaml'
            ? 'Do I repeat "${1}" times\n    $0\nEndDo'
            : 'And I repeat "${1}" times');
        state.service.dispose();
    }
});

test('library loop insertion and drops classify the file extension before its language mode', async () => {
    const loop = definition({ kind: 'builtInStep', template: 'And I repeat "%1 Count" times' });
    for (const extension of ['yaml', 'yml', 'feature']) {
        const editor = extension === 'feature' ? createEditor()
            : createEditor(['ТипФайла: "Сценарий"', 'ТекстСценария: |', '    #language: en', '    ']);
        editor.document.uri = uri(`file:///workspace/scen.${extension}`);
        editor.document.languageId = extension === 'feature' ? 'yaml' : 'feature';
        const state = harness(editor, loop);
        const expected = extension === 'feature' ? 'And I repeat "${1}" times'
            : 'Do I repeat "${1}" times\n    $0\nEndDo';
        assert.equal(await state.service.insert(item({ kind: 'builtInStep' })), true);
        assert.equal(editor.inserted[0]?.value, expected, extension);
        assert.equal(buildStepLibraryDropSnippet(loop, editor.document, editor.selections[0].active), expected, extension);
        state.service.dispose();
    }
});

test('dropping a library loop into YAML supplies compiler delimiters and preserves snippet arguments', () => {
    const editor = createEditor(['ТипФайла: "Сценарий"', 'ТекстСценария: |', '    #language: en', '    ']);
    editor.document.uri = uri('file:///workspace/scen.yaml');
    editor.document.languageId = 'yaml';
    const result = buildStepLibraryDropSnippet(definition({
        kind: 'builtInStep', template: 'And I repeat "%1 Count" times'
    }), editor.document, { line: 3, character: 4 } as never);
    assert.equal(result, 'Do I repeat "${1}" times\n    $0\nEndDo');
});

test('library loop drops do not adapt payloads or insert inside existing step text', () => {
    for (const line of ['    | value |', '    # comment', '    And existing']) {
        const editor = createEditor(['ТипФайла: "Сценарий"', 'ТекстСценария: |', line]);
        editor.document.uri = uri('file:///workspace/scen.yaml');
        editor.document.languageId = 'yaml';
        assert.equal(buildStepLibraryDropSnippet(definition({ template: 'And I repeat "10" times' }),
            editor.document, { line: 2, character: line.length } as never), null);
    }
});

test('rejects heterogeneous multi-cursor contexts and stale editor generations', async () => {
    const mixed = createEditor(['Feature: Demo', 'Scenario: Demo', '    Then ', '    Когда ']);
    mixed.selections = [
        { anchor: { line: 2, character: 9 }, active: { line: 2, character: 9 } },
        { anchor: { line: 3, character: 10 }, active: { line: 3, character: 10 } }
    ];
    const mixedState = harness(mixed);
    assert.equal(mixedState.service.getInsertionTargetState().available, false);
    assert.equal(await mixedState.service.insert(item(), mixed.document.uri), false);
    mixedState.service.dispose();

    const first = createEditor();
    const second = createEditor();
    second.document.uri = uri('file:///workspace/other.feature');
    const race = harness(first);
    const pending = race.service.insert(item(), first.document.uri);
    race.setEditor(second);
    race.activeEditorEvents.fire(second);
    assert.equal(await pending, false);
    assert.equal(first.inserted.length, 0);
    race.service.dispose();
});

test('revalidates changed documents and reports insertion-target changes', async () => {
    const editor = createEditor();
    const state = harness(editor);
    const identities: string[] = [];
    state.service.onDidChangeInsertionTarget(target => identities.push(target.identity));

    editor.document.version = 2;
    editor.document.text = 'Feature: Metadata only';
    state.documentEvents.fire({ document: editor.document });

    assert.equal(state.service.getInsertionTargetState().available, false);
    assert.equal(await state.service.insert(item(), editor.document.uri), false);
    assert.deepEqual(identities, ['unavailable']);
    state.service.dispose();
});

test('copies display text and opens only captured navigable definitions', async () => {
    const state = harness(undefined);
    const location = {
        uri: 'file:///workspace/library.feature',
        range: {
            start: { line: 4, character: 0 },
            end: { line: 4, character: 18 }
        }
    };
    const navigable = item({ displayText: 'And choose "Default"', capturedLocation: location });

    assert.equal(await state.service.copy(navigable), true);
    assert.deepEqual(state.clipboardWrites, ['And choose "Default"']);
    assert.equal(await state.service.openDefinition(navigable, uri('file:///workspace/caller.feature')), true);
    assert.equal(state.openCalls.length, 1);
    assert.equal(await state.service.openDefinition(item({ kind: 'builtInStep', capturedLocation: location })), false);
    assert.equal(await state.service.openDefinition(item({ navigable: false })), false);
    state.service.dispose();
});
