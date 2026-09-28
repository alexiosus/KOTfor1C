import type * as vscode from 'vscode';
import {
    ScenarioDirectoryIndex,
    type ScenarioCatalog,
    type ScenarioCatalogProvider
} from './scenarioCatalog';
import {
    ScenarioRelationshipIndex,
    type ScenarioRelationshipProjection
} from './scenarioRelationshipIndex';
import { getScenarioRuntimeKey } from './scenarioRuntimeIdentity';

const relationshipHighlightConfigurationKey = 'phaseSwitcher.highlightAffectedMainScenarios';
const relationshipHighlightConfigurationPath = `kotTestToolkit.${relationshipHighlightConfigurationKey}`;

interface ScenarioRelationshipConfiguration {
    get<T>(section: string, defaultValue?: T): T | undefined;
    update(section: string, value: unknown, configurationTarget?: unknown): Thenable<void>;
}

export interface ScenarioRelationshipScanRootPaths {
    readonly scanRootPath: string;
    readonly canonicalScanRootPath: string;
}

export interface ScenarioRelationshipServiceDependencies {
    readonly catalogProvider: ScenarioCatalogProvider;
    readonly configuration: ScenarioRelationshipConfiguration;
    readonly workspaceConfigurationTarget: unknown;
    readonly onDidChangeConfiguration: vscode.Event<unknown>;
    readonly getScanRootPaths: () => ScenarioRelationshipScanRootPaths | null;
}

export interface ScenarioRelationshipState extends ScenarioRelationshipProjection {
    readonly enabled: boolean;
    readonly currentLabel: string | null;
    readonly revision: number;
}

const emptyProjection: ScenarioRelationshipProjection = Object.freeze({
    currentScenarioKeys: Object.freeze([]),
    relationships: Object.freeze([]),
    affectedMainScenarioKeys: Object.freeze([]),
    affectedPhaseNames: Object.freeze([])
});

function isRelevantConfigurationEvent(event: unknown): boolean {
    if (!event || typeof event !== 'object') {
        return true;
    }
    const affectsConfiguration = (event as {
        affectsConfiguration?: (section: string) => boolean;
    }).affectsConfiguration;
    return typeof affectsConfiguration !== 'function'
        || affectsConfiguration(relationshipHighlightConfigurationPath);
}

function stateValueSignature(state: Omit<ScenarioRelationshipState, 'revision'>): string {
    return JSON.stringify(state);
}

/**
 * Projects the already-published scenario catalog for the active editor.
 * The service deliberately performs no scanning or file-system I/O.
 */
export class ScenarioRelationshipService implements vscode.Disposable {
    private readonly listeners = new Set<(state: ScenarioRelationshipState) => unknown>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private catalog: ScenarioCatalog | null;
    private relationshipIndex: ScenarioRelationshipIndex | null;
    private directoryIndexCache: {
        readonly catalog: ScenarioCatalog;
        readonly scanRootPath: string;
        readonly canonicalScanRootPath: string;
        readonly index: ScenarioDirectoryIndex;
    } | null = null;
    private activeUri: vscode.Uri | undefined;
    private enabled: boolean;
    private state: ScenarioRelationshipState;

    public readonly onDidChangeState: vscode.Event<ScenarioRelationshipState> = (
        listener,
        thisArgs,
        disposables
    ) => {
        const boundListener = thisArgs
            ? (state: ScenarioRelationshipState) => listener.call(thisArgs, state)
            : listener;
        this.listeners.add(boundListener);
        const disposable: vscode.Disposable = {
            dispose: () => this.listeners.delete(boundListener)
        };
        disposables?.push(disposable);
        return disposable;
    };

    constructor(private readonly dependencies: ScenarioRelationshipServiceDependencies) {
        this.catalog = dependencies.catalogProvider.getScenarioCatalog();
        this.relationshipIndex = this.catalog
            ? ScenarioRelationshipIndex.fromCatalog(this.catalog)
            : null;
        this.enabled = dependencies.configuration.get<boolean>(
            relationshipHighlightConfigurationKey,
            true
        ) ?? true;
        this.state = Object.freeze({
            ...emptyProjection,
            enabled: this.enabled,
            currentLabel: null,
            revision: 0
        });

        this.subscriptions.push(dependencies.catalogProvider.onDidUpdateScenarioCatalog(catalog => {
            if (catalog === this.catalog) {
                return;
            }
            this.catalog = catalog;
            this.relationshipIndex = catalog
                ? ScenarioRelationshipIndex.fromCatalog(catalog)
                : null;
            this.directoryIndexCache = null;
            this.publishState(true);
        }));
        this.subscriptions.push(dependencies.onDidChangeConfiguration(event => {
            if (!isRelevantConfigurationEvent(event)) {
                return;
            }
            const nextEnabled = dependencies.configuration.get<boolean>(
                relationshipHighlightConfigurationKey,
                true
            ) ?? true;
            if (nextEnabled === this.enabled) {
                return;
            }
            this.enabled = nextEnabled;
            this.publishState();
        }));
    }

