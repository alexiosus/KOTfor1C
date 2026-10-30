import * as vscode from 'vscode';
import { getTranslator, type Translator } from './localization';
import { buildProcessStepsEditorAction } from './processEditorActions';

export class ProcessEditorCodeLensProvider implements vscode.CodeLensProvider {
    private readonly translator: Promise<Translator>;
    constructor(extensionUri: vscode.Uri) { this.translator = getTranslator(extensionUri); }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested || document.uri.scheme !== 'file') { return []; }
        const translate = await this.translator;
        if (token.isCancellationRequested) { return []; }
        const action = buildProcessStepsEditorAction(document.getText(), document.uri.toString(), translate);
        if (!action) { return []; }
        const range = new vscode.Range(action.line, 0, action.line, 0);
        return [
            new vscode.CodeLens(range, { title: action.title, command: action.command, arguments: [document.uri] }),
            new vscode.CodeLens(range, { title: translate('Edit process steps'), command: 'kotTestToolkit.editProcessSteps', arguments: [document.uri] })
        ];
    }
}
