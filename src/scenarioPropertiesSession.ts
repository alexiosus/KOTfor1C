import { parseDocument } from 'yaml';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { applyPropertyCatalogPresentation } from './scenarioPropertiesCatalogPresentation';
import type { ScenarioPropertiesCatalogs } from './scenarioPropertiesCatalogs';
import type { ScenarioIdentityChangeResult } from './scenarioPropertyIdentity';
const { remapUri } = require('../media/scenarioPropertiesProtocol.js') as { remapUri(uri: string, moves: ScenarioIdentityChangeResult['uriMoves']): string };
import { buildScenarioVariantPreview } from './scenarioParameterUtils';
import { fillMissingCompilerProcessDefaults } from './compilerProcessDefaults';
import { findLinkedScenarioSettings, selectScenarioSettings, type ScenarioPropertiesSource } from './scenarioPropertiesBindings';
import {
    readScenarioProperties, applyScenarioPropertyEdit, addScenarioPropertyRecord, removeScenarioPropertyRecord,
    moveScenarioPropertyRecord, applyYamlMapField
} from './scenarioPropertiesModel';

export interface ScenarioPropertiesDocument extends ScenarioPropertiesSource { readonly version: number; dirty: boolean; readonly scriptText?: string; readonly scriptUri?: string }
type Model = ReturnType<typeof readScenarioProperties>;
interface BoundDocument { uri: string; version: number; model: Model; scriptUri?: string }
export interface ScenarioVariantLimitWarning { readonly count: string; readonly limit: number }
export interface ScenarioPropertiesState {
    source: BoundDocument | null;
    settings: (BoundDocument & { label: string })[];
    selectedSettingsUri: string | null;
    metadata: { uri: string; version: number; values: { groupId?: string; order?: number; description?: string; category?: string } } | null;
    displayOrder?: number | null;
    groups: { id: string; name: string }[];
    pinned: boolean;
    dirty: boolean;
    canCreateSettings: boolean;
    variantLimitWarning?: ScenarioVariantLimitWarning | null;
    loading?: boolean;
    autoFill?: { parameters: boolean; nested: boolean };
    catalogs?: ScenarioPropertiesCatalogs;
    error?: string;
    mutationError?: boolean;
    uriMoves?: ScenarioIdentityChangeResult['uriMoves'];
}
export interface ScenarioPropertiesHost {
    presentation?(source: ScenarioPropertiesDocument): { autoFill: { parameters: boolean; nested: boolean }; systemFunctions: { name: string; uid: string }[]; suggestions: Record<string, string[]> };
    loadCatalogs?(source: ScenarioPropertiesDocument, candidates: ScenarioPropertiesSource[], settings?: ScenarioPropertiesSource,
        parseCandidate?: (source: ScenarioPropertiesSource) => ScenarioYamlDocument): Promise<ScenarioPropertiesCatalogs>;
    readDocument(uri: string): Promise<ScenarioPropertiesDocument>;
    replaceDocument(before: ScenarioPropertiesDocument, text: string): Promise<boolean>;
    saveDocument(uri: string): Promise<boolean>;
    listSettings(source: ScenarioPropertiesDocument): Promise<ScenarioPropertiesSource[]>;
    /** Only adjacent settings; never wait for the recursive project inventory. */
    listInitialSettings?(source: ScenarioPropertiesDocument): Promise<ScenarioPropertiesSource[]>;
    loadGroups(source: ScenarioPropertiesDocument): Promise<{ id: string; name: string }[]>;
    readDisplayOrder?(source: ScenarioPropertiesDocument, groupId: string): Promise<number | null>;
    setDisplayOrder?(source: ScenarioPropertiesDocument, groupId: string, value: number | null): Promise<void>;
    editProjectMetadata?(source: ScenarioPropertiesDocument, patch: import('./projectLibraryStore').ProjectEntityMetadataPatch): Promise<boolean>;
    readMetadata(source: ScenarioPropertiesDocument): Promise<ScenarioPropertiesDocument | undefined>;
    ensureMetadata(source: ScenarioPropertiesDocument): Promise<ScenarioPropertiesDocument>;
    runAction(action: string, source: ScenarioPropertiesDocument, settings: string | null, value?: string, catalogs?: { candidates: ScenarioPropertiesSource[] }): Promise<void | ScenarioIdentityChangeResult>;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid property action.'); }
    return value as Record<string, unknown>;
}
function string(value: unknown): string {
    if (typeof value !== 'string') { throw new Error('Invalid property value.'); }
    return value;
}

