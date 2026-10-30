import { sameVanessaFeaturePath } from './vanessaControlProtocol';

export interface VanessaBreakpointTarget { readonly generation: number; readonly filePath: string }
export interface VanessaBreakpointPorts {
    assertCurrent(): void;
    editor(): Promise<{ readonly featurePath: string; readonly dirty: boolean; readonly lineNumber?: number } | undefined>;
    list(): Promise<readonly number[]>;
    toggle(line: number): Promise<void>;
    settle?(): Promise<void>;
}

/** A fixed local message; remote prose is never surfaced as a command error. */
export class VanessaBreakpointUnavailableError extends Error {
    constructor() { super('Vanessa Editor is not ready. Open or reload the feature in Vanessa, then retry.'); }
}

/** An MCP acknowledgement alone does not prove that the editor applied the change. */
export class VanessaBreakpointConfirmationError extends Error {
    constructor() { super('Vanessa did not confirm the breakpoint change. The MCP list still shows the previous state. Check the breakpoint in Vanessa before retrying.'); }
}

/** Ownership lasts only for one attachment; external breakpoints are never removed. */
export class VanessaBreakpointReconciler {
    private owned: { target: VanessaBreakpointTarget; lines: Set<number> }[] = [];
    private epoch = 0;
    private busy = false;
    reset(): void { this.epoch++; this.owned = []; }
    ownedLines(target: VanessaBreakpointTarget): readonly number[] {
        return Object.freeze([...(this.owned.find(value => value.target.generation === target.generation && sameVanessaFeaturePath(value.target.filePath, target.filePath))?.lines ?? [])].sort((a, b) => a - b));
    }
    /** Reload can erase foreign points too; restore them without adopting ownership. */
    async restore(target: VanessaBreakpointTarget, lines: readonly number[], owned: readonly number[], ports: VanessaBreakpointPorts): Promise<readonly number[]> {
        try { return await this.reconcile(target, lines, ports); }
        finally {
            const entry = this.owned.find(value => value.target.generation === target.generation && sameVanessaFeaturePath(value.target.filePath, target.filePath));
            if (entry) { entry.lines = new Set([...entry.lines].filter(line => owned.includes(line))); }
        }
    }
    async reconcile(target: VanessaBreakpointTarget, desired: readonly number[] | undefined, ports: VanessaBreakpointPorts): Promise<readonly number[]> {
        desired = desired ? [...desired] : undefined;
        const valid = (lines: readonly number[]) => lines.every(line => Number.isSafeInteger(line) && line > 0) && new Set(lines).size === lines.length;
        if (!target.filePath.trim() || !Number.isSafeInteger(target.generation) || desired && !valid(desired)) { throw new Error('Saved feature and unique positive breakpoint lines are required.'); }
        if (this.busy) { throw new Error('Vanessa breakpoint synchronization is busy.'); }
        this.busy = true;
        const epoch = this.epoch;
        const check = () => {
            ports.assertCurrent();
            if (this.epoch !== epoch) { throw new Error('Vanessa attachment changed.'); }
        };
        const editor = async () => {
            check(); const active = await ports.editor(); check();
            if (!active || active.dirty || !sameVanessaFeaturePath(target.filePath, active.featurePath)) { throw new Error('Activate the saved feature in Vanessa before editing breakpoints.'); }
        };
        const read = async () => {
            await editor(); const lines = await ports.list(); check(); await editor();
            if (!valid(lines)) { throw new Error('Unknown Vanessa breakpoint response.'); }
            return new Set(lines);
        };
        try {
            let remote = await read();
            let entry = this.owned.find(value => value.target.generation === target.generation && sameVanessaFeaturePath(value.target.filePath, target.filePath));
            if (entry) { for (const line of entry.lines) { if (!remote.has(line)) { entry.lines.delete(line); } } }
            if (!desired) { return Object.freeze([...remote].sort((a, b) => a - b)); }
            if (!entry) { entry = { target: { ...target }, lines: new Set() }; this.owned.push(entry); }
            const wanted = new Set(desired);
            const changes = [...[...entry.lines].filter(line => !wanted.has(line) && remote.has(line)), ...desired.filter(line => !remote.has(line))];
            for (const line of changes) {
                remote = await read();
                if (remote.has(line) === wanted.has(line)) { continue; }
                try { await ports.toggle(line); } catch { /* Read actual state before deciding whether the toggle happened. */ }
                check(); remote = await read();
                for (let attempt = 0; attempt < 6 && remote.has(line) !== wanted.has(line); attempt++) {
                    if (ports.settle) { await ports.settle(); } else { await new Promise<void>(resolve => setTimeout(resolve, 100)); }
                    remote = await read();
                }
                if (remote.has(line) !== wanted.has(line)) { throw new VanessaBreakpointConfirmationError(); }
                if (wanted.has(line)) { entry.lines.add(line); } else { entry.lines.delete(line); }
            }
            return Object.freeze([...remote].sort((a, b) => a - b));
        } catch (error) {
            if (error instanceof VanessaBreakpointUnavailableError || error instanceof VanessaBreakpointConfirmationError) { throw error; }
            throw new Error('Could not confirm Vanessa breakpoints. Refresh before retrying.');
        } finally { this.busy = false; }
    }
}
