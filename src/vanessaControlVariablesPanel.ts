import { VanessaVariableControlError, type VanessaRuntimeVariable, type VanessaRuntimeVariables, type VanessaVariableScope } from './vanessaControlVariables';
export interface VanessaVariablesPanelPorts {
    snapshot(): { generation: number; ready: boolean; read: boolean; write: boolean; busy?: boolean };
    run<T>(work: (variables: VanessaRuntimeVariables) => Promise<T>, generation: number, isCurrent?: () => boolean): Promise<T>;
}
export interface VanessaVariableEdit { readonly generation: number; readonly lifetime: number; readonly scope: VanessaVariableScope; readonly name: string; readonly expected?: string }
export class VanessaVariablesPanelModel {
    private value: Readonly<{ status: 'idle' | 'ready' | 'loading' | 'unavailable' | 'error'; rows: readonly VanessaRuntimeVariable[] }> = Object.freeze({ status: 'idle', rows: [] });
    private visible = false;
    private disposed = false;
    private lifetime = 0;
    private revision = 0;
    private generation: number | undefined;
    get state() { return this.value; }
    constructor(private readonly ports: VanessaVariablesPanelPorts, private readonly changed: () => void = () => undefined) {}
    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) { return; }
        this.visible = visible; this.clear('idle'); this.sessionChanged();
    }
    sessionChanged(): void {
        const snapshot = this.ports.snapshot();
        if (this.generation !== snapshot.generation || !snapshot.ready || !snapshot.read) {
            this.clear(snapshot.ready && snapshot.read ? 'idle' : 'unavailable');
        }
        if (snapshot.ready && snapshot.read && this.value.status === 'unavailable') { this.publish('idle', []); }
        this.generation = snapshot.generation;
    }
    async refresh(): Promise<void> {
        if (!this.visible || this.disposed || this.state.status === 'loading') { return; }
        this.sessionChanged();
        const snapshot = this.ports.snapshot();
        if (!snapshot.ready || !snapshot.read || snapshot.busy) { return; }
        const lifetime = this.lifetime; const revision = ++this.revision;
        const current = () => this.current(lifetime, snapshot.generation) && revision === this.revision;
        this.publish('loading', []);
        try {
            const rows = await this.ports.run(variables => variables.list(), snapshot.generation, current);
            if (current()) { this.publish('ready', rows); }
        } catch { if (current()) { this.publish('error', []); } }
    }
    beginEdit(scope: VanessaVariableScope, name: string): VanessaVariableEdit {
        const snapshot = this.ports.snapshot();
        if (!this.visible || this.disposed || !snapshot.ready || !snapshot.read || !snapshot.write || this.state.status !== 'ready') {
            throw new VanessaVariableControlError('Refresh the runtime variables before editing.');
        }
        const expected = this.state.rows.find(row => row.scope === scope && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.representation;
        return Object.freeze({ generation: snapshot.generation, lifetime: this.lifetime, scope, name, expected });
    }
    async set(edit: VanessaVariableEdit, value: string): Promise<void> { await this.apply(edit, variables => variables.set(edit.scope, edit.name, value, edit.expected)); }
    async delete(edit: VanessaVariableEdit): Promise<void> {
        if (edit.expected === undefined) { throw new VanessaVariableControlError('The runtime variable changed. Refresh the variables before editing.'); }
        await this.apply(edit, variables => variables.delete(edit.scope, edit.name, edit.expected!));
    }
    dispose(): void { this.disposed = true; this.visible = false; this.clear('idle'); }
    private async apply(edit: VanessaVariableEdit, work: (variables: VanessaRuntimeVariables) => Promise<void>): Promise<void> {
        const current = () => this.current(edit.lifetime, edit.generation) && this.ports.snapshot().write;
        if (!current()) { throw new VanessaVariableControlError('The Vanessa session or variable panel changed. Refresh the variables.'); }
        try { await this.ports.run(work, edit.generation, current); }
        finally { if (current()) { await this.refresh(); } }
    }
    private current(lifetime: number, generation: number): boolean {
        const snapshot = this.ports.snapshot();
        return !this.disposed && this.visible && this.lifetime === lifetime && snapshot.generation === generation && snapshot.ready && snapshot.read;
    }
    private clear(status: typeof this.value.status): void { this.lifetime++; this.revision++; this.publish(status, []); }
    private publish(status: typeof this.value.status, rows: readonly VanessaRuntimeVariable[]): void {
        this.value = Object.freeze({ status, rows: Object.freeze([...rows]) }); this.changed();
    }
}
