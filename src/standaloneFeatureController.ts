import * as vscode from 'vscode';
import { createFeature, generateFeatureJson } from './featureCreator';
import { renameStandaloneFeatureTitle, renameStandaloneFeatureFile } from './featureRenameCommands';
import type { StandaloneFeatureService } from './standaloneFeatureService';
import type { StandaloneFeatureSnapshot } from './standaloneFeatureModel';

export type StandaloneFeatureAction =
    | 'createFeature' | 'createGroup' | 'renameGroup' | 'deleteGroup' | 'reorderGroup'
    | 'openScenarioProperties' | 'openFeature' | 'renameFeature' | 'renameFeatureFile' | 'generateJson' | 'selectJson' | 'openJson' | 'moveFeature'
    | 'run' | 'openLog' | 'watchLog' | 'openRunStep';

export interface StandaloneFeatureMessage {
    readonly command: 'standaloneFeatureAction';
    readonly action: StandaloneFeatureAction;
    readonly featureId?: string;
    readonly groupId?: string;
    readonly beforeId?: string;
    readonly projectRoot?: string;
    readonly revision?: number;
    readonly expectedIds?: readonly string[];
}

export interface StandaloneFeatureControllerOptions {
    readonly run?: (featureId: string) => Promise<void>;
    readonly openLog?: (featureId: string) => Promise<void>;
    readonly watchLog?: (featureId: string) => Promise<void>;
    readonly openRunStep?: (featureId: string) => Promise<void>;
}

export type StandaloneFeatureCatalog = Pick<StandaloneFeatureService,
    | 'getSnapshot' | 'ensureReady' | 'refresh' | 'onDidChange' | 'find'
    | 'createGroup' | 'renameGroup' | 'deleteGroup' | 'moveGroupDisplay' | 'moveFeature' | 'setLaunchJson'>;

function t(message: string): string {
    return typeof vscode.l10n?.t === 'function' ? vscode.l10n.t(message) : message;
}

export function getStandaloneFeatureLabels(translate: (message: string) => string = t): Record<string, string> {
    const t = translate;
    return {
        title: t('Standalone features'), ungrouped: t('Ungrouped'),
        createFeature: t('New feature'), createGroup: t('New feature group'),
        renameGroup: t('Rename group'), deleteGroup: t('Delete group'),
        dragToReorder: t('Drag to reorder'),
        openFeature: t('Open feature'), generateJson: t('Generate launch JSON'),
        renameFeature: t('Change feature title'), renameFeatureFile: t('Rename feature file'),
        renameScenario: t('Rename scenario'), renameMainGroup: t('Rename group'), scenarioActions: t('Scenario actions'),
        convertFormat: translate('Convert source format…'),
        openScenarioProperties: t('Open test properties'),
        deleteDefinition: t('Delete'), renameProcess: t('Rename process'), processActions: t('Process actions'),
        selectJson: t('Select launch JSON'), openJson: t('Open launch JSON'),
        moveFeature: t('Move feature'), moveUp: t('Move up'), moveDown: t('Move down'),
        run: t('Run feature'), openLog: t('Open run log'), watchLog: t('Watch run log'),
        empty: t('No standalone features found.'), noMatches: t('No features match the search.'),
        emptyGroup: t('Empty group'), idle: t('Not run'), running: t('Running'),
        passed: t('Passed'), failed: t('Failed'), actions: t('Feature actions'), stepActions: t('Actions'),
        error: t('The feature action could not be completed.')
    };
}

function id(value: unknown, allowEmpty = false): string | null {
    if (typeof value !== 'string' || value.length > 8_192 || /[\r\n\0]/u.test(value)) {
        return null;
    }
    const result = value.trim();
    return result || allowEmpty ? result : null;
}

