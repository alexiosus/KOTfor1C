import * as fs from 'node:fs';
import * as path from 'node:path';
import { enrichFormExplorerSnapshot } from './formExplorerEnrichment';
import {
    getFormExplorerGeneratedArtifactsDirectory,
    getFormExplorerSnapshotPath
} from './formExplorerPaths';
import {
    FormExplorerSnapshot,
    parseFormExplorerSnapshotText
} from './formExplorerTypes';

const DEFAULT_ADAPTER_RUNTIME_STATE_FILE_NAME = 'adapter-runtime-state.json';

export interface LoadedFormExplorerLiveSnapshot {
    snapshotPath: string;
    snapshot: FormExplorerSnapshot;
}

interface CachedLiveSnapshot extends LoadedFormExplorerLiveSnapshot {
    mtimeMs: number;
    size: number;
}

let cachedLiveSnapshot: CachedLiveSnapshot | null = null;

function getAdapterRuntimeStatePath(): string | null {
    const generatedArtifactsDirectory = getFormExplorerGeneratedArtifactsDirectory();
    if (!generatedArtifactsDirectory) {
        return null;
    }

    return path.join(generatedArtifactsDirectory, DEFAULT_ADAPTER_RUNTIME_STATE_FILE_NAME);
}

async function resolveActualLiveSnapshotPath(): Promise<string | null> {
    const configuredSnapshotPath = getFormExplorerSnapshotPath();
    const candidatePaths = new Set<string>();
    if (configuredSnapshotPath) {
        const normalizedConfiguredPath = path.resolve(configuredSnapshotPath);
        candidatePaths.add(normalizedConfiguredPath);

        const configuredDirectory = path.dirname(normalizedConfiguredPath);
        const configuredFileName = path.basename(normalizedConfiguredPath);
        const configuredPrefix = `${configuredFileName}.`;
        try {
            const directoryEntries = await fs.promises.readdir(configuredDirectory, { withFileTypes: true });
            for (const entry of directoryEntries) {
                if (!entry.isFile()) {
                    continue;
                }

                if (entry.name !== configuredFileName && !entry.name.startsWith(configuredPrefix)) {
                    continue;
                }

                candidatePaths.add(path.join(configuredDirectory, entry.name));
            }
        } catch {
            // Ignore directory scan failures and fall back to explicit paths.
        }
    }

    const runtimeStatePath = getAdapterRuntimeStatePath();
    let runtimeSnapshotPath: string | null = null;
    if (runtimeStatePath) {
        try {
            const rawText = await fs.promises.readFile(runtimeStatePath, 'utf8');
            const parsed = JSON.parse(rawText) as { snapshotPath?: unknown } | null;
            runtimeSnapshotPath = typeof parsed?.snapshotPath === 'string'
                ? parsed.snapshotPath.trim()
                : '';
            if (runtimeSnapshotPath) {
                candidatePaths.add(path.resolve(runtimeSnapshotPath));
            }
        } catch {
            // Ignore runtime-state read failures and keep the explicit candidates.
        }
    }

    const existingCandidates = await Promise.all(
        Array.from(candidatePaths).map(async candidatePath => {
            try {
                const stat = await fs.promises.stat(candidatePath);
                return {
                    path: path.resolve(candidatePath),
                    mtimeMs: stat.mtimeMs
                };
            } catch {
                return null;
            }
        })
    );

    const resolvedExistingCandidates = existingCandidates
        .filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== null)
        .sort((left, right) => right.mtimeMs - left.mtimeMs);

    const normalizedRuntimeSnapshotPath = runtimeSnapshotPath ? path.resolve(runtimeSnapshotPath) : null;
    if (normalizedRuntimeSnapshotPath) {
        const runtimeCandidate = resolvedExistingCandidates.find(candidate => candidate.path === normalizedRuntimeSnapshotPath);
        if (runtimeCandidate) {
            return runtimeCandidate.path;
        }
    }

    return resolvedExistingCandidates[0]?.path || null;
}

export async function loadLiveFormExplorerSnapshot(): Promise<LoadedFormExplorerLiveSnapshot | null> {
    const snapshotPath = await resolveActualLiveSnapshotPath();
    if (!snapshotPath) {
        return null;
    }

    let snapshotStat: fs.Stats;
    try {
        snapshotStat = await fs.promises.stat(snapshotPath);
    } catch {
        return null;
    }

    if (
        cachedLiveSnapshot
        && cachedLiveSnapshot.snapshotPath === snapshotPath
        && cachedLiveSnapshot.mtimeMs === snapshotStat.mtimeMs
        && cachedLiveSnapshot.size === snapshotStat.size
    ) {
        return {
            snapshotPath: cachedLiveSnapshot.snapshotPath,
            snapshot: cachedLiveSnapshot.snapshot
        };
    }

    try {
        const rawText = await fs.promises.readFile(snapshotPath, 'utf8');
        const parsedSnapshot = parseFormExplorerSnapshotText(rawText);
        const enrichedSnapshot = await enrichFormExplorerSnapshot(parsedSnapshot, snapshotPath);
        cachedLiveSnapshot = {
            snapshotPath,
            snapshot: enrichedSnapshot,
            mtimeMs: snapshotStat.mtimeMs,
            size: snapshotStat.size
        };

        return {
            snapshotPath,
            snapshot: enrichedSnapshot
        };
    } catch {
        return null;
    }
}
