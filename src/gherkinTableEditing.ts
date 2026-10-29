import * as vscode from 'vscode';
import { planGherkinHeaderColumnDeletion } from './gherkinTableUtils';
import { ScenarioYamlDocument } from './scenarioYamlDocument';

function isFeature(document: vscode.TextDocument): boolean {
    return document.languageId === 'feature' || /\.feature$/iu.test(document.fileName);
}

function supportsTables(document: vscode.TextDocument): boolean {
    return (document.uri.scheme === 'file' || document.uri.scheme === 'untitled')
        && (isFeature(document) || /\.ya?ml$/iu.test(document.fileName));
}

function scriptRange(document: vscode.TextDocument, text: string): { start: number; end: number } | undefined {
    if (isFeature(document)) { return { start: 0, end: text.length }; }
    const field = ScenarioYamlDocument.parse(text).findFieldAtPath(['ТекстСценария']);
    return field && !field.ambiguous ? field.blockScalarContentRange ?? undefined : undefined;
}

/** Propagate whole header-cell deletions without adding another Undo step. */
export function registerGherkinTableColumnDeletion(context: vscode.ExtensionContext): void {
    const snapshots = new Map<string, { text: string; version: number }>();
    const applying = new Set<string>();
    const remember = (document: vscode.TextDocument) => {
        const key = document.uri.toString();
        if (supportsTables(document)) {
            snapshots.set(key, { text: document.getText(), version: document.version });
        } else {
            snapshots.delete(key);
        }
    };
    for (const document of vscode.workspace.textDocuments) { remember(document); }

    const onChange = async (event: vscode.TextDocumentChangeEvent): Promise<void> => {
        const { document } = event;
        const key = document.uri.toString();
        const previous = snapshots.get(key);
        remember(document);
        const editor = vscode.window.activeTextEditor;
        if (!previous || !supportsTables(document) || applying.has(key) || event.reason !== undefined
            || previous.version !== document.version - 1 || event.contentChanges.length !== 1
            || editor?.document !== document) { return; }
        const change = event.contentChanges[0];
        if (change.text !== '' || change.rangeLength <= 0
            || !previous.text.slice(change.rangeOffset, change.rangeOffset + change.rangeLength).includes('|')) { return; }
        const scope = scriptRange(document, previous.text);
        if (!scope || change.rangeOffset < scope.start || change.rangeOffset + change.rangeLength > scope.end) { return; }
        const deletions = planGherkinHeaderColumnDeletion(previous.text.slice(scope.start, scope.end), {
            offset: change.rangeOffset - scope.start, length: change.rangeLength
        });
        if (!deletions.length) { return; }

        const version = document.version;
        applying.add(key);
        try {
            await editor.edit(builder => {
                if (document.version !== version) { return; }
                for (const deletion of deletions) {
                    // All planned data cells follow the header removed by the user.
                    const start = scope.start + deletion.start - change.rangeLength;
                    const end = scope.start + deletion.end - change.rangeLength;
                    builder.delete(new vscode.Range(document.positionAt(start), document.positionAt(end)));
                }
            }, { undoStopBefore: false, undoStopAfter: false });
        } catch (error) {
            console.error('[Gherkin tables] Could not propagate the header column deletion:', error);
        } finally {
            applying.delete(key);
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(remember),
        vscode.workspace.onDidCloseTextDocument(document => { snapshots.delete(document.uri.toString()); }),
        vscode.workspace.onDidChangeTextDocument(onChange),
        { dispose: () => { snapshots.clear(); applying.clear(); } }
    );
}
