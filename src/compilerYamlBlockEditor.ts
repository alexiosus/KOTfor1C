import * as vscode from 'vscode';
import { getTranslator, type Translator } from './localization';
import { appendCompilerYamlBlock, buildCompilerYamlBlockActions, validateCompilerYamlBlockName, type CompilerYamlBlockTarget } from './compilerYamlBlocks';

const ADD_BLOCK_COMMAND = 'kotTestToolkit.addCompilerYamlBlock';
interface BlockCommandTarget extends CompilerYamlBlockTarget { documentUri: string; documentVersion: number }

function isBlockTarget(value: unknown): value is BlockCommandTarget {
    if (!value || typeof value !== 'object') { return false; }
    const target = value as Partial<BlockCommandTarget>;
    return typeof target.documentUri === 'string' && Boolean(target.documentUri)
        && Number.isInteger(target.documentVersion) && Number(target.documentVersion) >= 0
        && typeof target.section === 'string'
        && ['ПараметрыСценария', 'ПараметрыТеста', 'ПараметрыШага', 'ТегиСценария', 'ТегиПроцесса', 'ТегиТеста'].includes(target.section)
        && (target.section === 'ПараметрыШага' ? typeof target.stepUid === 'string' && Boolean(target.stepUid) : target.stepUid === undefined);
}

export class CompilerYamlBlockCodeLensProvider implements vscode.CodeLensProvider {
    private readonly translator: Promise<Translator>;
    constructor(extensionUri: vscode.Uri) { this.translator = getTranslator(extensionUri); }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested || document.uri.scheme !== 'file') { return []; }
        const t = await this.translator;
        if (token.isCancellationRequested) { return []; }
        return buildCompilerYamlBlockActions(document.getText()).filter(action => action.section !== 'ПараметрыСценария').map(action => new vscode.CodeLens(
            new vscode.Range(action.line, 0, action.line, 0), {
                title: t(action.section.startsWith('Теги') ? 'Add tag block' : action.section === 'ПараметрыШага' ? 'Add step parameter block' : 'Add parameter block'),
                command: ADD_BLOCK_COMMAND,
                arguments: [{ documentUri: document.uri.toString(), documentVersion: document.version,
                    section: action.section, ...(action.stepUid ? { stepUid: action.stepUid } : {}) } satisfies BlockCommandTarget]
            }
        ));
    }
}

export async function addCompilerYamlBlockCommand(context: vscode.ExtensionContext, rawTarget: unknown): Promise<void> {
    const t = await getTranslator(context.extensionUri);
    try {
        if (!isBlockTarget(rawTarget)) { throw new Error(t('Choose a parameter or tag section button.')); }
        const uri = vscode.Uri.parse(rawTarget.documentUri);
        if (uri.scheme !== 'file') { throw new Error(t('Choose a parameter or tag section button.')); }
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.version !== rawTarget.documentVersion) { throw new Error(t('YAML changed while adding a block. Run the command again.')); }
        const source = document.getText(); const version = document.version;
        if (!buildCompilerYamlBlockActions(source).some(action => action.section === rawTarget.section && action.stepUid === rawTarget.stepUid)) {
            throw new Error(t('The parameter or tag section is missing or ambiguous.'));
        }
        const isTag = rawTarget.section.startsWith('Теги');
        const normalize = (input: string) => isTag ? input.trim().replace(/^@/u, '') : input.trim();
        const input = await vscode.window.showInputBox({
            title: t(isTag ? 'Add tag block' : 'Add parameter block'),
            prompt: t(isTag ? 'Enter tag name without @' : 'Enter parameter name'), ignoreFocusOut: true,
            validateInput: value => validateCompilerYamlBlockName(rawTarget.section, normalize(value)) ? undefined
                : t(isTag ? 'Tag name must be one non-empty word without @.' : 'Parameter name can contain letters, digits, underscores and hyphens.')
        });
        if (input === undefined) { return; }
        if (document.version !== version || document.getText() !== source) { throw new Error(t('YAML changed while adding a block. Run the command again.')); }
        const updated = appendCompilerYamlBlock(source, rawTarget, normalize(input));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(source.length)), updated);
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t('Could not insert the YAML block.')); }
        await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
        await vscode.window.showErrorMessage(t('Could not add YAML block: {0}', error instanceof Error ? t(error.message) : String(error)));
    }
}
