import * as vscode from 'vscode';
import { SettingsDraftSession } from './kotSettingsSession';
import type { KotSettingsModel } from './kotSettingsModel';

export function createWorkspaceSettingsSession(model: KotSettingsModel): SettingsDraftSession {
    const folder = (identity: string) => {
        const found = vscode.workspace.workspaceFolders?.find(value => value.uri.toString() === identity);
        if (identity && !found) { throw new Error('The project was closed'); }
        return found;
    };
    const config = (identity: string) => vscode.workspace.getConfiguration('kotTestToolkit', folder(identity)?.uri);
    const simpleFolder = () => !vscode.workspace.workspaceFile && vscode.workspace.workspaceFolders?.length === 1;
    const property = (key: string) => key.replace(/^kotTestToolkit\./u, '');
    return new SettingsDraftSession(model.settings, {
        inspect: (key, identity) => {
            const layers = config(identity).inspect(property(key));
            return { defaultValue: layers?.defaultValue, globalValue: layers?.globalValue,
                // A single-folder window aliases these two values to the same settings file.
                workspaceValue: layers?.workspaceValue, workspaceFolderValue: simpleFolder() ? undefined : layers?.workspaceFolderValue };
        },
        normalizeScope: scope => scope === 'folder' && simpleFolder() ? 'workspace' : scope,
        assertWritable: (key, scope, identity) => {
            const definition = model.settings.find(item => item.key === key)!;
            if (scope !== 'user' && !vscode.workspace.isTrusted) { throw new Error('Trust the workspace before changing project settings'); }
            if (scope !== 'user' && !folder(identity)) { throw new Error('Open a project folder first'); }
            if (scope === 'folder' && !simpleFolder() && !['resource', 'language-overridable', 'machine-overridable'].includes(definition.configScope ?? 'window')) { throw new Error('This setting applies to the whole window. Choose Workspace or User scope'); }
            if (definition.secret && scope !== 'user') { throw new Error('Save access keys in User settings'); }
            if (definition.editor === 'manager' || definition.editor === 'action') { throw new Error('Use the dedicated editor for this setting'); }
        },
        update: async (key, value, scope, identity) => {
            const target = scope === 'user' ? vscode.ConfigurationTarget.Global : scope === 'workspace' || simpleFolder() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.WorkspaceFolder;
            await config(identity).update(property(key), value, target);
        }
    });
}
