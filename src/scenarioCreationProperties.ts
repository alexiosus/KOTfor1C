import path from 'node:path';
import * as vscode from 'vscode';
import { ProjectPropertyCatalogStore, type ProjectPropertyCatalogKey } from './projectPropertyCatalogStore';
import { projectLibraryEnvironment } from './projectLibraryIntegration';
import { resolveProjectLibraryRoot } from './projectLibraryMetadata';
import type { Translator } from './localization';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { applyScenarioPropertyEdit, applyYamlMapField } from './scenarioPropertiesModel';

export function applyCreationResponsible(source: string, responsible: string): string {
    const document = ScenarioYamlDocument.parse(source);
    const header = document.findSection('ДанныеПроцесса') ? 'ДанныеПроцесса' : 'ДанныеСценария';
    const oldName = String(document.findField(header, 'Ответственный')?.value ?? '').trim().toLocaleLowerCase();
    let updated = applyScenarioPropertyEdit(source, { section: 'header', field: 'Ответственный', value: responsible });
    if (document.findField(header, 'UIDОтветственный')?.value && oldName !== responsible.trim().toLocaleLowerCase()) {
        updated = applyYamlMapField(updated, [header, 'UIDОтветственный'], '');
    }
    return updated;
}

/** The wizard uses the same portable catalogs as Properties, with an explicit empty responsible. */
export async function promptForCreationProperty(target: vscode.Uri, key: ProjectPropertyCatalogKey, label: string,
    initial: string, t: Translator, allowEmpty = false): Promise<string | undefined> {
    const environment = projectLibraryEnvironment();
    const root = resolveProjectLibraryRoot(target.fsPath, environment.workspaceRoots, environment.scanRoots);
    const store = new ProjectPropertyCatalogStore(root, { beforeWrite: () => {
        if ((vscode.workspace.textDocuments ?? []).some(document => document.isDirty && document.uri.scheme === 'file'
            && path.resolve(document.uri.fsPath) === store.filePath)) { throw new Error(t('Save the modified project catalog before creating a value.')); }
    } });
    const values = [...new Set([initial, ...(await store.read())[key]].filter(Boolean))];
    const picked = await vscode.window.showQuickPick([
        ...values.map(value => ({ label: value, value, action: undefined })),
        { label: `$(add) ${t('Create…')}`, value: undefined, action: 'create' },
        ...(allowEmpty ? [{ label: t('Not specified'), value: '', action: 'none' }] : [])
    ], { title: t(label), ignoreFocusOut: true });
    if (!picked) { return undefined; }
    if (picked.value !== undefined) { return picked.value; }
    const value = await vscode.window.showInputBox({
        title: t(label), prompt: t(label), value: initial, ignoreFocusOut: true,
        validateInput: input => input.trim() && !/[\r\n\0]/u.test(input) ? undefined : t('Name cannot be empty')
    });
    return value === undefined ? undefined : store.add(key, value);
}

/** Processes have their own header; system-function and cross-function flags are scenario fields. */
export async function promptForProcessCreationProperties(target: vscode.Uri, defaults: {
    project: string; reportLevel1: string; reportLevel2: string; responsible?: string;
}, t: Translator): Promise<{ project: string; reportLevel1: string; reportLevel2: string; responsible: string } | undefined> {
    const responsible = await promptForCreationProperty(target, 'responsibles', 'Responsible', defaults.responsible ?? '', t, true);
    if (responsible === undefined) { return undefined; }
    const mode = await vscode.window.showQuickPick([
        { label: t('Use defaults'), mode: 'defaults', detail: t('Project: {0}; report levels: {1} / {2}', defaults.project, defaults.reportLevel1, defaults.reportLevel2) },
        { label: t('Fill manually'), mode: 'manual' }
    ], { title: t('Process header fields'), ignoreFocusOut: true });
    if (!mode) { return undefined; }
    if (mode.mode === 'defaults') { return { ...defaults, responsible }; }
    const project = await promptForCreationProperty(target, 'projects', 'Project', defaults.project, t);
    if (project === undefined) { return undefined; }
    const reportLevel1 = await promptForCreationProperty(target, 'reportLevel1', 'Report level 1', defaults.reportLevel1, t);
    if (reportLevel1 === undefined) { return undefined; }
    const reportLevel2 = await promptForCreationProperty(target, 'reportLevel2', 'Report level 2', defaults.reportLevel2, t);
    return reportLevel2 === undefined ? undefined : { responsible, project, reportLevel1, reportLevel2 };
}
