import type * as vscode from 'vscode';
import { pathToFileURL } from 'node:url';
import { sameProjectDefinitionSource, type ProjectDefinitionView } from './projectDefinition';
import { ScenarioDirectoryIndex, type ScenarioCatalog, type ScenarioCatalogProvider } from './scenarioCatalog';
import {
    ScenarioRelationshipIndex,
    type ScenarioRelationshipEntry,
    type ScenarioRelationshipProjection
} from './scenarioRelationshipIndex';
import { getScenarioRuntimeKey } from './scenarioRuntimeIdentity';
import type { StandaloneFeatureSnapshot } from './standaloneFeatureModel';

const relationshipHighlightConfigurationKey = 'phaseSwitcher.highlightAffectedMainScenarios';
const relationshipHighlightConfigurationPath = `kotTestToolkit.${relationshipHighlightConfigurationKey}`;

interface ScenarioRelationshipConfiguration {
    get<T>(section: string, defaultValue?: T): T | undefined;
    update(section: string, value: unknown, configurationTarget?: unknown): Thenable<void>;
}

interface DefinitionLocationLike { readonly uri: vscode.Uri }
interface DefinitionCancellationTokenLike { readonly isCancellationRequested: boolean }
interface ScenarioProjectDefinitions {
    getView(resource?: vscode.Uri): Promise<ProjectDefinitionView>;
    findReferencesForDefinitions(
        definitionIds: readonly string[],
        resource?: vscode.Uri,
        options?: { readonly includeDeclaration: boolean },
        token?: DefinitionCancellationTokenLike
    ): Promise<ReadonlyMap<string, readonly DefinitionLocationLike[]>>;
    createUri(value: string): vscode.Uri;
    onDidChangeView?: vscode.Event<unknown>;
}

export interface ScenarioRelationshipScanRootPaths {
    readonly scanRootPath: string;
    readonly canonicalScanRootPath: string;
}

export interface ScenarioRelationshipServiceDependencies {
    readonly catalogProvider: ScenarioCatalogProvider;
    readonly getConfiguration: () => ScenarioRelationshipConfiguration;
    readonly workspaceConfigurationTarget: unknown;
    readonly onDidChangeConfiguration: vscode.Event<unknown>;
    readonly getScanRootPaths: () => ScenarioRelationshipScanRootPaths | null;
    readonly resolveAdditionalScenarioKeysForUri?: (uri: vscode.Uri) => readonly string[];
    readonly projectDefinitions?: ScenarioProjectDefinitions;
    readonly standaloneFeatures?: {
        getSnapshot(): StandaloneFeatureSnapshot;
        onDidChange(listener: (snapshot: StandaloneFeatureSnapshot) => void): vscode.Disposable;
        onDidRefresh?(listener: (snapshot: StandaloneFeatureSnapshot) => void): vscode.Disposable;
    };
}

export interface ScenarioDefinitionRelationshipEntry {
    readonly definitionId: string;
    readonly incomingDistance?: number;
    readonly outgoingDistance?: number;
}

export interface ScenarioRelationshipState extends ScenarioRelationshipProjection {
    readonly enabled: boolean;
    readonly currentLabel: string | null;
    readonly currentDefinitionIds: readonly string[];
    readonly definitionRelationships: readonly ScenarioDefinitionRelationshipEntry[];
    readonly revision: number;
}

const emptyProjection: ScenarioRelationshipProjection = Object.freeze({
    currentScenarioKeys: Object.freeze([]),
    relationships: Object.freeze([]),
    affectedMainScenarioKeys: Object.freeze([]),
    affectedPhaseNames: Object.freeze([])
});
const emptyStrings: readonly string[] = Object.freeze([]);
const emptyDefinitionRelationships: readonly ScenarioDefinitionRelationshipEntry[] = Object.freeze([]);

function isRelevantConfigurationEvent(event: unknown): boolean {
    const affectsConfiguration = event && typeof event === 'object'
        ? (event as { affectsConfiguration?: (section: string) => boolean }).affectsConfiguration
        : undefined;
    return typeof affectsConfiguration !== 'function'
        || affectsConfiguration(relationshipHighlightConfigurationPath);
}

