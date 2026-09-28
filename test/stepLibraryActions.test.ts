import assert from 'node:assert/strict';
import test from 'node:test';
import {
    StepLibraryActionService,
    type StepLibraryActionHost
} from '../src/stepLibraryActions';
import type { ProjectDefinition, ProjectDefinitionView } from '../src/projectDefinition';
import type { StepLibraryItem } from '../src/stepLibraryModel';

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

function harness(activeEditor: any, currentDefinition = definition()) {
    const activeEditorEvents = new EventHub<any>();
    const selectionEvents = new EventHub<any>();
    const documentEvents = new EventHub<any>();
    const clipboardWrites: string[] = [];
    const openCalls: unknown[][] = [];
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
        openDefinition: async (...args: unknown[]) => {
            openCalls.push(args);
            return true;
        }
    });
    return {
        service,
        activeEditorEvents,
        selectionEvents,
        documentEvents,
        clipboardWrites,
        openCalls,
        setEditor(value: any) { editor = value; },
        setView(value: ProjectDefinitionView) { resolverView = value; }
    };
}

test('captures an eligible editor and inserts the current resolver definition', async () => {
    const editor = createEditor();
    const state = harness(editor, definition({ template: 'And current text' }));
    assert.equal(state.service.getInsertionTargetState().available, true);

    const inserted = await state.service.insert(item({ template: 'And stale text' }), editor.document.uri);
    assert.equal(inserted, true);
    assert.equal(editor.inserted[0]?.value, 'And current text');
    state.service.dispose();
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
