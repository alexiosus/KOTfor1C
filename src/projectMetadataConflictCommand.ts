import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyMetadataResolution, listMetadataConflicts, metadataGit, prepareMetadataResolution } from './projectMetadataConflicts';
import { auditMetadataReferences } from './projectMetadataAudit';
import type { MetadataChoices } from './projectMetadataMerge';

/** Registered before project discovery so malformed/conflicted catalogs cannot hide the repair action. */
export function registerMetadataConflictCommand(context: vscode.ExtensionContext): void {
    const documents = new Map<string, string>();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('kot-metadata-review', {
        provideTextDocumentContent: uri => documents.get(uri.toString()) ?? ''
    }));
    context.subscriptions.push(vscode.commands.registerCommand('kotTestToolkit.resolveMetadataConflicts', async () => {
        try {
            const roots = new Set<string>();
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                if (folder.uri.scheme !== 'file') { continue; }
                try { roots.add((await metadataGit(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim()); } catch { /* A workspace can include folders outside Git. */ }
            }
            const files = (await Promise.all([...roots].map(async root => (await listMetadataConflicts(root)).map(relative => ({ root, relative,
                label: relative, description: path.basename(root) }))))).flat();
            if (!files.length) { await vscode.window.showInformationMessage(vscode.l10n.t('No KOT metadata conflicts found in Git.')); return; }
            const selected = await vscode.window.showQuickPick(files, { title: vscode.l10n.t('Resolve KOT metadata conflicts') });
            if (!selected) { return; }
            const choices: Record<string, 'ours' | 'theirs'> = {};
            let review = await prepareMetadataResolution(selected.root, selected.relative);
            for (const conflict of review.merge.conflicts) {
                const choice = await vscode.window.showQuickPick([
                    { label: vscode.l10n.t('Keep ours'), description: JSON.stringify(conflict.ours) ?? vscode.l10n.t('Delete'), value: 'ours' as const },
                    { label: vscode.l10n.t('Keep theirs'), description: JSON.stringify(conflict.theirs) ?? vscode.l10n.t('Delete'), value: 'theirs' as const }
                ], { title: `${selected.relative}: ${conflict.path || '/'}`, placeHolder: vscode.l10n.t('Base: {0}', JSON.stringify(conflict.base) ?? '∅') });
                if (!choice) { return; } choices[conflict.path] = choice.value;
            }
            if (Object.keys(choices).length) {
                const current = await prepareMetadataResolution(selected.root, selected.relative, choices as MetadataChoices);
                if (current.index !== review.index || current.original !== review.original) { throw new Error(vscode.l10n.t('Metadata changed while choosing a resolution. Start again.')); }
                review = current;
            }
            const id = randomUUID(); const before = vscode.Uri.parse(`kot-metadata-review:/${id}/before.yml`);
            const after = vscode.Uri.parse(`kot-metadata-review:/${id}/after.yml`);
            documents.set(before.toString(), review.original ?? ''); documents.set(after.toString(), review.merge.text ?? '');
            await vscode.commands.executeCommand('vscode.diff', before, after, vscode.l10n.t('KOT metadata: review changes'));
            const apply = vscode.l10n.t('Apply reviewed resolution');
            const action = await vscode.window.showInformationMessage(vscode.l10n.t('Review the diff, then apply. Git staging remains a separate action.'), apply, vscode.l10n.t('Cancel'));
            if (action !== apply) { return; }
            const dirty = (file: string) => vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file'
                && path.resolve(document.uri.fsPath).toLowerCase() === path.resolve(file).toLowerCase() && document.isDirty);
            await applyMetadataResolution(review, dirty);
            const warnings = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking metadata references…') }, () => auditMetadataReferences(review.root));
            if (warnings.length) {
                const report = await vscode.workspace.openTextDocument({ language: 'plaintext', content: warnings.join('\n') });
                await vscode.window.showTextDocument(report, { preview: true });
            }
            await vscode.window.showInformationMessage(vscode.l10n.t('Resolution saved. Review and stage it in Source Control. Numbering merges do not remove duplicate test codes; check build diagnostics.'));
        } catch (error) { await vscode.window.showErrorMessage(vscode.l10n.t('Could not resolve KOT metadata: {0}', error instanceof Error ? error.message : String(error))); }
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === 'kot-metadata-review') { documents.delete(document.uri.toString()); }
    }));
}
