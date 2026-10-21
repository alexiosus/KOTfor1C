import * as vscode from 'vscode';

export interface VanessaGutterLocation { readonly uri: string; readonly line: number }
type Owner = 'feature' | 'yaml';

/** Only source breakpoints created/claimed by KOT are reconciled here. */
export class VanessaBreakpointMarkers implements vscode.Disposable {
    private readonly owned = new Map<string, { point: vscode.SourceBreakpoint; owner: Owner; pending: boolean }>();
    owns(id: string): boolean { return this.owned.has(id); }
    adopt(point: vscode.SourceBreakpoint, owner: Owner, pending = true): void { this.owned.set(point.id, { point, owner, pending }); }
    takeRemoved(id: string): boolean { return this.owned.delete(id); }
    discardPending(id: string): void {
        const value = this.owned.get(id);
        if (!value?.pending) { return; }
        this.owned.delete(id); vscode.debug.removeBreakpoints([value.point]);
    }
    replace(owner: Owner, locations: readonly VanessaGutterLocation[]): void {
        const key = (uri: string, line: number) => `${uri}\n${line}`;
        const desired = new Map(locations.map(location => [key(location.uri, location.line), location]));
        const removed: vscode.SourceBreakpoint[] = [];
        for (const [id, value] of this.owned) {
            if (value.owner !== owner) { continue; }
            const location = key(value.point.location.uri.toString(), value.point.location.range.start.line);
            if (desired.delete(location)) { value.pending = false; continue; }
            this.owned.delete(id); removed.push(value.point);
        }
        // Delete ownership before emitting our own removal events.
        if (removed.length) { vscode.debug.removeBreakpoints(removed); }
        const added: vscode.SourceBreakpoint[] = [];
        for (const location of desired.values()) {
            // A pre-existing debugger breakpoint is never adopted or removed.
            if (vscode.debug.breakpoints.some(point => point instanceof vscode.SourceBreakpoint &&
                point.location.uri.toString() === location.uri && point.location.range.start.line === location.line)) { continue; }
            const point = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.parse(location.uri), new vscode.Range(location.line, 0, location.line, 0)));
            this.adopt(point, owner, false); added.push(point);
        }
        if (added.length) { vscode.debug.addBreakpoints(added); }
    }
    dispose(): void {
        const points = [...this.owned.values()].map(value => value.point); this.owned.clear();
        if (points.length) { vscode.debug.removeBreakpoints(points); }
    }
}
