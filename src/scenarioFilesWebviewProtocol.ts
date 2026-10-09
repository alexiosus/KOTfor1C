import type { ScenarioFileManifestEntry } from './scenarioFilesModel';
import { normalizeScenarioFileRelativePath } from './scenarioFilesModel';

export const MAX_SCENARIO_FILE_CHUNK_CHARACTERS = 360_000;
const MAX_ID_LENGTH = 2_048;
const MAX_PATH_LENGTH = 8_192;
const MAX_MANIFEST_ENTRIES = 5_000;

export type ScenarioFilesMessage =
    | { readonly command: 'listScenarioFiles'; readonly itemId: string; readonly relativePath: string; readonly requestId: string }
    | { readonly command: 'setScenarioFilesExpanded'; readonly itemId: string; readonly expanded: boolean }
    | { readonly command: 'openScenarioFile'; readonly itemId: string; readonly relativePath: string }
    | { readonly command: 'revealScenarioFile'; readonly itemId: string; readonly relativePath: string }
    | { readonly command: 'deleteScenarioFile'; readonly itemId: string; readonly relativePath: string }
    | { readonly command: 'openCompiledScenarioFeature'; readonly itemId: string }
    | {
        readonly command: 'prepareScenarioFileDrop';
        readonly dropId: string;
        readonly itemId: string;
        readonly targetRelativePath: string;
        readonly entries: readonly ScenarioFileManifestEntry[];
    }
    | { readonly command: 'appendScenarioFileChunk'; readonly transferId: string; readonly offset: number; readonly base64: string }
    | { readonly command: 'completeScenarioFileTransfer'; readonly transferId: string }
    | { readonly command: 'cancelScenarioFileTransfer'; readonly transferId: string };

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_ID_LENGTH ? trimmed : null;
}

function cleanPath(value: unknown, allowEmpty: boolean): string | null {
    if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH) {
        return null;
    }
    const normalized = normalizeScenarioFileRelativePath(value);
    if (normalized === null || (!allowEmpty && !normalized)) {
        return null;
    }
    return normalized;
}

function cleanManifest(value: unknown): readonly ScenarioFileManifestEntry[] | null {
    if (!Array.isArray(value) || value.length > MAX_MANIFEST_ENTRIES) {
        return null;
    }
    const result: ScenarioFileManifestEntry[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object') {
            return null;
        }
        const record = candidate as Record<string, unknown>;
        const clientPath = cleanPath(record.clientPath, false);
        const kind = record.kind;
        if (!clientPath || (kind !== 'directory' && kind !== 'file') || seen.has(clientPath)) {
            return null;
        }
        seen.add(clientPath);
        if (kind === 'file') {
            const size = record.size;
            if (!Number.isSafeInteger(size) || (size as number) < 0) {
                return null;
            }
            result.push(Object.freeze({ clientPath, kind, size: size as number }));
        } else {
            result.push(Object.freeze({ clientPath, kind }));
        }
    }
    return Object.freeze(result);
}

export function parseScenarioFilesMessage(value: unknown): ScenarioFilesMessage | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.command === 'listScenarioFiles') {
        const itemId = cleanId(record.itemId);
        const relativePath = cleanPath(record.relativePath, true);
        const requestId = cleanId(record.requestId);
        return itemId && relativePath !== null && requestId
            ? { command: record.command, itemId, relativePath, requestId }
            : null;
    }
    if (record.command === 'setScenarioFilesExpanded') {
        const itemId = cleanId(record.itemId);
        return itemId && typeof record.expanded === 'boolean'
            ? { command: record.command, itemId, expanded: record.expanded }
            : null;
    }
    if (record.command === 'openScenarioFile' || record.command === 'revealScenarioFile') {
        const itemId = cleanId(record.itemId);
        const relativePath = cleanPath(record.relativePath, record.command === 'revealScenarioFile');
        return itemId && relativePath !== null
            ? { command: record.command, itemId, relativePath }
            : null;
    }
    if (record.command === 'deleteScenarioFile') {
        const itemId = cleanId(record.itemId);
        const relativePath = cleanPath(record.relativePath, false);
        return itemId && relativePath
            ? { command: record.command, itemId, relativePath }
            : null;
    }
    if (record.command === 'openCompiledScenarioFeature') {
        const itemId = cleanId(record.itemId);
        return itemId ? { command: record.command, itemId } : null;
    }
    if (record.command === 'prepareScenarioFileDrop') {
        const dropId = cleanId(record.dropId);
        const itemId = cleanId(record.itemId);
        const targetRelativePath = cleanPath(record.targetRelativePath, true);
        const entries = cleanManifest(record.entries);
        return dropId && itemId && targetRelativePath !== null && entries
            ? { command: record.command, dropId, itemId, targetRelativePath, entries }
            : null;
    }
    if (record.command === 'appendScenarioFileChunk') {
        const transferId = cleanId(record.transferId);
        const offset = record.offset;
        const base64 = record.base64;
        return transferId
            && Number.isSafeInteger(offset)
            && (offset as number) >= 0
            && typeof base64 === 'string'
            && base64.length > 0
            && base64.length <= MAX_SCENARIO_FILE_CHUNK_CHARACTERS
            ? { command: record.command, transferId, offset: offset as number, base64 }
            : null;
    }
    if (
        record.command === 'completeScenarioFileTransfer'
        || record.command === 'cancelScenarioFileTransfer'
    ) {
        const transferId = cleanId(record.transferId);
        return transferId ? { command: record.command, transferId } : null;
    }
    return null;
}