function stateValueSignature(state: Omit<ScenarioRelationshipState, 'revision'>): string {
    return JSON.stringify(state);
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right);
}

/** Projects the published scenario and project-definition indexes for the active editor. */
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
    private enrichmentGeneration = 0;

    public readonly onDidChangeState: vscode.Event<ScenarioRelationshipState> = (
        listener,
        thisArgs,
        disposables
    ) => {
        const boundListener = thisArgs
            ? (state: ScenarioRelationshipState) => listener.call(thisArgs, state)
            : listener;
        this.listeners.add(boundListener);
        const disposable: vscode.Disposable = { dispose: () => this.listeners.delete(boundListener) };
        disposables?.push(disposable);
        return disposable;
    };

    constructor(private readonly dependencies: ScenarioRelationshipServiceDependencies) {
        this.catalog = dependencies.catalogProvider.getScenarioCatalog();
        this.relationshipIndex = this.catalog ? ScenarioRelationshipIndex.fromCatalog(this.catalog) : null;
        this.enabled = dependencies.getConfiguration()
            .get<boolean>(relationshipHighlightConfigurationKey, true) ?? true;
        this.state = Object.freeze({
            ...emptyProjection,
            enabled: this.enabled,
            currentLabel: null,
            currentDefinitionIds: emptyStrings,
            definitionRelationships: emptyDefinitionRelationships,
            revision: 0
        });

        this.subscriptions.push(dependencies.catalogProvider.onDidUpdateScenarioCatalog(catalog => {
            if (catalog === this.catalog) {
                return;
            }
            this.catalog = catalog;
            this.relationshipIndex = catalog ? ScenarioRelationshipIndex.fromCatalog(catalog) : null;
            this.directoryIndexCache = null;
            this.publishState(true);
        }));
        this.subscriptions.push(dependencies.onDidChangeConfiguration(event => {
            if (!isRelevantConfigurationEvent(event)) {
                return;
            }
            const nextEnabled = dependencies.getConfiguration()
                .get<boolean>(relationshipHighlightConfigurationKey, true) ?? true;
            if (nextEnabled !== this.enabled) {
                this.enabled = nextEnabled;
                this.publishState();
            }
        }));
        if (dependencies.projectDefinitions?.onDidChangeView) {
            this.subscriptions.push(dependencies.projectDefinitions.onDidChangeView(() => this.publishState(true)));
        }
        if (dependencies.standaloneFeatures) {
            const standalone = dependencies.standaloneFeatures;
            const refresh = () => this.publishState(true);
            this.subscriptions.push(standalone.onDidRefresh ? standalone.onDidRefresh(refresh) : standalone.onDidChange(refresh));
        }
    }

    public getState(): ScenarioRelationshipState { return this.state; }

    public handleActiveEditorChanged(uri: vscode.Uri | undefined): void {
        if ((this.activeUri?.toString() ?? null) === (uri?.toString() ?? null)) {
            return;
        }
        this.activeUri = uri;
        this.publishState();
    }

    public async setEnabled(enabled: boolean): Promise<void> {
        await this.dependencies.getConfiguration().update(
            relationshipHighlightConfigurationKey,
            enabled,
            this.dependencies.workspaceConfigurationTarget
        );
        if (this.enabled !== enabled) {
            this.enabled = enabled;
            this.publishState();
        }
    }

    public dispose(): void {
        this.enrichmentGeneration += 1;
        for (const subscription of this.subscriptions.splice(0)) {
            subscription.dispose();
        }
        this.listeners.clear();
    }

    private publishState(force: boolean = false): void {
        const generation = ++this.enrichmentGeneration;
        this.commitState(this.buildBaseStateValue(), force);
        if (this.dependencies.projectDefinitions && this.activeUri) {
            void this.buildEnrichedStateValue(generation).then(value => {
                if (value && generation === this.enrichmentGeneration) {
                    this.commitState(value);
                }
            }).catch(() => undefined);
        }
    }

    private commitState(nextValue: Omit<ScenarioRelationshipState, 'revision'>, force = false): void {
        const { revision: _revision, ...currentValue } = this.state;
        if (!force && stateValueSignature(nextValue) === stateValueSignature(currentValue)) {
            return;
        }
        this.state = Object.freeze({ ...nextValue, revision: this.state.revision + 1 });
        for (const listener of [...this.listeners]) {
            listener(this.state);
        }
    }

    private buildBaseStateValue(): Omit<ScenarioRelationshipState, 'revision'> {
        const currentScenarioKeys = this.resolveScenarioKeysForUri(this.activeUri);
        const projection = this.relationshipIndex
            ? this.relationshipIndex.project(currentScenarioKeys)
            : { ...emptyProjection, currentScenarioKeys: Object.freeze([...currentScenarioKeys]) };
        const standaloneIds = new Set(this.dependencies.standaloneFeatures?.getSnapshot().features.map(feature => feature.id) ?? []);
        return {
            ...projection,
            currentScenarioKeys: Object.freeze([...new Set([
                ...projection.currentScenarioKeys, ...currentScenarioKeys.filter(key => standaloneIds.has(key))
            ])]),
            enabled: this.enabled,
            currentLabel: this.resolveCurrentLabel(currentScenarioKeys),
            currentDefinitionIds: emptyStrings,
            definitionRelationships: emptyDefinitionRelationships
        };
    }

    private async buildEnrichedStateValue(
        generation: number
    ): Promise<Omit<ScenarioRelationshipState, 'revision'> | null> {
        const definitions = this.dependencies.projectDefinitions;
        const activeUri = this.activeUri;
        if (!definitions || !activeUri) {
            return null;
        }
        const view = await definitions.getView(activeUri);
        if (generation !== this.enrichmentGeneration) {
            return null;
        }
        const exports = view.all.filter(definition => definition.kind === 'exportScenario');
        const service = this;
        const token: DefinitionCancellationTokenLike = {
            get isCancellationRequested() { return generation !== service.enrichmentGeneration; }
        };
        const references = await definitions.findReferencesForDefinitions(
            exports.map(definition => definition.id),
            activeUri,
            { includeDeclaration: false },
            token
        );
        if (generation !== this.enrichmentGeneration) {
            return null;
        }

        const base = this.buildBaseStateValue();
        const activeUriKey = activeUri.toString();
        const currentDefinitionIds = exports
            .filter(definition => [definition.definitionLocation?.uri, definition.implementationLocation?.uri]
                .some(uri => sameProjectDefinitionSource(uri, activeUriKey)))
            .map(definition => definition.id)
            .sort(compareText);
        const callersByDefinition = new Map<string, readonly string[]>();
        for (const definition of exports) {
            const callerKeys = new Set<string>();
            for (const location of references.get(definition.id) ?? []) {
                for (const key of this.resolveScenarioKeysForUri(location.uri)) {
                    callerKeys.add(key);
                }
            }
            callersByDefinition.set(definition.id, Object.freeze([...callerKeys].sort(compareText)));
        }

        const definitionRelationships = base.currentScenarioKeys.length === 0
            ? emptyDefinitionRelationships
            : Object.freeze(exports
                .filter(definition => callersByDefinition.get(definition.id)?.some(
                    key => base.currentScenarioKeys.includes(key)
                ))
                .map(definition => Object.freeze({ definitionId: definition.id, outgoingDistance: 1 }))
                .sort((left, right) => compareText(left.definitionId, right.definitionId)));

        if (currentDefinitionIds.length === 0) {
            return {
                ...base,
                currentDefinitionIds: Object.freeze(currentDefinitionIds),
                definitionRelationships
            };
        }

        const directCallers = new Set<string>();
        for (const definitionId of currentDefinitionIds) {
            for (const callerKey of callersByDefinition.get(definitionId) ?? []) {
                directCallers.add(callerKey);
            }
        }
        const relationshipMap = new Map<string, ScenarioRelationshipEntry>();
        const affectedMainScenarioKeys = new Set<string>();
        const affectedPhaseNames = new Set<string>();
        for (const callerKey of directCallers) {
            relationshipMap.set(callerKey, { scenarioKey: callerKey, incomingDistance: 1 });
            const projection = this.relationshipIndex?.project([callerKey]) ?? emptyProjection;
            for (const entry of projection.relationships) {
                if (entry.incomingDistance === undefined) {
                    continue;
                }
                const distance = entry.incomingDistance + 1;
                const previous = relationshipMap.get(entry.scenarioKey)?.incomingDistance;
                if (previous === undefined || distance < previous) {
                    relationshipMap.set(entry.scenarioKey, { scenarioKey: entry.scenarioKey, incomingDistance: distance });
                }
            }
            projection.affectedMainScenarioKeys.forEach(key => affectedMainScenarioKeys.add(key));
            projection.affectedPhaseNames.forEach(name => affectedPhaseNames.add(name));
        }
        const relationships = [...relationshipMap.values()].sort((left, right) =>
            (left.incomingDistance ?? Infinity) - (right.incomingDistance ?? Infinity)
            || compareText(left.scenarioKey, right.scenarioKey)
        );
        const definitionLabels = currentDefinitionIds
            .map(id => view.byId.get(id)?.template?.trim() ?? '')
            .filter(Boolean);
        return {
            ...base,
            currentLabel: definitionLabels.length > 0 ? definitionLabels.join(' / ') : base.currentLabel,
            relationships: Object.freeze(relationships),
            affectedMainScenarioKeys: Object.freeze([...affectedMainScenarioKeys].sort(compareText)),
            affectedPhaseNames: Object.freeze([...affectedPhaseNames].sort(compareText)),
            currentDefinitionIds: Object.freeze(currentDefinitionIds),
            definitionRelationships
        };
    }

    private resolveScenarioKeysForUri(uri: vscode.Uri | undefined): readonly string[] {
        const catalog = this.catalog;
        if (!uri) {
            return emptyProjection.currentScenarioKeys;
        }
        const canonicalUri = uri.scheme === 'file'
            ? pathToFileURL(process.platform === 'win32' ? uri.fsPath.toLocaleLowerCase() : uri.fsPath).toString()
            : uri.toString();
        const standalone = this.dependencies.standaloneFeatures?.getSnapshot().features.find(feature => feature.uri === canonicalUri);
        if (standalone) { return Object.freeze([standalone.id]); }
        if (!catalog) { return emptyProjection.currentScenarioKeys; }
        const additionalKeys = this.dependencies.resolveAdditionalScenarioKeysForUri?.(uri) ?? [];
        const normalizedAdditionalKeys = [...new Set(additionalKeys
            .map(key => typeof key === 'string' ? key.trim() : '')
            .filter(Boolean))];
        if (normalizedAdditionalKeys.length > 0) {
            return Object.freeze(normalizedAdditionalKeys);
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
        if (!this.directoryIndexCache
            || this.directoryIndexCache.catalog !== catalog
            || this.directoryIndexCache.scanRootPath !== scanRootPaths.scanRootPath
            || this.directoryIndexCache.canonicalScanRootPath !== scanRootPaths.canonicalScanRootPath) {
            this.directoryIndexCache = {
                catalog,
                ...scanRootPaths,
                index: new ScenarioDirectoryIndex(
                    catalog.all.filter(info => info.yamlFileUri.scheme === 'file').map(info => ({
                        key: getScenarioRuntimeKey(info),
                        name: info.name,
                        filePath: info.yamlFileUri.fsPath
                    })),
                    scanRootPaths.scanRootPath,
                    scanRootPaths.canonicalScanRootPath
                )
            };
        }
        return Object.freeze(this.directoryIndexCache.index.getRelatedScenarioKeys(uri.fsPath));
    }

    private resolveCurrentLabel(currentScenarioKeys: readonly string[]): string | null {
        if (currentScenarioKeys.length === 0) {
            return null;
        }
        const scenariosByKey = new Map((this.catalog?.all ?? []).map(info => [getScenarioRuntimeKey(info), info] as const));
        const featuresById = new Map(this.dependencies.standaloneFeatures?.getSnapshot().features.map(feature => [feature.id, feature]) ?? []);
        const names = [...new Set(currentScenarioKeys
            .map(key => featuresById.get(key)?.title?.trim() || featuresById.get(key)?.name?.trim() || scenariosByKey.get(key)?.name?.trim() || '')
            .filter(Boolean))];
        return names.length > 0 ? names.join(' / ') : null;
    }
}
