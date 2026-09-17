import {
    resolveScenarioByName,
    type ScenarioCatalog,
    type ScenarioResolution
} from './scenarioCatalog';
import type { TestInfo } from './types';

export type ScenarioRuntimeKey = string;

export interface ScenarioRuntimeTarget {
    key?: ScenarioRuntimeKey;
    name?: string;
    uri?: string;
}

export type ScenarioBuildSelectionValidation =
    | { kind: 'valid' }
    | { kind: 'ambiguous'; name: string; keys: readonly ScenarioRuntimeKey[] };

function hasOwnBoolean(
    values: Readonly<Record<string, boolean>>,
    key: string
): boolean {
    return Object.prototype.hasOwnProperty.call(values, key)
        && typeof values[key] === 'boolean';
}

export function getScenarioRuntimeKey(info: TestInfo): ScenarioRuntimeKey {
    return info.yamlFileUri.toString();
}

export function resolveScenarioRuntimeTarget(
    catalog: ScenarioCatalog,
    target: ScenarioRuntimeTarget
): ScenarioResolution {
    const name = target.name?.trim() ?? '';
    const key = target.key?.trim() || target.uri?.trim();

    if (!key) {
        return resolveScenarioByName(catalog, name);
    }
    if (target.key && target.uri && target.key.trim() !== target.uri.trim()) {
        return { kind: 'missing', name };
    }

    const scenario = catalog.byUri.get(key);
    if (!scenario || (name && scenario.name !== name)) {
        return { kind: 'missing', name: name || scenario?.name || '' };
    }

    return {
        kind: 'unique',
        name: scenario.name,
        scenario
    };
}

export function migrateLegacySelectionStates(
    catalog: ScenarioCatalog,
    legacyByName: Readonly<Record<string, boolean>>,
    currentByKey: Readonly<Record<ScenarioRuntimeKey, boolean>>
): Record<ScenarioRuntimeKey, boolean> {
    const migrated: Record<ScenarioRuntimeKey, boolean> = {};

    for (const scenario of catalog.all) {
        const key = getScenarioRuntimeKey(scenario);
        if (hasOwnBoolean(currentByKey, key)) {
            migrated[key] = currentByKey[key];
            continue;
        }

        const primary = catalog.primaryByName.get(scenario.name);
        if (primary === scenario && hasOwnBoolean(legacyByName, scenario.name)) {
            migrated[key] = legacyByName[scenario.name];
            continue;
        }

        migrated[key] = scenario.defaultState === true;
    }

    return migrated;
}

export function resolveUniqueRuntimeKeyByName(
    catalog: ScenarioCatalog,
    name: string
): ScenarioRuntimeKey | null {
    const resolution = resolveScenarioByName(catalog, name.trim());
    return resolution.kind === 'unique'
        ? getScenarioRuntimeKey(resolution.scenario)
        : null;
}

export function validateEnabledScenarioKeys(
    catalog: ScenarioCatalog,
    enabledKeys: readonly ScenarioRuntimeKey[]
): ScenarioBuildSelectionValidation {
    const enabled = new Set(enabledKeys);
    const keysByName = new Map<string, ScenarioRuntimeKey[]>();

    for (const scenario of catalog.all) {
        const key = getScenarioRuntimeKey(scenario);
        if (!enabled.has(key)) {
            continue;
        }
        const keys = keysByName.get(scenario.name) ?? [];
        keys.push(key);
        keysByName.set(scenario.name, keys);
    }

    for (const [name, keys] of keysByName) {
        if (keys.length > 1) {
            return { kind: 'ambiguous', name, keys };
        }
    }

    return { kind: 'valid' };
}

export function remapRuntimeKey<T>(
    records: ReadonlyMap<ScenarioRuntimeKey, T>,
    oldKey: ScenarioRuntimeKey,
    newKey: ScenarioRuntimeKey
): Map<ScenarioRuntimeKey, T> {
    const remapped = new Map(records);
    if (oldKey === newKey || !remapped.has(oldKey)) {
        return remapped;
    }

    const value = remapped.get(oldKey) as T;
    remapped.delete(oldKey);
    remapped.set(newKey, value);
    return remapped;
}

export function removeRuntimeKey<T>(
    records: ReadonlyMap<ScenarioRuntimeKey, T>,
    key: ScenarioRuntimeKey
): Map<ScenarioRuntimeKey, T> {
    const remaining = new Map(records);
    remaining.delete(key);
    return remaining;
}