function compilerVariantLimitWarning(count: string): ScenarioVariantLimitWarning | null {
    return BigInt(count) > 100n ? { count, limit: 100 } : null;
}

/** A document-backed session; the form owns no duplicate persistent run settings. */
export class ScenarioPropertiesSession {
    private state: ScenarioPropertiesState = { source: null, settings: [], selectedSettingsUri: null, metadata: null, groups: [], pinned: false, dirty: false, canCreateSettings: false, variantLimitWarning: null };
    private tail: Promise<unknown> = Promise.resolve();
    private readonly edited = new Map<string, Set<string>>();
    private sourceUri?: string;
    private actionError?: { uri?: string; key: string; message: string };

    private generation = 0;
    private readonly candidateCache = new Map<string, { text: string; yaml: ScenarioYamlDocument }>();
    private readonly parseCandidate = (source: ScenarioPropertiesSource): ScenarioYamlDocument => {
        const cached = this.candidateCache.get(source.uri);
        if (cached?.text === source.text) { return cached.yaml; }
        const yaml = ScenarioYamlDocument.parse(source.text);
        this.candidateCache.set(source.uri, { text: source.text, yaml });
        return yaml;
    };
    constructor(private readonly host: ScenarioPropertiesHost, private readonly changed?: () => void) {}
    get currentSourceUri(): string | undefined { return this.sourceUri; }
    get pinned(): boolean { return this.state.pinned; }
    getState(): ScenarioPropertiesState { return this.state; }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => undefined);
        return result;
    }
    open(uri: string, immediate = false): Promise<ScenarioPropertiesState> {
        return this.serial(async () => {
            const document = await this.host.readDocument(uri);
            const model = readScenarioProperties(document.text, document.scriptText);
            if (model.kind !== 'scenario' && model.kind !== 'process') { throw new Error('Choose a scenario or process source.'); }
            if (this.sourceUri !== uri) { this.state.selectedSettingsUri = null; }
            this.sourceUri = uri;
            if (this.actionError?.uri !== uri) { this.actionError = undefined; }
            return this.load(immediate);
        });
    }
    refresh(immediate = false): Promise<ScenarioPropertiesState> { return this.serial(() => this.load(immediate)); }

    remapFiles(uriMoves: ScenarioIdentityChangeResult['uriMoves']): Promise<ScenarioPropertiesState> {
        return this.serial(async () => {
            if (!this.sourceUri || !this.state.source) { return this.state; }
            const changed = [this.sourceUri, ...this.state.settings.map(document => document.uri), this.state.metadata?.uri,
                ...(this.edited.get(this.sourceUri) ?? [])]
                .some(uri => uri && remapUri(uri, uriMoves) !== uri);
            if (!changed) { return this.state; }
            await this.applyUriMoves({ sourceUri: remapUri(this.sourceUri, uriMoves), uriMoves }, this.state.source.model);
            return this.load(!!this.changed);
        });
    }

    clear(): Promise<ScenarioPropertiesState> {
        return this.serial(async () => {
            this.generation++;
            this.sourceUri = undefined;
            this.actionError = undefined;
            this.state = { source: null, settings: [], selectedSettingsUri: null, metadata: null, groups: [], pinned: false, dirty: false, canCreateSettings: false, variantLimitWarning: null };
            return this.state;
        });
    }

    private async load(immediate = false): Promise<ScenarioPropertiesState> {
        if (!this.sourceUri) { return this.state; }
        const generation = ++this.generation;
        const source = await this.host.readDocument(this.sourceUri);
        const model = readScenarioProperties(source.text, source.scriptText);
        let variantLimitWarning: ScenarioVariantLimitWarning | null = null;
        if (model.kind === 'scenario') {
            const preview = buildScenarioVariantPreview(source.text);
            const parameters = model.sections.find(section => section.key === 'ПараметрыСценария');
            if (parameters?.records?.length) {
                variantLimitWarning = compilerVariantLimitWarning(preview.count);
                parameters.fields = [{ key: 'Parameter combinations', readonly: true, multiline: true,
                    value: [String(preview.count), ...preview.samples.slice(0, 8).map(sample =>
                        Object.entries(sample).map(([name, value]) => `${name} = ${value}`).join(', ')), ...(preview.truncated ? ['…'] : [])].join('\n') }];
            }
        }
        const presentation = this.host.presentation?.(source);
        const system = model.header.find(field => field.key === 'ФункцияСистемы');
        const systemName = system?.value ?? '';
        const systemUid = model.header.find(field => field.key === 'UIDФункцияСистемы')?.value ?? '';
        for (const field of model.header) {
            if (['Имя', 'Код'].includes(field.key)) { field.readonly = false; field.action = field.key === 'Имя' ? 'rename' : 'changeCode'; }
            if (presentation?.suggestions[field.key]) { field.suggestions = presentation.suggestions[field.key]; }
        }
        if (system && presentation) {
            system.readonly = false; system.action = 'systemFunction'; system.value = systemUid;
            system.choices = presentation.systemFunctions.map(value => value.uid);
            system.choiceLabels = Object.fromEntries(presentation.systemFunctions.map(value => [value.uid, value.name]));
            system.choiceLabels[systemUid] ??= systemName || 'Current system function';
        }
        const sameSource = this.state.source?.uri === source.uri;
        let initialGroups: ScenarioPropertiesState['groups'] | undefined;
        let initialMetadata: ScenarioPropertiesState['metadata'] = null;
        let initiallyMain = sameSource && this.state.settings.length > 0;
        if (!sameSource) {
            initialGroups = await this.host.loadGroups(source).catch(() => undefined);
            // Group loading can migrate the sidecar. Read it afterwards, before the first paint.
            try {
                const metadata = await this.host.readMetadata(source);
                if (metadata) {
                    const parsed = parseDocument(metadata.text);
                    if (!parsed.errors.length && !parsed.warnings.length) {
                        const values = object(parsed.toJS().metadata);
                        initialMetadata = { uri: metadata.uri, version: metadata.version, values };
                    }
                }
            } catch { /* The full load retains the existing metadata error handling. */ }
            if (!initiallyMain) {
                const localSettings = await this.host.listInitialSettings?.(source).catch(() => []) ?? [];
                try { initiallyMain = findLinkedScenarioSettings(source, localSettings, this.parseCandidate).length > 0; }
                catch { /* A malformed adjacent setting is reported by full enrichment. */ }
            }
        }
        const catalogs = sameSource ? this.state.catalogs : undefined;
        const initialCatalogs = catalogs ?? { projects: presentation?.suggestions.Проект ?? [], reportLevel1: presentation?.suggestions.УровеньОтчета1 ?? [],
            reportLevel2: presentation?.suggestions.УровеньОтчета2 ?? [], categories: [], responsibles: presentation?.suggestions.Ответственный ?? [], systemFunctions: presentation?.systemFunctions ?? [],
            bases: [], userProfiles: [], settingsUserProfiles: [] };
        if (this.host.loadCatalogs) { applyPropertyCatalogPresentation(model, initialCatalogs); }
        if (immediate && sameSource) {
            const settings = await Promise.allSettled(this.state.settings.map(async value => {
                const document = await this.host.readDocument(value.uri);
                if (findLinkedScenarioSettings(source, [document]).length !== 1) { throw new Error('The selected settings no longer belong to this test.'); }
                const model = readScenarioProperties(document.text, document.scriptText);
                if (this.host.loadCatalogs) { applyPropertyCatalogPresentation(model, initialCatalogs); }
                return { ...value, version: document.version, model };
            }));
            this.state.settings = settings.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
            if (!this.state.settings.some(value => value.uri === this.state.selectedSettingsUri)) { this.state.selectedSettingsUri = null; }
            if (this.state.metadata) {
                try {
                    const document = await this.host.readMetadata(source);
                    if (!document) { throw new Error('The selected metadata no longer belong to this test.'); }
                    const parsed = parseDocument(document.text);
                    if (parsed.errors.length || parsed.warnings.length) { throw new Error('Invalid project metadata YAML.'); }
                    this.state.metadata = { uri: document.uri, version: document.version, values: object(parsed.toJS().metadata) };
                } catch { this.state.metadata = null; }
            }
        }
        const initialDisplayOrder = !sameSource ? await this.host.readDisplayOrder?.(source, String(initialMetadata?.values.groupId ?? '')) : this.state.displayOrder;
        if (generation !== this.generation) { return this.state; }
        this.state = { ...this.state, source: { uri: source.uri, version: source.version, model, scriptUri: source.scriptUri }, loading: true, variantLimitWarning,
            autoFill: presentation?.autoFill,
            ...(!sameSource ? { catalogs: undefined, settings: [], selectedSettingsUri: null, metadata: initialMetadata, groups: initialGroups ?? [], canCreateSettings: initiallyMain, displayOrder: initialDisplayOrder } : {}),
            dirty: source.dirty || sameSource && this.state.dirty };
        const enrich = async (): Promise<ScenarioPropertiesState> => {
            try {
                const candidates = await this.host.listSettings(source);
                const present = new Set(candidates.map(candidate => candidate.uri));
                for (const uri of this.candidateCache.keys()) { if (!present.has(uri)) { this.candidateCache.delete(uri); } }
                const linked = findLinkedScenarioSettings(source, candidates, this.parseCandidate);
                const [settings, groups] = await Promise.all([
                    Promise.all(linked.map(async value => {
                        const document = await this.host.readDocument(value.uri);
                        return { uri: document.uri, version: document.version, model: readScenarioProperties(document.text, document.scriptText),
                            label: decodeURIComponent(new URL(document.uri).pathname.split('/').at(-1) ?? document.uri), dirty: document.dirty, text: document.text };
                    })), initialGroups ?? this.host.loadGroups(source)
                ]);
                // The store may migrate metadata: read the sidecar after groups.
                let metadata: ScenarioPropertiesDocument | undefined;
                try { metadata = await this.host.readMetadata(source); }
                catch (reason) { if (generation === this.generation) { this.state.metadata = null; } throw reason; }
                let values: NonNullable<ScenarioPropertiesState['metadata']>['values'] = {};
                if (metadata) {
                    const parsed = parseDocument(metadata.text);
                    if (parsed.errors.length || parsed.warnings.length) { throw new Error('Invalid project metadata YAML.'); }
                    values = object(parsed.toJS({ maxAliasCount: 100 }).metadata);
                }
                if (generation !== this.generation) { return this.state; }
                const headers = candidates.flatMap(candidate => {
                    const yaml = this.parseCandidate(candidate);
                    return ['ДанныеСценария', 'ДанныеПроцесса', 'ДанныеТеста'].flatMap(section =>
                        ['Проект', 'УровеньОтчета1', 'УровеньОтчета2', 'ПрофильПользователя', 'Ответственный'].flatMap(key => {
                            const field = yaml.findField(section, key);
                            return field && !field.ambiguous && field.valueKind === 'scalar' ? [{ key, value: String(field.value ?? '') }] : [];
                        }));
                });
                for (const field of model.header.filter(field => ['Проект', 'УровеньОтчета1', 'УровеньОтчета2', 'ПрофильПользователя', 'Ответственный'].includes(field.key))) {
                    const used = headers.filter(value => value.key === field.key && value.value).map(value => value.value);
                    field.suggestions = [...new Set([...(field.suggestions ?? []), ...used])].sort();
                }
                const selectedSettingsUri = selectScenarioSettings(settings, this.state.selectedSettingsUri ?? undefined) ?? null;
                const selectedSettings = settings.find(setting => setting.uri === selectedSettingsUri);
                const catalogs = await this.host.loadCatalogs?.(source, candidates, selectedSettings, this.parseCandidate);
                if (generation !== this.generation) { return this.state; }
                if (catalogs) {
                    applyPropertyCatalogPresentation(model, catalogs);
                    for (const setting of settings) { applyPropertyCatalogPresentation(setting.model, catalogs); }
                }
                const canCreateSettings = settings.length > 0;
                if (model.kind === 'scenario') {
                    const parameters = model.sections.find(section => section.key === 'ПараметрыСценария');
                    const preview = buildScenarioVariantPreview(source.text, 8, settings.find(setting => setting.uri === selectedSettingsUri)?.text);
                    if (parameters && canCreateSettings) {
                        variantLimitWarning = compilerVariantLimitWarning(preview.count);
                        parameters.fields = [{ key: 'Parameter combinations', readonly: true, multiline: true,
                            value: [preview.count, ...preview.samples.map(sample => Object.entries(sample).map(([name, value]) => `${name} = ${value}`).join(', ')), ...(preview.truncated ? ['…'] : [])].join('\n') }];
                    } else if (parameters) { parameters.fields = []; variantLimitWarning = null; }
                }
                const displayOrder = await this.host.readDisplayOrder?.(source, values.groupId ?? '');
                if (generation !== this.generation) { return this.state; }
                this.state = { ...this.state, loading: false, catalogs, settings: settings.map(({ dirty: _dirty, text: _text, ...item }) => item),
                    selectedSettingsUri,
                    displayOrder,
                    metadata: metadata ? { uri: metadata.uri, version: metadata.version, values } : null, groups,
                    dirty: source.dirty || settings.some(value => value.dirty) || !!metadata?.dirty,
                    canCreateSettings, variantLimitWarning };
                if (this.actionError && this.actionError.uri === this.sourceUri) { this.state.error = this.actionError.message; }
                else { delete this.state.error; }
            } catch (reason) {
                if (generation !== this.generation) { return this.state; }
                this.state = { ...this.state, loading: false, error: reason instanceof Error ? reason.message : String(reason) };
                if (!immediate) { throw reason; }
            }
            if (immediate) { this.changed?.(); }
            return this.state;
        };
        const hydrated = enrich();
        return immediate ? this.state : hydrated;
    }
    handle(value: unknown): Promise<ScenarioPropertiesState> {
        return this.serial(async () => {
            const message = object(value);
            delete this.state.uriMoves;
            const target = (message.edit ?? message.target ?? {}) as Record<string, unknown>;
            const key = JSON.stringify([message.command, message.documentUri, target.section, target.recordKey, target.stepUid, target.field ?? message.field ?? message.action]);
            let error: string | undefined;
            try { await this.perform(message); }
            catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
            if (error) { this.actionError = { uri: this.sourceUri, key, message: error }; }
            else if (this.actionError?.key === key) { this.actionError = undefined; delete this.state.error; }
            const navigation = message.command === 'action' && ['openSource', 'openFeature', 'openText', 'openSettings', 'openMetadata', 'openReference', 'copyPath', 'pin', 'dismissError'].includes(String(message.action));
            try {
                if (!navigation && !(message.command === 'action' && message.action === 'selectSettings' && await this.selectKnownSettings())) {
                    await this.load(!!this.changed);
                }
            }
            catch (reason) { error ??= reason instanceof Error ? reason.message : String(reason); }
            const visibleError = error ?? (this.actionError?.uri === this.sourceUri ? this.actionError?.message : undefined);
            if (visibleError) { this.state.error = visibleError; } else if (!this.state.loading) { delete this.state.error; }
            this.state.mutationError = !!error;
            return this.state;
        });
    }
    private async selectKnownSettings(): Promise<boolean> {
        if (this.state.loading || !this.state.source || !this.state.selectedSettingsUri) { return false; }
        const source = await this.host.readDocument(this.state.source.uri);
        const setting = await this.host.readDocument(this.state.selectedSettingsUri);
        const cached = this.state.settings.find(value => value.uri === setting.uri);
        if (!cached || source.version !== this.state.source.version || setting.version !== cached.version) { return false; }
        if (findLinkedScenarioSettings(source, [setting]).length !== 1) { throw new Error('The selected settings no longer belong to this test.'); }
        const model = this.state.source.model;
        if (model.kind === 'scenario' && this.state.canCreateSettings) {
            const parameters = model.sections.find(section => section.key === 'ПараметрыСценария');
            if (parameters) {
                const preview = buildScenarioVariantPreview(source.text, 8, setting.text);
                this.state.variantLimitWarning = compilerVariantLimitWarning(preview.count);
                parameters.fields = [{ key: 'Parameter combinations', readonly: true, multiline: true,
                    value: [preview.count, ...preview.samples.map(sample => Object.entries(sample).map(([name, value]) => `${name} = ${value}`).join(', ')), ...(preview.truncated ? ['…'] : [])].join('\n') }];
            }
        }
        return true;
    }
    private async target(message: Record<string, unknown>, metadata = false): Promise<ScenarioPropertiesDocument> {
        const uri = string(message.documentUri);
        const source = this.state.source;
        const allowed = metadata ? this.state.metadata?.uri ?? source?.uri : uri === source?.uri ? source.uri : this.state.selectedSettingsUri;
        if (!source || uri !== allowed) { throw new Error('The property target is not bound to the selected test/settings.'); }
        const currentSource = await this.host.readDocument(source.uri);
        const currentMetadata = metadata ? await this.host.readMetadata(currentSource) : undefined;
        const document = metadata ? currentMetadata ?? (uri === source.uri ? currentSource : undefined) : await this.host.readDocument(uri);
        if (!document || document.uri !== uri) { throw new Error('The selected metadata no longer belong to this test.'); }
        if (!metadata && uri !== source.uri && findLinkedScenarioSettings(currentSource, [document]).length !== 1) {
            throw new Error('The selected settings no longer belong to this test.');
        }
        if (!Number.isInteger(message.documentVersion) || document.version !== message.documentVersion) {
            throw new Error('The document changed. Refresh the properties and retry the edit.');
        }
        return document;
    }
    private async replace(document: ScenarioPropertiesDocument, text: string): Promise<void> {
        if (text === document.text) { return; }
        if (!await this.host.replaceDocument(document, text)) { throw new Error('The document changed before applying properties.'); }
        const edited = this.edited.get(this.sourceUri!) ?? new Set<string>();
        edited.add(document.uri); this.edited.set(this.sourceUri!, edited);
    }
    private async runAction(action: string, source: ScenarioPropertiesDocument, value?: string): Promise<void> {
        const before = readScenarioProperties(source.text, source.scriptText);
        if (action === 'changeCode' && value !== undefined && value.trim() !== before.header.find(field => field.key === 'Код')?.value) {
            await this.perform({ command: 'action', action: 'save' });
            const saved = await this.host.readDocument(source.uri); const after = readScenarioProperties(saved.text, saved.scriptText);
            if (after.kind !== before.kind || ['UID', 'Имя', 'Код'].some(key => before.header.find(field => field.key === key)?.value !== after.header.find(field => field.key === key)?.value)) {
                throw new Error('The source identity changed while saving. Refresh the properties and retry.');
            }
            source = saved;
        }
        const result = await this.host.runAction(action, source, this.state.selectedSettingsUri, value);
        if (!result) { return; }
        await this.applyUriMoves(result, before);
    }
    private async applyUriMoves(result: ScenarioIdentityChangeResult, before: Model): Promise<void> {
        const current = await this.host.readDocument(result.sourceUri); const after = readScenarioProperties(current.text, current.scriptText);
        const uid = (model: Model) => model.header.find(field => field.key === 'UID')?.value.trim().toLowerCase();
        if (!uid(before) || uid(before) !== uid(after) || before.kind !== after.kind || remapUri(this.sourceUri!, result.uriMoves) !== result.sourceUri) {
            throw new Error('The renamed source does not belong to the selected test.');
        }
        const previous = this.sourceUri!; const map = (uri: string) => remapUri(uri, result.uriMoves);
        this.generation++; this.sourceUri = result.sourceUri;
        const resources = this.edited.get(previous); this.edited.delete(previous);
        if (resources) { this.edited.set(result.sourceUri, new Set(Array.from(resources, map))); }
        if (this.actionError?.uri === previous) { this.actionError.uri = result.sourceUri; }
        this.state = { ...this.state, source: { uri: current.uri, version: current.version, model: after, scriptUri: current.scriptUri },
            settings: this.state.settings.map(document => ({ ...document, uri: map(document.uri) })),
            selectedSettingsUri: this.state.selectedSettingsUri ? map(this.state.selectedSettingsUri) : null,
            metadata: this.state.metadata ? { ...this.state.metadata, uri: map(this.state.metadata.uri) } : null,
            uriMoves: result.uriMoves };
    }
    private async perform(message: Record<string, unknown>): Promise<void> {
        const command = string(message.command);
        if (command === 'ready') { return; }
        if (command === 'action') {
            const action = string(message.action);
            if (action === 'dismissError') { this.actionError = undefined; delete this.state.error; return; }
            if (action === 'pin') { this.state.pinned = !this.state.pinned; return; }
            if (!this.sourceUri) { throw new Error('Choose a scenario or process source.'); }
            if (action === 'selectSettings') {
                const uri = string(message.value);
                if (!this.state.settings.some(item => item.uri === uri)) { throw new Error('The selected settings no longer belong to this test.'); }
                this.state.selectedSettingsUri = uri; return;
            }
            if (action === 'save') {
                const edited = this.edited.get(this.sourceUri) ?? new Set<string>();
                const resources = new Set([this.sourceUri, ...edited]);
                if (this.state.selectedSettingsUri) { resources.add(this.state.selectedSettingsUri); }
                if (this.state.metadata) { resources.add(this.state.metadata.uri); }
                const currentSource = await this.host.readDocument(this.sourceUri);
                if (currentSource.scriptUri) { resources.add(currentSource.scriptUri); }
                for (const uri of resources) {
                    if (uri === this.sourceUri || uri === currentSource.scriptUri) { continue; }
                    if (uri === this.sourceUri + '.kot.yml') {
                        const metadata = await this.host.readMetadata(currentSource);
                        if (!metadata || metadata.uri !== uri) { throw new Error('The selected metadata no longer belong to this test.'); }
                    } else if (findLinkedScenarioSettings(currentSource, [await this.host.readDocument(uri)]).length !== 1) {
                        throw new Error('The selected settings no longer belong to this test.');
                    }
                }
                for (const uri of resources) {
                    if (!await this.host.saveDocument(uri)) { throw new Error(`Could not save ${uri}. Unsaved edits are retained.`); }
                    edited.delete(uri);
                }
                return;
            }
            const actions = ['openSource', 'openFeature', 'openText', 'openSettings', 'openMetadata', 'copyPath', 'rename', 'changeCode', 'systemFunction', 'base', 'users', 'addSteps', 'aiDescription', 'changeGroup', 'newGroup', 'createSettings', 'addNested', 'openReference', 'fillParameters', 'fillNested', 'convertFormat', 'convertRole', 'run'];
            if (action === 'copyPath' && ![this.sourceUri, this.state.selectedSettingsUri, this.state.metadata?.uri].includes(message.value as string)) { throw new Error('The property target is not bound to the selected test/settings.'); }
            if (!actions.includes(action)) { throw new Error('Unknown test properties action.'); }
            if (action === 'createSettings' && !this.state.canCreateSettings) { throw new Error('Run settings are available for main scenarios and processes.'); }
            if (action === 'run' && !this.state.canCreateSettings) { throw new Error('Run settings are available for main scenarios and processes.'); }
            if (['newGroup', 'changeGroup'].includes(action) && !this.state.canCreateSettings) { throw new Error('Groups are available for main scenarios and processes.'); }
            await this.runAction(action, await this.host.readDocument(this.sourceUri), message.value === undefined ? undefined : string(message.value));
            return;
        }
        if (command === 'createChoice' || command === 'catalogChoice') {
            const target = object(message.target);
            const section = string(target.section); const field = string(target.field);
            const metadata = section === 'metadata';
            const document = await this.target(message, metadata);
            const source = await this.host.readDocument(this.sourceUri!);
            const model = metadata ? null : readScenarioProperties(document.text, document.scriptText);
            const header = model?.kind === 'scenario' ? 'ДанныеСценария' : model?.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеТеста';
            if (metadata ? field !== 'category' : section !== header || !['Проект', 'УровеньОтчета1', 'УровеньОтчета2', 'ПрофильПользователя', 'Ответственный', 'ФункцияСистемы', 'ЭталоннаяБазаИмя'].includes(field)) {
                throw new Error('Unsupported property catalog target.');
            }
            await this.host.runAction(command, source, this.state.selectedSettingsUri, JSON.stringify({ section, field, documentUri: document.uri,
                documentVersion: document.version, ...(command === 'catalogChoice' ? { value: string(message.value) } : {}) }),
                { candidates: [source, ...await this.host.listSettings(source)] });
            const edited = this.edited.get(this.sourceUri!) ?? new Set<string>();
            if (metadata) {
                const after = await this.host.readMetadata(source);
                if (after) {
                    edited.add(after.uri);
                    this.state.metadata = { uri: after.uri, version: after.version, values: object(parseDocument(after.text).toJS().metadata) };
                    this.state.dirty ||= after.dirty;
                }
            } else { edited.add(document.uri); }
            this.edited.set(this.sourceUri!, edited);
            return;
        }
        if (command === 'editMetadata') {
            let document = await this.target(message, true);
            const field = string(message.field);
            if (!['groupId', 'order', 'description', 'category'].includes(field)) { throw new Error('Unsupported metadata field.'); }
            const rawValue = string(message.value);
            if (['groupId', 'order'].includes(field) && !this.state.canCreateSettings) { throw new Error('Groups and order are available for main scenarios and processes.'); }
            if (field === 'groupId' && rawValue && !this.state.groups.some(group => group.id === rawValue)) { throw new Error('The selected group no longer exists.'); }
            const fieldValue = field === 'order' ? rawValue.trim() ? Number(rawValue) : null : rawValue;
            if (typeof fieldValue === 'number' && (!Number.isFinite(fieldValue) || fieldValue < 0)) { throw new Error('Order must be a finite nonnegative number.'); }
            if (await this.host.editProjectMetadata?.(await this.host.readDocument(this.sourceUri!), { [field]: fieldValue })) { return; }
            if (field === 'order' && this.host.setDisplayOrder) {
                const source = await this.host.readDocument(this.sourceUri!);
                await this.host.setDisplayOrder(source, this.state.metadata?.values.groupId ?? '', fieldValue as number | null);
                return;
            }
            if (!this.state.metadata) { document = await this.host.ensureMetadata(document); }
            await this.replace(document, applyYamlMapField(document.text, ['metadata', field], fieldValue));
            return;
        }
        const document = await this.target(message);
        if (command === 'fillProcessDefaults') {
            if (this.state.source?.model.kind !== 'process' || document.uri !== this.state.selectedSettingsUri || document.uri === this.sourceUri) {
                throw new Error('Choose selected process settings to fill defaults.');
            }
            const source = await this.host.readDocument(this.sourceUri!);
            if (source.version !== message.sourceVersion) { throw new Error('The process changed. Refresh the properties and retry.'); }
            await this.replace(document, fillMissingCompilerProcessDefaults(source.text, document.text).text);
            return;
        }
        let text: string;
        const target = object(message.target ?? message.edit);
        const section = string(target.section);
        const stepUid = target.stepUid === undefined ? undefined : string(target.stepUid);
        const generated = document.uri === this.sourceUri && this.state.source?.model.kind === 'scenario'
            && ['ПараметрыСценария', 'ВложенныеСценарии'].includes(section);
        if (generated && command !== 'edit') { throw new Error('Fill declarations from scenario text instead of editing their order or membership.'); }
        if (command === 'edit') {
            const action = this.state.source?.model.header.find(field => field.key === target.field)?.action;
            if (document.uri === this.sourceUri && ['header', 'ДанныеСценария', 'ДанныеПроцесса'].includes(section) && action && ['rename', 'changeCode', 'systemFunction'].includes(action)) {
                await this.runAction(action, document, string(target.value)); return;
            }
            text = applyScenarioPropertyEdit(document.text, { section, stepUid, field: string(target.field), value: string(target.value),
                ...(target.recordKey === undefined ? {} : { recordKey: string(target.recordKey) }) });
        } else if (command === 'addRecord') {
            text = addScenarioPropertyRecord(document.text, { section, stepUid });
        } else if (command === 'removeRecord') {
            text = removeScenarioPropertyRecord(document.text, { section, stepUid, recordKey: string(target.recordKey) });
        } else if (command === 'moveRecord') {
            text = moveScenarioPropertyRecord(document.text, { section, stepUid, recordKey: string(target.recordKey),
                beforeRecordKey: target.beforeRecordKey === null ? null : string(target.beforeRecordKey) });
        } else { throw new Error('Unknown test properties command.'); }
        await this.replace(document, text);
    }
}
