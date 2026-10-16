import type { StepLibraryItem, StepLibrarySnapshot } from './stepLibraryModel';

interface WorkspaceStateLike {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

interface LegacyFavoriteScenarioEntry {
    readonly uri: string;
    readonly name: string;
    readonly scenarioCode?: string;
}

export interface StepLibraryFavoriteChangeEvent {
    readonly itemId?: string;
}

const favoriteItemIdsKey = 'stepLibrary.favoriteItemIds';
const legacyFavoriteScenariosKey = 'phaseSwitcher.favoriteScenarios';

function normalizedStrings(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map(candidate => candidate.trim())
        .filter(Boolean))];
}

function legacyEntries(value: unknown): LegacyFavoriteScenarioEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const byUri = new Map<string, LegacyFavoriteScenarioEntry>();
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object') {
            continue;
        }
        const record = candidate as Record<string, unknown>;
        const uri = typeof record.uri === 'string' ? record.uri.trim() : '';
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!uri || !name) {
            continue;
        }
        const scenarioCode = typeof record.scenarioCode === 'string'
            ? record.scenarioCode.trim()
            : '';
        byUri.set(uri, Object.freeze({
            uri,
            name,
            ...(scenarioCode ? { scenarioCode } : {})
        }));
    }
    return [...byUri.values()];
}

export class StepLibraryFavoritesService {
    private readonly listeners = new Set<(event: StepLibraryFavoriteChangeEvent) => unknown>();

    constructor(private readonly workspaceState: WorkspaceStateLike) {}

    public readonly onDidChange = (
        listener: (event: StepLibraryFavoriteChangeEvent) => unknown
    ): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    public favoriteItemIds(snapshot: StepLibrarySnapshot): ReadonlySet<string> {
        const result = new Set(normalizedStrings(
            this.workspaceState.get<unknown>(favoriteItemIdsKey, [])
        ));
        const legacyUris = new Set(legacyEntries(
            this.workspaceState.get<unknown>(legacyFavoriteScenariosKey, [])
        ).map(entry => entry.uri));
        for (const item of snapshot.items) {
            if (
                (item.sourceGroup === 'main' || item.sourceGroup === 'process')
                && item.capturedLocation
                && legacyUris.has(item.capturedLocation.uri)
            ) {
                result.add(item.id);
            }
        }
        return result;
    }

    public async toggle(item: StepLibraryItem): Promise<boolean> {
        if ((item.sourceGroup === 'main' || item.sourceGroup === 'process') && item.capturedLocation) {
            const entries = legacyEntries(
                this.workspaceState.get<unknown>(legacyFavoriteScenariosKey, [])
            );
            const index = entries.findIndex(entry => entry.uri === item.capturedLocation!.uri);
            const nextFavorite = index < 0;
            if (nextFavorite) {
                entries.push(Object.freeze({
                    uri: item.capturedLocation.uri,
                    name: item.displayText,
                    ...(item.scenarioCode ? { scenarioCode: item.scenarioCode } : {})
                }));
            } else {
                entries.splice(index, 1);
            }
            await this.workspaceState.update(legacyFavoriteScenariosKey, entries);
            this.fire({ itemId: item.id });
            return nextFavorite;
        }

        const ids = new Set(normalizedStrings(
            this.workspaceState.get<unknown>(favoriteItemIdsKey, [])
        ));
        const nextFavorite = !ids.has(item.id);
        if (nextFavorite) {
            ids.add(item.id);
        } else {
            ids.delete(item.id);
        }
        await this.workspaceState.update(favoriteItemIdsKey, [...ids].sort());
        this.fire({ itemId: item.id });
        return nextFavorite;
    }

    public notifyLegacyFavoritesChanged(): void {
        this.fire({});
    }

    public dispose(): void {
        this.listeners.clear();
    }

    private fire(event: StepLibraryFavoriteChangeEvent): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }
}
