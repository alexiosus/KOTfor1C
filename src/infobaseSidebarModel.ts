import * as path from 'node:path';
import type { ActiveYamlParametersProfile } from './activeYamlParametersProfile';
import type { ManagedInfobaseKind, ManagedInfobaseState } from './infobaseManager';
import type { ManagedInfobaseSnapshot } from './managedInfobaseService';
import {
    isWindowsAbsolutePath,
    normalizeInfobaseConnectionIdentity,
    normalizeInfobaseReference,
    parseInfobaseConnectionString
} from './oneCInfobaseConnection';

export interface InfobaseSidebarItem {
    readonly id: string;
    readonly displayName: string;
    readonly infobasePath: string;
    readonly locationLabel: string;
    readonly infobaseKind: ManagedInfobaseKind;
    readonly state: ManagedInfobaseState;
    readonly roles: readonly string[];
    readonly active: boolean;
}

export interface InfobaseSidebarModel {
    readonly revision: number;
    readonly profileId: string;
    readonly profileName: string;
    readonly activeInfobaseId: string | null;
    readonly items: readonly InfobaseSidebarItem[];
}

const ACTIVE_INFOBASE_ALIASES = new Set([
    'launchdbfolder',
    'testclientdbpath',
    'infobasepath',
    'testclientdb'
]);

function normalizedParameterKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function unquoteConnectionValue(value: string): string {
    const trimmed = value.trim().replace(/;\s*$/u, '').trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/gu, '"');
    }
    return trimmed;
}

function resolveFileReference(rawPath: string, workspaceRootPath: string | null): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed) {
        return null;
    }
    if (isWindowsAbsolutePath(trimmed)) {
        return path.win32.normalize(trimmed);
    }
    if (path.isAbsolute(trimmed)) {
        return path.normalize(trimmed);
    }
    return path.resolve(workspaceRootPath ?? process.cwd(), trimmed);
}

export function resolveActiveProfileInfobasePath(
    profile: ActiveYamlParametersProfile,
    workspaceRootPath: string | null
): string | null {
    const parameter = profile.buildParameters.find(candidate =>
        ACTIVE_INFOBASE_ALIASES.has(normalizedParameterKey(candidate.key))
        && candidate.value.trim().length > 0
    );
    const rawValue = parameter?.value.trim() ?? '';
    if (!rawValue) {
        return null;
    }

    const fileMatch = /(?:^|;)\s*File\s*=\s*("(?:[^"]|"")*"|[^;]+)/iu.exec(rawValue);
    if (fileMatch) {
        return resolveFileReference(unquoteConnectionValue(fileMatch[1]), workspaceRootPath);
    }
    const connection = parseInfobaseConnectionString(rawValue);
    if (connection && connection.kind !== 'file') {
        return normalizeInfobaseReference(rawValue);
    }
    return resolveFileReference(rawValue, workspaceRootPath);
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

export function buildInfobaseSidebarModel(snapshot: ManagedInfobaseSnapshot): InfobaseSidebarModel {
    const activeIdentity = snapshot.activeInfobaseIdentity;
    const items = snapshot.infobases
        .filter(record => !record.hidden)
        .map(record => {
            const active = activeIdentity !== null
                && normalizeInfobaseConnectionIdentity(record.infobasePath) === activeIdentity;
            return Object.freeze({
                id: record.id,
                displayName: record.displayName,
                infobasePath: record.infobasePath,
                locationLabel: record.locationLabel,
                infobaseKind: record.infobaseKind,
                state: record.state,
                roles: Object.freeze([...record.roles]),
                active
            });
        })
        .sort((left, right) => Number(right.active) - Number(left.active)
            || compareText(left.displayName, right.displayName)
            || compareText(left.infobasePath, right.infobasePath));
    return Object.freeze({
        revision: snapshot.revision,
        profileId: snapshot.profileId,
        profileName: snapshot.profileName,
        activeInfobaseId: items.find(item => item.active)?.id ?? null,
        items: Object.freeze(items)
    });
}