export function parseStandaloneFeatureMessage(value: unknown): StandaloneFeatureMessage | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.command !== 'standaloneFeatureAction') {
        return null;
    }
    const action = record.action;
    const featureActions = ['openScenarioProperties', 'openFeature', 'renameFeature', 'renameFeatureFile', 'generateJson', 'selectJson', 'openJson', 'moveFeature', 'run', 'openLog', 'watchLog', 'openRunStep'];
    if (action !== 'createFeature' && action !== 'createGroup' && action !== 'renameGroup' && action !== 'deleteGroup' && action !== 'reorderGroup' && !featureActions.includes(action as string)) {
        return null;
    }
    const featureId = record.featureId === undefined ? undefined : id(record.featureId);
    const groupId = record.groupId === undefined ? undefined : id(record.groupId, true);
    const beforeId = record.beforeId === undefined ? undefined : id(record.beforeId);
    if (featureId === null || groupId === null || beforeId === null
        || (featureActions.includes(action as string) && !featureId)
        || ((action === 'renameGroup' || action === 'deleteGroup' || action === 'reorderGroup') && !groupId)
        || (beforeId !== undefined && action !== 'moveFeature' && action !== 'reorderGroup')
        || (record.revision !== undefined && (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0))
        || (record.projectRoot !== undefined && (typeof record.projectRoot !== 'string' || !record.projectRoot || record.projectRoot.includes('\0')))
        || (action === 'reorderGroup' && (!Array.isArray(record.expectedIds) || record.expectedIds.some(value => typeof value !== 'string' || !value)
            || record.revision === undefined || record.projectRoot === undefined))
        || ((record.revision === undefined) !== (record.projectRoot === undefined))) {
        return null;
    }
    return {
        command: 'standaloneFeatureAction', action: action as StandaloneFeatureAction,
        ...(featureId === undefined ? {} : { featureId }),
        ...(groupId === undefined ? {} : { groupId }),
        ...(beforeId === undefined ? {} : { beforeId }),
        ...(record.revision === undefined ? {} : { revision: record.revision as number, projectRoot: record.projectRoot as string }),
        ...(action === 'reorderGroup' ? { expectedIds: record.expectedIds as string[] } : {})
    };
}

