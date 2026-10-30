interface NativeMetadataDocument {
    readonly uri: { toString(): string };
    readonly isDirty: boolean;
    save(): PromiseLike<boolean>;
}
export interface NativeSpprSyncPorts<Document extends NativeMetadataDocument> {
    resolve(document: Document): Promise<Document | undefined>;
    read(metadata: Document): Promise<string>;
    enabled(): { nested: boolean; parameters: boolean };
    needsNested(source: string): boolean;
    needsParameters(source: string): boolean;
    fillNested(metadata: Document): Promise<boolean>;
    fillParameters(metadata: Document): Promise<boolean>;
    changed(metadata: Document): void;
}
/** Synchronize native pairs through the same metadata editors as embedded YAML scripts. */
export class NativeSpprScenarioSynchronizer<Document extends NativeMetadataDocument> {
    private readonly active = new Set<string>();
    private readonly pending = new Set<string>();
    constructor(private readonly ports: NativeSpprSyncPorts<Document>) {}
    async onSave(document: Document): Promise<boolean> {
        const metadata = await this.ports.resolve(document);
        if (!metadata) { return false; }
        const key = metadata.uri.toString();
        if (this.active.has(key)) { this.pending.add(key); return true; }
        this.active.add(key);
        try {
            do {
                this.pending.delete(key);
                const wasDirty = metadata.isDirty;
                const enabled = this.ports.enabled();
                let changed = false;
                if (enabled.nested && this.ports.needsNested(await this.ports.read(metadata))) {
                    changed = await this.ports.fillNested(metadata) || changed;
                }
                if (enabled.parameters && this.ports.needsParameters(await this.ports.read(metadata))) {
                    changed = await this.ports.fillParameters(metadata) || changed;
                }
                if (changed) {
                    this.ports.changed(metadata);
                    if (!wasDirty && !await metadata.save()) { throw new Error('Could not save synchronized SPPR metadata. Unsaved changes were retained.'); }
                }
            } while (this.pending.delete(key));
        } finally { this.active.delete(key); this.pending.delete(key); }
        return true;
    }
}
