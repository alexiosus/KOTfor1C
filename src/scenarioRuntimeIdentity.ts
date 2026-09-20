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

export interface ScenarioBuildSelectionProjection {
    total: number;
    enabledKeys: ScenarioRuntimeKey[];
    disabledKeys: ScenarioRuntimeKey[];
    enabledNames: string[];
    disabledNames: string[];
    isolatedDisabledKeys: ScenarioRuntimeKey[];
    enabledKeyByName: Record<string, ScenarioRuntimeKey>;
}

export interface ScenarioRuntimeRenameCandidate {
    oldKey: ScenarioRuntimeKey;
    newKey: ScenarioRuntimeKey;
}

export interface ScenarioRuntimeRenamePlan {
    remappedKeys: ReadonlyMap<ScenarioRuntimeKey, ScenarioRuntimeKey>;
    removedKeys: ReadonlySet<ScenarioRuntimeKey>;
}

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

export function migrateLegacyScenarioValues(
    catalog: ScenarioCatalog,
    legacyByName: Readonly<Record<string, string>>,
    currentByKey: Readonly<Record<ScenarioRuntimeKey, string>>
): Record<ScenarioRuntimeKey, string> {
    const migrated: Record<ScenarioRuntimeKey, string> = {};

    for (const scenario of catalog.all) {
        const key = getScenarioRuntimeKey(scenario);
        const currentValue = currentByKey[key];
        if (typeof currentValue === 'string' && currentValue.trim()) {
            migrated[key] = currentValue;
            continue;
        }

        const primary = catalog.primaryByName.get(scenario.name);
        const legacyValue = legacyByName[scenario.name];
        if (primary === scenario && typeof legacyValue === 'string' && legacyValue.trim()) {
            migrated[key] = legacyValue;
        }
    }

    return migrated;
}

export function projectScenarioBuildSelection(
    scenarios: readonly TestInfo[],
    selectionByKey: Readonly<Record<ScenarioRuntimeKey, boolean>>
): ScenarioBuildSelectionProjection {
    const enabledKeys: ScenarioRuntimeKey[] = [];
    const disabledKeys: ScenarioRuntimeKey[] = [];
    const enabledKeyByName: Record<string, ScenarioRuntimeKey> = {};
    const disabledScenarios: Array<{ key: ScenarioRuntimeKey; name: string }> = [];

    for (const scenario of scenarios) {
        const key = getScenarioRuntimeKey(scenario);
        if (selectionByKey[key] === true) {
            enabledKeys.push(key);
            enabledKeyByName[scenario.name] = key;
        } else {
            disabledKeys.push(key);
            disabledScenarios.push({ key, name: scenario.name });
        }
    }

    const enabledNameSet = new Set(Object.keys(enabledKeyByName));
    const disabledNameSet = new Set<string>();
    const isolatedDisabledKeys: ScenarioRuntimeKey[] = [];
    for (const scenario of disabledScenarios) {
        if (enabledNameSet.has(scenario.name)) {
            isolatedDisabledKeys.push(scenario.key);
        } else {
            disabledNameSet.add(scenario.name);
        }
    }

    const compareNames = (left: string, right: string): number =>
        left.localeCompare(right, undefined, { sensitivity: 'base' });

    return {
        total: scenarios.length,
        enabledKeys,
        disabledKeys,
        enabledNames: [...enabledNameSet].sort(compareNames),
        disabledNames: [...disabledNameSet].sort(compareNames),
        isolatedDisabledKeys,
        enabledKeyByName
    };
}

export function buildUniqueCaseInsensitiveNameLookup(
    names: Iterable<string>
): Map<string, string> {
    const buckets = new Map<string, string[]>();
    for (const rawName of names) {
        const name = rawName.trim();
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        const bucket = buckets.get(key) ?? [];
        if (!bucket.includes(name)) {
            bucket.push(name);
        }
        buckets.set(key, bucket);
    }

    const lookup = new Map<string, string>();
    for (const [key, bucket] of buckets) {
        if (bucket.length === 1) {
            lookup.set(key, bucket[0]);
        }
    }
    return lookup;
}

export function resolveConfirmedScenarioRuntimeRenames(
    candidates: Iterable<ScenarioRuntimeRenameCandidate>,
    refreshedCatalog: ScenarioCatalog
): ScenarioRuntimeRenamePlan {
    const remappedKeys = new Map<ScenarioRuntimeKey, ScenarioRuntimeKey>();
    const removedKeys = new Set<ScenarioRuntimeKey>();

    for (const { oldKey, newKey } of candidates) {
        if (!oldKey || !newKey || oldKey === newKey) {
            continue;
        }
        if (refreshedCatalog.byUri.has(newKey)) {
            remappedKeys.set(oldKey, newKey);
        } else {
            removedKeys.add(oldKey);
        }
    }

    return { remappedKeys, removedKeys };
}

export function applyScenarioRuntimeRenamePlanToRecord<T>(
    values: Readonly<Record<ScenarioRuntimeKey, T>>,
    plan: ScenarioRuntimeRenamePlan
): Record<ScenarioRuntimeKey, T> {
    const next: Record<ScenarioRuntimeKey, T> = {};
    for (const [key, value] of Object.entries(values) as Array<[ScenarioRuntimeKey, T]>) {
        if (plan.removedKeys.has(key)) {
            continue;
        }
        next[plan.remappedKeys.get(key) ?? key] = value;
    }
    return next;
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
