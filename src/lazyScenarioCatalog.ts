import type { ScenarioCatalog } from './scenarioCatalog';

export class LazyScenarioCatalog {
    private catalog: ScenarioCatalog | null = null;
    private dirty = true;
    private inFlight: Promise<ScenarioCatalog> | null = null;

    public constructor(private readonly loader: () => Promise<ScenarioCatalog>) {}

    public get current(): ScenarioCatalog | null {
        return this.catalog;
    }

    public get isDirty(): boolean {
        return this.dirty;
    }

    public ensureLoaded(): Promise<ScenarioCatalog> {
        if (this.catalog && !this.dirty) {
            return Promise.resolve(this.catalog);
        }
        if (this.inFlight) {
            return this.inFlight;
        }

        this.inFlight = this.loader()
            .then(catalog => {
                this.replace(catalog);
                return catalog;
            })
            .finally(() => {
                this.inFlight = null;
            });
        return this.inFlight;
    }

    public replace(catalog: ScenarioCatalog): void {
        this.catalog = catalog;
        this.dirty = false;
    }

    public update(transform: (catalog: ScenarioCatalog) => ScenarioCatalog): boolean {
        if (!this.catalog || this.dirty) {
            return false;
        }

        this.replace(transform(this.catalog));
        return true;
    }

    public invalidate(): void {
        this.dirty = true;
    }
}
