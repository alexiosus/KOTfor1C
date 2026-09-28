import type * as vscode from 'vscode';
import {
    getGherkinInsertionContext,
    type GherkinInsertionContext
} from './gherkinInsertionContext';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { openProjectDefinitionHandler } from './projectDefinitionNavigation';
import { buildProjectDefinitionInsertion } from './projectDefinitionSnippet';
import type { StepLibraryItem } from './stepLibraryModel';

interface DisposableLike {
    dispose(): void;
}

class SimpleEmitter<T> implements DisposableLike {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): DisposableLike => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

export interface StepLibraryInsertionTargetState {
    readonly identity: string;
    readonly available: boolean;
    readonly resource?: vscode.Uri;
}

export interface StepLibraryActionHost {
    readonly getActiveTextEditor: () => vscode.TextEditor | undefined;
    readonly onDidChangeActiveTextEditor: vscode.Event<vscode.TextEditor | undefined>;
    readonly onDidChangeTextEditorSelection: vscode.Event<vscode.TextEditorSelectionChangeEvent>;
    readonly onDidChangeTextDocument: vscode.Event<vscode.TextDocumentChangeEvent>;
    readonly createPosition: (line: number, character: number) => vscode.Position;
    readonly createSelection: (
        anchor: vscode.Position,
        active: vscode.Position
    ) => vscode.Selection;
    readonly createSnippetString: (value: string) => vscode.SnippetString;
    readonly writeClipboardText: (value: string) => Thenable<void>;
}

export interface StepLibraryActionServiceDependencies {
    readonly resolver: ProjectDefinitionResolver;
    readonly host: StepLibraryActionHost;
    readonly openDefinition: typeof openProjectDefinitionHandler;
}

interface CapturedInsertionTarget {
    readonly editor: vscode.TextEditor;
    readonly uri: string;
    readonly selections: readonly vscode.Selection[];
    readonly context: GherkinInsertionContext;
    readonly indentation: string;
    readonly identity: string;
}

export class StepLibraryActionService implements vscode.Disposable {
    private readonly targetEmitter = new SimpleEmitter<StepLibraryInsertionTargetState>();
    private readonly disposables: DisposableLike[] = [];
    private insertionTarget: CapturedInsertionTarget | null = null;
    private insertionTargetGeneration = 0;

    public readonly onDidChangeInsertionTarget = this.targetEmitter.event as vscode.Event<StepLibraryInsertionTargetState>;