export class StandaloneFeatureController implements vscode.Disposable {
    private readonly subscription: vscode.Disposable;
    private readonly pending = new Set<string>();
    private snapshot: StandaloneFeatureSnapshot;
    private ready = false;
    private visible = true;
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly catalog: StandaloneFeatureCatalog,
        private readonly webview: Pick<vscode.Webview, 'postMessage'>,
        private readonly options: StandaloneFeatureControllerOptions = {}
    ) {
        this.snapshot = catalog.getSnapshot();
        this.subscription = catalog.onDidChange(snapshot => {
            this.snapshot = snapshot;
            void this.postCurrentSnapshot();
        });
    }

    public setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) {
            void this.postCurrentSnapshot();
        }
    }

    public async postSnapshot(): Promise<void> {
        this.snapshot = await this.catalog.ensureReady();
        this.ready = true;
        await this.postCurrentSnapshot();
    }

    public async refresh(): Promise<void> {
        this.snapshot = await this.catalog.refresh();
        await this.postCurrentSnapshot();
    }

    private async postCurrentSnapshot(): Promise<void> {
        if (!this.disposed && this.ready && this.visible) {
            await this.webview.postMessage({ command: 'standaloneFeatures', snapshot: this.snapshot });
        }
    }

    public async handleMessage(value: unknown): Promise<boolean> {
        const message = parseStandaloneFeatureMessage(value);
        if (!message || this.disposed) {
            return false;
        }
        const key = `${message.action}\0${message.featureId ?? message.groupId ?? ''}`;
        if (this.pending.has(key)) {
            return true;
        }
        this.pending.add(key);
        try {
            await this.performAction(message);
        } catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            if (!this.disposed) {
                await this.webview.postMessage({
                    command: 'standaloneFeatureActionResult', action: message.action,
                    featureId: message.featureId, succeeded: false, message: errorText
                });
                await vscode.window.showErrorMessage(errorText);
            }
        } finally {
            this.pending.delete(key);
        }
        return true;
    }

    private validGroup(groupId: string): boolean {
        return groupId === '' || this.catalog.getSnapshot().groups.some(group => group.id === groupId);
    }

    private async groupName(current?: string): Promise<string | undefined> {
        const answer = await vscode.window.showInputBox({
            title: current === undefined ? t('New feature group') : t('Rename group'),
            prompt: t('Group name'), value: current ?? '',
            validateInput: value => value.trim() ? undefined : t('Enter a group name.')
        });
        return answer?.trim() || undefined;
    }

    private async performAction(message: StandaloneFeatureMessage): Promise<void> {
        if (message.action === 'reorderGroup') {
            await this.catalog.moveGroupDisplay(message.projectRoot!, message.groupId!, message.beforeId, message.expectedIds!, message.revision!);
            return;
        }
        if (message.action === 'createGroup') {
            const name = await this.groupName();
            if (name) {
                await this.catalog.createGroup(name);
            }
            return;
        }
        if (message.action === 'renameGroup' || message.action === 'deleteGroup') {
            const group = this.catalog.getSnapshot().groups.find(value => value.id === message.groupId);
            if (!group) {
                return;
            }
            if (message.action === 'renameGroup') {
                const name = await this.groupName(group.name);
                if (name && name !== group.name) {
                    await this.catalog.renameGroup(group.id, name);
                }
            } else {
                const deleteLabel = t('Delete group');
                const confirmation = await vscode.window.showWarningMessage(
                    t('Delete this group and move its features to Ungrouped?'), { modal: true }, deleteLabel
                );
                if (confirmation === deleteLabel) {
                    await this.catalog.deleteGroup(group.id);
                }
            }
            return;
        }
        if (message.action === 'createFeature') {
            if (message.groupId !== undefined && !this.validGroup(message.groupId)) {
                return;
            }
            const uri = await createFeature(this.context);
            if (uri) {
                await this.refresh();
                const feature = this.catalog.find(uri.toString());
                if (message.groupId && feature) {
                    await this.catalog.moveFeature(feature.id, message.groupId);
                }
            }
            return;
        }
        const feature = this.catalog.find(message.featureId!);
        if (!feature) {
            return;
        }
        const featureUri = vscode.Uri.parse(feature.uri);
        switch (message.action) {
            case 'renameFeature':
                if (await renameStandaloneFeatureTitle(featureUri)) { await this.refresh(); }
                return;
            case 'renameFeatureFile':
                if (await renameStandaloneFeatureFile(featureUri, async () => {
                    if (feature.jsonPath) { await this.catalog.setLaunchJson(feature.id, feature.jsonPath); }
                })) { await this.refresh(); }
                return;
            case 'openScenarioProperties':
                await vscode.commands.executeCommand('kotTestToolkit.openScenarioEditor', featureUri);
                return;
            case 'openFeature':
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(featureUri));
                return;
            case 'generateJson': {
                const uri = await generateFeatureJson(this.context, featureUri);
                if (uri) {
                    await this.catalog.setLaunchJson(feature.id, uri.fsPath);
                }
                return;
            }
            case 'selectJson': {
                const selected = await vscode.window.showOpenDialog({
                    title: t('Select launch JSON'), canSelectMany: false,
                    canSelectFiles: true, canSelectFolders: false, filters: { JSON: ['json'] }
                });
                if (selected?.[0]) {
                    await this.catalog.setLaunchJson(feature.id, selected[0].fsPath);
                }
                return;
            }
            case 'openJson':
                if (feature.jsonPath) {
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(feature.jsonPath)));
                } else {
                    await this.performAction({ ...message, action: 'selectJson' });
                }
                return;
            case 'moveFeature': {
                let groupId = message.groupId;
                const choosingMembership = groupId === undefined;
                if (groupId === undefined) {
                    const choice = await vscode.window.showQuickPick([
                        { label: t('Ungrouped'), groupId: '' },
                        ...this.catalog.getSnapshot().groups.map(group => ({ label: group.name, groupId: group.id }))
                    ], { title: t('Move feature'), placeHolder: t('Choose a destination group') });
                    groupId = choice?.groupId;
                }
                if (groupId === undefined || !this.validGroup(groupId)) {
                    return;
                }
                if (choosingMembership && groupId === feature.groupId) { return; }
                const before = message.beforeId ? this.catalog.find(message.beforeId) : undefined;
                if (message.beforeId && (!before || before.groupId !== groupId || before.id === feature.id)) {
                    return;
                }
                if (message.revision === undefined) {
                    await this.catalog.moveFeature(feature.id, groupId, message.beforeId);
                } else {
                    await this.catalog.moveFeature(feature.id, groupId, message.beforeId, { revision: message.revision, projectRoot: message.projectRoot! });
                }
                return;
            }
            case 'run':
                await this.options.run?.(feature.id);
                return;
            case 'openLog':
                await this.options.openLog?.(feature.id);
                return;
            case 'watchLog':
                await this.options.watchLog?.(feature.id);
                return;
            case 'openRunStep':
                await this.options.openRunStep?.(feature.id);
                return;
        }
    }

    public dispose(): void {
        this.disposed = true;
        this.subscription.dispose();
        this.pending.clear();
    }
}
