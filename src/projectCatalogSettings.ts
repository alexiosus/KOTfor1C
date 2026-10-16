import { parseDocument } from 'yaml';
import { randomUUID } from 'node:crypto';
import { ProjectPropertyCatalogStore, readPropertyCatalogFile, type ProjectPropertyCatalogKey, type ProjectSystemFunction } from './projectPropertyCatalogStore';
import { TestNumberingStore, type TestNumberingDefinition } from './testNumberingStore';

export const PROJECT_CATALOG_SETTINGS = {
    projects: 'catalogs.projects', responsibles: 'catalogs.responsibles', reportLevel1: 'catalogs.reportLevel1',
    reportLevel2: 'catalogs.reportLevel2', categories: 'catalogs.categories',
    systemFunctions: 'catalogs.systemFunctions', series: 'numbering.series'
} as const;
type Field = keyof typeof PROJECT_CATALOG_SETTINGS;
interface BaselineField { project?: unknown; setting?: unknown; present?: boolean }
export interface CatalogSettingsBaseline { version: 1; fields: Partial<Record<Field, BaselineField>> }
export interface CatalogSettingsHost {
    readSetting(key: string): { value: unknown; explicit: boolean; userOnly?: boolean; needsReflection?: boolean };
    writeSetting(key: string, value: unknown): Promise<void>;
    readBaseline(): CatalogSettingsBaseline | undefined;
    writeBaseline(value: CatalogSettingsBaseline): Promise<void>;
    assertSaved(file: string): void;
    loadCodes(): Promise<readonly string[]>;
    readLegacySystemFunctions?(): readonly ProjectSystemFunction[] | undefined;
    translate?(message: string): string;
}
function equal(field: Field, a: unknown, b: unknown): boolean {
    // Native key/value controls cannot preserve YAML sequence order for numeric object keys.
    const normalize = (value: unknown) => Array.isArray(value) && (field === 'series' || field === 'systemFunctions')
        ? [...value].sort((left, right) => String(left?.[field === 'series' ? 'prefix' : 'name']).localeCompare(String(right?.[field === 'series' ? 'prefix' : 'name'])))
        : value;
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Native settings are an editable projection of shared YAML, with field-level conflict detection. */
export class ProjectCatalogSettings {
    private readonly properties: ProjectPropertyCatalogStore;
    private readonly numbering: TestNumberingStore;
    private queue: Promise<unknown> = Promise.resolve();
    constructor(root: string, private readonly host: CatalogSettingsHost) {
        this.properties = new ProjectPropertyCatalogStore(root, { beforeWrite: () => host.assertSaved(this.properties.filePath) });
        this.numbering = new TestNumberingStore(root, { beforeWrite: () => host.assertSaved(this.numbering.filePath) });
    }
    synchronize(reason: 'project' | 'settings', changedKeys?: readonly string[]): Promise<string[]> {
        const result = this.queue.then(() => this.run(reason, changedKeys));
        this.queue = result.catch(() => undefined); return result;
    }
    private async snapshot() {
        this.host.assertSaved(this.properties.filePath); this.host.assertSaved(this.numbering.filePath);
        const legacy = this.host.readLegacySystemFunctions?.();
        if (legacy !== undefined) { await this.properties.ensureSystemFunctions(legacy); }
        const [properties, numbering, propertyText, numberingText] = await Promise.all([
            this.properties.read(), this.numbering.read(), readPropertyCatalogFile(this.properties.filePath), readPropertyCatalogFile(this.numbering.filePath)
        ]);
        const values: Record<Field, unknown> = { ...properties, systemFunctions: properties.systemFunctions,
            series: numbering.series.map(({ prefix, author }) => ({ prefix, author })) };
        const propertyDocument = parseDocument(propertyText ?? '');
        const present = (field: Field) => field === 'series' ? numberingText !== undefined : propertyDocument.has(field);
        return { values, present };
    }
    private async apply(field: Field, value: unknown, expected: unknown): Promise<void> {
        if (!Array.isArray(value)) { throw new Error('A project catalog setting must contain an array.'); }
        if (field === 'series') {
            await this.numbering.replaceSeries(value as TestNumberingDefinition[], expected as TestNumberingDefinition[], () => this.host.loadCodes());
            for (const entry of value as TestNumberingDefinition[]) { await this.properties.add('responsibles', entry.author); }
        } else if (field === 'systemFunctions') {
            const previous = expected as ProjectSystemFunction[] | undefined;
            const entries = value.map(entry => entry && typeof entry === 'object' && entry.uid === ''
                ? { ...entry, uid: previous?.find(old => old.name.toLocaleLowerCase() === String(entry.name).toLocaleLowerCase())?.uid ?? randomUUID() } : entry);
            await this.properties.replaceSystemFunctions(entries as ProjectSystemFunction[], previous);
        } else { await this.properties.replace(field as ProjectPropertyCatalogKey, value as string[], expected as string[]); }
    }
    private async run(reason: 'project' | 'settings', changedKeys?: readonly string[]): Promise<string[]> {
        const errors: string[] = [];
        try {
            const snapshot = await this.snapshot();
            const saved = this.host.readBaseline();
            const baseline: CatalogSettingsBaseline = saved?.version === 1 && saved.fields ? structuredClone(saved) : { version: 1, fields: {} };
            for (const field of Object.keys(PROJECT_CATALOG_SETTINGS) as Field[]) {
                const key = PROJECT_CATALOG_SETTINGS[field];
                try {
                    const affected = !changedKeys || changedKeys.includes(key);
                    if (reason === 'settings' && !affected) { continue; }
                    const setting = this.host.readSetting(key); const previous = baseline.fields[field];
                    const project = snapshot.values[field];
                    if (reason === 'settings' && affected && setting.userOnly) {
                        throw new Error('Edit project catalogs in the Workspace or Folder settings tab.');
                    }
                    const settingsChanged = setting.explicit && (previous ? !equal(field, setting.value, previous.setting)
                        || !snapshot.present(field) && reason === 'settings' : !snapshot.present(field) || reason === 'settings');
                    const projectChanged = previous ? !equal(field, project, previous.project) : false;
                    if (previous && settingsChanged && projectChanged && !equal(field, project, setting.value)) {
                        throw new Error('Both the project YAML and VS Code setting changed. Resolve this field conflict before saving.');
                    }
                    let canonical = project;
                    let present = snapshot.present(field);
                    let consumed = setting.value;
                    if (settingsChanged && (!present || !equal(field, setting.value, project))) {
                        await this.apply(field, setting.value, project);
                        const applied = await this.snapshot(); canonical = applied.values[field]; present = applied.present(field);
                    }
                    if (present && canonical !== undefined && (setting.needsReflection || !equal(field, canonical, setting.value))) {
                        // A later edit belongs to its queued pass. Do not overwrite it or record it as consumed.
                        if (equal(field, this.host.readSetting(key).value, setting.value)) {
                            await this.host.writeSetting(key, canonical); consumed = canonical;
                        }
                    }
                    if (!present && previous?.present) { await this.host.writeSetting(key, undefined); }
                    baseline.fields[field] = { project: canonical, setting: consumed, present };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    errors.push(`${key}: ${this.host.translate?.(message) ?? message}`);
                }
            }
            await this.host.writeBaseline(baseline);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(this.host.translate?.(message) ?? message);
        }
        return errors;
    }
}
