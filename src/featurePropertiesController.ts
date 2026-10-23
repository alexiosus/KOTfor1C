import { readFeatureProperties, planFeaturePropertiesEdit, type FeaturePropertiesDocument, type FeaturePropertiesEdit } from './featurePropertiesModel';
export interface FeaturePropertiesDecoration {
    favorite?: boolean; canFavorite?: boolean;
    standalone?: { groupId: string; groups: { id: string; name: string }[]; jsonPath?: string };
}
export interface FeaturePropertiesState extends FeaturePropertiesDecoration {
    uri: string; version: number; model: ReturnType<typeof readFeatureProperties>; dirty: boolean; pinned: boolean; error?: string;
}
export interface FeaturePropertiesHost {
    readDocument(uri: string): Promise<FeaturePropertiesDocument>;
    replaceDocument(before: FeaturePropertiesDocument, after: string): Promise<boolean>;
    saveDocument(uri: string): Promise<boolean>;
    decorate(document: FeaturePropertiesDocument): Promise<FeaturePropertiesDecoration>;
    action(action: string, document: FeaturePropertiesDocument, value?: string, line?: number): Promise<void>;
}
const actions = new Set(['edit', 'save', 'pin', 'favorite', 'openSource', 'copyPath', 'structure', 'openScenario', 'renameScenario',
    'group', 'chooseJson', 'generateJson', 'openJson', 'run', 'dismissError', 'convertExport']);
const fields = new Set(['title', 'description', 'tags']);
/** Owns no files: every operation reads and changes the native source document. The panel serializes requests. */
export class FeaturePropertiesController {
    state?: FeaturePropertiesState;
    private uri?: string;
    private error?: string;
    private isPinned = false;
    constructor(private readonly host: FeaturePropertiesHost) {}
    get currentSourceUri(): string | undefined { return this.uri; }
    get pinned(): boolean { return this.isPinned; }
    clear(): void { this.uri = undefined; this.state = undefined; this.error = undefined; this.isPinned = false; }
    async open(uri: string): Promise<void> {
        if (uri !== this.uri) { this.clear(); }
        this.uri = uri;
        try { await this.refresh(); } catch (error) { this.clear(); throw error; }
    }
    async remap(uri: string): Promise<void> { this.uri = uri; await this.refresh(); }
    async refresh(): Promise<void> {
        const uri = this.uri; if (!uri) { return; }
        const document = await this.host.readDocument(uri);
        const model = readFeatureProperties(document); const decoration = await this.host.decorate(document);
        if (uri !== this.uri) { return; }
        this.state = { uri, version: document.version, model, ...decoration, dirty: !!document.dirty, pinned: this.isPinned,
            ...(this.error ? { error: this.error } : {}) };
    }
    async handle(input: unknown): Promise<void> {
        try {
            if (!input || typeof input !== 'object') { throw new Error('Invalid feature properties message.'); }
            const message = input as Record<string, unknown>;
            if (message.command !== 'featureAction' || typeof message.uri !== 'string' || !Number.isSafeInteger(message.version)
                || typeof message.action !== 'string' || !actions.has(message.action)
                || message.value !== undefined && typeof message.value !== 'string'
                || message.line !== undefined && (!Number.isSafeInteger(message.line) || (message.line as number) < 0)) {
                throw new Error('Invalid feature properties message.');
            }
            if (!this.uri || message.uri !== this.uri) { throw new Error('The feature changed. Refresh the form and retry.'); }
            if (message.action === 'pin') {
                this.isPinned = !this.isPinned;
                if (this.state) { this.state = { ...this.state, pinned: this.isPinned }; }
                return;
            }
            const document = await this.host.readDocument(this.uri);
            if (document.version !== message.version) { throw new Error('The feature changed. Refresh the form and retry.'); }
            const model = readFeatureProperties(document); const action = message.action;
            if (action === 'edit') {
                if (typeof message.field !== 'string' || !fields.has(message.field) || typeof message.value !== 'string' || typeof message.baseValue !== 'string') { throw new Error('Invalid feature field.'); }
                const previous = message.field === 'tags' ? model.tags.join(' ') : model[message.field as 'title' | 'description'];
                if (previous !== message.baseValue) { throw new Error('The field changed in the editor. Review your draft and retry.'); }
                const edit = planFeaturePropertiesEdit(document, { uri: document.uri, version: document.version,
                    field: message.field as FeaturePropertiesEdit['field'], value: message.value });
                const after = document.text.slice(0, edit.start) + edit.text + document.text.slice(edit.end);
                if (after !== document.text && !await this.host.replaceDocument(document, after)) { throw new Error('The feature changed. Refresh the form and retry.'); }
            } else if (action === 'save') { if (!await this.host.saveDocument(document.uri)) { throw new Error('Could not save the feature.'); } }
            else if (action !== 'dismissError') {
                if (action === 'structure' && ![...model.actions, ...model.scenarios.flatMap(scenario => scenario.actions)]
                    .some(item => item.line === message.line && item.kind === message.value)) { throw new Error('The feature action is no longer available.'); }
                if (['openScenario', 'renameScenario'].includes(action) && !model.scenarios.some(item => item.line === message.line)) {
                    throw new Error('The scenario is no longer available.');
                }
                if (action === 'convertExport' && !model.scenarios.some(item => item.line === message.line && 'exported' in item && item.exported)) {
                    throw new Error('Choose an exported scenario declaration.');
                }
                await this.host.action(action, document, message.value as string | undefined, message.line as number | undefined);
            }
            this.error = undefined; await this.refresh();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
            try { await this.refresh(); } catch { /* Keep the last readable state if the source is invalid. */ }
            if (this.state) { this.state = { ...this.state, error: this.error }; }
            throw error;
        }
    }
}