    public getState(): ScenarioRelationshipState {
        return this.state;
    }

    public handleActiveEditorChanged(uri: vscode.Uri | undefined): void {
        const previousUri = this.activeUri?.toString() ?? null;
        const nextUri = uri?.toString() ?? null;
        if (previousUri === nextUri) {
            return;
        }

        this.activeUri = uri;
        this.publishState();
    }

    public async setEnabled(enabled: boolean): Promise<void> {
        await this.dependencies.configuration.update(
            relationshipHighlightConfigurationKey,
            enabled,
            this.dependencies.workspaceConfigurationTarget
        );
        if (this.enabled === enabled) {
            return;
        }
        this.enabled = enabled;
        this.publishState();
    }

    public dispose(): void {
        for (const subscription of this.subscriptions.splice(0)) {
            subscription.dispose();
        }
        this.listeners.clear();
    }

    private publishState(force: boolean = false): void {
        const nextValue = this.buildStateValue();
        const currentValue: Omit<ScenarioRelationshipState, 'revision'> = {
            enabled: this.state.enabled,
            currentLabel: this.state.currentLabel,
            currentScenarioKeys: this.state.currentScenarioKeys,
            relationships: this.state.relationships,
            affectedMainScenarioKeys: this.state.affectedMainScenarioKeys,
            affectedPhaseNames: this.state.affectedPhaseNames
        };
        if (!force && stateValueSignature(nextValue) === stateValueSignature(currentValue)) {
            return;
        }

        this.state = Object.freeze({
            ...nextValue,
            revision: this.state.revision + 1
        });
        for (const listener of [...this.listeners]) {
            listener(this.state);
        }
    }

    private buildStateValue(): Omit<ScenarioRelationshipState, 'revision'> {
        const currentScenarioKeys = this.resolveCurrentScenarioKeys();
        const currentLabel = this.resolveCurrentLabel(currentScenarioKeys);
        if (!this.enabled || !this.relationshipIndex) {
            return {
                enabled: this.enabled,
                currentLabel,
                currentScenarioKeys: Object.freeze([...currentScenarioKeys]),
                relationships: emptyProjection.relationships,
                affectedMainScenarioKeys: emptyProjection.affectedMainScenarioKeys,
                affectedPhaseNames: emptyProjection.affectedPhaseNames
            };
        }

        return {
            ...this.relationshipIndex.project(currentScenarioKeys),
            enabled: true,
            currentLabel
        };
    }

    private resolveCurrentScenarioKeys(): readonly string[] {
        const catalog = this.catalog;
        const uri = this.activeUri;
        if (!catalog || !uri) {
            return emptyProjection.currentScenarioKeys;
        }

        const exactScenario = catalog.byUri.get(uri.toString());
        if (exactScenario) {
            return Object.freeze([getScenarioRuntimeKey(exactScenario)]);
        }
        if (uri.scheme !== 'file') {
            return emptyProjection.currentScenarioKeys;
        }

        const scanRootPaths = this.dependencies.getScanRootPaths();
        if (!scanRootPaths) {
            return emptyProjection.currentScenarioKeys;
        }
        if (
            !this.directoryIndexCache
            || this.directoryIndexCache.catalog !== catalog
            || this.directoryIndexCache.scanRootPath !== scanRootPaths.scanRootPath
            || this.directoryIndexCache.canonicalScanRootPath !== scanRootPaths.canonicalScanRootPath
        ) {
            this.directoryIndexCache = {
                catalog,
                ...scanRootPaths,
                index: new ScenarioDirectoryIndex(
                    catalog.all
                        .filter(info => info.yamlFileUri.scheme === 'file')
                        .map(info => ({
                            key: getScenarioRuntimeKey(info),
                            name: info.name,
                            filePath: info.yamlFileUri.fsPath
                        })),
                    scanRootPaths.scanRootPath,
                    scanRootPaths.canonicalScanRootPath
                )
            };
        }

        return Object.freeze(
            this.directoryIndexCache.index.getRelatedScenarioKeys(uri.fsPath)
        );
    }

    private resolveCurrentLabel(currentScenarioKeys: readonly string[]): string | null {
        if (!this.catalog || currentScenarioKeys.length === 0) {
            return null;
        }
        const scenariosByKey = new Map(
            this.catalog.all.map(info => [getScenarioRuntimeKey(info), info] as const)
        );
        const names = [...new Set(currentScenarioKeys
            .map(key => scenariosByKey.get(key)?.name?.trim() ?? '')
            .filter(Boolean))];
        return names.length > 0 ? names.join(' / ') : null;
    }
}
