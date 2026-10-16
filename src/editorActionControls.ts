import type * as vscode from 'vscode';

function combinedChanges(first: vscode.Event<void>, second?: vscode.Event<void>): vscode.Event<void> {
    return (listener, thisArgs, disposables) => {
        const firstSubscription = first(listener, thisArgs);
        const secondSubscription = second?.(listener, thisArgs);
        const subscription = { dispose: () => { firstSubscription.dispose(); secondSubscription?.dispose(); } };
        disposables?.push(subscription); return subscription;
    };
}

export function controlledCodeLenses(provider: vscode.CodeLensProvider, enabled: (uri: vscode.Uri) => boolean,
    changes: vscode.Event<void>): vscode.CodeLensProvider {
    return {
        onDidChangeCodeLenses: combinedChanges(changes, provider.onDidChangeCodeLenses),
        provideCodeLenses: (document, token) => enabled(document.uri) ? provider.provideCodeLenses(document, token) : [],
        resolveCodeLens: provider.resolveCodeLens?.bind(provider)
    };
}

export function filterEditorActionHints(hints: vscode.InlayHint[], enabled: boolean): vscode.InlayHint[] {
    return enabled ? hints : hints.filter(hint => !Array.isArray(hint.label) || !hint.label.some(part => part.command));
}

export function controlledInlayHints(provider: vscode.InlayHintsProvider, enabled: (uri: vscode.Uri) => boolean,
    changes: vscode.Event<void>): vscode.InlayHintsProvider {
    return {
        onDidChangeInlayHints: combinedChanges(changes, provider.onDidChangeInlayHints),
        provideInlayHints: async (document, range, token) => filterEditorActionHints(await provider.provideInlayHints(document, range, token) ?? [], enabled(document.uri)),
        resolveInlayHint: provider.resolveInlayHint?.bind(provider)
    };
}
