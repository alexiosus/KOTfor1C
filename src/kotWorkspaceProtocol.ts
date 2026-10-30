import type { SettingsScope } from './kotSettingsSession';

export const workspaceActions: Readonly<Record<string, string>> = {
    library: 'kotTestToolkit.openStepLibrary', manager: 'kotTestToolkit.phaseSwitcherView.focus',
    infobases: 'kotTestToolkit.openInfobaseManager', properties: 'kotTestToolkit.scenarioProperties.focus',
    variables: 'kotTestToolkit.vanessaVariables.focus', parameters: 'kotTestToolkit.openYamlParametersManager',
    platforms: 'kotTestToolkit.managePlatforms', functions: 'kotTestToolkit.manageSystemFunctions', numbering: 'kotTestToolkit.manageTestNumbering'
};
export interface KotWorkspaceRequest {
    id: string; type: string; folder?: string; scope?: SettingsScope; key?: string; action?: string; value?: unknown; data?: unknown;
}
const types = new Set(['ready', 'settings', 'applySettings', 'pickPath', 'scan', 'checkRuntime', 'reviewSetup', 'applySetup', 'cancel', 'openNative', 'action', 'openExample', 'openWorkshop', 'progress', 'loadProgress', 'draft', 'chooseFolder', 'openProjectWindow', 'retryExecution']);
/** Validate messages at the extension boundary; never pass arbitrary commands or resource URIs through. */
export function parseKotWorkspaceRequest(message: unknown, folders: readonly string[]): KotWorkspaceRequest {
    if (!message || typeof message !== 'object' || Array.isArray(message)) { throw new Error('Invalid KOT request'); }
    const request = message as KotWorkspaceRequest;
    if (typeof request.id !== 'string' || request.id.length > 100 || !types.has(request.type)) { throw new Error('Invalid KOT request'); }
    if (request.type === 'ready' && !folders.includes(request.folder ?? '')) { return { id: request.id, type: 'ready' }; }
    if (request.folder !== undefined && (typeof request.folder !== 'string' || !folders.includes(request.folder))) { throw new Error('Select an open project folder'); }
    if (request.scope !== undefined && !['user', 'workspace', 'folder'].includes(request.scope)) { throw new Error('Invalid settings scope'); }
    if (request.type === 'action' && (typeof request.action !== 'string' || !Object.hasOwn(workspaceActions, request.action))) { throw new Error('Unknown KOT action'); }
    return request;
}