    constructor(private readonly dependencies: StepLibraryActionServiceDependencies) {
        this.disposables.push(
            dependencies.host.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    this.updateInsertionTarget(editor);
                }
            }),
            dependencies.host.onDidChangeTextEditorSelection(event => {
                this.updateInsertionTarget(event.textEditor);
            }),
            dependencies.host.onDidChangeTextDocument(event => {
                if (this.insertionTarget?.uri === event.document.uri.toString()) {
                    this.updateInsertionTarget(this.insertionTarget.editor);
                }
            })
        );
        const activeEditor = dependencies.host.getActiveTextEditor();
        if (activeEditor) {
            this.updateInsertionTarget(activeEditor, false);
        }
    }

    public getInsertionTargetState(): StepLibraryInsertionTargetState {
        return Object.freeze({
            identity: this.insertionTarget?.identity ?? 'unavailable',
            available: this.insertionTarget !== null,
            ...(this.insertionTarget
                ? { resource: this.insertionTarget.editor.document.uri }
                : {})
        });
    }

    public async insert(item: StepLibraryItem, resource?: vscode.Uri): Promise<boolean> {
        if (!item.insertable) {
            return false;
        }
        let target = this.revalidateInsertionTarget();
        if (!target) {
            return false;
        }
        const targetGeneration = this.insertionTargetGeneration;
        const view = await this.dependencies.resolver.getView(resource ?? target.editor.document.uri);
        const definition = view.byId.get(item.definitionId);
        if (!definition) {
            return false;
        }
        if (
            targetGeneration !== this.insertionTargetGeneration
            || this.insertionTarget?.editor !== target.editor
        ) {
            return false;
        }
        target = this.revalidateInsertionTarget(target);
        if (!target) {
            return false;
        }
        const insertion = buildProjectDefinitionInsertion(definition, {
            preferredText: definition.kind === 'exportScenario'
                ? definition.usageExample ?? definition.template
                : definition.template,
            typedKeyword: target.context.typedKeyword,
            fallbackKeyword: target.context.fallbackKeyword,
            indentation: target.indentation,
            language: target.context.language
        });
        return target.editor.insertSnippet(
            this.dependencies.host.createSnippetString(insertion.snippetText),
            [...target.selections]
        );
    }

    public async copy(item: StepLibraryItem): Promise<boolean> {
        await this.dependencies.host.writeClipboardText(item.displayText);
        return true;
    }

    public async openDefinition(item: StepLibraryItem, resource?: vscode.Uri): Promise<boolean> {
        if (item.kind === 'builtInStep' || !item.navigable || !item.capturedLocation) {
            return false;
        }
        return this.dependencies.openDefinition(
            item.definitionId,
            resource,
            this.dependencies.resolver,
            item.capturedLocation
        );
    }

    public dispose(): void {
        this.insertionTargetGeneration += 1;
        this.insertionTarget = null;
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        this.targetEmitter.dispose();
    }

    private cloneSelection(selection: vscode.Selection): vscode.Selection {
        return this.dependencies.host.createSelection(
            this.dependencies.host.createPosition(selection.anchor.line, selection.anchor.character),
            this.dependencies.host.createPosition(selection.active.line, selection.active.character)
        );
    }

    private positionsEqual(left: vscode.Position, right: vscode.Position): boolean {
        return left.line === right.line && left.character === right.character;
    }

    private orderedSelectionStart(selection: vscode.Selection): vscode.Position {
        const anchorBeforeActive = selection.anchor.line < selection.active.line
            || (
                selection.anchor.line === selection.active.line
                && selection.anchor.character <= selection.active.character
            );
        return anchorBeforeActive ? selection.anchor : selection.active;
    }

    private buildInsertionSelection(
        editor: vscode.TextEditor,
        selection: vscode.Selection,
        context: GherkinInsertionContext
    ): { readonly selection: vscode.Selection; readonly indentation: string } {
        if (!this.positionsEqual(selection.anchor, selection.active)) {
            const start = this.orderedSelectionStart(selection);
            return {
                selection: this.cloneSelection(selection),
                indentation: start.character === 0 ? context.indentation : ''
            };
        }

        const position = selection.active;
        const linePrefix = editor.document.lineAt(position.line).text.slice(0, position.character);
        const actualIndentation = /^\s*/u.exec(linePrefix)?.[0] ?? '';
        if (!linePrefix.trim()) {
            if (actualIndentation !== context.indentation) {
                return {
                    selection: this.dependencies.host.createSelection(
                        this.dependencies.host.createPosition(position.line, 0),
                        this.dependencies.host.createPosition(position.line, position.character)
                    ),
                    indentation: context.indentation
                };
            }
            return { selection: this.cloneSelection(selection), indentation: '' };
        }

        return {
            selection: this.dependencies.host.createSelection(
                this.dependencies.host.createPosition(position.line, actualIndentation.length),
                this.dependencies.host.createPosition(position.line, position.character)
            ),
            indentation: ''
        };
    }

    private captureInsertionTarget(editor: vscode.TextEditor): CapturedInsertionTarget | null {
        if (editor.selections.length === 0) {
            return null;
        }
        const contexts: GherkinInsertionContext[] = [];
        const insertionSelections: vscode.Selection[] = [];
        const insertionIndentations: string[] = [];
        for (const selection of editor.selections) {
            const anchorContext = getGherkinInsertionContext(editor.document, selection.anchor);
            const activeContext = this.positionsEqual(selection.anchor, selection.active)
                ? anchorContext
                : getGherkinInsertionContext(editor.document, selection.active);
            if (!anchorContext || !activeContext) {
                return null;
            }
            contexts.push(activeContext);
            const insertion = this.buildInsertionSelection(editor, selection, activeContext);
            insertionSelections.push(insertion.selection);
            insertionIndentations.push(insertion.indentation);
        }
        const context = contexts[0];
        const indentation = insertionIndentations[0];
        const homogeneous = contexts.every((candidate, index) =>
            candidate.language === context.language
            && candidate.typedKeyword === context.typedKeyword
            && candidate.fallbackKeyword === context.fallbackKeyword
            && insertionIndentations[index] === indentation
        );
        if (!homogeneous) {
            return null;
        }
        const uri = editor.document.uri.toString();
        return {
            editor,
            uri,
            selections: insertionSelections,
            context,
            indentation,
            identity: `available\0${uri}`
        };
    }

    private updateInsertionTarget(editor: vscode.TextEditor, emit = true): void {
        const previousIdentity = this.getInsertionTargetState().identity;
        this.insertionTargetGeneration += 1;
        this.insertionTarget = this.captureInsertionTarget(editor);
        const state = this.getInsertionTargetState();
        if (emit && previousIdentity !== state.identity) {
            this.targetEmitter.fire(state);
        }
    }

    private revalidateInsertionTarget(
        captured: CapturedInsertionTarget | null = this.insertionTarget
    ): CapturedInsertionTarget | null {
        if (
            !captured
            || this.insertionTarget?.editor !== captured.editor
            || captured.editor.document.uri.toString() !== captured.uri
        ) {
            return null;
        }
        const current = this.captureInsertionTarget(captured.editor);
        if (!current) {
            const previousIdentity = this.getInsertionTargetState().identity;
            this.insertionTarget = null;
            const state = this.getInsertionTargetState();
            if (previousIdentity !== state.identity) {
                this.targetEmitter.fire(state);
            }
            return null;
        }
        this.insertionTarget = current;
        return current;
    }
}
