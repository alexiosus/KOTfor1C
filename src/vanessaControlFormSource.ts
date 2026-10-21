import type { FormExplorerSnapshot } from './formExplorerTypes';
import type { VanessaFormStepCache, VanessaFormStepResult } from './vanessaControlFormSteps';
import { VanessaFormContextChangedError, VanessaFormControlError, type VanessaFormWindows, type VanessaRuntimeForms } from './vanessaControlForms';
export interface VanessaFormSourcePorts {
    snapshot(): { generation: number; ready: boolean; supported: boolean; busy?: boolean; windowsSupported?: boolean };
    run<T>(work: (forms: VanessaRuntimeForms) => Promise<T>, isCurrent: () => boolean): Promise<T>;
    enrich?(snapshot: FormExplorerSnapshot): Promise<FormExplorerSnapshot>;
}
/** Shared in-memory form cache; optional enrichment reads existing project metadata. No live values are persisted. */
export class VanessaFormExplorerSource {
    private value: { status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; snapshot?: FormExplorerSnapshot; message?: string } = { status: 'idle' };
    private generation: number | undefined; private revision = 0; private disposed = false; private readAt = 0;
    private failedGeneration: number | undefined;
    private pending: Promise<FormExplorerSnapshot | undefined> | undefined;
    private pendingKind: 'tree' | 'identity' | 'element' | undefined;
    private readonly listeners = new Set<() => void>();
    get state() { return this.value; }
    get available() { return !this.disposed && this.ports.snapshot().supported; }
    get inspectionReady() { const state = this.ports.snapshot(); return !!this.cached() && !this.pending && !state.busy; }
    get windowControlsAvailable() { return this.available && this.ports.snapshot().windowsSupported !== false; }
    constructor(private readonly ports: VanessaFormSourcePorts) { this.sessionChanged(); }
    onDidChange(listener: () => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
    sessionChanged(): void {
        const state = this.ports.snapshot();
        if (this.generation !== state.generation || !state.ready || !state.supported) {
            this.revision++;
            if (this.generation !== state.generation) { this.pending = undefined; this.pendingKind = undefined; this.failedGeneration = undefined; }
            this.publish({ status: state.ready && state.supported ? 'idle' : 'unavailable' });
        } else if (state.ready && state.supported && this.value.status === 'unavailable') { this.publish({ status: 'idle' }); }
        this.generation = state.generation;
    }
    cached(): FormExplorerSnapshot | undefined {
        const state = this.ports.snapshot();
        return !this.disposed && state.ready && state.supported && state.generation === this.generation ? this.value.snapshot : undefined;
    }
    refresh(force = false): Promise<FormExplorerSnapshot | undefined> {
        if (this.pending) {
            if (force && this.pendingKind !== 'tree') {
                const generation = this.ports.snapshot().generation;
                return this.pending.then(() => !this.disposed && this.ports.snapshot().generation === generation ? this.refresh(true) : undefined);
            }
            return this.pending;
        }
        if (this.ports.snapshot().busy) { return Promise.resolve(this.cached()); }
        if (!force && this.failedGeneration === this.ports.snapshot().generation) { return Promise.resolve(undefined); }
        if (force) { this.failedGeneration = undefined; }
        if (!force && Date.now() - this.readAt < 5_000 && this.cached()) { return Promise.resolve(this.cached()); }
        const previous = this.value.snapshot;
        return this.perform(forms => !force && previous ? forms.refresh(previous) : forms.read(), !force && previous ? 'identity' : 'tree');
    }
    element(path: string): Promise<FormExplorerSnapshot | undefined> {
        const snapshot = this.cached();
        if (!snapshot || this.pending) { return Promise.resolve(undefined); }
        return this.perform(forms => forms.element(snapshot, path), 'element');
    }
    async steps(expected: FormExplorerSnapshot, path: string, cache: VanessaFormStepCache, language: string, isCurrent: () => boolean): Promise<VanessaFormStepResult | undefined> {
        if (!this.inspectionReady || this.cached() !== expected || !isCurrent()) { return; }
        let result: VanessaFormStepResult | undefined;
        const accepted = await this.perform(async forms => {
            result = await forms.steps(expected, path, cache, language);
            return result.snapshot;
        }, 'element', isCurrent);
        return accepted && result ? { ...result, snapshot: accepted } : undefined;
    }
    async windows(): Promise<VanessaFormWindows | undefined> {
        await this.pending;
        const state = this.ports.snapshot(); const revision = this.revision;
        if (this.disposed || !this.windowControlsAvailable || !state.ready || state.busy) { return; }
        const current = () => !this.disposed && this.revision === revision && this.ports.snapshot().generation === state.generation && this.ports.snapshot().ready;
        const windows = await this.ports.run(forms => forms.windows(), current);
        return current() ? windows : undefined;
    }
    async activateWindow(windows: VanessaFormWindows, title: string): Promise<FormExplorerSnapshot | undefined> {
        await this.pending;
        if (!this.windowControlsAvailable) { return; }
        return this.perform(forms => forms.activateWindow(windows, title), 'tree');
    }
    dispose(): void { this.disposed = true; this.revision++; this.pending = undefined; this.publish({ status: 'idle' }); this.listeners.clear(); }
    private perform(work: (forms: VanessaRuntimeForms) => Promise<FormExplorerSnapshot>, kind: 'tree' | 'identity' | 'element', isCurrent?: () => boolean): Promise<FormExplorerSnapshot | undefined> {
        this.sessionChanged(); const state = this.ports.snapshot();
        if (this.disposed || !state.ready || !state.supported || state.busy) { return Promise.resolve(undefined); }
        const revision = ++this.revision;
        const previous = this.value.snapshot;
        const sameSession = () => !this.disposed && this.revision === revision && this.ports.snapshot().generation === state.generation && this.ports.snapshot().ready;
        const current = () => sameSession() && (!isCurrent || isCurrent());
        this.publish({ status: 'loading', ...(kind !== 'tree' && previous ? { snapshot: previous } : {}) });
        const operation = (async () => {
            try {
                let snapshot = await this.ports.run(work, current);
                if (current() && snapshot !== previous && this.ports.enrich) {
                    try { snapshot = await this.ports.enrich(snapshot); } catch { /* Optional local metadata never blocks the live form. */ }
                }
                if (current()) { this.readAt = Date.now(); this.publish({ status: 'ready', snapshot }); return snapshot; }
            } catch (error) {
                if ((!isCurrent || isCurrent()) && (current() || !this.disposed && this.ports.snapshot().generation === state.generation && this.value.status === 'idle')) {
                    const retain = kind === 'element' && previous && error instanceof VanessaFormControlError && !(error instanceof VanessaFormContextChangedError);
                    if (!retain) { this.failedGeneration = state.generation; }
                    this.publish({ status: 'error', ...(retain ? { snapshot: previous } : {}), message: error instanceof VanessaFormControlError ? error.message : 'Could not read the Vanessa form. Refresh the session and form.' }); }
            }
            if (sameSession() && isCurrent && !isCurrent()) {
                this.publish(previous ? { status: 'ready', snapshot: previous } : { status: 'idle' });
            }
            return undefined;
        })();
        this.pending = operation;
        this.pendingKind = kind;
        void operation.finally(() => { if (this.pending === operation) { this.pending = undefined; this.pendingKind = undefined; } });
        return operation;
    }
    private publish(value: typeof this.value) { this.value = value; for (const listener of this.listeners) { listener(); } }
}
