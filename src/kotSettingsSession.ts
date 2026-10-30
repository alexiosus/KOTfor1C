import { createHash } from 'node:crypto';

export type SettingsScope = 'user' | 'workspace' | 'folder';
export interface SettingSchema {
    key: string; type?: string | readonly string[]; default?: unknown; enum?: readonly unknown[];
    items?: Omit<SettingSchema, 'key'>; properties?: Record<string, Omit<SettingSchema, 'key'>>;
    additionalProperties?: boolean | Omit<SettingSchema, 'key'>; uniqueItems?: boolean;
    minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; secret?: boolean;
}
export interface ConfigurationLayers { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
export interface SettingsAdapter {
    inspect(key: string, folder: string): ConfigurationLayers;
    update(key: string, value: unknown, scope: SettingsScope, folder: string): Promise<void>;
    assertWritable?(key: string, scope: SettingsScope, folder: string): void;
    normalizeScope?(scope: SettingsScope, folder: string): SettingsScope;
}
export interface SettingsChange { key: string; folder: string; scope: SettingsScope; token: string; reset?: boolean; value?: unknown }
export interface SettingView {
    key: string; value: unknown; inheritedValue: unknown; source: 'default' | SettingsScope; explicit: boolean; configured: boolean; token: string;
}
const levels = ['defaultValue', 'globalValue', 'workspaceValue', 'workspaceFolderValue'] as const;
const scopes = ['default', 'user', 'workspace', 'folder'] as const;
const hashLayers = (layers: ConfigurationLayers) => createHash('sha256').update(JSON.stringify(levels.map(level => layers[level]))).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const id = (change: Pick<SettingsChange, 'folder' | 'scope' | 'key'>) => `${change.folder}:${change.scope}:${change.key}`;

export function validateSetting(value: unknown, schema: Omit<SettingSchema, 'key'>, label = 'Value'): void {
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (types.length && !types.includes(type) && !(type === 'number' && Number.isInteger(value) && types.includes('integer'))) { throw new Error(`${label}: invalid type`); }
    if (schema.enum && !schema.enum.some(option => equal(option, value))) { throw new Error(`${label}: invalid choice`); }
    if (typeof value === 'number' && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) { throw new Error(`${label}: outside allowed range`); }
    if (typeof value === 'string' && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength || schema.pattern && !new RegExp(schema.pattern).test(value))) { throw new Error(`${label}: invalid format`); }
    if (Array.isArray(value)) {
        if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) { throw new Error(`${label}: duplicate entries`); }
        if (schema.items) { for (const item of value) { validateSetting(item, schema.items, label); } }
    } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new Error(`${label}: invalid property`); }
            const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
            if (child) { validateSetting(item, child, label); }
            else if (schema.additionalProperties === false) { throw new Error(`${label}: unknown property`); }
        }
    }
}

export class SettingsApplyError extends Error {
    constructor(message: string, readonly applied: readonly string[]) { super(message); }
}

/** Owns validation and optimistic concurrency; VS Code remains the only configuration store. */
export class SettingsDraftSession {
    private queue: Promise<unknown> = Promise.resolve();
    private readonly definitions: Map<string, SettingSchema>;
    constructor(definitions: readonly SettingSchema[], private readonly adapter: SettingsAdapter) { this.definitions = new Map(definitions.map(item => [item.key, item])); }
    private layers(schema: SettingSchema, folder: string): ConfigurationLayers { const layers = this.adapter.inspect(schema.key, folder); return { ...layers, defaultValue: layers.defaultValue ?? schema.default }; }
    private token(schema: SettingSchema, folder: string): string {
        const layers = this.layers(schema, folder);
        return hashLayers(layers);
    }
    snapshot(folder: string, scope: SettingsScope): SettingView[] {
        if (!['user', 'workspace', 'folder'].includes(scope)) { throw new Error('Invalid settings scope'); }
        const last = scopes.indexOf(this.adapter.normalizeScope?.(scope, folder) ?? scope);
        return [...this.definitions.values()].map(schema => {
            const layers = this.layers(schema, folder); let selected = 0;
            for (let index = 1; index <= last; index++) { if (layers[levels[index]] !== undefined) { selected = index; } }
            const value = layers[levels[selected]];
            let inherited = 0;
            for (let index = 1; index < last; index++) { if (layers[levels[index]] !== undefined) { inherited = index; } }
            return { key: schema.key, value: schema.secret ? '' : value, inheritedValue: schema.secret ? '' : layers[levels[inherited]], source: scopes[selected], explicit: layers[levels[last]] !== undefined,
                configured: value !== undefined && value !== '', token: this.token(schema, folder) };
        });
    }
    apply(changes: readonly SettingsChange[]): Promise<readonly string[]> {
        const operation = this.queue.then(async () => {
            const applied: string[] = [];
            const unique = new Set<string>();
            const check = (change: SettingsChange, expectedToken = change.token) => {
                const schema = this.definitions.get(change.key);
                if (!schema || !['user', 'workspace', 'folder'].includes(change.scope) || typeof change.folder !== 'string' || typeof change.token !== 'string') { throw new Error('Invalid settings request'); }
                if (this.token(schema, change.folder) !== expectedToken) { throw new Error(`Setting changed outside this page: ${change.key}`); }
                this.adapter.assertWritable?.(change.key, change.scope, change.folder);
                if (!change.reset) { validateSetting(change.value, schema, change.key); }
            };
            try {
                for (const change of changes) { check(change); if (unique.has(id(change))) { throw new Error('Duplicate settings change'); } unique.add(id(change)); }
                const expected = new Map<string, string>();
                for (const change of changes) {
                    const resource = JSON.stringify([change.folder, change.key]);
                    check(change, expected.get(resource) ?? change.token);
                    const schema = this.definitions.get(change.key)!;
                    const layers = this.layers(schema, change.folder);
                    const scope = this.adapter.normalizeScope?.(change.scope, change.folder) ?? change.scope;
                    layers[levels[scopes.indexOf(scope)]] = change.reset ? undefined : change.value;
                    const nextToken = hashLayers(layers);
                    await this.adapter.update(change.key, change.reset ? undefined : change.value, change.scope, change.folder);
                    applied.push(id(change));
                    if (this.token(schema, change.folder) !== nextToken) { throw new Error(`Setting changed outside this page: ${change.key}`); }
                    expected.set(resource, nextToken);
                }
                return applied;
            } catch (error) { throw new SettingsApplyError(error instanceof Error ? error.message : String(error), applied); }
        });
        this.queue = operation.catch(() => undefined);
        return operation;
    }
}
