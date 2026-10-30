import { collectGherkinProjectTags } from './gherkinAnnotations';

interface Resource { toString(): string }
interface Cancellation { readonly isCancellationRequested: boolean }
export interface ProjectFeatureTagSources {
    loadSources(resource?: Resource, token?: Cancellation): Promise<readonly string[]>;
    readSource(uri: string): Promise<string>;
    getOpenSources(): readonly { uri: string; text: string }[];
}

/** Reads only catalogued features, caches their tags, and overlays unsaved editor contents. */
export class ProjectFeatureTagCatalog {
    private readonly cache = new Map<string, Promise<readonly string[]>>();
    private generation = 0;
    constructor(private readonly sources: ProjectFeatureTagSources) {}

    invalidate(): void { this.generation++; this.cache.clear(); }

    async getTags(resource?: Resource, token?: Cancellation): Promise<readonly string[]> {
        let uris: readonly string[];
        try { uris = await this.sources.loadSources(resource, token); }
        catch { return []; }
        if (token?.isCancellationRequested) { return []; }
        const generation = this.generation;
        const selected = [...new Set(uris.filter(uri => /\.feature(?:[?#].*)?$/iu.test(uri)))];
        const disk = new Map<string, readonly string[]>();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
            while (next < selected.length && !token?.isCancellationRequested) {
                const uri = selected[next++];
                let pending = this.cache.get(uri);
                if (!pending) {
                    pending = this.sources.readSource(uri).then(text => collectGherkinProjectTags({ text, uri, language: 'en' })).catch(() => []);
                    this.cache.set(uri, pending);
                }
                disk.set(uri, await pending);
            }
        }));
        if (token?.isCancellationRequested || generation !== this.generation) { return []; }
        for (const source of this.sources.getOpenSources()) {
            if (disk.has(source.uri)) { disk.set(source.uri, collectGherkinProjectTags({ ...source, language: 'en' })); }
        }
        const tags = new Map<string, string>();
        for (const values of disk.values()) {
            for (const tag of values) { if (!tags.has(tag.toLocaleLowerCase())) { tags.set(tag.toLocaleLowerCase(), tag); } }
        }
        return [...tags.values()].sort((a, b) => a.localeCompare(b, 'en'));
    }
}
