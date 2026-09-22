import * as vscode from 'vscode';
import { getTranslator } from './localization';
import { fetchHttpsBytes } from './stepCatalogHttp';

const LEGACY_HTML_MAX_BYTES = 20 * 1024 * 1024;

// Deprecated compatibility API for the remaining Form Explorer HTML consumer.
// StepCatalogService is the only entry point for completion, hover, and diagnostics.
export async function getStepsHtml(
    context: vscode.ExtensionContext,
    _forceRemote = false
): Promise<string> {
    const externalUrl = vscode.workspace
        .getConfiguration('kotTestToolkit')
        .get<string>('steps.externalUrl', '')
        .trim();

    if (externalUrl) {
        try {
            const response = await fetchHttpsBytes(new URL(externalUrl), {
                maxBytes: LEGACY_HTML_MAX_BYTES
            });
            if (response.status === 200 && response.body.byteLength > 0) {
                return Buffer.from(response.body).toString('utf8');
            }
            console.warn(`[StepsFetcher] Legacy HTML request returned status ${response.status}.`);
        } catch (error) {
            console.warn('[StepsFetcher] Legacy HTML request failed; using bundled steps.', error);
        }
    }

    const bundledUri = vscode.Uri.joinPath(context.extensionUri, 'res', 'steps.htm');
    return Buffer.from(await vscode.workspace.fs.readFile(bundledUri)).toString('utf8');
}

export async function forceRefreshSteps(context: vscode.ExtensionContext): Promise<string> {
    try {
        const html = await getStepsHtml(context, true);
        const t = await getTranslator(context.extensionUri);
        vscode.window.showInformationMessage(t('Steps library successfully updated.'));
        return html;
    } catch (error) {
        const t = await getTranslator(context.extensionUri);
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(t('Error updating steps: {0}', message));
        throw error;
    }
}
